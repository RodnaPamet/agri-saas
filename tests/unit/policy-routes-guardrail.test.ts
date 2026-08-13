/**
 * Structural guardrail: tenant API route handlers are thin.
 *
 * They must NOT contain direct Prisma calls or audit logging — the
 * CLAUDE.md layer contract puts the HTTP boundary at `src/app/api`
 * (parse input, call usecases, return responses) and every query in
 * `src/app-layer/repositories`, every audit write behind `logEvent` in
 * a usecase.
 *
 * GRC teardown phase 2 deleted the `policies` API family with the Policy
 * model, which emptied this guard's only directory and left it vacuous.
 * It is RE-POINTED rather than deleted: this is the sole test in the repo
 * asserting the thin-route invariant, and 143 surviving KEEP-surface
 * routes are live subjects for it. The three assertions below are
 * unchanged from the policy-era version.
 *
 * Scope note — why a family list and not a bare walk of the whole
 * `src/app/api/t/[tenantSlug]` tree: five surviving routes outside these
 * families violate the invariant today and predate the teardown
 * (`admin/scim` queries Prisma directly; `access-reviews/[reviewId]/
 * evidence` uses `db.<model>`; `files/[fileName]/download`,
 * `admin/sessions` and `admin/key-rotation` call `logEvent` at the
 * boundary). Baselining those is a separate call than a test-repair
 * pass, so the guard covers the agri entity families — which are clean —
 * and a new violation inside them fails CI. Widening to the whole tree
 * is the follow-up, not a weakening of what is asserted here.
 *
 * (Filename kept as-is to avoid touching paths outside the teardown's
 * assigned set; the subject is the surviving tenant API families.)
 */
import path from 'path';
import fs from 'fs';

const API_ROOT = path.resolve(__dirname, '../../src/app/api/t/[tenantSlug]');

/**
 * Surviving KEEP-surface route families. Every one was verified clean
 * against all three assertions when this guard was re-pointed
 * (2026-08-13); a family that disappears fails the non-empty check below
 * rather than silently shrinking the sweep.
 */
const COVERED_FAMILIES = [
    'agro',
    'assets',
    'calendar',
    'climate',
    'costs',
    'equipment',
    'evidence',
    'exchange',
    'farm-tasks',
    'field-operations',
    'grain',
    'insurance',
    'inventory',
    'issues',
    'items',
    'journal',
    'knowledge',
    'leases',
    'locations',
    'offers',
    'planning',
    'schemes',
    'trends',
    'units',
] as const;

/**
 * MEASURED, not guessed: `find … -name route.ts` across the families
 * above returned 143 files on 2026-08-13. It is an anti-vacuity floor —
 * if a legitimate route deletion lowers it, lower this in the same diff.
 */
const MEASURED_ROUTE_COUNT = 143;

function getAllRouteFiles(dir: string): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;

    function walk(d: string) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name === 'route.ts') files.push(full);
        }
    }
    walk(dir);
    return files;
}

describe('Tenant API Route Structural Guardrails', () => {
    const routeFiles = COVERED_FAMILIES.flatMap((family) =>
        getAllRouteFiles(path.join(API_ROOT, family)),
    );

    it.each(COVERED_FAMILIES)(
        'the %s family still resolves to at least one route file',
        (family) => {
            // Guards against the failure mode that emptied the policy-era
            // version of this file: a directory that no longer exists
            // reads as "zero violations" instead of "not covered".
            expect(
                getAllRouteFiles(path.join(API_ROOT, family)).length,
            ).toBeGreaterThanOrEqual(1);
        },
    );

    it('sweeps the measured number of route files', () => {
        expect(routeFiles.length).toBeGreaterThanOrEqual(MEASURED_ROUTE_COUNT);
    });

    describe.each(routeFiles.map((f) => [path.relative(API_ROOT, f), f]))('%s', (_, filePath) => {
        const content = fs.readFileSync(filePath as string, 'utf-8');

        it('should not call prisma directly', () => {
            // Check for prisma.model.method() patterns
            expect(content).not.toMatch(/prisma\./);
            expect(content).not.toMatch(/db\.\w+\.\w+/);
        });

        it('should not call logEvent or logAudit directly', () => {
            expect(content).not.toMatch(/logEvent\s*\(/);
            expect(content).not.toMatch(/logAudit\s*\(/);
        });

        it('should use withApiErrorHandling', () => {
            expect(content).toContain('withApiErrorHandling');
        });
    });
});
