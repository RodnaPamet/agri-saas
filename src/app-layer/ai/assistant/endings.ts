/**
 * Resolve a refusal or halt code to the sentence a person reads — #2578.
 *
 * ## Why this is not `localizeErrorPayload`
 *
 * That function mutates an `ApiErrorResponse`, and an SSE event is not one:
 * the response is already a 200 with bytes sent, so there is no error payload
 * to mutate. What IS shared is the lookup, which `localize.ts` now exports as
 * `sentenceForCode` — extracted rather than reimplemented, because the part
 * that must not be copied is its double check. A `has`-only detector returns
 * TRUE for a code whose entry is a variant table and then puts the literal KEY
 * in front of a farmer; that was measured against next-intl.
 *
 * So: one lookup, two transports. The HTTP path replaces a message, the stream
 * path composes an event.
 */
import { ENDING_FALLBACK_EN, isHaltCode } from '../safety/refusal-codes';
import type { HaltCode, RefusalCode } from '../safety/refusal-codes';
import { sentenceForCode } from '@/lib/errors/localize';
import { logger } from '@/lib/observability';
import type { AssistantStreamEvent } from './stream-events';

/**
 * The sentence for a code, in the reader's language.
 *
 * Never throws and never returns empty. A catalogue that cannot be loaded
 * falls back to English — see `ENDING_FALLBACK_EN` for why that beats the
 * alternatives here — and a code with no fallback either (which the guard
 * makes impossible) yields a last-resort sentence rather than a token.
 */
export async function endingMessage(code: string): Promise<string> {
    try {
        const text = await sentenceForCode(code);
        if (text !== null && text.trim() !== '') return text;
    } catch (err) {
        // Swallowed for `localizeErrorPayload`'s reason, which applies with
        // more force here: this runs while a stream is open, and a throw would
        // replace a refusal the person can act on with a dead socket.
        logger.warn('assistant.ending_localize_failed', {
            component: 'assistant',
            errorCode: code,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    return ENDING_FALLBACK_EN[code] ?? 'The assistant could not complete that request.';
}

/** The terminal event for a code, with its sentence resolved. */
export async function endingEvent(
    code: RefusalCode | HaltCode,
): Promise<Extract<AssistantStreamEvent, { type: 'refusal' | 'halt' }>> {
    const message = await endingMessage(code);
    return isHaltCode(code)
        ? { type: 'halt', code: code as HaltCode, message }
        : { type: 'refusal', code: code as RefusalCode, message };
}
