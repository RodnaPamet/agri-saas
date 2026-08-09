/**
 * Structural ratchet: `PracticesClient` adopts `<EntityListPage>`.
 *
 * Locks the invariant that the practices list page sits on the shared
 * shell rather than re-introducing inline `<ListPageShell>` +
 * `<FilterToolbar>` + `<DataTable>` composition. Mirrors the shape of
 * `practice-detail-shell-adoption.test.ts` (Prompt 1).
 *
 * Why this exists: a future "tidy-up" PR could quietly inline the shell
 * back out and undo the entity-page-architecture work. This test fails
 * CI on that regression. Same idea as the Epic 52 list-page-shell
 * coverage ratchet — locking a shape, not a value.
 *
 * What it does NOT enforce: the contents of each cell / modal / button.
 * Those are tested by the rendered tests + downstream E2E flows. This
 * file ONLY asserts the *shell-adoption* contract.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CONTROLS_CLIENT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/practices/PracticesClient.tsx',
);

const source = readFileSync(CONTROLS_CLIENT, 'utf8');

describe('PracticesClient — EntityListPage adoption', () => {
    it('imports EntityListPage from the canonical path', () => {
        expect(source).toMatch(
            /import\s*\{\s*EntityListPage\s*\}\s*from\s*['"]@\/components\/layout\/EntityListPage['"];?/,
        );
    });

    it('mounts <EntityListPage<PracticeListItem>> at the top level of render', () => {
        expect(source).toContain('<EntityListPage<PracticeListItem>');
        expect(source).toContain('</EntityListPage>');
    });

    it('does NOT hand-roll <ListPageShell> directly (shell owns the composition)', () => {
        // The shell wraps ListPageShell internally. A direct import here
        // would mean the page is composing the shell manually again.
        expect(source).not.toMatch(
            /import\s*\{[^}]*\bListPageShell\b[^}]*\}\s*from\s*['"]@\/components\/layout\/ListPageShell['"]/,
        );
    });

    it('does NOT hand-roll <FilterToolbar> directly (shell owns the wiring)', () => {
        // Same reasoning — `filters` prop on EntityListPage is the
        // canonical seam.
        expect(source).not.toMatch(
            /import\s*\{[^}]*\bFilterToolbar\b[^}]*\}\s*from\s*['"]@\/components\/filters\/FilterToolbar['"]/,
        );
    });

    it('threads filters through the shell (defs + live search box)', () => {
        // Whitespace-tolerant — the prop literal can wrap across lines.
        // The `searchId` / `searchPlaceholder` props (retired by the
        // #443 kill sweep) were restored 2026-05-30 as a LIVE search
        // box — typing filters the table, no Enter. Both thread
        // through the shell alongside the filter `defs`.
        expect(source).toMatch(/filters\s*=\s*\{\{/);
        expect(source).toContain('defs: liveFilterDefs');
        expect(source).toContain("searchId: 'practices-search'");
        // i18n batch T07 — the placeholder routes through next-intl
        // (`t('searchPlaceholder')`); assert the key is wired AND the
        // en.json value preserves the "Search practices…" copy.
        expect(source).toMatch(/searchPlaceholder:\s*t\(['"]searchPlaceholder['"]\)/);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        expect(require('../../messages/en.json').practices.searchPlaceholder).toMatch(/^Search practices/);
    });

    it('threads the table config through the shell', () => {
        // table prop is required — shell forwards data/columns/etc.
        expect(source).toMatch(/table\s*=\s*\{\{/);
        // PR-1 — `data:` may bind to either the raw `practices`
        // array or its `useThresholdLoadMore`-windowed `visiblePractices`
        // slice. Both surface the same row shape to the table; what
        // matters is that the shell receives `practices`-derived data.
        expect(source).toMatch(/data:\s*(visiblePractices|practices)\b/);
        expect(source).toContain('columns: orderColumns(practiceColumns)');
        // `getRowId` is a stable `useCallback` (right-rail Phase 2 —
        // a referentially-stable row-id fn keeps a selection-toggle
        // re-render from rebuilding the DataTable model).
        expect(source).toContain('getRowId: getPracticeRowId');
        expect(source).toContain("'data-testid': 'practices-table'");
    });

    it('keeps the create action gated by appPermissions.practices.create', () => {
        // Regression guard — the refactor must not silently drop the
        // permission gate or the create button. Accept both ternary
        // (`? :`) and short-circuit (`&&`) gating styles — both correctly
        // hide the action when the permission is false.
        expect(source).toMatch(/appPermissions\.practices\.create\s*[?&]/);
        expect(source).toContain('new-practice-btn');
        // UI-15: the standalone "Frameworks" header button was removed.
        expect(source).not.toContain('frameworks-btn');
        // The Dashboard / Templates / Sankey shields linked to
        // `/practices/dashboard`, `/practices/templates` and
        // `/practices/sankey` — all three pages went with the practice
        // exoskeleton, so the buttons were live links to 404s. They must
        // not come back without their destinations.
        expect(source).not.toContain('practices-dashboard-btn');
        expect(source).not.toContain('install-templates-btn');
        expect(source).not.toContain('practices-sankey-btn');
    });

    it('preserves the rich domain cell behaviour (status / applicability / quick-edit)', () => {
        // The point of the refactor: keep Inflect's domain richness.
        // These ids are E2E-load-bearing.
        expect(source).toMatch(/status-pill-\$\{c\.id\}/);
        expect(source).toMatch(/applicability-pill-\$\{c\.id\}/);
        expect(source).toMatch(/practice-quick-edit-\$\{row\.original\.id\}/);
    });

    it('renders modals + sheet as children (page-state lives next to the page)', () => {
        // Modals/sheets must sit at the page level, not nested into the
        // shell — they own the page's state, not the shell's tree.
        expect(source).toContain('<NewPracticeModal');
        expect(source).toContain('<PracticeDetailSheet');
        // The justification modal was hosted here pre-2026-05-19;
        // it left when the inline-edit dropdowns were retired. The
        // justification flow now lives on the per-practice detail
        // page (asserted independently by practice-detail-* tests).
        expect(source).not.toMatch(/<Modal[\s>]/);
    });
});
