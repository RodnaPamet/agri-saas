/**
 * Ratchet — translation labels MUST NOT lead with `+ `.
 *
 * The `+ Asset` / `+ Risk` / `+ Audit` antipattern (literal "+"
 * baked into the translation string) bypasses the cva centering
 * logic: the "+" becomes part of the centered text block, so the
 * button reads visually unbalanced — text wants to centre as a
 * unit, but the "+" character has different visual weight than
 * the noun next to it, pulling the eye left.
 *
 * Per CLAUDE.md "Action button vocabulary": the icon belongs to
 * the button's `icon` slot, never the text. Translation values
 * use the canonical verb form ("Create Asset" / "Add Asset" /
 * "New Audit") and the Plus glyph is passed via `icon={<Plus />}`
 * at the call site. The Button cva then centers icon + label as
 * a properly balanced flex group.
 *
 * Scans every `messages/*.json` and fails CI if any value starts
 * with `"+ "`.
 */
import { locales, readCatalogue } from '../helpers/catalogue';
import * as fs from 'node:fs';
import * as path from 'node:path';


function flatten(obj: unknown, prefix = ''): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    if (obj === null || typeof obj !== 'object') return out;
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof val === 'string') {
            out.push([path, val]);
        } else if (typeof val === 'object') {
            out.push(...flatten(val, path));
        }
    }
    return out;
}

describe('Translation labels — no "+ " prefix antipattern', () => {
    // LOCALES, not files: a locale became a bundle DIRECTORY in #1813, so a
    // `.endsWith('.json')` filter over `messages/` now matches nothing and
    // this suite would scan zero catalogues while still reporting no
    // violations. The assertion below is the only thing that would notice.
    const files = locales();

    it('found at least one translation file to scan', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    /*
     * THE SELECTOR'S OWN CONTROL — #2417.
     *
     * `selector-teeth` found `flatten()` DEAD: gutted to `return []` it
     * survived every test in this file. The reason is narrow and worth
     * stating, because the file already looked careful.
     *
     * The assertion each locale makes is `expect(violations).toEqual([])`,
     * over `flatten(json).filter(...)`. An empty `flatten` makes `violations`
     * empty, so the suite reports "no `+ ` labels" having read nothing. The
     * existing control above checks that FILES were found — a real control,
     * and the one that caught #1813's bundle split — but it says nothing about
     * whether the extraction inside each file reached any strings. Two
     * different denominators; only one was checked.
     *
     * Measured: 6,011 string pairs per locale bundle. The floor is well under
     * that so an ordinary catalogue edit does not move it, while a `flatten`
     * that returns nothing — or stops recursing into nested objects, which is
     * where nearly all of them live — fails here.
     */
    it('flatten reaches the catalogue strings the filter runs over', () => {
        const pairs = flatten(readCatalogue(files[0]) as unknown);
        expect(pairs.length).toBeGreaterThan(2000);
        // And they are really [key, value] string pairs, so the count cannot
        // be satisfied by 6,011 of something else.
        expect(pairs.every(([k, v]) => typeof k === 'string' && typeof v === 'string')).toBe(true);
    });

    it('the "+ " filter fires on a value that has the prefix', () => {
        // The other half. The control above proves the population is reached;
        // this proves the predicate over it can still discriminate, so a
        // broken regex fails too rather than passing over a real catalogue.
        const hit = flatten({ nested: { label: '+ Asset' }, ok: 'Create Asset' }).filter(
            ([, v]) => /^\+\s/.test(v),
        );
        expect(hit).toEqual([['nested.label', '+ Asset']]);
    });

    for (const file of files) {
        it(`${file} has no values starting with "+ "`, () => {
            const json = readCatalogue(file) as unknown;
            const violations = flatten(json).filter(([, v]) =>
                /^\+\s/.test(v),
            );
            // Print actionable diff if any violation is found —
            // the developer sees `key: "+ Asset"` not a counter.
            expect(violations).toEqual([]);
        });
    }
});
