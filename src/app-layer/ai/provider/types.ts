/**
 * Swappable AI provider — types.
 *
 * A thin, backend-agnostic completion surface. ONE implementation
 * (OpenAiCompatibleProvider) is backed by the `openai` SDK and serves
 * Ollama (local dev) / OpenRouter / Groq / Together — they differ only
 * by base URL + key + model (+ a capability map). The interface stays
 * minimal and fully typed: no `any`, structured output via Zod
 * generics, tool calls + streaming as opt-in options.
 */
import type { ZodType } from 'zod';

// ─── Backends ───

/**
 * The backends an `AiProvider` instance can be configured for.
 *
 * The first five are OpenAI-compatible (served by `OpenAiCompatibleProvider`);
 * `openai-compatible` is a generic catch-all for any other host speaking
 * the same shape. `claude` is the native Anthropic Messages-API backend,
 * served by `ClaudeProvider` (NOT the OpenAI-compat shim).
 */
export type AiBackend = 'ollama' | 'openrouter' | 'groq' | 'together' | 'openai-compatible' | 'claude';

/** What a given backend can do. Drives the structured-output path. */
export interface AiCapabilities {
    /** Backend honours `response_format: { type: 'json_schema' }`. */
    jsonSchema: boolean;
    /** Backend supports OpenAI function/tool calling. */
    tools: boolean;
    /** Backend supports streamed chat completions. */
    streaming: boolean;
    /** Backend exposes an OpenAI-compatible `/embeddings` endpoint. */
    embeddings: boolean;
}

// ─── Messages ───

export type AiRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AiMessage {
    role: AiRole;
    content: string;
    /** Present on `tool` messages — the id of the tool call being answered. */
    toolCallId?: string;
    /** Optional name (tool name on a `tool` message). */
    name?: string;
}

// ─── Tools ───

export interface AiToolDef {
    /** Tool name the model calls. */
    name: string;
    /** Human/model-readable description of what the tool does. */
    description?: string;
    /** JSON-Schema object describing the tool's parameters. */
    parameters: Record<string, unknown>;
}

export interface AiToolCall {
    id: string;
    name: string;
    /** Raw JSON-string arguments emitted by the model. */
    arguments: string;
}

// ─── Completion request / response ───

export interface AiCompleteOptions<T = unknown> {
    messages: AiMessage[];
    /**
     * When set, structured output: the response is parsed as JSON and
     * validated against this Zod schema; `parsed` carries the typed value.
     */
    schema?: ZodType<T>;
    /** Name for the json_schema response format (defaults to 'response'). */
    schemaName?: string;
    /** Function/tool calling — passed through to the backend. */
    tools?: AiToolDef[];
    /** Opt into streaming — `complete()` returns once the stream drains. */
    stream?: boolean;
    /**
     * Sampling temperature (provider default when unset).
     *
     * **IGNORED by the Claude provider.** Anthropic API version `2026-10-21`
     * — which `@anthropic-ai/sdk` v1 pins in its `anthropic-version` header —
     * removed `temperature`, `top_p` and `top_k` from the Messages API
     * entirely; they are absent from the SDK's types, and there is no
     * replacement field to forward this to. `ClaudeProvider` therefore drops
     * it rather than sending a parameter the API would reject.
     *
     * It is still honoured by `OpenAiCompatibleProvider` and by the
     * OpenRouter call in `llm-client.ts`, which is why the option stays on
     * this shared type instead of being deleted.
     *
     * So a caller setting this gets different behaviour per provider. That is
     * stated here because the alternative — a field that looks universal and
     * silently does nothing on one backend — is the failure this comment
     * exists to prevent. See `tests/guards/anthropic-sampling-params-are-gone.test.ts`.
     */
    temperature?: number;
    /** Max completion tokens. */
    maxTokens?: number;
    /** Per-call model override (defaults to the configured model). */
    model?: string;
    /**
     * Optional abort signal. When provided, the provider threads it to
     * the underlying SDK request so an upstream completion / stream is
     * cancelled when the signal fires (client disconnect, routing
     * timeout). Provider-agnostic — honoured by both backends.
     */
    signal?: AbortSignal;

    // ── Guardrail hints (feat/ai-guardrails) ─────────────────────────
    // Consumed by `completeWithRouting`, ignored by the providers. All
    // optional — existing callers are unaffected.

    /**
     * Mark this request as handling sensitive content. Combined with PII
     * detection, it biases routing toward a LOCAL backend (ollama) when
     * one is configured — "prefer local for sensitive content".
     */
    sensitive?: boolean;
    /**
     * Extra exact spans (contract terms / identifiers) the caller knows
     * are sensitive — redacted before any EXTERNAL provider call.
     */
    sensitiveTerms?: string[];
    /**
     * Citations to fold into the immutable AI_COMPLETION audit entry.
     * Opaque to routing — passed straight through to the audit detailsJson.
     */
    citations?: unknown;
}

/**
 * Token usage for one completion. Drives the per-tenant token budget
 * ledger (`AiUsageEvent`) + the cost estimate. When the backend SDK did
 * NOT return usage, the provider fills these from a char/4 estimate and
 * sets `estimated:true` so downstream consumers know the numbers are
 * approximate.
 */
export interface AiUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** True when the counts are an estimate (SDK returned no usage). */
    estimated?: boolean;
}

export interface AiCompletion<T = unknown> {
    /** Full assistant text (assembled from stream chunks when streaming). */
    text: string;
    /** Present when `schema` was supplied and validation succeeded. */
    parsed?: T;
    /** Present when the model emitted tool calls. */
    toolCalls?: AiToolCall[];
    /**
     * Token usage for the call. Always populated by both providers —
     * actual when the SDK reports it, otherwise estimated (char/4) with
     * `usage.estimated === true`.
     */
    usage?: AiUsage;
}

/** Result of a non-throwing backend probe. */
export interface AiHealth {
    /** The probe itself succeeded (backend reachable + responded). */
    ok: boolean;
    /** The configured model id. */
    model: string;
    /** Configured model is present in the backend's model list. */
    modelAvailable: boolean;
    /** Optional human-readable detail (error summary on failure). */
    detail?: string;
}

// ─── Embeddings ───

export interface AiEmbedOptions {
    /** Texts to embed (one vector returned per input, order-preserved). */
    texts: string[];
    /** Per-call embedding-model override (defaults to the configured embed model). */
    model?: string;
}

/** One embedding result — the source text paired with its vector. */
export interface AiEmbedding {
    text: string;
    vector: number[];
}

// ─── Provider ───

export interface AiProvider {
    /** The backend this provider instance is configured for. */
    readonly backend: AiBackend;
    /** Structured / tool / streaming completion. */
    complete<T = unknown>(opts: AiCompleteOptions<T>): Promise<AiCompletion<T>>;
    /**
     * Embed one or more texts. Returns one `{ text, vector }` per input,
     * in the same order. Used by the RAG ingestion + retrieval paths.
     */
    embed(opts: AiEmbedOptions): Promise<AiEmbedding[]>;
    /** Non-throwing backend probe (model availability + reachability). */
    health(): Promise<AiHealth>;
}

/** Construction config for the OpenAI-compatible provider. */
export interface OpenAiCompatibleConfig {
    backend: AiBackend;
    baseURL: string;
    apiKey: string;
    model: string;
    /** Embedding model id (defaults handled by the factory via env). */
    embedModel?: string;
}
