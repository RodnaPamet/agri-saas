/**
 * The ONE place an assistant answer reaches a client — #2578.
 *
 * ## Why a choke point and not a rule
 *
 * #2578 records that the egress scan shipped with no caller, and that when it
 * got one it would need a COVERAGE control — because "the stream route calls
 * it, done" is the same reading that left `enforceApiKeyScope` covering 23 of
 * 273 routes. An answer can leave by more than one door: the SSE `answer`
 * event, a non-streaming fallback if one is ever added, a refusal that quotes
 * retrieved content, and the `links` field.
 *
 * A guard that hunts for unscanned emit sites is the obvious answer and the
 * weaker one: it has to enumerate the shapes text can take, and
 * `count-the-routes-a-gate-covers` is about exactly the blind spot that
 * leaves. So the scan is not a step a caller must remember — it is the only
 * way to construct the event. `{ type: 'answer'` is spelled HERE and nowhere
 * else, and `tests/guards/assistant-answer-goes-through-the-scan.test.ts`
 * holds that at one site.
 *
 * The tool loop is why this lands before it rather than with it: every tool
 * result is farm data entering the answer, so the number of ways text can
 * reach a client is about to grow. A control added after that growth would be
 * written against the paths that already exist.
 *
 * ## The answer is DISCARDED, never redacted
 *
 * A partially-redacted credential is a credential with a hint attached. And
 * the verdict carries `ruleIds` only — never the matched text — so the log
 * line below cannot log the secret that caused it.
 */
import { endingEvent } from './endings';
import { sseFormat, type AssistantStreamEvent } from './stream-events';
import { scanEgress } from '../safety/egress-scan';
import { logger } from '@/lib/observability';

/** What `emitAnswer` decided, so a caller can report it without re-deciding. */
export interface AnswerOutcome {
    readonly sent: boolean;
    readonly ruleIds: readonly string[];
}

/**
 * Scan `text`, then send it — or send the refusal instead.
 *
 * `send` takes an already-formatted SSE chunk, matching `createSseResponse`'s
 * guarded sender. Returns what happened so the caller can decide whether to
 * follow with `done` or stop; it does not emit a terminal event itself,
 * because what terminates a turn is the caller's business and burying that
 * here is how a stream ends twice.
 */
export async function emitAnswer(
    send: (chunk: string) => void,
    text: string,
    meta: { tenantId: string },
): Promise<AnswerOutcome> {
    const trimmed = text.trim();
    if (trimmed === '') {
        // An empty answer is not a clean answer. Reported as no grounding,
        // which is what it means, rather than sent as an empty bubble.
        send(sseFormat(await endingEvent('ASSISTANT_NO_GROUNDING')));
        return { sent: false, ruleIds: [] };
    }

    const verdict = scanEgress(trimmed);
    if (!verdict.clean) {
        logger.warn('assistant.egress_blocked', {
            component: 'assistant',
            tenantId: meta.tenantId,
            // Rule NAMES only. `EgressVerdict` deliberately carries no matched
            // text, so this cannot log the secret.
            ruleIds: verdict.ruleIds.join(','),
        });
        send(sseFormat(await endingEvent('ASSISTANT_EGRESS_BLOCKED')));
        return { sent: false, ruleIds: verdict.ruleIds };
    }

    // The ONLY construction of this event in the codebase. Moving or copying
    // it is what the guard refuses.
    const event: AssistantStreamEvent = { type: 'answer', text: trimmed };
    send(sseFormat(event));
    return { sent: true, ruleIds: [] };
}
