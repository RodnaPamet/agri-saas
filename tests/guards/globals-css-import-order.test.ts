/**
 * Guard — globals.css must contain NO remote `@import`.
 *
 * ## The hazard, which is real and cost a site-wide outage
 *
 * `@import "tailwindcss"` is inlined by the bundler and expands to thousands
 * of generated rules. A remote-URL `@import` CANNOT be inlined — it stays an
 * `@import` RULE in the compiled output, and CSS requires every `@import` to
 * precede all other rules. Next 16's strict CSS parser hard-errors otherwise,
 * which fails to compile `globals.css` and returns a 500 on every page that
 * imports it.
 *
 * **2026-05-21: exactly this shipped.** The Google-Fonts `@import` sat after
 * `@import "tailwindcss"` and took the whole site down in `next dev`.
 *
 * ## Why this guard was INVERTED (#779)
 *
 * It used to assert "every remote `@import` precedes `@import tailwindcss`".
 * Self-hosting the fonts removed the last remote import — and that turned the
 * old assertion VACUOUS: with nothing to filter, `misplaced` is `[]` and the
 * test passes trivially, forever, no matter what anyone does to the file.
 * A guard that cannot fail is the defect this repo names by name.
 *
 * So the invariant is now the stronger and still-falsifiable one: there are NO
 * remote imports at all. That is both what the code does and what we want it
 * to keep doing — the fonts are vendored under `public/fonts/` and declared by
 * the generated `src/styles/fonts.css`, which is same-origin, cacheable by the
 * service worker, and subject to our own CSP.
 *
 * If a remote `@import` is ever genuinely needed again, this test is the place
 * that argument gets made: delete the assertion deliberately and restore the
 * ordering rule below it, which is preserved here for that purpose rather than
 * deleted.
 */
import * as fs from 'fs';
import * as path from 'path';

const GLOBALS = path.resolve(__dirname, '../../src/app/globals.css');

describe('globals.css @import discipline', () => {
    const source = fs.readFileSync(GLOBALS, 'utf-8');
    const lines = source.split('\n');

    const tailwindIdx = lines.findIndex((l) => /^\s*@import\s+["']tailwindcss["']/.test(l));
    const remoteImports = lines
        .map((line, i) => ({ line, lineNo: i + 1 }))
        .filter(({ line }) => /^\s*@import\s+url\(\s*["']?https?:/i.test(line));

    test('@import "tailwindcss" is present', () => {
        // Positive control for the ordering assertion below: without it,
        // `tailwindIdx` is -1 and any comparison against it is meaningless.
        expect(tailwindIdx).toBeGreaterThanOrEqual(0);
    });

    test('globals.css contains NO remote @import', () => {
        // The live invariant since #779. Falsifiable: adding one fails here.
        if (remoteImports.length > 0) {
            throw new Error(
                `globals.css has ${remoteImports.length} remote @import(s) on line(s) ` +
                    `${remoteImports.map((m) => m.lineNo).join(', ')}. Fonts are ` +
                    `self-hosted (#779) and there should be no third-party stylesheet ` +
                    `left. A remote @import is also an ordering hazard that 500'd the ` +
                    `site once — see this file's docblock. If one is genuinely needed, ` +
                    `delete this assertion deliberately and re-enable the ordering rule.`,
            );
        }
        expect(remoteImports).toEqual([]);
    });

    test('the fonts are imported from the generated same-origin stylesheet', () => {
        // Pairs with the assertion above: "no remote import" would also be
        // satisfied by importing no fonts at all, which would silently drop
        // every typeface to system-ui. This is what separates the two.
        expect(source).toMatch(/^\s*@import\s+'\.\.\/styles\/fonts\.css';/m);
    });

    test('ORDERING RULE (dormant): any remote @import would have to precede tailwindcss', () => {
        // Kept executable rather than deleted, so it is ready the moment a
        // remote import returns — and so the reasoning survives in code rather
        // than only in this docblock. Vacuous TODAY by design, which is
        // acceptable only because the assertion above makes the emptiness
        // itself the thing being enforced.
        const misplaced = remoteImports.filter(({ lineNo }) => lineNo > tailwindIdx + 1);
        expect(misplaced).toEqual([]);
    });
});
