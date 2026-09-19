/**
 * Guardrail: in-map parcel authoring invariants.
 *
 * Locks the load-bearing properties of the draw/edit feature:
 *
 *   1. `areaHa` is SERVER-DERIVED. The parcel write schemas must not
 *      accept a client `areaHa`, and the repository must compute it from
 *      the geometry via `areaHectaresSql`. A client that could set areaHa
 *      would desync the displayed area from the actual polygon.
 *
 *   2. terra-draw is a SINGLE SEAM. The drawing library is imported only
 *      by `MapCanvas` — every other surface goes through MapCanvas's
 *      `mode` / `onCreateGeometry` / `onUpdateGeometry` props, never a
 *      direct terra-draw import (mirrors the react-window single-seam
 *      discipline of Epic 68).
 *
 *   3. The authoring wiring is present: MapCanvas exposes the seam and
 *      the parcel routes call the create/update/delete usecases.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const MAP_CANVAS = 'src/components/ui/map/MapCanvas.tsx';
const GEO_SCHEMAS = 'src/app-layer/schemas/geo.schemas.ts';
const PARCEL_REPO = 'src/app-layer/repositories/ParcelRepository.ts';
const PARCEL_ITEM_ROUTE = 'src/app/api/t/[tenantSlug]/locations/[id]/parcels/[parcelId]/route.ts';
const PARCELS_ROUTE = 'src/app/api/t/[tenantSlug]/locations/[id]/parcels/route.ts';

// ─── 1 — areaHa is server-derived ──────────────────────────────────

describe('parcel areaHa is server-derived', () => {
    it('the parcel write schemas do not declare an areaHa field', () => {
        const src = read(GEO_SCHEMAS);
        // The schemas live in this file; none of them should name areaHa.
        expect(/\bareaHa\b/.test(src)).toBe(false);
    });

    it('ParcelRepository derives areaHa from geometry via areaHectares(NonNull)Sql', () => {
        const src = read(PARCEL_REPO);
        // Used in BOTH the create and the update write paths. The
        // data-integrity hardening swapped these to `areaHectaresNonNullSql`
        // (COALESCE→0 so a geometried parcel can never carry a NULL areaHa);
        // either server-derivation helper satisfies the invariant.
        const count = (src.match(/areaHectares(?:NonNull)?Sql\s*\(/g) ?? []).length;
        expect(count).toBeGreaterThanOrEqual(2);
    });
});

// ─── 2 — terra-draw is a single seam ───────────────────────────────

function walk(dir: string): string[] {
    const out: string[] = [];
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) return out;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(rel));
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
    }
    return out;
}

describe('terra-draw single seam', () => {
    it('control: walk returns the source tree this seam check scans', () => {
        // This is the entry #971 names as the first proven-dead selector:
        // `walk` gutted to `[]` left 6 of 6 tests green, because the seam
        // check is `walk('src').filter(...)` expecting no offenders and an
        // empty walk offends nobody.
        //
        // Per rule 3 of selector-teeth-baseline.json — "the exemption must be
        // deleted in the same PR" — its baseline entry goes in this diff.
        const files = walk('src');
        expect(files.length).toBeGreaterThan(200);
        expect(files.every((f) => f.startsWith('src/'))).toBe(true);
        expect(files.every((f) => /\.(ts|tsx)$/.test(f))).toBe(true);
        // The walk's own exclusion must hold, or the population silently grows.
        expect(files.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
        // And MAP_CANVAS — the one file allowed to import terra-draw — must be
        // IN the population, or the seam check is scanning past its subject.
        expect(files).toContain(MAP_CANVAS);
    });

    // Matches both static (`from 'terra-draw'`) and dynamic
    // (`import('terra-draw')`) imports — MapCanvas uses the dynamic form.
    const importRe = /(from\s+|import\s*\(\s*)['"]terra-draw(-maplibre-gl-adapter)?['"]/;

    it('only MapCanvas imports terra-draw', () => {
        const offenders = walk('src')
            .filter((rel) => rel !== MAP_CANVAS)
            .filter((rel) => importRe.test(read(rel)));
        expect(offenders).toEqual([]);
    });

    it('MapCanvas actually loads terra-draw + exposes the authoring seam', () => {
        const src = read(MAP_CANVAS);
        expect(importRe.test(src)).toBe(true);
        expect(src).toMatch(/onCreateGeometry/);
        expect(src).toMatch(/onUpdateGeometry/);
        expect(src).toMatch(/mode\??:\s*MapMode|mode = 'select'/);
    });
});

// ─── 3 — authoring wiring present ──────────────────────────────────

describe('parcel authoring routes wire the usecases', () => {
    it('POST /parcels calls createParcel', () => {
        expect(read(PARCELS_ROUTE)).toMatch(/createParcel\s*\(/);
    });
    it('PATCH/DELETE /parcels/:id call updateParcel + deleteParcel', () => {
        const src = read(PARCEL_ITEM_ROUTE);
        expect(src).toMatch(/updateParcel\s*\(/);
        expect(src).toMatch(/deleteParcel\s*\(/);
    });
});
