/**
 * The assistant's ending sentences resolve, and degrade honestly — #2578.
 *
 * `resolveRequestLocale()` returns `RECIPIENT_FALLBACK_LOCALE` ('bg') when
 * there is no request context, which is what a unit test has — so these
 * assertions are about the language a Bulgarian farmer actually gets, with no
 * mocking of the locale at all.
 */
import { endingEvent, endingMessage } from '@/app-layer/ai/assistant/endings';
import {
    ASSISTANT_END_CODES,
    ENDING_FALLBACK_EN,
    HALT_CODES,
    REFUSAL_CODES,
} from '@/app-layer/ai/safety/refusal-codes';

const CYRILLIC = /[Ѐ-ӿ]/;

describe('assistant ending sentences (#2578)', () => {
    it('resolves every code to BULGARIAN, not to the English fallback', async () => {
        for (const code of ASSISTANT_END_CODES) {
            const msg = await endingMessage(code);
            expect(msg).toMatch(CYRILLIC);
            // The decisive assertion: it must NOT be the fallback. Without
            // this, a broken catalogue lookup would pass the Cyrillic check
            // the moment somebody translated the fallback map.
            expect(msg).not.toBe(ENDING_FALLBACK_EN[code]);
        }
    });

    it('a halt code yields a halt event; a refusal code a refusal', async () => {
        for (const code of HALT_CODES) {
            const e = await endingEvent(code);
            expect(e.type).toBe('halt');
            expect(e.code).toBe(code);
            expect(e.message).toMatch(CYRILLIC);
        }
        for (const code of REFUSAL_CODES) {
            const e = await endingEvent(code);
            expect(e.type).toBe('refusal');
            expect(e.code).toBe(code);
        }
    });

    it('every code has an English fallback, so the last resort never fires', async () => {
        // The `??` in `endingMessage` exists so the function cannot return a
        // token, not because any code is expected to need it.
        for (const code of ASSISTANT_END_CODES) {
            expect(typeof ENDING_FALLBACK_EN[code]).toBe('string');
            expect(ENDING_FALLBACK_EN[code].length).toBeGreaterThan(20);
            expect(ENDING_FALLBACK_EN[code]).not.toMatch(CYRILLIC);
        }
        expect(Object.keys(ENDING_FALLBACK_EN).sort()).toEqual([...ASSISTANT_END_CODES].sort());
    });

    it('never returns a token, and never throws, when the catalogue cannot be read', async () => {
        // The one case the fallback is for. A stream is open when this runs,
        // so a throw would replace an actionable refusal with a dead socket.
        jest.resetModules();
        jest.doMock('@/lib/errors/localize', () => ({
            sentenceForCode: jest.fn(async () => {
                throw new Error('catalogue unreadable');
            }),
        }));
        const { endingMessage: degraded } = await import('@/app-layer/ai/assistant/endings');
        for (const code of ASSISTANT_END_CODES) {
            const msg = await degraded(code);
            expect(msg).toBe(ENDING_FALLBACK_EN[code]);
            expect(msg).not.toBe(code);
        }
        jest.dontMock('@/lib/errors/localize');
        jest.resetModules();
    });

    it('an unknown code still yields a sentence rather than the code itself', async () => {
        const msg = await endingMessage('ASSISTANT_NOT_A_REAL_CODE');
        expect(msg).not.toBe('ASSISTANT_NOT_A_REAL_CODE');
        expect(msg.length).toBeGreaterThan(20);
    });
});
