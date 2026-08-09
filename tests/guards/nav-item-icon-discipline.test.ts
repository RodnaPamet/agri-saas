/**
 * Roadmap-12 PR-9 — NavItem icon discipline.
 *
 * The icon is the row's anchor. Four invariants:
 *
 *   1. The icon's `className` is the named const
 *      `NAV_ITEM_ICON_CLASS` — never a parallel hand-rolled string.
 *      This ties the runtime to the const that carries the
 *      rationale + the ratchet.
 *
 *   2. `NAV_ITEM_ICON_CLASS` composes `NAV_ITEM_ICON_SIZE` (the
 *      canonical 18×18 geometry) + `flex-shrink-0` (the icon
 *      doesn't get squeezed when a row's label is long). No other
 *      tokens — chrome stays minimal.
 *
 *   3. The icon carries `aria-hidden="true"` so the label is the
 *      accessible name. Screen readers announce "Practices", not
 *      "icon Practices". The icon is decorative.
 *
 *   4. The icon has NO other width/height tokens reaching it.
 *      A regression like `className={NAV_ITEM_ICON_CLASS + ' w-5
 *      h-5'}` would silently override the canonical 18×18.
 *      Lock the *only* size source against drift.
 *
 * What this ratchet does NOT police
 *
 *   - The icon library (lucide-react). The no-lucide ratchet
 *     handles import discipline product-wide.
 *   - The stroke width — that's the icon component's own
 *     responsibility (Lucide defaults to 2; design-system
 *     standardisation on 1.5 is a separate concern).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-item.tsx'),
    'utf8',
);

describe('Roadmap-12 PR-9 — NavItem icon discipline', () => {
    it('exports `NAV_ITEM_ICON_CLASS` composing the canonical size + flex-shrink-0', () => {
        // The const is a template literal that COMPOSES
        // NAV_ITEM_ICON_SIZE — not a duplicated string literal.
        // A regression that hand-copies the `w-[18px] h-[18px]`
        // string would un-link the icon recipe from the geometry
        // token's single source of truth.
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_ICON_CLASS\s*=\s*`([^`]+)`/,
        );
        expect(match).not.toBeNull();
        const recipe = match![1];

        // Composes NAV_ITEM_ICON_SIZE.
        expect(recipe).toMatch(/\$\{\s*NAV_ITEM_ICON_SIZE\s*\}/);
        // Carries flex-shrink-0.
        expect(recipe).toMatch(/\bflex-shrink-0\b/);
    });

    it('the icon `<Icon>` JSX consumes `NAV_ITEM_ICON_CLASS` (no parallel hand-roll)', () => {
        // Match the JSX exactly: className references the const,
        // nothing else interpolated alongside.
        expect(SRC).toMatch(
            /<Icon\s+className=\{NAV_ITEM_ICON_CLASS\}\s+aria-hidden="true"\s*\/>/,
        );
    });

    it('the icon carries `aria-hidden="true"` (label is the accessible name)', () => {
        // Already covered by the consume-the-const assertion
        // above, but locked separately so a future PR that splits
        // the className recipe but drops the aria-hidden attr
        // can't slip through.
        const iconJsx = SRC.match(/<Icon\s+[^/]+\/>/);
        expect(iconJsx).not.toBeNull();
        expect(iconJsx![0]).toMatch(/aria-hidden="true"/);
    });

    it('the icon JSX has NO other width/height tokens reaching it', () => {
        // The only size source is `NAV_ITEM_ICON_SIZE` (via
        // `NAV_ITEM_ICON_CLASS`). A regression that appends
        // `w-5 h-5` / `w-4` / `size-5` to the icon's className
        // would silently override the canonical 18×18. Catch any
        // such addition inside the `<Icon … />` JSX block.
        const iconJsx = SRC.match(/<Icon\s+[^/]+\/>/);
        expect(iconJsx).not.toBeNull();
        const inside = iconJsx![0];

        // No `w-N` / `w-[Npx]` / `h-N` / `h-[Npx]` / `size-N`
        // tokens directly in the JSX. (The const itself contains
        // `w-[18px] h-[18px]` but that's via the interpolated
        // NAV_ITEM_ICON_SIZE — NOT a literal in the JSX.)
        expect(inside).not.toMatch(/\bw-\d/);
        expect(inside).not.toMatch(/\bw-\[/);
        expect(inside).not.toMatch(/\bh-\d/);
        expect(inside).not.toMatch(/\bh-\[/);
        expect(inside).not.toMatch(/\bsize-\d/);
    });
});
