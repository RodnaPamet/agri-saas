/**
 * Every recommendation the rule table can produce has copy, in BOTH locales —
 * #3070.
 *
 * ## Why a guard and not a careful afternoon
 *
 * `rules.ts` holds KEY NAMES; the sentences live in `messages/{bg,en}/app.json`.
 * Two artefacts, and nothing structural ties them: a 23rd recommendation added
 * to the table compiles, renders, and shows the key where a sentence belongs.
 *
 * The key-parity gate cannot see it either, and that is the point worth
 * keeping: parity compares the two CATALOGUES with each other, so a key absent
 * from both is perfectly balanced. P9.3d shipped Art 17 statements reading
 * `statementOfReasons.action.CONTENT_AUTO_HIDDEN` for exactly that reason —
 * counts matched, copy was missing.
 *
 * ## Both directions, because each failure is different
 *
 * A recommendation with no sentence renders a dotted path to a farmer. A
 * sentence with no recommendation is dead copy that a translator maintains for
 * nothing and a reader never sees.
 *
 * ## The phone copies these word for word
 *
 * agrent-ios builds «Лунен календар» against the same keys and takes the
 * Bulgarian verbatim, so the web and the phone say the same thing. A key that
 * silently falls back to English on the web ships English to the phone too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../helpers/collect-files';
import { RECOMMENDATIONS, type Recommendation } from '../../src/lib/lunar/rules';
import { DAY_TYPES, ELEMENTS, SIGNS } from '../../src/lib/lunar/zodiac';

type Catalogue = { lunar?: Record<string, string> };

function lunarKeys(locale: string): Record<string, string> {
    const file = path.join(REPO_ROOT, `messages/${locale}/app.json`);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Catalogue;
    return parsed.lunar ?? {};
}

/** `sowBeetPotato` → `recSowBeetPotato`, the one place that spelling lives. */
function copyKeyFor(rec: Recommendation): string {
    return `rec${rec[0].toUpperCase()}${rec.slice(1)}`;
}

const LOCALES = ['bg', 'en'] as const;

describe('the lunar rule table has copy in both locales (#3070)', () => {
    it('ranges over a real table and real catalogues', () => {
        console.log(
            `[lunar-copy] ${RECOMMENDATIONS.length} recommendation(s) against `
                + LOCALES.map((l) => `${l}=${Object.keys(lunarKeys(l)).length}`).join(' ')
                + ' lunar key(s)',
        );
        // Floors: an empty table or an empty namespace satisfies every
        // assertion below over nothing.
        expect(RECOMMENDATIONS.length).toBeGreaterThanOrEqual(20);
        for (const locale of LOCALES) {
            expect(Object.keys(lunarKeys(locale)).length).toBeGreaterThanOrEqual(40);
        }
    });

    it.each(LOCALES)('%s has a sentence for every recommendation', (locale) => {
        const keys = lunarKeys(locale);
        const missing = RECOMMENDATIONS.filter((rec) => {
            const value = keys[copyKeyFor(rec)];
            // An empty string is as missing as an absent key — it renders
            // nothing where a sentence belongs.
            return typeof value !== 'string' || value.trim() === '';
        });
        expect(missing).toEqual([]);
    });

    it.each(LOCALES)('%s carries no rec* copy the table cannot produce', (locale) => {
        const produced = new Set(RECOMMENDATIONS.map(copyKeyFor));
        const dead = Object.keys(lunarKeys(locale))
            .filter((k) => k.startsWith('rec'))
            .filter((k) => !produced.has(k));
        expect(dead).toEqual([]);
    });

    it.each(LOCALES)('%s names every day type, element and sign', (locale) => {
        // The vocabularies the API returns. A missing one shows `capricorn`
        // to a Bulgarian farmer, which is the same defect one level along.
        const keys = lunarKeys(locale);
        const want = [
            ...DAY_TYPES.map((d) => `dayType${d[0].toUpperCase()}${d.slice(1)}`),
            ...ELEMENTS.map((e) => `element${e[0].toUpperCase()}${e.slice(1)}`),
            ...SIGNS.map((s) => `sign${s[0].toUpperCase()}${s.slice(1)}`),
        ];
        expect(want.filter((k) => !keys[k])).toEqual([]);
    });

    it.each(LOCALES)('%s states the tradition framing the owner required', (locale) => {
        // Owner, 2026-11-15: titled «По лунния календар», with one line saying
        // it follows folk tradition and is NOT agronomic advice. Pinned
        // because it is the sentence most likely to be trimmed as boilerplate,
        // and it is the one that keeps this feature clear of the ДНЕВНИК.
        const keys = lunarKeys(locale);
        expect(keys.traditionTitle?.trim()).toBeTruthy();
        expect(keys.traditionNotice?.trim()).toBeTruthy();
        expect(keys.traditionNotice.length).toBeGreaterThan(40);
    });
});
