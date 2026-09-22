/**
 * The ДНЕВНИК's technique labels and `messages/bg.json` say the same thing.
 *
 * There are deliberately TWO representations. The web sheet renders these
 * through next-intl, which needs them in `messages/`. The register renders
 * them too, but `buildChemicalRows` is a pure synchronous function its tests
 * call directly, and the form is always Bulgarian — reaching `translateFor`
 * would make it async for one column and ripple through every caller.
 *
 * Two sources with a guard is the repo's usual answer where one source is not
 * reachable. Two sources WITHOUT one is how `messages/` came to hold three
 * separate crop vocabularies, which is the outcome this file exists to stop.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    APPLICATION_TECHNIQUES,
    _TECHNIQUE_BG_FOR_TESTS as MAP,
    normaliseTechnique,
    techniqueLabelBg,
} from '@/lib/agro/application-techniques';

const ROOT = path.resolve(__dirname, '../..');

function messagesBg(): Record<string, string> {
    const raw = fs.readFileSync(path.join(ROOT, 'messages/bg.json'), 'utf8');
    return JSON.parse(raw).ag?.map?.parcelSheet?.techniqueOptions ?? {};
}

describe('the technique vocabulary has one wording, in two places', () => {
    it('messages actually carries the namespace (positive control)', () => {
        // Every comparison below is against this object. An empty one makes
        // "no mismatches" true and meaningless.
        expect(Object.keys(messagesBg()).length).toBeGreaterThanOrEqual(7);
    });

    it('every technique has a label in both, with identical wording', () => {
        const msg = messagesBg();
        const mismatched = APPLICATION_TECHNIQUES.filter((t) => MAP[t] !== msg[t]);
        expect(mismatched).toEqual([]);
    });

    it('neither side carries a technique the other does not', () => {
        expect(Object.keys(MAP).sort()).toEqual([...APPLICATION_TECHNIQUES].sort());
        expect(Object.keys(messagesBg()).sort()).toEqual([...APPLICATION_TECHNIQUES].sort());
    });
});

describe('normaliseTechnique', () => {
    it('folds the casing that actually occurred in production', () => {
        // `Dron` and `dron` were two rows on the filed register.
        expect(normaliseTechnique('Dron')).toBe('dron');
        expect(normaliseTechnique('dron')).toBe('dron');
        expect(normaliseTechnique('  DRONE  ')).toBe('drone');
    });

    it('treats empty and whitespace as absent, not as a value', () => {
        expect(normaliseTechnique('')).toBeNull();
        expect(normaliseTechnique('   ')).toBeNull();
        expect(normaliseTechnique(null)).toBeNull();
        expect(normaliseTechnique(undefined)).toBeNull();
    });
});

describe('techniqueLabelBg — what the register prints', () => {
    it('renders a known slug in Bulgarian', () => {
        expect(techniqueLabelBg('drone')).toBe('Дрон');
        expect(techniqueLabelBg('boom')).toBe('Щангова пръскачка');
        // Case-folded, because rows predate the write-side normalisation.
        expect(techniqueLabelBg('Drone')).toBe('Дрон');
    });

    it('passes an UNKNOWN value through unchanged', () => {
        // The column is free text, so an unrecognised value is ordinary. A
        // legally-filed register must show what was recorded — not a blank,
        // and not a guess at what the operator meant.
        expect(techniqueLabelBg('самоделна пръскачка')).toBe('самоделна пръскачка');
        expect(techniqueLabelBg('quad bike')).toBe('quad bike');
    });

    it('renders nothing for an absent value', () => {
        expect(techniqueLabelBg(null)).toBe('');
        expect(techniqueLabelBg('  ')).toBe('');
    });
});
