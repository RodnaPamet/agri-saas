/**
 * Guardrail: Epic C.1 — API permission coverage.
 *
 * Locks in two invariants for every "privileged" API route, so a future
 * PR that adds a sensitive endpoint cannot ship without API-layer
 * permission enforcement:
 *
 *   1. The route file uses `requirePermission(...)` from
 *      `@/lib/security/permission-middleware`.
 *   2. The route's URL pathname matches at least one rule in
 *      `ROUTE_PERMISSIONS` — the declarative source of truth that
 *      `tools/SDK generation/docs read`.
 *
 * "Privileged" is defined deterministically below — currently every
 * route under `src/app/api/t/[tenantSlug]/admin/`. This is intentionally
 * narrow for Epic C.1; widening to other privileged surfaces (billing,
 * security, sso) lands in C.2 once those routes adopt
 * `requirePermission` and gain map entries.
 *
 * The complementary guardrail `admin-route-coverage.test.ts` keeps the
 * legacy role-based guards (`requireAdminCtx` etc.) honest. The two
 * together mean: a privileged route either uses the new permission
 * key model OR the legacy role model — never neither.
 *
 * Failure messages are written to be copy-paste-actionable. A reviewer
 * who sees a CI failure here should know exactly which file to edit
 * and which line to add.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    ROUTE_PERMISSIONS,
    isRouteCovered,
    type RoutePermissionRule,
} from '@/lib/security/route-permissions';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Discovery ───────────────────────────────────────────────────────

/**
 * Roots that are scanned for privileged route files. Each entry comes
 * with a short description that surfaces in failure output so a
 * reviewer can see why the directory is in scope.
 */
const PRIVILEGED_ROOTS: ReadonlyArray<{
    /** Filesystem path relative to repo root. */
    relPath: string;
    /** Human-readable rationale, surfaced in failures. */
    why: string;
}> = [
    {
        relPath: 'src/app/api/t/[tenantSlug]/admin',
        why: 'Tenant admin surface — RBAC management, SCIM, integrations, key rotation.',
    },
    // Epic D.3 — billing, SSO, security session-management bulk
    // endpoints, and the MFA-policy PUT all moved off legacy
    // `requireAdminCtx` to `requirePermission(...)`. Their
    // route directories now belong in scope so a future regression
    // here gets caught.
    {
        relPath: 'src/app/api/t/[tenantSlug]/billing',
        why: 'Stripe checkout/portal/events — admin-only commercial actions.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/sso',
        why: 'Tenant SSO configuration — admin-only.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/security',
        why: 'Tenant security surface — MFA policy mutations + admin-driven session revocation.',
    },
    // Global framework catalogue. Both roots were absent, so a denial on
    // either emitted NO AUTHZ_DENIED row and neither was visible to this
    // guardrail — which is how a tenant-scoped route that can deprecate every
    // requirement of a standard, for every tenant, went unnoticed.
    {
        relPath: 'src/app/api/t/[tenantSlug]/frameworks',
        why:
            'Framework writes reach the GLOBAL catalogue (upsert-requirements ' +
            'can deprecate every requirement of a standard, zeroing coverage ' +
            'for all tenants). Catalogue arms are platform-tenant gated in the ' +
            'usecase; the permission is the audited role floor.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/schemes',
        why:
            'Scheme authoring writes the GLOBAL Framework table that every ' +
            'tenant reads, and burns a globally-unique key with no delete ' +
            'path. Platform-tenant gated in the usecase.',
    },
];

/**
 * Routes intentionally excluded from API permission coverage. Each
 * entry MUST carry a `reason` so the carve-out is reviewable.
 *
 * Format: relative path from `src/app` (the same prefix `Next.js`
 * uses), e.g. `api/t/[tenantSlug]/admin/foo/route.ts`.
 */
const EXCLUDED_ROUTES: ReadonlyArray<{ relPath: string; reason: string }> = [
    // ── Catalogue READS (#P1) ───────────────────────────────────────
    // The frameworks + schemes roots are in scope because their WRITES reach
    // the global catalogue. These three are read-only: browsing a standard's
    // control points is not a privileged act, and every role may do it
    // (`assertCanViewFrameworks` admits any authenticated member). Gating them
    // on `admin.manage` would hide the catalogue from the readers it exists
    // for. Each handler still resolves ctx via `getTenantCtx`, so tenant
    // membership is enforced.
    {
        relPath: 'api/t/[tenantSlug]/schemes/route.ts',
        reason:
            'GET only — lists government support measures (ДФЗ / МЗХ / EC). ' +
            'National open calls are public reference data, not one farm\'s ' +
            'business, so the route is read-open to every role exactly as ' +
            'AgriEvent and the news feed are. `getTenantCtx` still runs, so ' +
            'tenant membership is enforced and the route is not anonymous.',
    },
    {
        relPath: 'api/t/[tenantSlug]/frameworks/route.ts',
        reason:
            'GET only — lists the global catalogue. Read-open to every role ' +
            'via assertCanViewFrameworks; no write reachable here.',
    },
    {
        relPath: 'api/t/[tenantSlug]/frameworks/[frameworkKey]/tree/route.ts',
        reason:
            'GET only — requirement tree for display. Read-open to every ' +
            'role; no write reachable here.',
    },
    {
        relPath: 'api/t/[tenantSlug]/schemes/[schemeKey]/route.ts',
        reason:
            'GET only — one scheme plus this farm\'s progress against it. ' +
            'Catalogue reads are open to every role; the farm-specific half ' +
            'is tenant-scoped inside computeCoverage.',
    },
    {
        relPath: 'api/t/[tenantSlug]/schemes/[schemeKey]/applicability.csv/route.ts',
        reason:
            'GET only — the applicability CSV a farm hands its certifier. ' +
            'Read-open to every role; the export is of the caller\'s OWN ' +
            'tenant data (scoped in the usecase), not the catalogue.',
    },
    // Epic D.3 — self-service security routes that are intentionally
    // NOT admin-gated. Any authenticated tenant member may operate on
    // their own MFA enrolment / challenge / current session. The
    // handlers resolve ctx via `getTenantCtx` and the underlying
    // usecases scope each action to `ctx.userId`. Admin-driven
    // counterparts (`/admin/sessions`, `/security/sessions/revoke-{all,user}`)
    // ARE in scope and gated by `requirePermission`.
    {
        relPath: 'api/t/[tenantSlug]/security/sessions/revoke-current/route.ts',
        reason: 'Self-service: revoke MY sessions (scoped to ctx.userId).',
    },
    {
        relPath: 'api/t/[tenantSlug]/security/mfa/enroll/route.ts',
        reason: 'Self-service: enrol MY MFA factor (scoped to ctx.userId).',
    },
    {
        relPath: 'api/t/[tenantSlug]/security/mfa/enroll/start/route.ts',
        reason: 'Self-service: start MY MFA enrolment.',
    },
    {
        relPath: 'api/t/[tenantSlug]/security/mfa/enroll/verify/route.ts',
        reason: 'Self-service: verify MY MFA enrolment.',
    },
    {
        relPath: 'api/t/[tenantSlug]/security/mfa/challenge/verify/route.ts',
        reason: 'Self-service: complete MY MFA challenge during sign-in.',
    },
    // Epic 1, PR 2 — Platform-admin routes authenticated by PLATFORM_ADMIN_API_KEY
    // (X-Platform-Admin-Key header, constant-time verified). These routes operate
    // outside the tenant-session model — there is no tenantId or userId in scope
    // when the platform key is verified, so requirePermission(...) does not apply.
    // The key is injected by the orchestrator / secret-manager and is never exposed
    // to tenant-level callers.
    {
        relPath: 'api/admin/tenants/route.ts',
        reason: 'Platform-admin-key-gated: POST /api/admin/tenants — tenant-scope does not apply.',
    },
    {
        relPath: 'api/admin/tenants/[slug]/transfer-ownership/route.ts',
        reason: 'Platform-admin-key-gated: transfer-ownership — tenant-scope does not apply.',
    },
    {
        relPath: 'api/admin/agri-events/route.ts',
        reason:
            'Platform-admin-key-gated: POST /api/admin/agri-events — AgriEvent is a GLOBAL ' +
            'catalogue with no tenantId, so a tenant-scoped permission does not apply.',
    },
    {
        relPath: 'api/admin/agri-events/[id]/route.ts',
        reason:
            'Platform-admin-key-gated: PATCH/DELETE /api/admin/agri-events/[id] — global ' +
            'catalogue, tenant-scope does not apply.',
    },
    // Calendar roadmap PR 3 — the NewsDerivedEvent review surface. Same
    // shape as the agri-events entries above (GLOBAL catalogue, no
    // tenantId, platform-admin-key-gated).
    {
        relPath: 'api/admin/news-derived-events/route.ts',
        reason:
            'Platform-admin-key-gated: GET /api/admin/news-derived-events — global ' +
            'catalogue, tenant-scope does not apply.',
    },
    {
        relPath: 'api/admin/news-derived-events/[id]/approve/route.ts',
        reason:
            'Platform-admin-key-gated: POST .../approve — global catalogue, tenant-scope ' +
            'does not apply.',
    },
    {
        relPath: 'api/admin/news-derived-events/[id]/reject/route.ts',
        reason:
            'Platform-admin-key-gated: POST .../reject — global catalogue, tenant-scope ' +
            'does not apply.',
    },
];

const REPO_ROOT = path.resolve(__dirname, '../..');

function walkRouteFiles(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walkRouteFiles(full));
        } else if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
            out.push(full);
        }
    }
    return out;
}

function discoverPrivilegedRoutes(): string[] {
    const seen = new Set<string>();
    for (const root of PRIVILEGED_ROOTS) {
        const abs = path.resolve(REPO_ROOT, root.relPath);
        for (const f of walkRouteFiles(abs)) seen.add(f);
    }
    return Array.from(seen).sort();
}

/**
 * Convert a route file's filesystem path back to its URL pathname.
 *
 *   src/app/api/t/[tenantSlug]/admin/scim/route.ts
 *      → /api/t/acme/admin/scim
 *
 * `[tenantSlug]` becomes a literal segment so the regexes in
 * `ROUTE_PERMISSIONS` (which use `\/[^/]+`) match cleanly. Other
 * dynamic `[id]` segments are similarly stubbed.
 */
function fileToPathname(routeFile: string): string {
    const rel = path.relative(path.join(REPO_ROOT, 'src/app'), routeFile);
    const noFile = rel.replace(/\/route\.tsx?$/, '');
    const segments = noFile.split('/').map((seg) => {
        if (seg === '[tenantSlug]') return 'acme';
        if (seg.startsWith('[') && seg.endsWith(']')) return 'stub-id';
        return seg;
    });
    return '/' + segments.join('/');
}

function readSource(file: string): string {
    return fs.readFileSync(file, 'utf8');
}

function relPathFromRepo(file: string): string {
    return path.relative(REPO_ROOT, file);
}

function lookupExclusion(
    fileFromAppRoot: string,
): { reason: string } | undefined {
    return EXCLUDED_ROUTES.find((e) => e.relPath === fileFromAppRoot);
}

const PRIVILEGED_ROUTES = discoverPrivilegedRoutes();

// ─── Tests ───────────────────────────────────────────────────────────

describe('Epic C.1 — API permission coverage guardrail', () => {
    it('discovers at least one privileged route (sanity check)', () => {
        // Catches a refactor that moves the admin directory and
        // silently empties the entire suite.
        expect(PRIVILEGED_ROUTES.length).toBeGreaterThan(0);
    });

    test.each(
        PRIVILEGED_ROUTES.map((r) => [relPathFromRepo(r), r] as const),
    )('%s wraps its handlers with requirePermission(...)', (relFromRepo, full) => {
        const fromAppRoot = path.relative(
            path.join(REPO_ROOT, 'src/app'),
            full,
        );
        const exclusion = lookupExclusion(fromAppRoot);
        if (exclusion) {

            console.log(`[exempt] ${relFromRepo} — ${exclusion.reason}`);
            return;
        }

        const src = readSource(full);
        const ok = /requirePermission\s*[<(]/.test(src);

        if (!ok) {
            // High-signal failure message a reviewer can act on without
            // re-reading the test.
            throw new Error(
                [
                    `Privileged route is missing API-layer permission enforcement.`,
                    `  File:  ${relFromRepo}`,
                    `  Fix:   Wrap each exported handler with`,
                    `         requirePermission('admin.<key>', async (req, { params }, ctx) => { ... })`,
                    `         imported from '@/lib/security/permission-middleware'.`,
                    `         Then add the route URL to ROUTE_PERMISSIONS in`,
                    `         src/lib/security/route-permissions.ts.`,
                    `  Or:    If the route is intentionally exempt, append it to`,
                    `         EXCLUDED_ROUTES in this guardrail with a written reason.`,
                ].join('\n'),
            );
        }
    });

    test.each(
        PRIVILEGED_ROUTES.map((r) => [relPathFromRepo(r), r] as const),
    )('%s is registered in ROUTE_PERMISSIONS', (relFromRepo, full) => {
        const fromAppRoot = path.relative(
            path.join(REPO_ROOT, 'src/app'),
            full,
        );
        if (lookupExclusion(fromAppRoot)) return;

        const pathname = fileToPathname(full);

        if (!isRouteCovered(pathname)) {
            throw new Error(
                [
                    `Privileged route is not in the ROUTE_PERMISSIONS map.`,
                    `  File:     ${relFromRepo}`,
                    `  URL:      ${pathname}`,
                    `  Fix:      Add a rule in src/lib/security/route-permissions.ts:`,
                    ``,
                    `              {`,
                    `                  path: new RegExp(\`^\\\\/api\\\\/t\\\\/[^/]+\\\\/admin\\\\/<segment>(\\\\/.*)?$\`),`,
                    `                  permission: 'admin.<key>',`,
                    `                  note: 'Why this route is admin-only.',`,
                    `              }`,
                    ``,
                    `            …and ensure the rule's regex matches the URL above.`,
                ].join('\n'),
            );
        }
    });

    // ── Map sanity ──────────────────────────────────────────────────

    it('every rule in ROUTE_PERMISSIONS carries a non-trivial `note`', () => {
        const offenders = ROUTE_PERMISSIONS.filter(
            (r: RoutePermissionRule) => !r.note || r.note.trim().length < 20,
        ).map((r) => r.path.source);

        if (offenders.length > 0) {
            throw new Error(
                [
                    `ROUTE_PERMISSIONS contains rules with missing or trivial \`note\`:`,
                    ...offenders.map((p) => `  - ${p}`),
                    ``,
                    `Each rule must have a one-sentence rationale (>=20 chars) so a`,
                    `reviewer can validate the policy in code review without`,
                    `chasing the handler.`,
                ].join('\n'),
            );
        }
    });

    it('every rule references a real PermissionSet key', () => {
        // PermissionKey is a TS-only contract; this runtime check
        // prevents `as PermissionKey` casts from ever sneaking in.
        const adminPerms = getPermissionsForRole('ADMIN');
        const offenders: string[] = [];

        for (const rule of ROUTE_PERMISSIONS) {
            const keys = Array.isArray(rule.permission)
                ? rule.permission
                : [rule.permission];
            for (const k of keys) {
                const [domain, action] = k.split('.');
                const bag = (adminPerms as Record<string, Record<string, boolean>>)[
                    domain
                ];
                if (!bag || typeof bag[action] !== 'boolean') {
                    offenders.push(`${rule.path.source}: ${k}`);
                }
            }
        }

        if (offenders.length > 0) {
            throw new Error(
                [
                    `ROUTE_PERMISSIONS references unknown PermissionKey(s):`,
                    ...offenders.map((o) => `  - ${o}`),
                    ``,
                    `Check the spelling against PermissionSet in src/lib/permissions.ts`,
                    `and against the keys returned by getPermissionsForRole('ADMIN').`,
                ].join('\n'),
            );
        }
    });

    it('every rule path-regex matches at least one real route on disk', () => {
        // Catches dead rules left over after a route is moved or
        // deleted. A rule that matches nothing silently weakens the
        // map's coverage signal.
        const orphans: string[] = [];

        for (const rule of ROUTE_PERMISSIONS) {
            const matchesSomething = PRIVILEGED_ROUTES.some((file) =>
                rule.path.test(fileToPathname(file)),
            );
            if (!matchesSomething) {
                orphans.push(rule.path.source);
            }
        }

        if (orphans.length > 0) {
            throw new Error(
                [
                    `ROUTE_PERMISSIONS contains rules that match no route on disk:`,
                    ...orphans.map((p) => `  - ${p}`),
                    ``,
                    `If the route was moved or deleted, remove or update the rule.`,
                    `If the rule covers a future route, add it together with the`,
                    `route file in the same PR.`,
                ].join('\n'),
            );
        }
    });
});
