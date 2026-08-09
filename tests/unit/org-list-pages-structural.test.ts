/**
 * Epic O-4 — structural contract for the four cross-tenant list pages.
 *
 * Static-file checks (no jsdom, no React render). Locks the load-
 * bearing properties for each list page:
 *
 *   - server page exists at the canonical (app)/<entity>/page.tsx
 *   - server page resolves OrgContext via getOrgCtx and routes errors
 *     to notFound() (anti-enumeration)
 *   - server page calls the matching Epic O-3 portfolio usecase and
 *     hands serialised rows to the client island
 *   - client island uses ListPageShell + DataTable + TableEmptyState
 *     (platform primitives — never a hand-rolled <table>)
 *   - the row-link cell uses the pre-computed `drillDownUrl` from the
 *     usecase (never a hand-built href)
 *   - tenant attribution is rendered as a column on every cross-tenant
 *     list (controls / evidence)
 *
 * Mirrors the org-overview-structural.test.ts template.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

interface PageSpec {
    name: string;
    serverPath: string;
    clientPath: string;
    usecase: string;
    rowLinkPattern: RegExp;
    testIds: string[];
    requiresTenantColumn: boolean;
}

const PAGES: PageSpec[] = [
    {
        name: 'tenants',
        serverPath: 'src/app/org/[orgSlug]/(app)/tenants/page.tsx',
        clientPath: 'src/app/org/[orgSlug]/(app)/tenants/TenantsTable.tsx',
        usecase: 'getPortfolioTenantHealth',
        // Tenant link is the row.original.drillDownUrl (already
        // /t/{slug}/dashboard at the usecase layer).
        rowLinkPattern: /href=\{row\.original\.drillDownUrl\}/,
        testIds: ['org-tenants-table', 'org-tenant-link-'],
        // Tenant page IS the tenant list — the "tenant" column is the
        // primary entity, not a side-attribution column.
        requiresTenantColumn: false,
    },
    {
        name: 'controls',
        serverPath: 'src/app/org/[orgSlug]/(app)/controls/page.tsx',
        clientPath: 'src/app/org/[orgSlug]/(app)/controls/ControlsTable.tsx',
        // Cursor-paginated list usecase. The non-paginated
        // `getNonPerformingControls` remains for the dashboard
        // summary card + CSV export.
        usecase: 'listNonPerformingControls',
        rowLinkPattern: /href=\{row\.original\.drillDownUrl\}/,
        testIds: ['org-controls-table', 'org-control-link-', 'org-control-tenant-'],
        requiresTenantColumn: true,
    },
    {
        name: 'evidence',
        serverPath: 'src/app/org/[orgSlug]/(app)/evidence/page.tsx',
        clientPath: 'src/app/org/[orgSlug]/(app)/evidence/EvidenceTable.tsx',
        usecase: 'listOverdueEvidenceAcrossOrg',
        rowLinkPattern: /href=\{row\.original\.drillDownUrl\}/,
        testIds: ['org-evidence-table', 'org-evidence-link-', 'org-evidence-tenant-'],
        requiresTenantColumn: true,
    },
];

describe('Epic O-4 — cross-tenant list pages structural contract', () => {
    describe.each(PAGES)('$name page', (spec) => {
        it('server page exists at the canonical path', () => {
            expect(exists(spec.serverPath)).toBe(true);
        });

        it('client island file exists', () => {
            expect(exists(spec.clientPath)).toBe(true);
        });

        it('server page declares dynamic = "force-dynamic"', () => {
            expect(read(spec.serverPath)).toMatch(
                /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/,
            );
        });

        it('server page resolves OrgContext via getOrgCtx and routes errors to notFound()', () => {
            const src = read(spec.serverPath);
            expect(src).toMatch(/from\s+['"]@\/app-layer\/context['"]/);
            expect(src).toMatch(/getOrgCtx\s*\(\s*\{[^}]*orgSlug/);
            expect(src).toMatch(/}\s*catch\b[\s\S]*?notFound\s*\(\s*\)/);
        });

        it(`server page invokes ${spec.usecase} from the portfolio barrel`, () => {
            const src = read(spec.serverPath);
            expect(src).toMatch(/from\s+['"]@\/app-layer\/usecases\/portfolio['"]/);
            expect(src).toContain(spec.usecase);
        });

        it('client island is a "use client" component', () => {
            expect(read(spec.clientPath)).toMatch(/^['"]use client['"]/);
        });

        it('client island wraps in ListPageShell + DataTable + TableEmptyState', () => {
            const src = read(spec.clientPath);
            expect(src).toMatch(/from\s+['"]@\/components\/layout\/ListPageShell['"]/);
            expect(src).toMatch(/<ListPageShell/);
            expect(src).toMatch(/from\s+['"]@\/components\/ui\/table['"]/);
            expect(src).toMatch(/<DataTable/);
            expect(src).toMatch(/<TableEmptyState/);
        });

        it('row link uses the pre-computed drillDownUrl from the usecase', () => {
            // Anti-pattern guard: a hand-built `/t/${slug}/.../${id}`
            // would let the page drift from the usecase contract.
            // Force consumers to use row.original.drillDownUrl so the
            // single source of truth stays at the usecase layer.
            expect(read(spec.clientPath)).toMatch(spec.rowLinkPattern);
        });

        it('exposes stable test-ids for E2E targeting', () => {
            const src = read(spec.clientPath);
            for (const id of spec.testIds) {
                expect(src).toContain(id);
            }
        });

        if (spec.requiresTenantColumn) {
            it('renders tenant attribution as a column (cross-tenant rows)', () => {
                const src = read(spec.clientPath);
                // Column id="tenantName" + a header that references "Tenant".
                expect(src).toMatch(/id:\s*['"]tenantName['"]/);
                // i18n (T06/T07): header may be a literal or a next-intl
                // call, with or without a namespace prefix (e.g.
                // t('colTenant') or t('orgTable.colTenant')).
                expect(src).toMatch(/header:\s*(['"]Tenant['"]|t\(['"][\w.]*colTenant['"]\))/);
                // And renders the human-readable name from the row.
                expect(src).toMatch(/row\.original\.tenantName/);
            });
        }

        it('does not hand-roll a <table> (DataTable/Table primitive only)', () => {
            const src = read(spec.clientPath);
            expect(src).not.toMatch(/<table\b/);
        });
    });

    // ── Cross-page invariants ────────────────────────────────────────

    it('the pages collectively cover the spec entities', () => {
        // Was four; `risks` went with the risk register.
        const names = PAGES.map((p) => p.name).sort();
        expect(names).toEqual(['controls', 'evidence', 'tenants']);
    });

    it('every cross-tenant list resourceName is plural-aware', () => {
        // Locks consistent empty-state copy: "no controls" vs
        // "no control" — DataTable uses the resourceName to drive
        // pagination + empty-state language.
        for (const spec of PAGES) {
            const src = read(spec.clientPath);
            expect(src).toMatch(/resourceName=\{\(plural\)\s*=>/);
        }
    });
});
