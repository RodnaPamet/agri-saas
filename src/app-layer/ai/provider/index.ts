/**
 * Swappable AI provider — factory.
 *
 * `getAiProvider()` reads the AI_* env contract (via src/env.ts — never
 * raw process.env) and returns ONE provider configured for the chosen
 * COMPLETION backend. Local dev defaults to Ollama (qwen3:1.7b at
 * http://localhost:11434/v1, key 'ollama') so it runs with zero config
 * at zero API cost; prod swaps the backend purely by setting AI_BASE_URL
 * / AI_API_KEY / AI_MODEL (+ optional AI_BACKEND, including 'claude' for
 * the native Anthropic Messages API).
 *
 * Backend inference: when AI_BACKEND is the default 'ollama' but the base
 * URL points elsewhere (openrouter.ai / groq / together), the backend is
 * inferred from the host so the capability map matches the real backend.
 *
 * `getEmbeddingProvider()` (below) is a SEPARATE seam for RAG
 * ingestion/retrieval — Anthropic has no embeddings endpoint, so the
 * embedding role must resolve independently of AI_BACKEND, otherwise
 * `AI_BACKEND=claude` would silently disable embeddings. See its doc
 * comment + the AI_EMBED_* vars in src/env.ts.
 */
import { env } from '@/env';
import { OpenAiCompatibleProvider, AiProviderError } from './openai-compatible-provider';
import { ClaudeProvider } from './claude-provider';
import type { AiBackend, AiProvider } from './types';

/** Infer the backend from a base-URL host when not set explicitly. */
export function inferBackend(baseURL: string): AiBackend {
    let host: string;
    try {
        host = new URL(baseURL).hostname.toLowerCase();
    } catch {
        return 'openai-compatible';
    }
    // Exact host OR a subdomain of it — NOT a substring match (a substring
    // check would treat e.g. `evilgroq.com` / `groq.com.attacker.net` as Groq;
    // CodeQL's js/incomplete-url-substring-sanitization flags that).
    const isHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (isHost('openrouter.ai')) return 'openrouter';
    if (isHost('groq.com')) return 'groq';
    if (isHost('together.ai') || isHost('together.xyz')) return 'together';
    if (host === 'localhost' || host === '127.0.0.1' || isHost('ollama')) return 'ollama';
    return 'openai-compatible';
}

/**
 * Resolve the configured backend. An explicitly-set AI_BACKEND (anything
 * other than the schema default 'ollama') wins; otherwise infer from the
 * base URL so a hosted base URL with the default backend still maps right.
 */
function resolveBackend(): AiBackend {
    const explicit = env.AI_BACKEND;
    const inferred = inferBackend(env.AI_BASE_URL);
    // 'ollama' is the schema default — treat it as "unset" so a hosted
    // AI_BASE_URL is honoured. Any other explicit value is respected.
    if (explicit !== 'ollama') {
        // 'openai-compatible' is a deliberate generic choice — prefer a
        // sharper inference when the host is recognisable.
        if (explicit === 'openai-compatible' && inferred !== 'openai-compatible') return inferred;
        return explicit;
    }
    return inferred;
}

/**
 * Build the configured provider from env. When `AI_BACKEND='claude'`
 * the native `ClaudeProvider` (Anthropic Messages API) is returned,
 * authenticated with `ANTHROPIC_API_KEY`; every other backend resolves
 * to the single `OpenAiCompatibleProvider`.
 *
 * NOTE: this is the COMPLETION provider. Anthropic exposes no
 * embeddings endpoint, so `ClaudeProvider.embed()` always throws — RAG
 * ingestion (`embed-chunks` job) and retrieval (`rag/retrieve.ts`) MUST
 * call `getEmbeddingProvider()` below instead, never this function, so
 * choosing Claude for completions can never disable embeddings.
 */
export function getAiProvider(): AiProvider {
    if (env.AI_BACKEND === 'claude') {
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new AiProviderError(
                'claude',
                'AI_BACKEND=claude requires ANTHROPIC_API_KEY to be set.',
            );
        }
        return new ClaudeProvider({
            apiKey,
            model: env.AI_MODEL,
            baseURL: env.ANTHROPIC_BASE_URL,
        });
    }

    return new OpenAiCompatibleProvider({
        backend: resolveBackend(),
        baseURL: env.AI_BASE_URL,
        apiKey: env.AI_API_KEY,
        model: env.AI_MODEL,
        embedModel: env.AI_EMBED_MODEL,
    });
}

/**
 * Resolve the configured EMBEDDING backend — same "explicit wins,
 * otherwise infer from the host" rule as `resolveBackend()`, but over
 * the embed-specific base URL and NEVER over `AI_BACKEND`/`AI_BASE_URL`
 * (that would re-couple the two roles this split exists to separate).
 */
function resolveEmbedBackend(baseURL: string): AiBackend {
    const explicit = env.AI_EMBED_BACKEND;
    if (!explicit) return inferBackend(baseURL);
    const inferred = inferBackend(baseURL);
    if (explicit === 'openai-compatible' && inferred !== 'openai-compatible') return inferred;
    return explicit;
}

/**
 * Build the EMBEDDING provider from env — resolved INDEPENDENTLY of
 * `AI_BACKEND` / `getAiProvider()`. Anthropic has no embeddings
 * endpoint, so if this reused the completion provider, setting
 * `AI_BACKEND=claude` for better completions would silently disable
 * RAG retrieval — the exact bug this seam exists to prevent.
 *
 * Always returns an `OpenAiCompatibleProvider`; there is no "claude"
 * branch here. `AI_EMBED_BACKEND` / `AI_EMBED_BASE_URL` /
 * `AI_EMBED_API_KEY` let an operator point embeddings at a dedicated
 * hosted, OpenAI-compatible embedding API (Option B — see
 * deploy/env.prod.example); left unset, each falls back to the
 * completion path's equivalent (`AI_BASE_URL` / `AI_API_KEY`), so
 * local dev's Ollama-serves-both default keeps working unmodified.
 */
export function getEmbeddingProvider(): AiProvider {
    const baseURL = env.AI_EMBED_BASE_URL ?? env.AI_BASE_URL;
    return new OpenAiCompatibleProvider({
        backend: resolveEmbedBackend(baseURL),
        baseURL,
        apiKey: env.AI_EMBED_API_KEY ?? env.AI_API_KEY,
        model: env.AI_MODEL,
        embedModel: env.AI_EMBED_MODEL,
    });
}

export { OpenAiCompatibleProvider, CAPABILITIES, AiProviderError } from './openai-compatible-provider';
export { ClaudeProvider, DEFAULT_CLAUDE_MODEL } from './claude-provider';
export type {
    AiBackend,
    AiCapabilities,
    AiProvider,
    AiMessage,
    AiRole,
    AiToolDef,
    AiToolCall,
    AiCompleteOptions,
    AiCompletion,
    AiEmbedOptions,
    AiEmbedding,
    AiHealth,
    OpenAiCompatibleConfig,
} from './types';
