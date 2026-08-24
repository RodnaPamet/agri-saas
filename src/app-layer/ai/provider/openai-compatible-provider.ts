/**
 * Swappable AI provider — the single OpenAI-compatible implementation.
 *
 * Backed by the `openai` SDK pointed at any OpenAI-compatible base URL.
 * The SAME class serves Ollama (local dev, zero cost), OpenRouter, Groq
 * and Together — they differ only by `{ baseURL, apiKey, model, backend }`
 * plus a per-backend capability map (CAPABILITIES below). Prod swaps the
 * backend purely by changing env (see src/env.ts + ./index.ts).
 *
 * Structured output:
 *   - When `schema` is given AND the backend advertises json_schema
 *     support → `response_format: { type: 'json_schema', … strict }`.
 *   - Validate / repair fallback: if json_schema is unsupported, or the
 *     first response fails Zod validation, fall back to
 *     `response_format: { type: 'json_object' }` with the JSON schema
 *     injected into the system prompt, then re-validate. One repair
 *     re-prompt is attempted; a typed AiProviderError surfaces if the
 *     output is still invalid.
 *
 * Tools + streaming are passed through to the SDK and surfaced on the
 * returned AiCompletion.
 */
import OpenAI from 'openai';
import { z, type ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { logger } from '@/lib/observability/logger';
import { estimateTokens, estimateMessageTokens } from '../token-estimate';
import type {
    AiBackend,
    AiCapabilities,
    AiCompleteOptions,
    AiCompletion,
    AiEmbedding,
    AiEmbedOptions,
    AiHealth,
    AiMessage,
    AiProvider,
    AiToolCall,
    AiUsage,
    OpenAiCompatibleConfig,
} from './types';

/**
 * Default embedding model — nomic-embed-text (768 dims, the
 * `KnowledgeChunk.embedding vector(768)` column width). Ollama serves
 * it locally; hosted backends expose a same-named model. The configured
 * `AI_EMBED_MODEL` (env, default 'nomic-embed-text') overrides it.
 */
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

/**
 * Per-backend capability map. Drives the structured-output path and is
 * conservative on purpose — when a backend MIGHT not honour a feature on
 * a small/older model, we set the flag false so the safe json_object +
 * validate path runs instead of failing the request.
 *
 *   ollama  — jsonSchema FALSE on purpose. Ollama's OpenAI endpoint does
 *             support a `format`-based JSON schema on recent versions, but
 *             the target dev model (qwen3:1.7b) is small and the support is
 *             version-dependent; forcing the json_object + system-prompt
 *             schema + Zod-validate path makes structured output work
 *             reliably on the 1.7b model. tools/streaming TRUE (Ollama's
 *             OpenAI-compatible endpoint streams and calls tools on
 *             tool-capable models).
 *   openrouter — jsonSchema TRUE: OpenRouter forwards json_schema to
 *             schema-capable upstreams (OpenAI/Anthropic/etc.). On a model
 *             that rejects it the runtime fallback still recovers.
 *   groq    — jsonSchema TRUE (Groq supports structured outputs).
 *   together — jsonSchema TRUE (Together supports JSON-schema mode).
 *   openai-compatible — generic catch-all: conservative FALSE so an
 *             unknown host always gets the universally-supported
 *             json_object path.
 */
//   embeddings — ollama + openrouter expose an OpenAI-compatible
//             `/embeddings` endpoint (Ollama serves nomic-embed-text
//             locally; OpenRouter proxies embedding models). groq +
//             together do NOT serve embeddings via this surface, and the
//             generic catch-all stays conservative FALSE — callers that
//             need embeddings on those backends configure a dedicated
//             embedding host. `embed()` throws if the flag is false so
//             the failure is loud, not a silent empty vector.
export const CAPABILITIES: Record<AiBackend, AiCapabilities> = {
    ollama: { jsonSchema: false, tools: true, streaming: true, embeddings: true },
    openrouter: { jsonSchema: true, tools: true, streaming: true, embeddings: true },
    groq: { jsonSchema: true, tools: true, streaming: true, embeddings: false },
    together: { jsonSchema: true, tools: true, streaming: true, embeddings: false },
    'openai-compatible': { jsonSchema: false, tools: true, streaming: true, embeddings: false },
    // claude — served by ClaudeProvider (native Anthropic Messages API),
    // NOT this OpenAI-compat class. The entry exists only to satisfy the
    // exhaustive `Record<AiBackend, …>` type; ClaudeProvider does not
    // consult this map (structured output is via forced tool-use, not
    // an OpenAI `response_format`). jsonSchema is therefore false here:
    // the OpenAI json_schema path is N/A. tools + streaming are native.
    // embeddings false — Anthropic has no embeddings endpoint.
    claude: { jsonSchema: false, tools: true, streaming: true, embeddings: false },
};

/** Typed error for unrecoverable provider failures. */
export class AiProviderError extends Error {
    readonly backend: AiBackend;
    constructor(backend: AiBackend, message: string) {
        super(message);
        this.name = 'AiProviderError';
        this.backend = backend;
    }
}

/**
 * Convert a Zod schema to a JSON Schema object.
 *
 * This codebase is on Zod 4, whose native `z.toJSONSchema()` is the
 * accurate converter. The widely-used `zod-to-json-schema` package is
 * installed and used as the explicit Zod-3-style fallback (its output
 * is non-empty only on a Zod-3 schema), so the conversion path is robust
 * across either Zod major.
 */
function toJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
    try {
        const native = z.toJSONSchema(schema) as Record<string, unknown>;
        if (native && Object.keys(native).some((k) => k !== '$schema')) return native;
    } catch {
        // Fall through to the package-based converter below.
    }
    // `zod-to-json-schema` is typed against Zod 3; this codebase is Zod 4,
    // so reach the function through a minimal `unknown`-accepting signature
    // rather than its Zod-3 `ZodType` parameter (no `any` involved).
    const convert = zodToJsonSchema as unknown as (s: unknown, opts: { target: string }) => Record<string, unknown>;
    return convert(schema, { target: 'jsonSchema7' });
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type ResponseFormat = OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'];

export class OpenAiCompatibleProvider implements AiProvider {
    readonly backend: AiBackend;
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly embedModel: string;
    private readonly baseURL: string;
    private readonly capabilities: AiCapabilities;

    constructor(config: OpenAiCompatibleConfig) {
        this.backend = config.backend;
        this.model = config.model;
        this.embedModel = config.embedModel ?? DEFAULT_EMBED_MODEL;
        this.baseURL = config.baseURL;
        this.capabilities = CAPABILITIES[config.backend];
        this.client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
    }

    async complete<T = unknown>(opts: AiCompleteOptions<T>): Promise<AiCompletion<T>> {
        const model = opts.model ?? this.model;
        const tools = this.buildTools(opts);

        // ── Structured-output branch ──
        if (opts.schema) {
            return this.completeStructured(opts, model, tools);
        }

        // ── Plain / tool / streaming branch ──
        const { text, toolCalls, usage } = await this.runChat({
            model,
            messages: this.toChatMessages(opts.messages),
            tools,
            stream: opts.stream === true && this.capabilities.streaming,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            signal: opts.signal,
        });

        const result: AiCompletion<T> = { text, usage };
        if (toolCalls.length > 0) result.toolCalls = toolCalls;
        return result;
    }

    /**
     * Map OpenAI usage (prompt_tokens / completion_tokens) to AiUsage,
     * falling back to a char/4 estimate (flagged `estimated`) when the
     * host omitted the usage object.
     */
    private toUsage(
        sdkUsage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined,
        promptMessages: ChatMessage[],
        completionText: string,
    ): AiUsage {
        const input = sdkUsage?.prompt_tokens;
        const output = sdkUsage?.completion_tokens;
        if (typeof input === 'number' && typeof output === 'number') {
            return { promptTokens: input, completionTokens: output, totalTokens: input + output };
        }
        const flat: AiMessage[] = promptMessages.map((m): AiMessage => ({
            role: 'user',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        }));
        const promptTokens = estimateMessageTokens(flat);
        const completionTokens = estimateTokens(completionText);
        return {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            estimated: true,
        };
    }

    private async completeStructured<T>(
        opts: AiCompleteOptions<T>,
        model: string,
        tools: ChatTool[] | undefined,
    ): Promise<AiCompletion<T>> {
        const schema = opts.schema;
        if (!schema) throw new AiProviderError(this.backend, 'completeStructured called without a schema');

        const jsonSchema = toJsonSchema(schema);
        const schemaName = opts.schemaName ?? 'response';

        // 1. Preferred path — native json_schema when the backend supports it.
        if (this.capabilities.jsonSchema) {
            const responseFormat: ResponseFormat = {
                type: 'json_schema',
                json_schema: { name: schemaName, schema: jsonSchema, strict: true },
            };
            try {
                const { text, usage } = await this.runChat({
                    model,
                    messages: this.toChatMessages(opts.messages),
                    tools,
                    responseFormat,
                    stream: false,
                    temperature: opts.temperature,
                    maxTokens: opts.maxTokens,
                    signal: opts.signal,
                });
                const parsed = this.tryParse(schema, text);
                if (parsed.ok) return { text, parsed: parsed.value, usage };
                logger.warn('ai json_schema response failed validation, falling back to json_object', {
                    component: 'ai',
                    backend: this.backend,
                });
            } catch (err) {
                // Backend rejected json_schema (e.g. unsupported by the model).
                logger.warn('ai json_schema request rejected, falling back to json_object', {
                    component: 'ai',
                    backend: this.backend,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // 2. Fallback path — json_object + schema in the system prompt,
        //    with ONE repair re-prompt on a validation miss.
        return this.completeJsonObject(opts, model, tools, jsonSchema, schemaName);
    }

    private async completeJsonObject<T>(
        opts: AiCompleteOptions<T>,
        model: string,
        tools: ChatTool[] | undefined,
        jsonSchema: Record<string, unknown>,
        schemaName: string,
    ): Promise<AiCompletion<T>> {
        const schema = opts.schema;
        if (!schema) throw new AiProviderError(this.backend, 'completeJsonObject called without a schema');

        const schemaInstruction =
            `You MUST respond with ONLY a single JSON object — no markdown, no commentary — ` +
            `that conforms to this JSON Schema named "${schemaName}":\n` +
            `${JSON.stringify(jsonSchema)}`;
        const baseMessages = this.injectSystemInstruction(opts.messages, schemaInstruction);
        const responseFormat: ResponseFormat = { type: 'json_object' };

        // First attempt.
        const first = await this.runChat({
            model,
            messages: this.toChatMessages(baseMessages),
            tools,
            responseFormat,
            stream: false,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            signal: opts.signal,
        });
        const firstParse = this.tryParse(schema, first.text);
        if (firstParse.ok) return { text: first.text, parsed: firstParse.value, usage: first.usage };

        // One repair re-prompt — feed back the invalid output + the error.
        const repairMessages: AiMessage[] = [
            ...baseMessages,
            { role: 'assistant', content: first.text },
            {
                role: 'user',
                content:
                    `That response was not valid against the schema (${firstParse.error}). ` +
                    `Reply again with ONLY the corrected JSON object.`,
            },
        ];
        const repaired = await this.runChat({
            model,
            messages: this.toChatMessages(repairMessages),
            tools,
            responseFormat,
            stream: false,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            signal: opts.signal,
        });
        const repairedParse = this.tryParse(schema, repaired.text);
        if (repairedParse.ok) return { text: repaired.text, parsed: repairedParse.value, usage: repaired.usage };

        throw new AiProviderError(
            this.backend,
            `Structured output failed validation after repair attempt: ${repairedParse.error}`,
        );
    }

    async embed(opts: AiEmbedOptions): Promise<AiEmbedding[]> {
        if (!this.capabilities.embeddings) {
            throw new AiProviderError(
                this.backend,
                `Backend "${this.backend}" does not expose an embeddings endpoint. ` +
                    `Configure an embedding-capable backend (ollama / openrouter) ` +
                    `for the RAG ingestion + retrieval paths.`,
            );
        }
        if (opts.texts.length === 0) return [];

        const model = opts.model ?? this.embedModel;
        const response = await this.client.embeddings.create({
            model,
            input: opts.texts,
            // NAME THE WIRE FORMAT. Omit this and the SDK silently sends
            // `encoding_format: "base64"` and base64-decodes the reply — a
            // backend that answers with plain float arrays (which
            // OpenAI-COMPATIBLE hosts are free to do, and this provider exists
            // to talk to them) decodes to an EMPTY vector with no error
            // raised. The count check below would still pass, because the
            // count is right: one empty vector per input. Measured in
            // tests/integration/openai-real-api.test.ts.
            encoding_format: 'float',
        });
        // The OpenAI embeddings API returns one datum per input, carrying
        // an `index` — sort by it so the vectors line up with the inputs
        // regardless of server ordering.
        const sorted = [...response.data].sort((a, b) => a.index - b.index);
        if (sorted.length !== opts.texts.length) {
            throw new AiProviderError(
                this.backend,
                `Embedding count mismatch: requested ${opts.texts.length}, ` +
                    `received ${sorted.length}.`,
            );
        }
        return sorted.map((datum, i): AiEmbedding => {
            const vector = datum.embedding as number[];
            // Defence in depth behind the explicit format above. `embedding`
            // is cast, not checked, so an empty array satisfies both the
            // compiler and the count guard — and an empty vector is not a
            // degraded embedding, it is a silently useless one that would be
            // stored and searched as though it meant something.
            if (!Array.isArray(vector) || vector.length === 0) {
                throw new AiProviderError(
                    this.backend,
                    `Embedding ${i} came back empty — the backend may have ignored ` +
                        `the requested encoding_format.`,
                );
            }
            return { text: opts.texts[i], vector };
        });
    }

    async health(): Promise<AiHealth> {
        try {
            // GET ${baseURL}/models — OpenAI-compatible model listing.
            const list = await this.client.models.list();
            const ids: string[] = [];
            for await (const m of list) {
                if (typeof m.id === 'string') ids.push(m.id);
            }
            const modelAvailable = ids.some((id) => id === this.model || id.startsWith(`${this.model}:`));
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

    private buildTools(opts: AiCompleteOptions<unknown>): ChatTool[] | undefined {
        if (!opts.tools || opts.tools.length === 0) return undefined;
        if (!this.capabilities.tools) return undefined;
        return opts.tools.map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));
    }

    private toChatMessages(messages: AiMessage[]): ChatMessage[] {
        return messages.map((m): ChatMessage => {
            if (m.role === 'tool') {
                return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' };
            }
            if (m.role === 'system') return { role: 'system', content: m.content };
            if (m.role === 'assistant') return { role: 'assistant', content: m.content };
            return { role: 'user', content: m.content };
        });
    }

    private injectSystemInstruction(messages: AiMessage[], instruction: string): AiMessage[] {
        const idx = messages.findIndex((m) => m.role === 'system');
        if (idx >= 0) {
            const next = [...messages];
            next[idx] = { ...next[idx], content: `${next[idx].content}\n\n${instruction}` };
            return next;
        }
        return [{ role: 'system', content: instruction }, ...messages];
    }

    private tryParse<T>(
        schema: NonNullable<AiCompleteOptions<T>['schema']>,
        text: string,
    ): { ok: true; value: T } | { ok: false; error: string } {
        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch {
            return { ok: false, error: 'response was not valid JSON' };
        }
        const result = schema.safeParse(json);
        if (result.success) return { ok: true, value: result.data };
        return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }

    /**
     * Single seam over the SDK's chat-completions call. Handles streaming
     * (assembles text + tool-call deltas) and non-streaming uniformly,
     * returning `{ text, toolCalls }`.
     */
    private async runChat(args: {
        model: string;
        messages: ChatMessage[];
        tools?: ChatTool[];
        responseFormat?: ResponseFormat;
        stream: boolean;
        temperature?: number;
        maxTokens?: number;
        signal?: AbortSignal;
    }): Promise<{ text: string; toolCalls: AiToolCall[]; usage: AiUsage }> {
        const reqOpts = args.signal ? { signal: args.signal } : undefined;
        const base = {
            model: args.model,
            messages: args.messages,
            ...(args.tools ? { tools: args.tools } : {}),
            ...(args.responseFormat ? { response_format: args.responseFormat } : {}),
            ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
            ...(args.maxTokens !== undefined ? { max_tokens: args.maxTokens } : {}),
        };

        if (args.stream) {
            // `stream_options.include_usage` asks the server to emit a final
            // usage-only chunk; hosts that ignore it just fall through to the
            // char/4 estimate in `toUsage`.
            const stream = await this.client.chat.completions.create(
                { ...base, stream: true, stream_options: { include_usage: true } },
                reqOpts,
            );
            let text = '';
            const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
            let promptTokens: number | undefined;
            let completionTokens: number | undefined;
            for await (const chunk of stream) {
                if (chunk.usage) {
                    promptTokens = chunk.usage.prompt_tokens;
                    completionTokens = chunk.usage.completion_tokens;
                }
                const delta = chunk.choices[0]?.delta;
                if (delta?.content) text += delta.content;
                for (const tc of delta?.tool_calls ?? []) {
                    const slot = toolAcc.get(tc.index) ?? { id: '', name: '', arguments: '' };
                    if (tc.id) slot.id = tc.id;
                    if (tc.function?.name) slot.name = tc.function.name;
                    if (tc.function?.arguments) slot.arguments += tc.function.arguments;
                    toolAcc.set(tc.index, slot);
                }
            }
            const toolCalls = [...toolAcc.values()]
                .filter((t) => t.name)
                .map((t): AiToolCall => ({ id: t.id, name: t.name, arguments: t.arguments }));
            const usage = this.toUsage(
                { prompt_tokens: promptTokens, completion_tokens: completionTokens },
                args.messages,
                text,
            );
            return { text, toolCalls, usage };
        }

        const completion = await this.client.chat.completions.create({ ...base, stream: false }, reqOpts);
        const message = completion.choices[0]?.message;
        const text = message?.content ?? '';
        const toolCalls: AiToolCall[] = (message?.tool_calls ?? [])
            .filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
                tc.type === 'function')
            .map((tc): AiToolCall => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
            }));
        const usage = this.toUsage(completion.usage, args.messages, text);
        return { text, toolCalls, usage };
    }
}
