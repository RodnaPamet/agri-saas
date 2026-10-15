/**
 * B5 (2026-06-07) — the prev/next entity nav beside the detail-page name.
 *
 * `<EntityPrevNextNav>` is a reusable vertical up/down stepper that walks to
 * the previous / next entity in list order. The asset detail page is the
 * first adopter: it fetches the ordered asset-id list and mounts the nav
 * next to the asset name, so you can step through assets without returning
 * to the list. Disables the ends; renders nothing when there's nothing to
 * step through.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
// Comments blanked before matching (#1774). Comments only, NOT strings:
// an assertion about a string LITERAL would pass vacuously under
// `{ strings: true }`, which is why this stays a per-file decision.
const read = (p: string) =>
    blankNonCode(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const PRIM = read('src/components/ui/entity-prev-next-nav.tsx');
const ASSET = read('src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx');

describe('B5 — entity prev/next nav', () => {
    it('the primitive exposes up/down steppers, disables the ends, hides when empty', () => {
        expect(PRIM).toMatch(/export function EntityPrevNextNav/);
        // The per-stepper test-id is a template (`entity-nav-${prev|next}`).
        expect(PRIM).toMatch(/data-testid=\{`entity-nav-\$\{/);
        expect(PRIM).toMatch(/\? 'prev' : 'next'/);
        // hide when there's nothing to step through (single item / id not in window)
        expect(PRIM).toMatch(/idx < 0 \|\| ids\.length <= 1/);
        // disable a stepper when its neighbour doesn't exist
        expect(PRIM).toMatch(/disabled=\{!id\}/);
        // navigate via the router using the caller's href builder
        expect(PRIM).toMatch(/router\.push\(hrefFor\(id\)\)/);
    });

    it('the asset detail page mounts it beside the name with the ordered ids', () => {
        expect(ASSET).toMatch(/<EntityPrevNextNav/);
        expect(ASSET).toMatch(/ids=\{assetIds\}/);
        expect(ASSET).toMatch(/currentId=\{assetId\}/);
        // i18n (T11): labelSingular now resolves through useTranslations.
        expect(ASSET).toMatch(/labelSingular=\{t\('assetLabelSingular'\)\}/);
        // the ordered id list is fetched from the list endpoint
        expect(ASSET).toMatch(/setAssetIds/);
    });
});
