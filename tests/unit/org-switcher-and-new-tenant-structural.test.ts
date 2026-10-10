/**
 * Epic O-4 — structural contract for the OrgSwitcher + new-tenant form.
 *
 * Locks:
 *   - OrgSwitcher renders a portfolio entry + tenant rows with the
 *     correct hrefs (/org/{slug} and /t/{slug}/dashboard) so links
 *     stay deep-linkable and middle-clickable.
 *   - The trigger and rows expose stable test-ids for E2E targeting.
 *   - Switcher is mounted inside the org sidebar header so first-paint
 *     of every org page surfaces the context-switch affordance.
 *   - New-tenant page exists, gates on canManageTenants, posts to
 *     /api/org/{slug}/tenants, and lands on the new tenant's dashboard.
 *   - Form validation tightens the slug to the API contract regex
 *     before sending — fast feedback without a round-trip.
 *
 * P2.6 removed a third field. The form carried a "Starting framework"
 * radio group (ISO/IEC 27001, NIS2, ISO 9001, ISO 28000, ISO 39001) whose
 * non-default options pushed `/t/<slug>/frameworks?install=…` — a route
 * GRC teardown phase 2 deleted, so five of six options sent a brand-new
 * tenant to a 404. The assertions below now pin the ABSENCE of that
 * picker and of that redirect, because re-adding either is the
 * regression.
 */
import * as fs from 'fs';
import * as path from 'path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const SWITCHER = 'src/components/org-switcher.tsx';
const ORG_NAV = 'src/components/layout/OrgSidebarNav.tsx';
const NEW_TENANT_PAGE = 'src/app/org/[orgSlug]/(app)/tenants/new/page.tsx';
const NEW_TENANT_FORM = 'src/app/org/[orgSlug]/(app)/tenants/new/NewTenantForm.tsx';
const TENANTS_TABLE = 'src/app/org/[orgSlug]/(app)/tenants/TenantsTable.tsx';

describe('Epic O-4 — OrgSwitcher structural contract', () => {
    it('component file exists at the canonical path', () => {
        expect(exists(SWITCHER)).toBe(true);
    });

    it('is a client component (renders Popover)', () => {
        const src = read(SWITCHER);
        expect(src).toMatch(/^['"]use client['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/ui\/popover['"]/);
    });

    it('exposes typed props for context kind + current tenant', () => {
        const src = read(SWITCHER);
        // Locks the surface so the same component can later mount in
        // the tenant shell without prop-shape drift.
        expect(src).toMatch(/currentKind:\s*['"]org['"]\s*\|\s*['"]tenant['"]/);
        expect(src).toMatch(/currentTenantSlug\?:\s*string\s*\|\s*null/);
    });

    it('builds the portfolio link as /org/{slug} and tenant links as /t/{slug}/dashboard', () => {
        const src = read(SWITCHER);
        expect(src).toMatch(/href=\{`\/org\/\$\{orgSlug\}`\}/);
        expect(src).toMatch(/href=\{`\/t\/\$\{t\.slug\}\/dashboard`\}/);
    });

    it('lazy-fetches the tenant list from /api/org/{slug}/tenants', () => {
        const src = read(SWITCHER);
        // Endpoint is the Epic O-2 list route. Locking the URL means
        // a refactor of the API path forces a switcher update.
        expect(src).toMatch(/`\/api\/org\/\$\{orgSlug\}\/tenants`/);
    });

    it('exposes stable test-ids (trigger + portfolio + per-tenant)', () => {
        const src = read(SWITCHER);
        for (const id of [
            'org-switcher-trigger',
            'org-switcher-portfolio',
            'org-switcher-tenant-',
        ]) {
            expect(src).toContain(id);
        }
    });

    it('renders an aria-label on the trigger and role="status" on the loading region', () => {
        const src = read(SWITCHER);
        // T04 i18n — the aria-label moved from a literal to
        // `t('switchOrgContext')`; the English copy is asserted below to
        // stay exactly "Switch organization context" (a11y-stable label).
        expect(src).toMatch(/aria-label=\{\w+\(['"]switchOrgContext['"]\)\}/);
        const messages = JSON.parse(read('messages/en.json'));
        expect(messages.orgSwitcher.switchOrgContext).toBe('Switch organization context');
        expect(src).toMatch(/role="status"/);
    });

    it('avatar pill derives initials from orgName via formatInitials (no hardcoded "IC")', () => {
        // The trigger MUST NOT bake the brand initials into the
        // avatar pill — the pill represents the active org's
        // identity. Locks both the import + the substitution so a
        // future "minimal cleanup" PR doesn't quietly reintroduce
        // "IC".
        const src = read(SWITCHER);
        expect(src).toMatch(
            /import\s+\{\s*formatInitials\s*\}\s+from\s+['"]@\/lib\/format-initials['"]/,
        );
        expect(src).toMatch(/formatInitials\(orgName\)/);
        // Negative: the literal "IC" pill must be gone. Match
        // ">IC<" between JSX tags so we don't false-positive on
        // unrelated occurrences of those letters in identifiers.
        expect(src).not.toMatch(/>\s*IC\s*</);
        // Stable test-id for the dynamic content lets E2E assert
        // the rendered initials.
        expect(src).toContain('org-switcher-avatar-initials');
    });
});

describe('Epic O-4 — OrgSidebarNav mounts OrgSwitcher in the header', () => {
    it('imports OrgSwitcher', () => {
        expect(read(ORG_NAV)).toMatch(/from\s+['"]@\/components\/org-switcher['"]/);
    });

    it('renders <OrgSwitcher currentKind="org" /> in the sidebar', () => {
        const src = read(ORG_NAV);
        expect(src).toMatch(/<OrgSwitcher\b/);
        expect(src).toMatch(/currentKind=['"]org['"]/);
    });

    it('does not also keep the old static "Portfolio" tagline (avoid duplicate header)', () => {
        // The switcher carries its own tagline. A leftover static
        // "Portfolio" block would visually conflict.
        const src = read(ORG_NAV);
        const matches = src.match(/Portfolio<\/p>/g) ?? [];
        expect(matches.length).toBe(0);
    });
});

describe('Epic O-4 — new-tenant page structural contract', () => {
    it('server page + client form both exist', () => {
        expect(exists(NEW_TENANT_PAGE)).toBe(true);
        expect(exists(NEW_TENANT_FORM)).toBe(true);
    });

    it('server page declares dynamic = "force-dynamic"', () => {
        expect(read(NEW_TENANT_PAGE)).toMatch(
            /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/,
        );
    });

    it('server page resolves OrgContext, gates on canManageTenants, and routes errors to notFound()', () => {
        const src = read(NEW_TENANT_PAGE);
        expect(src).toMatch(/getOrgCtx\s*\(\s*\{[^}]*orgSlug/);
        expect(src).toMatch(/}\s*catch\b[\s\S]*?notFound\s*\(\s*\)/);
        expect(src).toMatch(/ctx\.permissions\.canManageTenants/);
        expect(src).toMatch(/throw\s+forbidden\(/);
    });

    it('client form is a "use client" component using shared form primitives', () => {
        const src = read(NEW_TENANT_FORM);
        expect(src).toMatch(/^['"]use client['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/ui\/form-field['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/ui\/input['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/ui\/button['"]/);
    });

    it('renders both spec fields (name, slug) and no framework picker', () => {
        const src = read(NEW_TENANT_FORM);
        expect(src).toContain('org-new-tenant-name');
        expect(src).toContain('org-new-tenant-slug');
        expect(src).not.toContain('org-new-tenant-framework');
        expect(src).not.toMatch(/FRAMEWORK_OPTIONS/);
    });

    it('POSTs to /api/org/{slug}/tenants with name + slug only (matches API contract)', () => {
        const src = read(NEW_TENANT_FORM);
        expect(src).toMatch(/`\/api\/org\/\$\{orgSlug\}\/tenants`/);
        // The request body uses the API's two fields — the only two the
        // form collects.
        expect(src).toMatch(
            /body:\s*JSON\.stringify\(\s*\{\s*name:[^,]+,\s*slug:[^}]+\}\s*\)/,
        );
    });

    it('lands on the new tenant dashboard and nowhere else', () => {
        const src = read(NEW_TENANT_FORM);
        const pushes = [...src.matchAll(/router\.push\(([^)]*)\)/g)].map((m) => m[1]);
        // Exactly one navigation, and it is the dashboard. A second
        // `router.push` is how the `/frameworks?install=` 404 got in.
        expect(pushes).toEqual(['`/t/${newSlug}/dashboard`']);
        // Belt-and-braces on the route itself — but over CODE, not prose.
        // The file's docblock names `/frameworks` on purpose, to say why the
        // picker is gone, so a whole-file `not.toContain` fails on the very
        // explanation it is meant to protect. (It did: that is this
        // assertion's own first red.)
        const code = blankNonCode(src);
        expect(code).toMatch(/router\.push/); // the strip did not eat everything
        expect(code).not.toContain('/frameworks');
    });

    it('validates the slug with the API contract regex before sending', () => {
        // Mirrors `SlugField` in `organization.schemas.ts` — fail fast
        // in the UI rather than waiting on a 400 round-trip.
        const src = read(NEW_TENANT_FORM);
        expect(src).toMatch(/SLUG_RE\s*=\s*\//);
        expect(src).toMatch(/SLUG_RE\.test\(trimmedSlug\)/);
    });

    it('renders submit/cancel/error/loading states with stable test-ids', () => {
        const src = read(NEW_TENANT_FORM);
        for (const id of [
            'org-new-tenant-submit',
            'org-new-tenant-cancel',
            'org-new-tenant-error',
            'org-new-tenant-back',
            'org-new-tenant-form',
        ]) {
            expect(src).toContain(id);
        }
    });
});

describe('Epic O-4 — Tenant list page exposes a "New tenant" CTA when permitted', () => {
    it('TenantsTable links to /org/{slug}/tenants/new and gates on canManageTenants', () => {
        const src = read(TENANTS_TABLE);
        expect(src).toMatch(/from\s+['"]@\/lib\/org-context-provider['"]/);
        expect(src).toMatch(/perms\.canManageTenants/);
        expect(src).toMatch(/`\/org\/\$\{orgSlug\}\/tenants\/new`/);
        expect(src).toContain('org-tenants-new-link');
    });
});
