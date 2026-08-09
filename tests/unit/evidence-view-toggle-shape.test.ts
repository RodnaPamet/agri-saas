/**
 * Structural ratchet: Epic 43.2 view toggle preserves filter state.
 *
 * The toggle is in URL-only state via `useUrlFilters(['tab', 'view'])`,
 * NOT in `filterCtx`. Switching list ↔ gallery therefore cannot
 * disturb the filter state (`q` / `type` / `status` / `practiceId` /
 * retention pills) because both renderers consume the SAME
 * `displayEvidence` array which is computed off `filterCtx`.
 *
 * This test locks in that wiring shape so a future refactor can't
 * silently re-introduce per-view filter state and reset filters on
 * toggle.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
const EVIDENCE_CLIENT =
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx';

describe('Epic 43.2 — view toggle wiring', () => {
    const src = read(EVIDENCE_CLIENT);

    it('imports the gallery + toggle primitives from canonical paths', () => {
        expect(src).toMatch(
            /import\s*\{[^}]*\bEvidenceGallery\b[^}]*\}\s*from\s*['"]@\/components\/ui\/EvidenceGallery['"]/,
        );
        expect(src).toMatch(
            /import\s*\{[^}]*\bToggleGroup\b[^}]*\}\s*from\s*['"]@\/components\/ui\/toggle-group['"]/,
        );
        expect(src).toMatch(
            /import\s*\{[^}]*\bFreshnessBadge\b[^}]*\}\s*from\s*['"]@\/components\/ui\/FreshnessBadge['"]/,
        );
    });

    it('extends useUrlFilters to include the view selector (alongside tab)', () => {
        // useUrlFilters now manages BOTH tab and view — the view value
        // flips the renderer, the tab value flips the retention slice.
        // Filter pills (q / type / status / practiceId) live in
        // `filterCtx` and aren't touched by either.
        expect(src).toMatch(/useUrlFilters\(\[['"]tab['"],\s*['"]view['"]\]\)/);
    });

    it('derives a `viewMode` of list | gallery from the URL', () => {
        expect(src).toContain("filters.view === 'gallery'");
    });

    it('mounts the ToggleGroup with list and gallery options + ids', () => {
        expect(src).toContain(
            "id: 'evidence-view-list'",
        );
        expect(src).toContain(
            "id: 'evidence-view-gallery'",
        );
    });

    it('wires the toggle into setFilter, NOT into filter context', () => {
        // Locks the architecture: filter state stays in filterCtx,
        // view state stays in useUrlFilters.
        expect(src).toMatch(/selectAction=\{\(v\)\s*=>\s*setFilter\(['"]view['"]/);
    });

    it('renders <EvidenceGallery> when viewMode === gallery, <DataTable> otherwise', () => {
        expect(src).toMatch(/viewMode === ['"]gallery['"]\s*\?\s*\(\s*<EvidenceGallery/);
        expect(src).toMatch(/<DataTable/);
    });

    it('passes the SAME `displayEvidence` array to both renderers', () => {
        // Both views read from displayEvidence — the filtered list.
        // If a future refactor introduced separate per-view state
        // (e.g. galleryRows / tableRows) that would BREAK filter
        // preservation. This test fails CI on that regression.
        expect(src).toMatch(
            /<EvidenceGallery[\s\S]{0,300}rows=\{displayEvidence\}/,
        );
        // PR-1 — the table view binds `data` to the
        // `useThresholdLoadMore`-windowed `visibleEvidence` slice,
        // not the full `displayEvidence` array. The slice is the
        // same source filtered through a window — filter preservation
        // is unaffected (the hook narrows on the same array). Match
        // either binding so the gallery↔table regression class stays
        // covered.
        expect(src).toMatch(
            /<DataTable[\s\S]{0,300}data=\{(visibleEvidence|displayEvidence)\}/,
        );
    });

    it('keeps the columns dropdown out of the gallery view', () => {
        // The columns dropdown is only meaningful for the list view —
        // hiding it under viewMode === 'list' is the correct shape.
        // R10-PR6 unified the mount via `useColumnsDropdown` returning a
        // `dropdown` node; R-filter-gear (2026-06-07) renders BOTH gears
        // (filter + columns) as a fragment under the same list guard.
        // Accept any of those shapes — the invariant is `columnsDropdown`
        // stays gated behind `viewMode === 'list'`.
        expect(src).toMatch(
            /viewMode === ['"]list['"][\s\S]{0,300}columnsDropdown/,
        );
    });

    it('adds a freshness column to the list view', () => {
        // `id: 'freshness'` was added to evidenceColumnConfig.all and
        // evidenceColumnDropdown so the column reads cleanly through
        // the existing visibility plumbing.
        expect(src).toContain("id: 'freshness'");
        expect(src).toMatch(/<FreshnessBadge[\s\S]{0,400}lastRefreshedAt=/);
    });

    it('passes a fileUrl resolver that pins to the existing download route', () => {
        // The gallery must NOT invent a parallel preview API. It
        // re-uses the tenant-scoped download endpoint that already
        // serves images inline + redirects S3-hosted files.
        expect(src).toContain('/evidence/files/');
        expect(src).toContain('/download');
    });
});
