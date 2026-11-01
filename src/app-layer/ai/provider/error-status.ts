/**
 * The HTTP status an SDK error carries, read in ONE place — #2655.
 *
 * Both the Anthropic SDK and the OpenAI-compatible client throw errors with a
 * numeric `status`, and that error reaches the caller UNWRAPPED: nothing in
 * `claude-provider.ts` or `openai-compatible-provider.ts` catches an SDK
 * failure to re-throw it as `AiProviderError`, which is why `isTransient` in
 * `routing.ts` could already read `(err as { status?: number }).status`.
 *
 * #2655 proposed adding `status?: number` to `AiProviderError` and populating
 * it in each provider. That turned out to be unnecessary — the field was
 * already arriving — and the measurement is worth keeping, because the issue
 * was wrong in the expensive direction: it described a contract change across
 * three provider classes for a value that was already there.
 *
 * It lives here rather than inline at two call sites because the two
 * questions — "should this be retried" and "what do we tell the farmer" — are
 * different decisions over the SAME reading, and two spellings of a reading is
 * how two answers diverge.
 */

import { isAppError } from '@/lib/errors/types';

/** The numeric HTTP status an SDK error carries, or undefined for anything else. */
export function httpStatusOf(err: unknown): number | undefined {
    if (!(err instanceof Error)) return undefined;
    const status = (err as { status?: number }).status;
    return typeof status === 'number' ? status : undefined;
}

/**
 * The PROVIDER was reached and REFUSED us — as distinct from our own code
 * refusing, or the provider being unreachable.
 *
 * ## `AppError` is excluded, and that exclusion is the load-bearing half
 *
 * `AppError` declares `public readonly status: number`, so EVERY coded failure
 * this codebase raises carries a 4xx — `assertAiBudget`'s
 * `AI_BUDGET_EXCEEDED`, a tool's policy refusal, a bad-request from a
 * usecase. A status read alone therefore cannot tell "the model refused" from
 * "our own policy refused", and reporting the second as the first would just
 * MOVE the defect #2655 is about: the farmer would be told the model rejected
 * their question when the truth is that their role is not allowed to read
 * something.
 *
 * #2655 proposed `status?: number` on `AiProviderError`, populated per
 * provider. I first judged that unnecessary, having found that SDK errors
 * arrive unwrapped with `status` already set — true, and not sufficient, which
 * is why the exclusion below exists rather than a bare range check. A typed
 * carrier would make this a positive identification instead of an exclusion,
 * and is the better end state; it is a contract change across three provider
 * classes and is not needed to fix the misreport.
 *
 * ## Why 429 is not a rejection
 *
 * It is the one 4xx that does NOT mean "your request was wrong": it is
 * transient, `isTransient` retries it, and when the retries run out the useful
 * thing to tell a farmer is "try again" — which is what the unavailable copy
 * already says. Treating 4xx as a class would sweep it in and tell a
 * rate-limited farmer they had sent something invalid.
 *
 * A 5xx is the provider FAILING rather than refusing, so it stays unavailable.
 */
export function isProviderRejection(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (isAppError(err)) return false;
    const status = httpStatusOf(err);
    return status !== undefined && status >= 400 && status < 500 && status !== 429;
}
