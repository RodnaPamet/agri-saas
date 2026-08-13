/**
 * Structural ratchet — the canonical entity DETAIL page composes via
 * EntityDetailLayout and reads through the Epic 69 SWR seam.
 *
 * This file was `practice-detail-shell-adoption.test.ts`, pinned to the
 * practices detail page. GRC teardown phase 2 deleted that page, and the
 * app-layer work order was explicit that this ratchet must be RE-POINTED,
 * not deleted (§T5): it is the repo's only assertion that a real page
 * actually *threads* the shell's contract, as opposed to merely importing
 * it. The sibling guards are all weaker than they look —
 *
 *   - `entity-detail-shell-coverage` / `entity-detail-layout-coverage`
 *     assert only that `<EntityDetailLayout` appears and no back-link is
 *     hand-rolled;
 *   - `detail-page-tabs-slot` is a NEGATIVE pin (no page co-imports
 *     `TabSelect`) and never checks the props are passed;
 *   - `skeleton-parity` asserts the SHELL exposes `loading`, not that any
 *     page routes through it — and `state-coverage` actively EXEMPTS
 *     detail pages on the stated grounds that they "delegate loading to
 *     EntityDetailLayout", so deleting this file would have left that
 *     delegation asserted nowhere.
 *
 * The target is `journal/[id]`, NOT the `assets/[id]` the work order
 * suggested. Assets carries the shell half but is not SWR-migrated — its
 * line 5 is a standing comment reading "migrate to useTenantSWR (Epic 69
 * shape) so the rule can lift", so pinning the SWR half there would have
 * asserted a state the page has not reached. Journal satisfies both halves
 * against live source.
 *
 * One assertion from the original did NOT survive the move and is
 * deliberately absent rather than weakened: the practices page wrote status
 * via `useTenantMutation` with an `optimisticUpdate:` updater, and the
 * journal detail page has no optimistic write. That pin lives on for LIST
 * pages in `list-pages-swr-migration.test.ts`; when a detail page grows an
 * optimistic write, add it back here.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const PAGE_PATH = 'src/app/t/[tenantSlug]/(app)/journal/[id]/page.tsx';
const read = () => fs.readFileSync(path.join(ROOT, PAGE_PATH), 'utf-8');

describe('Entity detail page — EntityDetailLayout adoption', () => {
    it('the pinned page still exists (catches a silent move)', () => {
        expect(fs.existsSync(path.join(ROOT, PAGE_PATH))).toBe(true);
    });

    it('imports EntityDetailLayout from @/components/layout', () => {
        expect(read()).toMatch(
            /import\s+\{[^}]*EntityDetailLayout[^}]*\}\s+from\s+['"]@\/components\/layout/,
        );
    });

    it('mounts <EntityDetailLayout> as the page wrapper', () => {
        expect(read()).toMatch(/<EntityDetailLayout\b/);
    });

    it('threads the tabs/activeTab/onTabChange contract through the shell', () => {
        // The load-bearing half: a page can import the shell and still
        // paint its own tab bar. These three props are what prove the
        // shell is actually driving the tab UI.
        const src = read();
        expect(src).toMatch(/tabs=\{/);
        expect(src).toMatch(/activeTab=\{/);
        expect(src).toMatch(/onTabChange=\{/);
    });

    it('routes loading/error/empty through the shell (single visual style)', () => {
        // `state-coverage.test.ts` exempts detail pages BECAUSE of this
        // delegation. If this assertion goes, that exemption is unbacked.
        const src = read();
        expect(src).toMatch(/\bloading=\{/);
        expect(src).toMatch(/\berror=\{/);
        expect(src).toMatch(/\bempty=\{/);
    });

    it('does NOT hand-roll the tab bar (the shell paints it)', () => {
        const src = read();
        // The pre-refactor shape: an inline map over tab defs emitting
        // <button> elements. The shell owns this now.
        expect(src).not.toMatch(/\.map\(\s*\(?\s*tab\s*\)?\s*=>\s*\(?\s*<button/);
    });
});

describe('Entity detail page — Epic 69 SWR migration', () => {
    it('reads via useTenantSWR', () => {
        expect(read()).toMatch(/\buseTenantSWR\b/);
    });

    it('keys the read at a CACHE_KEYS entry', () => {
        expect(read()).toMatch(/\bCACHE_KEYS\b/);
    });

    it('does not reach back to react-query on the detail path', () => {
        // Epic 69 moved these pages off @tanstack/react-query onto the
        // SWR seam. A reintroduced query client here would split the
        // cache in two and make optimistic updates unobservable.
        const src = read();
        expect(src).not.toMatch(/from ['"]@tanstack\/react-query['"]/);
        expect(src).not.toMatch(/\buseQueryClient\b/);
        expect(src).not.toMatch(/\binvalidateQueries\b/);
    });

    it('does not force a full server round-trip with router.refresh()', () => {
        expect(read()).not.toMatch(/router\.refresh\(/);
    });
});
