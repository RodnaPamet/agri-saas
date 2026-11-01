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
    /**
     * A tool's result was INCOMPLETE — it did not gather everything that
     * exists — #2639.
     *
     * Distinct from `ASSISTANT_TRUNCATED_RESULT` on purpose, and the two are
     * easy to conflate. Truncated means the result exceeded
     * `TOOL_RESULT_MAX_CHARS`, so the MODEL did not see all of what was
     * gathered. Partial means the TOOL did not gather it: 24 of 30 parcels
     * analysed, a net worth whose commodities had no price.
     *
     * Collapsing them would tell a farmer "the result was shortened" when the
     * truth is "six of your parcels were never looked at" —
     * `uniform-failure-shape-blinds-the-client`.
     */
    'ASSISTANT_PARTIAL_DATA',
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

/**
 * The English sentence to use when the CATALOGUE LOOKUP FAILS — #2578.
 *
 * Not a second catalogue, and not displayed copy in the normal case. This is
 * the same arrangement `coded*()` already has: its English second argument is
 * the FALLBACK for an unentried code, and `localizeErrorPayload` replaces it
 * from `errors.<CODE>` before anyone sees it.
 *
 * Every code here IS entried in both locales, and
 * `assistant-refusal-codes-are-entried` fails CI if one stops being. So this
 * map only fires when the catalogue cannot be LOADED at all — and in that
 * situation the alternative is worse: an SSE event has no prior `message` to
 * leave in place, so the choice is an English sentence or the code itself, and
 * `a-coded-message-is-not-its-own-code` is right that a token on screen tells
 * a farmer nothing and a support agent almost nothing.
 *
 * A Bulgarian reader seeing English here is the same degradation the HTTP path
 * already has, not a new one — and the iOS client's own rule (never show
 * English) covers it there.
 */
export const ENDING_FALLBACK_EN: Record<string, string> = {
    ASSISTANT_NO_GROUNDING:
        "I could not find anything in this farm's records to answer that, so I will not guess.",
    ASSISTANT_OUT_OF_SCOPE: "That is outside what I can answer from this farm's records.",
    ASSISTANT_HIGH_STAKES_NEEDS_SOURCE:
        'That needs an exact figure from a registered product label, and I do not have one. Check the label or ask an agronomist.',
    ASSISTANT_EGRESS_BLOCKED:
        'I stopped that answer because it looked like it contained a credential. Nothing was sent.',
    ASSISTANT_INPUT_REJECTED: 'I could not read that question safely. Try putting it another way.',
    ASSISTANT_TOOL_BUDGET:
        'The answer above is real but incomplete — I reached the limit on how much I may look up for one question.',
    ASSISTANT_SPEND_CEILING:
        'The answer above is incomplete because this farm has reached its monthly limit for the assistant.',
    ASSISTANT_TIME_BUDGET:
        'The answer above is incomplete — it was taking too long, so I stopped rather than leave you waiting.',
    ASSISTANT_PROVIDER_UNAVAILABLE:
        "I could not reach the model. This farm's records were not read and nothing was created.",
    ASSISTANT_TRUNCATED_RESULT:
        'The answer above uses part of the data — one of the lists I read was too long to use whole.',
    ASSISTANT_PARTIAL_DATA:
        'The answer above is incomplete — some of your records could not be included, so treat it as a partial picture.',
};
