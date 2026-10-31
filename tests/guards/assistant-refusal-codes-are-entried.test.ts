/**
 * Every assistant ending has a sentence, in BOTH locales — #2578.
 *
 * The codes in `refusal-codes.ts` are wire identifiers for branching; the copy
 * a person reads comes from `errors.<CODE>`. That split is #1677's owner
 * ruling — the server resolves the locale and sends `message` already
 * translated, "so neither client needs a code catalogue".
 *
 * What makes an unentried code expensive rather than untidy: `translateFor`
 * returns the KEY when it finds no entry, and `localizeErrorPayload` SWALLOWS
 * its own failures by design, so a miss ships the English fallback — and
 * `src/lib/api-client.ts` prints `message` at 142 web call sites with no
 * language test. A Bulgarian farmer reads the fallback.
 *
 * The existing `a-new-code-ships-with-its-entry` ratchet cannot cover these.
 * Its population is `coded*('CODE'` calls in `src/`, and a MID-stream refusal
 * is not one: the response is already a 200 with bytes sent, so it is an SSE
 * event rather than a thrown error. Hence a second guard on the same
 * catalogue — a different population, not a second convention.
 *
 * Read through `readCatalogue` because `one-catalogue-reader` is right: 43
 * files once read `messages/<locale>.json` directly, and a new direct reader
 * silently re-breaks the property that the bundles can be split.
 */
import {
    ASSISTANT_END_CODES,
    HALT_CODES,
    HALT_WITHOUT_PARTIAL_ANSWER,
    isHaltCode,
    isRefusalCode,
    REFUSAL_CODES,
} from '@/app-layer/ai/safety/refusal-codes';
import { locales, readCatalogue } from '../helpers/catalogue';

/**
 * How a halt may say "there IS an answer and it is partial".
 *
 * A vocabulary rather than one literal, because the first version of this
 * demanded the word "incomplete" and `ASSISTANT_TRUNCATED_RESULT` says "uses
 * part of the data" — the same property, better copy. Forcing one word into
 * ten sentences makes them formulaic, and the Bulgarian needs a different root
 * anyway. It stays a closed set so the check keeps teeth: a halt that says
 * nothing about partialness at all still fails, which is the defect worth
 * catching.
 */
const PARTIAL_EN = /incomplete|part of the data|partial/;
const PARTIAL_BG = /непълен|част от данните|частич/;

type Dict = Record<string, unknown>;
const errorsFor = (locale: string): Record<string, string> => {
    const cat = readCatalogue(locale) as Dict;
    const errors = cat.errors as Record<string, string> | undefined;
    if (!errors || Object.keys(errors).length === 0) {
        // An empty section would make every assertion below pass for free.
        throw new Error(`no errors section in the ${locale} catalogue`);
    }
    return errors;
};

describe('assistant refusal and halt codes (#2578)', () => {
    it('ranges over a real population, and the two sets are disjoint', () => {
        console.log(
            `[assistant-codes] ${REFUSAL_CODES.length} refusal + ${HALT_CODES.length} halt `
                + `= ${ASSISTANT_END_CODES.length} code(s) across ${locales().length} locale(s)`,
        );
        expect(REFUSAL_CODES.length).toBeGreaterThanOrEqual(4);
        expect(HALT_CODES.length).toBeGreaterThanOrEqual(4);
        expect(new Set(ASSISTANT_END_CODES).size).toBe(ASSISTANT_END_CODES.length);
        // A code in both sets would mean "no answer" and "partial answer" at
        // once, which is the uniform-failure-shape defect by construction.
        for (const c of ASSISTANT_END_CODES) {
            expect(isHaltCode(c)).toBe(!isRefusalCode(c));
        }
    });

    it('every code has an entry in EVERY locale', () => {
        const missing: string[] = [];
        for (const locale of locales()) {
            const errors = errorsFor(locale);
            for (const code of ASSISTANT_END_CODES) {
                if (typeof errors[code] !== 'string' || errors[code].trim() === '') {
                    missing.push(`${locale}:${code}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('the Bulgarian is a TRANSLATION, not the English pasted across', () => {
        // `i18n-completeness`'s untranslated check catches a byte-identical
        // value, and would not catch an English sentence with one word changed.
        // Cyrillic presence is the cheap positive signal that someone wrote
        // Bulgarian here at all.
        const en = errorsFor('en');
        const bg = errorsFor('bg');
        for (const code of ASSISTANT_END_CODES) {
            expect(bg[code]).not.toBe(en[code]);
            expect(bg[code]).toMatch(/[Ѐ-ӿ]/);
            expect(en[code]).not.toMatch(/[Ѐ-ӿ]/);
        }
    });

    it('a HALT says the answer is incomplete; a REFUSAL does not claim one', () => {
        // The distinction is the whole reason there are two sets, and copy is
        // where it reaches a person. A halt whose sentence reads like a refusal
        // tells someone to retry when the answer they have is real — which
        // spends again and teaches them the feature is unreliable.
        const en = errorsFor('en');
        const bg = errorsFor('bg');
        for (const code of HALT_CODES) {
            if (HALT_WITHOUT_PARTIAL_ANSWER.includes(code)) {
                // The documented exception: a provider failure can land before
                // the first token, so there is no answer for "incomplete" to
                // describe. It must say plainly that nothing was produced
                // instead — silence on both counts is what this refuses.
                expect(en[code].toLowerCase()).toMatch(/not read|nothing was created/);
                expect(bg[code]).toMatch(/не бяха прочетени|нищо не беше създадено/);
                continue;
            }
            expect(en[code].toLowerCase()).toMatch(PARTIAL_EN);
            expect(bg[code]).toMatch(PARTIAL_BG);
        }
        for (const code of REFUSAL_CODES) {
            expect(en[code].toLowerCase()).not.toMatch(PARTIAL_EN);
            expect(bg[code]).not.toMatch(PARTIAL_BG);
        }
    });

    it('the no-partial-answer exception stays SMALL and every member is a halt', () => {
        // An exception list that can grow without comment is how a
        // distinction stops being enforced. One member today; if a second
        // arrives it should cost a reader's attention.
        expect(HALT_WITHOUT_PARTIAL_ANSWER.length).toBeLessThanOrEqual(2);
        for (const c of HALT_WITHOUT_PARTIAL_ANSWER) {
            expect(isHaltCode(c)).toBe(true);
        }
    });

    it('no sentence is the code repeated, and none carries an unrendered param', () => {
        // `a-coded-message-is-not-its-own-code` makes this point for the
        // thrown-error path: a token on screen tells a farmer nothing. And an
        // ICU brace that reaches a person is the `translateFor` trap — these
        // sentences deliberately take no parameters, so any brace is a bug.
        for (const locale of locales()) {
            const errors = errorsFor(locale);
            for (const code of ASSISTANT_END_CODES) {
                expect(errors[code]).not.toBe(code);
                expect(errors[code]).not.toMatch(/[{}]/);
            }
        }
    });
});
