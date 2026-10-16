/**
 * PR-2 — Org shell parity ratchet (navbar + workspace switcher).
 *
 *   1. `<OrgWorkspaceSwitcher>` exists and mirrors `<TenantSwitcher>`'s
 *      Popover structure (two sections: Organizations + Workspaces,
 *      same MENU_ROW recipe, same trigger pill recipe + chevron).
 *
 *   2. TopChrome mounts `<OrgWorkspaceSwitcher>` on the org variant
 *      (no longer the passive `<OrgIdentityPill>`). Tenant variant
 *      stays on `<TenantSwitcher>`.
 *
 *   3. The org sidebar uses the canonical `<NavItem>` + `<NavSection>`
 *      primitives — same vocabulary the tenant sidebar (`SidebarNav`)
 *      uses. The legacy bespoke `OrgNavItem` / `OrgNavSection` are
 *      retired.
 *
 *   4. Both variants of TopChrome render the same `<NavBar>` shell
 *      structure with brand + breadcrumbs + slot stack — no second
 *      navbar style exists.
 */
import { readCatalogue } from '../helpers/catalogue';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('PR-2 — org shell parity', () => {
    describe('OrgWorkspaceSwitcher primitive', () => {
        const src = read('src/components/layout/org-workspace-switcher.tsx');

        it('exports the component + props shape', () => {
            expect(src).toMatch(/export function OrgWorkspaceSwitcher/);
            expect(src).toMatch(/export interface OrgWorkspaceSwitcherProps/);
        });

        it('reads useOrgContext (NOT useTenantContext) for the active context', () => {
            expect(src).toMatch(/useOrgContext\(\)/);
            expect(src).not.toMatch(/useTenantContext\(\)/);
        });

        it('renders BOTH Organizations and Workspaces sections', () => {
            // T04 i18n — the section headers moved behind t('organizations')
            // / t('workspaces'); match the t() references and cross-check the
            // en.json copy so the two-section contract still holds.
            expect(src).toMatch(/t\(['"]organizations['"]\)/);
            expect(src).toMatch(/t\(['"]workspaces['"]\)/);
            const messages = readCatalogue('en');
            expect(messages.switcher.organizations).toBe('Organizations');
            expect(messages.switcher.workspaces).toBe('Workspaces');
        });

        it('trigger pill carries the canonical testid + chevron', () => {
            expect(src).toMatch(/data-testid="top-chrome-org-switcher"/);
            expect(src).toMatch(/ChevronsUpDown/);
        });

        it('mirrors TenantSwitcher menu-row recipe (active-state styling)', () => {
            // Both switchers use the same MENU_ROW_ACTIVE_CLASS for
            // the active row highlight. The substring is the locking
            // anchor — any drift triggers the test.
            expect(src).toMatch(/bg-bg-subtle text-content-emphasis/);
        });

        it('Organizations section links to /org/{slug}', () => {
            expect(src).toMatch(/href=\{`\/org\/\$\{o\.slug\}`\}/);
        });

        it('Workspaces section links to /t/{slug}/dashboard', () => {
            expect(src).toMatch(/href=\{`\/t\/\$\{m\.slug\}\/dashboard`\}/);
        });
    });

    describe('TopChrome mounts the right switcher per variant', () => {
        const src = read('src/components/layout/TopChrome.tsx');

        it('imports OrgWorkspaceSwitcher', () => {
            expect(src).toMatch(
                /import\s*\{\s*OrgWorkspaceSwitcher\s*\}\s*from\s*['"]\.\/org-workspace-switcher['"]/,
            );
        });

        it('org variant mounts <OrgWorkspaceSwitcher>', () => {
            expect(src).toMatch(
                /variant === 'org'[\s\S]{0,400}<OrgWorkspaceSwitcher/,
            );
        });

        it('passive OrgIdentityPill is no longer mounted', () => {
            expect(src).not.toMatch(/<OrgIdentityPill\s*\/>/);
        });

        it('tenant variant continues to mount <TenantSwitcher>', () => {
            expect(src).toMatch(/<TenantSwitcher/);
        });
    });

    describe('Org sidebar adopts the canonical NavItem + NavSection', () => {
        const src = read('src/components/layout/OrgSidebarNav.tsx');

        it('imports the shared NavItem + NavSection primitives', () => {
            expect(src).toMatch(
                /import\s*\{\s*NavItem\s*\}\s*from\s*['"]\.\/nav-item['"]/,
            );
            expect(src).toMatch(
                /import\s*\{\s*NavSection\s*\}\s*from\s*['"]\.\/nav-section['"]/,
            );
        });

        it('the legacy bespoke OrgNavItem / OrgNavSection are gone', () => {
            // Both function/local helpers retired; only the shared
            // primitives remain. The defensive scan also checks for
            // the legacy `nav-link` class which carried the pre-R12
            // active-state.
            expect(src).not.toMatch(/function OrgNavItem\b/);
            expect(src).not.toMatch(/function OrgNavSection\b/);
            expect(src).not.toMatch(/className=\{`nav-link/);
        });

        it('uses <NavSection> + <NavItem> inside the nav loop', () => {
            // The org sidebar body now reads identically to the
            // tenant sidebar body (the only difference is the
            // section/item *data*, not the render).
            expect(src).toMatch(/<NavSection\b/);
            expect(src).toMatch(/<NavItem\b/);
        });
    });

    describe('Single navbar style across variants', () => {
        const topChrome = read('src/components/layout/TopChrome.tsx');

        it('TopChrome.tsx contains exactly one <NavBar> mount', () => {
            // Anchor on the JSX shape (`<NavBar` followed by newline
            // OR space-then-prop) so the `<NavBar>` mention in the
            // doc-comment header doesn't double-count.
            const matches = topChrome.match(/<NavBar\n/g);
            expect(matches).not.toBeNull();
            expect(matches!.length).toBe(1);
        });
    });
});
