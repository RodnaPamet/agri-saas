/**
 * Structural ratchet — controls detail page composes via EntityDetailLayout.
 *
 * Static-file checks (no jsdom). Locks the load-bearing properties
 * of the controls detail page after the EntityDetailLayout refactor:
 *
 *   - The page imports + renders <EntityDetailLayout>
 *   - It still references all three domain-specific panels —
 *     TraceabilityPanel, LinkedTasksPanel, TestPlansPanel — so the
 *     shell extraction didn't accidentally flatten the rich content
 *     into a generic renderer.
 *   - It still owns the Edit modal, the sync-status badges, and
 *     the per-tab content blocks (overview / tasks / evidence /
 *     mappings / activity / tests / traceability).
 *   - The page no longer hand-rolls the tab bar (the shell paints
 *     it). The structural-equivalent assertion: the page does NOT
 *     contain the inline tab-button mapping pattern that lived in
 *     it before the refactor.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const PAGE_PATH = 'src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx';
const read = () => fs.readFileSync(path.join(ROOT, PAGE_PATH), 'utf-8');

describe('Controls detail page — EntityDetailLayout adoption', () => {
    it('imports EntityDetailLayout from @/components/layout', () => {
        const src = read();
        expect(src).toMatch(
            /from\s+['"]@\/components\/layout\/EntityDetailLayout['"]/,
        );
    });

    it('mounts <EntityDetailLayout> as the page wrapper', () => {
        expect(read()).toMatch(/<EntityDetailLayout\b/);
    });

    it('preserves the remaining domain-specific panels', () => {
        const src = read();
        // The shell's job is layout, not content. Domain panels stay.
        expect(src).toMatch(/<TraceabilityPanel\b/);
        expect(src).toMatch(/<LinkedTasksPanel\b/);
    });

    it('preserves the rich tab set (overview/tasks/evidence/mappings/traceability/activity)', () => {
        const src = read();
        for (const tab of [
            "tab === 'overview'",
            "tab === 'tasks'",
            "tab === 'evidence'",
            "tab === 'mappings'",
            "tab === 'traceability'",
            "tab === 'activity'",
        ]) {
            expect(src).toContain(tab);
        }
    });

    it('preserves sync-status badge logic', () => {
        const src = read();
        // The three sync-state badge ids stay — they're load-bearing
        // E2E selectors and locking them guards against an accidental
        // strip of the integration affordance during a refactor.
        expect(src).toContain('sync-conflict-badge');
        expect(src).toContain('sync-failed-badge');
        expect(src).toContain('sync-ok-badge');
    });

    it('preserves the Edit modal', () => {
        // Elevation PR-2 — modal extracted to _modals/EditControlModal.tsx.
        // The page renders <EditControlModal>; the modal sub-component
        // owns the inner <Modal> + 'control-edit-dialog' id.
        const src = read();
        expect(src).toContain('<EditControlModal');
        const modalSrc = fs.readFileSync(
            path.resolve(
                __dirname,
                '../..',
                'src/app/t/[tenantSlug]/(app)/controls/[controlId]/_modals/EditControlModal.tsx',
            ),
            'utf8',
        );
        expect(modalSrc).toContain('control-edit-dialog');
        expect(modalSrc).toMatch(/<Modal\b/);
    });

    it('does NOT hand-roll the tab bar (shell paints it)', () => {
        const src = read();
        // The prior page rendered an inline `tabs.map(t => <button …>)`
        // with the active-state classNames. The shell now owns that.
        // If a refactor regresses this and reintroduces the inline
        // mapping, the assertion catches it.
        expect(src).not.toMatch(
            /tabs\.map\([^)]*=>[\s\S]{0,200}className=`[^`]*border-b-2[^`]*\$\{tab\s*===\s*t\.key/,
        );
    });

    it('threads the tabs/activeTab/onTabChange contract through the shell', () => {
        const src = read();
        expect(src).toMatch(/tabs=\{tabs\}/);
        expect(src).toMatch(/activeTab=\{tab\}/);
        expect(src).toMatch(/onTabChange=\{/);
    });

    it('routes loading/error/empty through the shell (single visual style)', () => {
        const src = read();
        // Each branch returns the shell with the matching prop —
        // no bespoke skeleton / error / empty divs at the top level.
        expect(src).toMatch(/<EntityDetailLayout\s+loading\b/);
        expect(src).toMatch(/<EntityDetailLayout\s+error=/);
        expect(src).toMatch(/<EntityDetailLayout\s+empty=/);
    });
});

// ─── Epic 69 — SWR-first migration pins ──────────────────────────────

describe('Controls detail page — Epic 69 SWR migration', () => {
    /**
     * Strip block + line comments so prose mentions of TanStack /
     * `router.refresh()` in the migration's docstrings don't trip
     * the negative assertions. We only want to match real call
     * expressions in executable code.
     */
    function stripComments(src: string): string {
        return src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
    }

    it('reads via useTenantSWR keyed at CACHE_KEYS.controls.pageData()', () => {
        const src = read();
        expect(src).toContain("from '@/lib/hooks/use-tenant-swr'");
        expect(src).toContain('useTenantSWR');
        expect(src).toContain('CACHE_KEYS.controls.pageData(');
    });

    it('writes status via useTenantMutation with an optimistic updater', () => {
        const src = read();
        expect(src).toContain("from '@/lib/hooks/use-tenant-mutation'");
        // The status mutation MUST carry an `optimisticUpdate` —
        // without it, the badge would still show stale state through
        // the POST round-trip and the migration would be cosmetic.
        expect(src).toContain('useTenantMutation');
        // At least one mutation block on this page declares
        // `optimisticUpdate:` (status, edit). Locks the contract.
        expect(src.match(/optimisticUpdate:/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });

    it('invalidates the controls list cache after the status mutation', () => {
        const src = read();
        // The list page must refresh after the status flip — pin
        // that the `invalidate` array references the list key.
        expect(src).toContain('CACHE_KEYS.controls.list()');
    });

    it('does NOT use TanStack React Query (queryKeys / useQuery / useMutation / useQueryClient)', () => {
        const code = stripComments(read());
        // Negative pins — every React Query symbol that previously
        // lived on this page is gone.
        expect(code).not.toMatch(/from\s+['"]@tanstack\/react-query['"]/);
        expect(code).not.toMatch(/\bqueryKeys\./);
        expect(code).not.toMatch(/\buseQueryClient\b/);
        expect(code).not.toMatch(/\.invalidateQueries\b/);
    });

    it('does not invoke router.refresh() in the status path', () => {
        // Acceptance criterion from the Epic 69 brief: status
        // freshness flows through SWR cache invalidation, not coarse
        // Next-router refresh.
        const code = stripComments(read());
        expect(code).not.toMatch(/router\.refresh\s*\(/);
    });
});
