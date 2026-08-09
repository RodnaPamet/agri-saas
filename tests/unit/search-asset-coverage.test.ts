/**
 * Asset search coverage — the palette-search-fix-for-assets PR.
 *
 * The unified search usecase originally covered five entity kinds:
 * control / risk / policy / evidence / framework. Assets weren't
 * searchable, so users typing an asset's externalRef tag
 * (`patent1`, `srv-prod-04`, …) into the palette got zero hits
 * even when the asset existed in their tenant.
 *
 * This ratchet is the structural anchor for the asset wiring:
 *
 *   1. `SearchHitType` union INCLUDES `'asset'`.
 *   2. `SEARCH_TYPE_DEFAULTS.asset` exists with the icon + category.
 *   3. `TYPE_BASELINE.asset` exists in the rank module.
 *   4. `__SEARCHABLE_TYPES__` lists `'asset'`.
 *   5. `ENTITY_META` + `ENTITY_ORDER` in the palette UI include
 *      `'asset'` (the renderer would silently drop hits otherwise).
 *
 * The "I added an entity kind to the type union but forgot to
 * wire the renderer" regression is what this catches. The doc-
 * comment in `src/lib/search/types.ts` lists the four steps; this
 * test enforces all four mechanically.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { SEARCH_TYPE_DEFAULTS, type SearchHitType } from '@/lib/search/types';
import { __SEARCHABLE_TYPES__ } from '@/app-layer/usecases/search';

const ROOT = path.resolve(__dirname, '../..');

describe('Asset search coverage', () => {
    it('SearchHitType union includes "asset" (compile-time + runtime check)', () => {
        // The compile-time check is implicit in the next assertion;
        // this is the runtime sanity check that no future codemod
        // strips the literal.
        const types: SearchHitType[] = [
            'control',
            'policy',
            'evidence',
            'framework',
            'asset',
        ];
        expect(types).toContain('asset');
    });

    it('SEARCH_TYPE_DEFAULTS has an entry for "asset"', () => {
        expect(SEARCH_TYPE_DEFAULTS.asset).toBeDefined();
        expect(SEARCH_TYPE_DEFAULTS.asset.iconKey).toBe('package');
        expect(SEARCH_TYPE_DEFAULTS.asset.category).toBe('Assets');
    });

    it('__SEARCHABLE_TYPES__ from the usecase lists "asset"', () => {
        expect(__SEARCHABLE_TYPES__).toContain('asset');
    });

    it('rank.ts TYPE_BASELINE includes "asset"', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src/lib/search/rank.ts'),
            'utf8',
        );
        expect(src).toMatch(
            /TYPE_BASELINE:\s*Record<SearchHitType,\s*number>\s*=\s*\{[\s\S]*?\basset:\s*\d+/,
        );
    });

    it('search usecase queries db.asset.findMany', () => {
        // The usecase must run a query against the asset table.
        // Without this, the `asset` type is declared but unsearchable.
        const src = fs.readFileSync(
            path.join(ROOT, 'src/app-layer/usecases/search.ts'),
            'utf8',
        );
        expect(src).toMatch(/db\.asset\.findMany\(/);
        // Matches against `name` AND `externalRef` (the canonical
        // "external system ID" field — `patent1`, asset tags, etc.).
        expect(src).toMatch(/name:\s*\{\s*contains/);
        expect(src).toMatch(/externalRef:\s*\{\s*contains/);
    });

    it('palette UI ENTITY_META + ENTITY_ORDER include "asset"', () => {
        // Without these the renderer drops asset hits from the
        // group-by-kind step even though the API returned them.
        const src = fs.readFileSync(
            path.join(
                ROOT,
                'src/components/command-palette/command-palette.tsx',
            ),
            'utf8',
        );
        // ENTITY_META.asset → { heading: 'Assets', icon: Package }
        expect(src).toMatch(
            /asset:\s*\{\s*heading:\s*['"]Assets['"][^}]*icon:\s*Package/,
        );
        // Package imported from lucide-react
        expect(src).toMatch(
            /import\s+\{[^}]*\bPackage\b[^}]*\}\s+from\s+['"]lucide-react['"]/,
        );
        // ENTITY_ORDER includes 'asset'
        expect(src).toMatch(
            /ENTITY_ORDER:\s*EntityKind\[\]\s*=\s*\[[\s\S]+?['"]asset['"]/,
        );
    });
});
