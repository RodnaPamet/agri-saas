/**
 * Native Claude provider — implements the SAME `AiProvider` interface
 * as `OpenAiCompatibleProvider`, but backed by the Anthropic Messages
 * API directly (NOT the OpenAI-compat shim) so the first-class
 * Anthropic features — prompt caching, tool-use, native streaming —
 * are available for the load-bearing reasoning paths (dosage,
 * regulatory, long-horizon copilot).
 *
 * Why a native adapter instead of pointing OpenAiCompatibleProvider at
 * an OpenAI-compat shim:
 *   - System prompts go in the top-level `system` param (not a message),
 *     which is where Anthropic applies `cache_practice` for prompt
 *     caching.
 *   - Structured output is done via a single FORCED tool whose
 *     `input_schema` is the Zod schema converted to JSON-Schema. The
 *     model returns a `tool_use` block; we Zod-validate its input. This
 *     is more reliable than json_object reprompting and is the
 *     idiomatic Anthropic shape.
 *   - Streaming uses the Anthropic event stream (`message_start` /
 *     `content_block_delta` / …) and assembles text + tool-input deltas.
 *
 * Mapping notes:
 *   - `AiMessage` roles: 'system' → top-level system param (concatenated
 *     if multiple). 'user'/'assistant' → messages. 'tool' → a user
 *     message carrying a `tool_result` block keyed by `toolCallId`.
 *   - `max_tokens` is REQUIRED by Anthropic; sourced from
 *     `opts.maxTokens` with a conservative default.
 *
 * `embed()` throws — Anthropic exposes no embeddings endpoint; RAG
 * embeddings stay on the OpenAI-compatible / Ollama path.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z, type ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { logger } from '@/lib/observability/logger';
import { AiProviderError } from './openai-compatible-provider';
import { estimateTokens, estimateMessageTokens } from '../token-estimate';
import type {
    AiBackend,
    AiCompleteOptions,
    AiCompletion,
    AiEmbedding,
    AiEmbedOptions,
    AiHealth,
    AiMessage,
    AiProvider,
    AiToolCall,
    AiUsage,
} from './types';

/**
 * Default Claude model when none is supplied per-call or via config.
 * Opus 4.8 — the most capable Opus-tier model, the right default for
 * the load-bearing reasoning this provider exists to serve. The
 * routing policy (`../routing.ts`) overrides this per task tier.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';

/**
 * Anthropic requires `max_tokens` on every request. This conservative
 * default is used only when neither the call nor the tier specifies
 * one — the routing policy always passes an explicit tier value.
 */
const DEFAULT_MAX_TOKENS = 4096;

/** Construction config for the native Claude provider. */
export interface ClaudeProviderConfig {
    apiKey: string;
    model?: string;
    /** Optional override for the Anthropic API base URL (proxy/gateway). */
    baseURL?: string;
}

/**
 * Convert a Zod schema to a JSON-Schema object for an Anthropic tool's
 * `input_schema`. Mirrors `OpenAiCompatibleProvider`'s converter:
 * prefer Zod 4's native `z.toJSONSchema`, fall back to the
 * `zod-to-json-schema` package (Zod-3-shaped) so the path is robust
 * across either Zod major. No `any` involved.
 */
function toJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
    try {
        const native = z.toJSONSchema(schema) as Record<string, unknown>;
        if (native && Object.keys(native).some((k) => k !== '$schema')) return native;
    } catch {
        // Fall through to the package-based converter below.
    }
    const convert = zodToJsonSchema as unknown as (s: unknown, opts: { target: string }) => Record<string, unknown>;
    return convert(schema, { target: 'jsonSchema7' });
}

type MessageParam = Anthropic.Messages.MessageParam;
type ToolParam = Anthropic.Messages.Tool;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

export class ClaudeProvider implements AiProvider {
    readonly backend: AiBackend = 'claude';
    private readonly client: Anthropic;
    private readonly model: string;

    constructor(config: ClaudeProviderConfig) {
        this.model = config.model ?? DEFAULT_CLAUDE_MODEL;
        this.client = new Anthropic({
            apiKey: config.apiKey,
            ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        });
    }

    async complete<T = unknown>(opts: AiCompleteOptions<T>): Promise<AiCompletion<T>> {
        const model = opts.model ?? this.model;
        const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
        const { system, messages } = this.toAnthropicMessages(opts.messages);

        // ── Structured-output branch — forced single tool ──
        if (opts.schema) {
            return this.completeStructured(opts, model, maxTokens, system, messages);
        }

        const tools = this.buildTools(opts);
        const { text, toolCalls, usage } = await this.runMessages({
            model,
            maxTokens,
            system,
            messages,
            tools,
            temperature: opts.temperature,
            stream: opts.stream === true,
            signal: opts.signal,
        });

        const result: AiCompletion<T> = { text, usage };
        if (toolCalls.length > 0) result.toolCalls = toolCalls;
        return result;
    }

    /**
     * Map Anthropic usage (input_tokens / output_tokens) to AiUsage. When
     * the SDK omitted usage (e.g. a streamed call that yielded no
     * message_delta), fall back to a char/4 estimate over the request +
     * response and flag `estimated`.
     */
    private toUsage(
        sdkUsage: { input_tokens?: number; output_tokens?: number } | null | undefined,
        promptMessages: MessageParam[],
        completionText: string,
    ): AiUsage {
        const input = sdkUsage?.input_tokens;
        const output = sdkUsage?.output_tokens;
        if (typeof input === 'number' && typeof output === 'number') {
            return { promptTokens: input, completionTokens: output, totalTokens: input + output };
        }
        const promptTokens = this.estimatePromptTokens(promptMessages);
        const completionTokens = estimateTokens(completionText);
        return {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            estimated: true,
        };
    }

    /** Rough prompt-token estimate over Anthropic message params. */
    private estimatePromptTokens(messages: MessageParam[]): number {
        const flat: AiMessage[] = messages.map((m): AiMessage => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }));
        return estimateMessageTokens(flat);
    }

    private async completeStructured<T>(
        opts: AiCompleteOptions<T>,
        model: string,
        maxTokens: number,
        system: Anthropic.Messages.TextBlockParam[] | undefined,
        messages: MessageParam[],
    ): Promise<AiCompletion<T>> {
        const schema = opts.schema;
        if (!schema) throw new AiProviderError(this.backend, 'completeStructured called without a schema');

        const toolName = opts.schemaName ?? 'respond';
        const jsonSchema = toJsonSchema(schema);
        const tool: ToolParam = {
            name: toolName,
            description: 'Return the response as a structured object matching the schema.',
            input_schema: jsonSchema as Anthropic.Messages.Tool.InputSchema,
        };

        // First attempt — force the tool so the model MUST return
        // structured input.
        const first = await this.runStructuredTool({
            model,
            maxTokens,
            system,
            messages,
            tool,
            temperature: opts.temperature,
            signal: opts.signal,
        });
        const firstParse = this.tryParse(schema, first.input);
        if (firstParse.ok) {
            return { text: JSON.stringify(first.input), parsed: firstParse.value, usage: first.usage };
        }

        logger.warn('claude structured tool output failed validation, attempting one repair', {
            component: 'ai',
            backend: this.backend,
            error: firstParse.error,
        });

        // One repair re-prompt — feed back the invalid output + the error,
        // re-force the tool.
        const repairMessages: MessageParam[] = [
            ...messages,
            { role: 'assistant', content: JSON.stringify(first.input) },
            {
                role: 'user',
                content:
                    `That response was not valid against the schema (${firstParse.error}). ` +
                    `Call the "${toolName}" tool again with the corrected structured input.`,
            },
        ];
        const repaired = await this.runStructuredTool({
            model,
            maxTokens,
            system,
            messages: repairMessages,
            tool,
            temperature: opts.temperature,
            signal: opts.signal,
        });
        const repairedParse = this.tryParse(schema, repaired.input);
        if (repairedParse.ok) {
            return { text: JSON.stringify(repaired.input), parsed: repairedParse.value, usage: repaired.usage };
        }

        throw new AiProviderError(
            this.backend,
            `Structured output failed validation after repair attempt: ${repairedParse.error}`,
        );
    }

    async embed(_opts: AiEmbedOptions): Promise<AiEmbedding[]> {
        throw new AiProviderError(
            this.backend,
            'embeddings not supported on claude — Anthropic exposes no embeddings endpoint. ' +
                'Configure an embedding-capable backend (ollama / openrouter) for the RAG paths.',
        );
    }

    async health(): Promise<AiHealth> {
        try {
            // Cheap availability probe — list models and check the
            // configured one is present. Never throws.
            const list = await this.client.models.list();
            const ids: string[] = [];
            for await (const m of list) {
                if (typeof m.id === 'string') ids.push(m.id);
            }
            const modelAvailable = ids.some((id) => id === this.model);
            return {
                ok: true,
                model: this.model,
                modelAvailable,
                detail: modelAvailable
                    ? undefined
                    : `Model "${this.model}" not found among ${ids.length} listed model(s)`,
            };
        } catch (err) {
            return {
                ok: false,
                model: this.model,
                modelAvailable: false,
                detail: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─── Internals ───

    /**
     * Split `AiMessage[]` into the top-level `system` param and the
     * Anthropic `messages` array. System messages are concatenated into
     * a single cached text block; tool messages become `tool_result`
     * blocks attached to a user turn.
     */
    private toAnthropicMessages(messages: AiMessage[]): {
        system: Anthropic.Messages.TextBlockParam[] | undefined;
        messages: MessageParam[];
    } {
        const systemParts: string[] = [];
        const out: MessageParam[] = [];

        for (const m of messages) {
            if (m.role === 'system') {
                systemParts.push(m.content);
                continue;
            }
            if (m.role === 'tool') {
                const block: ContentBlockParam = {
                    type: 'tool_result',
                    tool_use_id: m.toolCallId ?? '',
                    content: m.content,
                };
                out.push({ role: 'user', content: [block] });
                continue;
            }
            // 'user' | 'assistant'
            out.push({ role: m.role, content: m.content });
        }

        const system =
            systemParts.length > 0
                ? [
                      {
                          type: 'text' as const,
                          text: systemParts.join('\n\n'),
                          // Prompt caching on the system block — the
                          // system prompt is the stable, repeated prefix
                          // across copilot turns, so cache it.
                          cache_practice: { type: 'ephemeral' as const },
                      },
                  ]
                : undefined;

        return { system, messages: out };
    }

    private buildTools(opts: AiCompleteOptions<unknown>): ToolParam[] | undefined {
        if (!opts.tools || opts.tools.length === 0) return undefined;
        return opts.tools.map((t): ToolParam => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
        }));
    }

    private tryParse<T>(
        schema: NonNullable<AiCompleteOptions<T>['schema']>,
        value: unknown,
    ): { ok: true; value: T } | { ok: false; error: string } {
        const result = schema.safeParse(value);
        if (result.success) return { ok: true, value: result.data };
        return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }

    /**
     * Run a forced single-tool request and return the parsed tool input
     * (the structured object). Throws if the model produced no tool_use
     * block.
     */
    private async runStructuredTool(args: {
        model: string;
        maxTokens: number;
        system: Anthropic.Messages.TextBlockParam[] | undefined;
        messages: MessageParam[];
        tool: ToolParam;
        temperature?: number;
        signal?: AbortSignal;
    }): Promise<{ input: unknown; usage: AiUsage }> {
        const response = await this.client.messages.create(
            {
                model: args.model,
                max_tokens: args.maxTokens,
                ...(args.system ? { system: args.system } : {}),
                messages: args.messages,
                tools: [args.tool],
                tool_choice: { type: 'tool', name: args.tool.name },
                ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
            },
            args.signal ? { signal: args.signal } : undefined,
        );

        for (const block of response.content) {
            if (block.type === 'tool_use' && block.name === args.tool.name) {
                const usage = this.toUsage(response.usage, args.messages, JSON.stringify(block.input));
                return { input: block.input, usage };
            }
        }
        throw new AiProviderError(
            this.backend,
            `Forced tool "${args.tool.name}" produced no tool_use block (stop_reason: ${response.stop_reason}).`,
        );
    }

    /**
     * Single seam over the Anthropic Messages API for the plain / tool /
     * streaming branch. Assembles text + tool calls uniformly.
     */
    private async runMessages(args: {
        model: string;
        maxTokens: number;
        system: Anthropic.Messages.TextBlockParam[] | undefined;
        messages: MessageParam[];
        tools?: ToolParam[];
        temperature?: number;
        stream: boolean;
        signal?: AbortSignal;
    }): Promise<{ text: string; toolCalls: AiToolCall[]; usage: AiUsage }> {
        const reqOpts = args.signal ? { signal: args.signal } : undefined;
        const base = {
            model: args.model,
            max_tokens: args.maxTokens,
            ...(args.system ? { system: args.system } : {}),
            messages: args.messages,
            ...(args.tools ? { tools: args.tools } : {}),
            ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        };

        if (args.stream) {
            const stream = this.client.messages.stream(base, reqOpts);
            let text = '';
            // Accumulate tool_use blocks by content-block index.
            const toolAcc = new Map<number, { id: string; name: string; input: string }>();
            // Streaming usage: input_tokens lands on message_start,
            // output_tokens accumulates on message_delta.
            let inputTokens: number | undefined;
            let outputTokens: number | undefined;

            for await (const event of stream) {
                if (event.type === 'message_start') {
                    inputTokens = event.message.usage?.input_tokens;
                    outputTokens = event.message.usage?.output_tokens;
                } else if (event.type === 'message_delta') {
                    if (typeof event.usage?.output_tokens === 'number') {
                        outputTokens = event.usage.output_tokens;
                    }
                } else if (event.type === 'content_block_start') {
                    const block = event.content_block;
                    if (block.type === 'tool_use') {
                        toolAcc.set(event.index, { id: block.id, name: block.name, input: '' });
                    }
                } else if (event.type === 'content_block_delta') {
                    const delta = event.delta;
                    if (delta.type === 'text_delta') {
                        text += delta.text;
                    } else if (delta.type === 'input_json_delta') {
                        const slot = toolAcc.get(event.index);
                        if (slot) slot.input += delta.partial_json;
                    }
                }
            }

            const toolCalls = [...toolAcc.values()]
                .filter((t) => t.name)
                .map((t): AiToolCall => ({ id: t.id, name: t.name, arguments: t.input }));
            const usage = this.toUsage(
                { input_tokens: inputTokens, output_tokens: outputTokens },
                args.messages,
                text,
            );
            return { text, toolCalls, usage };
        }

        const response = await this.client.messages.create(base, reqOpts);
        let text = '';
        const toolCalls: AiToolCall[] = [];
        for (const block of response.content) {
            if (block.type === 'text') {
                text += block.text;
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                });
            }
        }
        const usage = this.toUsage(response.usage, args.messages, text);
        return { text, toolCalls, usage };
    }
}
