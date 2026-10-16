/**
 * PR-3 — Org dashboard → tenant dashboard parity ratchet.
 *
 *   1. PortfolioDashboard imports + mounts `<DashboardLayout>` (the
 *      same shell every tenant dashboard surface uses).
 *
 *   2. The bespoke `<header>` + `<Heading>` + `<p>` block is gone.
 *
 *   3. The page-header trio (title + description + actions) is
 *      threaded through DashboardLayout's `header` prop. The
 *      tenant-count stats line moves into `description`; the
 *      edit-dashboard / add-widget / done buttons move into
 *      `actions`.
 *
 *   4. The org dashboard inherits the canonical
 *      `animate-dashboard-rise-in` entry motion + the
 *      `space-y-section` vertical rhythm baked into
 *      DashboardLayout — the same first-paint feel the tenant
 *      dashboard has.
 *
 *   5. A stable `data-testid="org-dashboard"` lives on the outer
 *      wrapper so E2E specs can target it predictably.
 */
import { readCatalogue } from '../helpers/catalogue';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('PR-3 — org dashboard → tenant dashboard parity', () => {
    const src = read('src/app/org/[orgSlug]/(app)/PortfolioDashboard.tsx');

    it('imports the shared <DashboardLayout> shell', () => {
        expect(src).toMatch(
            /import\s*\{\s*DashboardLayout\s*\}\s*from\s*['"]@\/components\/layout\/DashboardLayout['"]/,
        );
    });

    it('mounts <DashboardLayout> as the outer shell with the org-dashboard testid', () => {
        expect(src).toMatch(/<DashboardLayout/);
        expect(src).toMatch(/data-testid="org-dashboard"/);
    });

    it('threads the header trio (title + description + actions) through PageHeader', () => {
        // Anchor on the JSX-shape `<DashboardLayout\n` so the
        // doc-comment that also mentions `<DashboardLayout>` doesn't
        // shift the slice window.
        const jsxIdx = src.search(/<DashboardLayout\n/);
        expect(jsxIdx).toBeGreaterThan(0);
        const block = src.slice(jsxIdx, jsxIdx + 800);
        expect(block).toMatch(/header=\{\{/);
        // T14 i18n — the title moved from a literal to `t('title')`
        // (the copy lives in messages/en.json under org.portfolio.title).
        // Accept either the literal OR the next-intl call, and cross-check
        // the English value so the rendered header contract still holds.
        expect(block).toMatch(/title:\s*(['"]Portfolio Overview['"]|t\(['"]title['"]\))/);
        const messages = readCatalogue('en');
        expect(messages.org.portfolio.title).toBe('Portfolio Overview');
        expect(block).toMatch(/description:\s*headerDescription/);
        expect(block).toMatch(/actions:\s*headerActions/);
    });

    it('preserves the tenant-count + pending-snapshot stats line', () => {
        // The pre-PR-3 stats line lived in `<p data-portfolio-header-stats>`.
        // The attribute survives the migration (moves onto the
        // inner `<span>` inside `headerDescription`) so external
        // tools that grep on it keep working.
        expect(src).toMatch(/data-portfolio-header-stats/);
        expect(src).toMatch(/data\.summary\.tenants\.total/);
        expect(src).toMatch(/data\.summary\.tenants\.pending/);
    });

    it('the bespoke <header> + <Heading> block is gone', () => {
        // Locking the ABSENCE of the legacy chrome — a future
        // refactor that puts the Heading back outside the
        // DashboardLayout shell would trip this assertion.
        expect(src).not.toMatch(/<Heading level=\{1\}>\s*Portfolio Overview/);
        // No top-level `<header className=` either.
        expect(src).not.toMatch(/<header className="flex items-end justify-between/);
    });

    it('edit-dashboard / add-widget / done actions live in the actions slot', () => {
        // All three testids must still be reachable.
        expect(src).toMatch(/data-testid="dashboard-edit-toggle"/);
        expect(src).toMatch(/data-testid="dashboard-add-widget"/);
        expect(src).toMatch(/data-testid="dashboard-edit-done"/);
    });

    it('uses DashboardLayout for the same animation + rhythm contract', () => {
        // The DashboardLayout shell carries `animate-dashboard-rise-in`
        // + `space-y-section`. Locking on the import path is enough
        // — the layout primitive's internal animation contract is
        // tested by the existing dashboard-layout primitive tests.
        const dashboardLayoutImpl = read('src/components/layout/DashboardLayout.tsx');
        expect(dashboardLayoutImpl).toMatch(/animate-dashboard-rise-in/);
    });
});
