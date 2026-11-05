/**
 * AI cost estimation (feat/ai-guardrails).
 *
 * Maps a model id + token usage to an estimated cost in USD
 * micro-dollars (integer — 1_000_000 micros = $1). Used by the budget
 * ledger (`AiUsageEvent.costMicros`) and the per-completion cost metric.
 *
 * IMPORTANT — the prices below are OPERATOR-TUNABLE ESTIMATES, not a
 * billing source of truth. They are list prices per 1,000,000 tokens at
 * the time of writing and WILL drift; an operator running a different
 * model mix should adjust `MODEL_PRICES`. Cost here exists for budgeting,
 * abuse-detection and observability — not invoicing. An unknown model
 * resolves to 0 (free) with a logged warning so a new/un-priced model is
 * loud but never blocks a completion.
 *
 * Local backends (ollama) cost nothing — the operator pays for the box,
 * not per token — so their models price at 0.
 */
import { logger } from '@/lib/observability/logger';
import type { AiUsage } from './provider/types';

/** Per-1M-token list prices (USD) for a model. */
interface ModelPrice {
    /** USD per 1,000,000 input (prompt) tokens, at the FULL rate. */
    inputPerMillion: number;
    /** USD per 1,000,000 output (completion) tokens. */
    outputPerMillion: number;
    /**
     * Multiplier on `inputPerMillion` for a token served FROM the cache.
     *
     * Per MODEL rather than one constant, because the vendors do not agree:
     * Anthropic discounts a cache read to 0.1x, OpenAI-compatible hosts to
     * 0.5x, and a self-hosted model charges nothing for anything. A single
     * global multiplier would be wrong for whichever vendor it was not taken
     * from — the `a-shared-field-cannot-name-its-source` shape, one level up
     * from the token counts themselves.
     *
     * Omitted means "this model has no cache discount we have priced", and
     * then a cache read is charged at the FULL rate — deliberately the
     * conservative direction, since over-counting a budget refuses a question
     * and under-counting lets a ceiling be passed silently (#2666).
     */
    cacheReadMultiplier?: number;
    /**
     * Multiplier on `inputPerMillion` for a token WRITTEN to the cache.
     *
     * Anthropic charges 1.25x for a write. The OpenAI-compatible hosts have no
     * such concept, which is why their provider leaves `cacheWriteTokens`
     * UNDEFINED rather than 0 — so a missing multiplier here never costs them
     * anything, because there is no figure to multiply.
     */
    cacheWriteMultiplier?: number;
}

/**
 * Operator-tunable price table. Keys are matched case-insensitively and
 * by prefix (so `claude-opus-4-8`, `anthropic/claude-opus-4-8` and any
 * dated variant resolve to the same Opus price). Covers the models the
 * routing policy (`./routing.ts`) actually targets.
 *
 *   Claude Opus / Sonnet / Haiku — Anthropic list prices.
 *   Groq llama — Groq list price (cheap/fast tier).
 *   Ollama / local — 0 (self-hosted, no per-token cost).
 */
const MODEL_PRICES: Record<string, ModelPrice> = {
    // ── Anthropic Claude (native + OpenRouter-proxied) ──
    // Anthropic's published cache rates: a read is 0.1x input, a write 1.25x.
    'claude-opus': {
        inputPerMillion: 15,
        outputPerMillion: 75,
        cacheReadMultiplier: 0.1,
        cacheWriteMultiplier: 1.25,
    },
    'claude-sonnet': {
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheReadMultiplier: 0.1,
        cacheWriteMultiplier: 1.25,
    },
    'claude-haiku': {
        inputPerMillion: 1,
        outputPerMillion: 5,
        cacheReadMultiplier: 0.1,
        cacheWriteMultiplier: 1.25,
    },
    // ── Groq (cheap/fast bulk tier) ──
    //
    // No cache multiplier: these hosts report no `prompt_tokens_details` at
    // all (measured in `openai-compatible-provider`), so there is no cache
    // figure to price. If one starts reporting, add its vendor's rate HERE
    // rather than reaching for Anthropic's.
    'llama-3.3-70b': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
    'llama-3.1-8b': { inputPerMillion: 0.05, outputPerMillion: 0.08 },
    // ── Embedding models (priced low; mostly local) ──
    'nomic-embed-text': { inputPerMillion: 0, outputPerMillion: 0 },
};

/**
 * Resolve the price entry for a model id. Normalises provider prefixes
 * (`anthropic/…`) and matches the longest table key that is a substring
 * of the (lower-cased) model id, so dated/region variants share a price.
 * Returns null when nothing matches.
 */
function lookupPrice(model: string): ModelPrice | null {
    const id = model.toLowerCase();
    // Local backends never cost anything.
    if (id.startsWith('ollama') || id.includes(':')) {
        // `qwen3:1.7b` and other Ollama-tagged ids are local → free.
        // (Hosted ids don't carry a `:` tag.)
        return { inputPerMillion: 0, outputPerMillion: 0 };
    }
    let best: ModelPrice | null = null;
    let bestLen = 0;
    for (const [key, price] of Object.entries(MODEL_PRICES)) {
        if (id.includes(key) && key.length > bestLen) {
            best = price;
            bestLen = key.length;
        }
    }
    return best;
}

/**
 * Estimate the cost of a completion in USD micro-dollars (integer).
 *
 * micros = round( promptTokens      * inputPerMillion
 *                + cacheReadTokens  * inputPerMillion * cacheReadMultiplier
 *                + cacheWriteTokens * inputPerMillion * cacheWriteMultiplier
 *                + completionTokens * outputPerMillion )
 *
 * The two cache terms were absent until #2669, so a cached token was charged
 * at zero rather than at its vendor's discounted rate.
 *
 * Unknown model → 0 + a logged warning (loud but non-blocking).
 */
export function estimateCostMicros(model: string, usage: AiUsage): number {
    const price = lookupPrice(model);
    if (!price) {
        logger.warn('ai cost: no price entry for model, charging 0', {
            component: 'ai',
            model,
        });
        return 0;
    }
    /*
     * THREE input rates, not one (#2669).
     *
     * `promptTokens` is the FULL-rate portion on both providers — the two
     * conventions were normalised at the mapping, so Anthropic's
     * `input_tokens` (which excludes its cache fields) and OpenAI's
     * `prompt_tokens` (which includes them) both arrive meaning the same
     * thing. Pricing can therefore add the cache classes rather than having
     * to ask which vendor the row came from.
     *
     * Before this, cached tokens were charged at ZERO: they are not in
     * `promptTokens` and nothing else looked at them. Verified against real
     * rows — 372 prompt / 163 completion recorded 3,561 µ$, and
     * `372x3 + 163x15 = 3,561` exactly, which is the uncached arithmetic.
     *
     * The error direction was UNDER-counting, which is the one that matters
     * here: `assertAiBudget` sums these rows against
     * `PLAN_LIMITS[plan].ai_tokens`, so a monthly ceiling would have been
     * enforced against a figure omitting most of the prompt — and #2666 made
     * that ceiling the only bound in self-hosted mode.
     *
     * `?? 0` on the token counts and `?? 1` on the multipliers are different
     * defaults on purpose. An ABSENT token count means no such measurement,
     * which costs nothing. An absent MULTIPLIER means we have not priced that
     * vendor's discount, so the token is charged at full rate — conservative,
     * because over-counting refuses a question while under-counting lets a
     * ceiling be passed silently.
     */
    const micros =
        usage.promptTokens * price.inputPerMillion +
        (usage.cacheReadTokens ?? 0) *
            price.inputPerMillion *
            (price.cacheReadMultiplier ?? 1) +
        (usage.cacheWriteTokens ?? 0) *
            price.inputPerMillion *
            (price.cacheWriteMultiplier ?? 1) +
        usage.completionTokens * price.outputPerMillion;
    return Math.round(micros);
}
