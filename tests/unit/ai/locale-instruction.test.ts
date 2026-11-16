/**
 * The shared Bulgarian prose rules, and the convention they rest on — #3090.
 *
 * `locale-instruction.ts` holds two phrasings of ONE set of rules: the
 * locale-resolved form every extractor appends, and the conditional form the
 * assistant appends because it answers in the language of the question. Two
 * phrasings of one list is only safe while they are literally the same string,
 * which is what this asserts.
 */
import { readCatalogue } from '../../helpers/catalogue';
import {
    BULGARIAN_REGISTER_RULE,
    CONDITIONAL_BULGARIAN_PROSE_RULE,
    localeOutputInstruction,
    withLocaleInstruction,
} from '@/app-layer/ai/locale-instruction';

function stringsIn(value: unknown, acc: string[] = []): string[] {
    if (typeof value === 'string') acc.push(value);
    else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, acc));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsIn(v, acc));
    return acc;
}

/**
 * Word-exact match by TOKENISING, never `\b`.
 *
 * JavaScript's `\b` is ASCII-only, so `/\bти\b/` never matches Cyrillic and a
 * negated assertion built on it passes VACUOUSLY — the trap that let a
 * «имот» guard report clean over a catalogue full of the word. Splitting on
 * non-letters and comparing tokens has no such blind spot.
 */
const words = (s: string): string[] => s.split(/[^\p{L}]+/u).filter(Boolean);
const INFORMAL = new Set(['ти', 'твой', 'твоя', 'твоята', 'твоите', 'твое', 'тебе']);
const hasInformal = (s: string): boolean => words(s).some((w) => INFORMAL.has(w.toLowerCase()));

describe('the Bulgarian instruction carries the register and the anti-drift rules', () => {
    it('names «Вие» and forbids «ти», including in imperatives', () => {
        expect(BULGARIAN_REGISTER_RULE).toMatch(/Вие/);
        expect(BULGARIAN_REGISTER_RULE).toMatch(/never the informal «ти»/i);
        // The imperative is the half a model gets wrong while still being
        // "formal": «провери» is correct Bulgarian AND informal.
        expect(BULGARIAN_REGISTER_RULE).toMatch(/проверете/);
    });

    it('is included in the locale-resolved instruction, so every surface gets it', () => {
        const bg = localeOutputInstruction('bg');
        expect(bg).toContain(BULGARIAN_REGISTER_RULE);
        // Beside the clauses that exist because the owner was shown Russian.
        expect(bg).toMatch(/Bulgarian is NOT Russian/i);
        expect(bg).toMatch(/проверь is Russian/);
        expect(bg).toMatch(/ы, э and ё do not exist/);
    });

    it('says NOTHING for English, so no tokens are spent', () => {
        for (const locale of ['en', null, undefined, '']) {
            expect(localeOutputInstruction(locale as string)).toBe('');
        }
        expect(withLocaleInstruction('SYSTEM', 'en')).toBe('SYSTEM');
        expect(withLocaleInstruction('SYSTEM', 'bg')).toContain('SYSTEM');
        expect(withLocaleInstruction('SYSTEM', 'bg').length).toBeGreaterThan('SYSTEM'.length);
    });

    it('the two phrasings share ONE copy of the rules', () => {
        /*
         * The property that keeps them from drifting. The conditional form is
         * for a surface answering in the question's language; if somebody ever
         * edits one list and not the other, a farmer gets the protection on
         * one surface and not the next — which is the state #3090 found.
         */
        const bg = localeOutputInstruction('bg');
        for (const clause of [
            BULGARIAN_REGISTER_RULE,
            'Bulgarian is NOT Russian',
            'проверь is Russian',
            'Make adjectives agree with the gender',
            'do not transliterate them',
        ]) {
            expect(bg).toContain(clause);
            expect(CONDITIONAL_BULGARIAN_PROSE_RULE).toContain(clause);
        }
        // And the conditional one says it is conditional, which is the only
        // difference there should be.
        expect(CONDITIONAL_BULGARIAN_PROSE_RULE).toMatch(/If any part of your answer is in Bulgarian/i);
        expect(bg).not.toMatch(/If any part of your answer is in Bulgarian/i);
    });
});

describe('the convention the register rule rests on', () => {
    it('the shipped Bulgarian catalogue is formal throughout — the measurement', () => {
        const strings = stringsIn(readCatalogue('bg'));
        const informal = strings.filter(hasInformal);
        const formal = strings.filter((s) =>
            words(s).some((w) => ['Вие', 'Ви', 'Вас', 'Вашият', 'Вашата', 'Вашите', 'Ваше', 'Вашето'].includes(w)),
        );
        console.log(
            `[locale-instruction] ${strings.length} bg string(s): ${formal.length} formal, `
                + `${informal.length} informal`,
        );
        // A floor first: over an empty catalogue "no informal strings" is free,
        // and that is the one way this fails toward green.
        expect(strings.length).toBeGreaterThanOrEqual(5000);
        expect(formal.length).toBeGreaterThanOrEqual(50);

        // The claim the rule is built on. A new informal string is either a
        // mistake or a product decision that makes the instruction wrong —
        // either way somebody should look.
        expect(informal).toEqual([]);
    });

    it('control: the informal detector actually fires, and tokenises', () => {
        /*
         * Without this the assertion above is the `\b` trap all over again: a
         * detector that matches nothing reports a clean catalogue for ever.
         */
        expect(hasInformal('Провери твоята нива')).toBe(true);
        expect(hasInformal('ти')).toBe(true);
        expect(hasInformal('Тебе')).toBe(true);
        // Formal copy is not flagged…
        expect(hasInformal('Проверете Вашата нива')).toBe(false);
        // …and neither is a word that merely CONTAINS one, which is what a
        // substring match would get wrong: «тиня», «тих», «материал».
        expect(hasInformal('тиня')).toBe(false);
        expect(hasInformal('тих вятър')).toBe(false);
        expect(hasInformal('материал')).toBe(false);
    });
});
