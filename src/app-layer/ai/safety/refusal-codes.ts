/**
 * Why the assistant refused, and why it stopped early — #2578.
 *
 * ## Two kinds of ending, and they are not interchangeable
 *
 * A REFUSAL means no answer was produced and the reason is not a fault: no
 * grounding, out of scope, the question itself unreadable, the answer caught
 * on the way out. A HALT means the answer above IS real and INCOMPLETE — a
 * budget ran out, a provider failed, a list was too long to read whole.
 *
 * Collapsing them would be the `uniform-failure-shape-blinds-the-client`
 * defect: a person who is told "I cannot answer that" when the truth is "that
 * is as far as I got" retries, which spends again and teaches them the feature
 * is unreliable.
 *
 * ## The codes carry no copy, and that is #1677's ruling
 *
 * The owner ruled that the SERVER resolves the locale and sends `message`
 * already translated, "so neither client needs a code catalogue".
 * `localizeErrorPayload` looks up `errors.<CODE>` and REPLACES the message, so
 * an entried code reads in the caller's language on both clients.
 *
 * So these are wire identifiers for BRANCHING — whether to offer a retry,
 * whether to point at billing — and the sentence a person reads comes from
 * `errors.<CODE>` in `messages/{en,bg}/app.json`. Both halves are required:
 * `tests/guards/assistant-refusal-codes-are-entried.test.ts` fails if a code
 * here has no entry in either locale, because an unentried code falls through
 * to English and `src/lib/api-client.ts` prints `message` at 142 web call
 * sites with no language test.
 *
 * ## One catalogue serves both paths
 *
 * A refusal decided BEFORE the stream opens is an HTTP error and goes through
 * `coded*()`, where the existing `a-new-code-ships-with-its-entry` ratchet
 * already covers it. A refusal or halt decided MID-stream cannot be: the
 * response is already a 200 and the bytes have started, so it is an SSE event
 * and the sentence has to be resolved at emit time. Same `errors.<CODE>`
 * namespace either way — two mechanisms, one catalogue, so a code cannot mean
 * two things depending on when it fired.
 */

/** No answer was produced, and the reason is not a fault. */
export const REFUSAL_CODES = [
    /** Nothing retrieved from the farm's own records, so it will not guess. */
    'ASSISTANT_NO_GROUNDING',
    /** The question is not answerable from farm data at all. */
    'ASSISTANT_OUT_OF_SCOPE',
    /**
     * A dosage, mixing or regulatory question with no structured product data
     * behind it. `safety/advisor.ts` already refuses rather than phrasing
     * around a number it cannot source; this is that refusal's wire name.
     */
    'ASSISTANT_HIGH_STAKES_NEEDS_SOURCE',
    /**
     * The composed answer tripped the outbound secret scan (#2584). The answer
     * is DISCARDED, not redacted — a partially-redacted credential is still a
     * credential with a hint attached.
     */
    'ASSISTANT_EGRESS_BLOCKED',
    /** The question failed the untrusted-input guard. */
    'ASSISTANT_INPUT_REJECTED',
] as const;

/** The answer above is real and INCOMPLETE. */
export const HALT_CODES = [
    /** Reached the ceiling on tool calls for one question. */
    'ASSISTANT_TOOL_BUDGET',
    /** The tenant reached its monthly assistant spend ceiling. */
    'ASSISTANT_SPEND_CEILING',
    /** Wall-clock bound hit; stopped rather than leave someone waiting. */
    'ASSISTANT_TIME_BUDGET',
    /**
     * The model provider could not be reached. This is the case the SSE
     * contract deliberately does NOT give an `error` event to: it is a halt
     * whose notice says the records were not read and nothing was created.
     */
    'ASSISTANT_PROVIDER_UNAVAILABLE',
    /** A tool result was too large and was read in part. */
    'ASSISTANT_TRUNCATED_RESULT',
] as const;

/**
 * The one halt whose copy does NOT say "incomplete", and why.
 *
 * Every other halt is emitted after partial content, so "the answer above is
 * incomplete" is both true and the useful thing to say. A provider failure can
 * land BEFORE the first token, and then there is no answer for the word
 * incomplete to describe — telling someone their non-existent answer is
 * partial is worse than saying plainly that nothing was read.
 *
 * It stays a HALT rather than becoming a refusal because of what the SSE
 * contract deliberately lacks: there is no `error` event, precisely so every
 * terminal state carries an actionable reason. A refusal means "no answer, and
 * that is not a fault" — a provider outage is a fault, and a person told
 * "I cannot answer that" would reasonably stop asking.
 *
 * So the test below accepts either shape and requires one of them. The
 * alternative — splitting it into a pre-stream and a mid-stream code — doubles
 * the catalogue for a distinction no client would branch on differently.
 */
export const HALT_WITHOUT_PARTIAL_ANSWER: readonly string[] = ['ASSISTANT_PROVIDER_UNAVAILABLE'];

export type RefusalCode = (typeof REFUSAL_CODES)[number];
export type HaltCode = (typeof HALT_CODES)[number];

/** Every code the assistant can end on, refusal or halt. */
export const ASSISTANT_END_CODES: readonly string[] = [...REFUSAL_CODES, ...HALT_CODES];

/**
 * A halt is reported with its code AND the partial answer; a refusal with its
 * code and no answer. Exported so the stream route and the guard agree on
 * which set a code belongs to rather than each re-deriving it.
 */
export function isHaltCode(code: string): code is HaltCode {
    return (HALT_CODES as readonly string[]).includes(code);
}

export function isRefusalCode(code: string): code is RefusalCode {
    return (REFUSAL_CODES as readonly string[]).includes(code);
}
