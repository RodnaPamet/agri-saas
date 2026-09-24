/**
 * Every tenant API route authenticates itself — the guard that makes the
 * API-key Edge carve-out safe.
 *
 * ## Why this exists
 *
 * `src/middleware.ts` lets a request carrying an `iflk_` bearer past
 * `getToken()` WITHOUT authenticating it, for the same reason SCIM gets the
 * same treatment: the key is an opaque token compared against a hash, and the
 * Edge has no database. The carve-out is bounded to `/api/t/`.
 *
 * That moves the entire authentication burden onto the route handlers for
 * every route under that prefix. A handler that forgets to resolve a context
 * is not "missing a check" — with the carve-out in place it is an
 * unauthenticated, tenant-scoped endpoint reachable from the internet by
 * anyone who sends a header starting `iflk_`.
 *
 * So this guard is FAIL-CLOSED and derives its inventory from the FILESYSTEM.
 * A new file under `src/app/api/t/` is covered the moment it is created.
 * Nothing has to be remembered and no list has to be updated — which is the
 * property the carve-out's safety actually rests on, since the routes it will
 * expose tomorrow do not exist today.
 *
 * ## Why a source-text guard rather than a runtime test
 *
 * A runtime test can only prove the routes that exist TODAY reject an
 * anonymous request. This has to hold for routes nobody has written yet, which
 * is what a structural scan is for. The runtime half — that a real request
 * with a real header reaches a real handler, and that a bad key does not — is
 * `tests/unit/api-key-edge-reachability.test.ts`. Neither substitutes
 * for the other.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const TENANT_API_DIR = path.join(REPO_ROOT, 'src/app/api/t');

/**
 * Calls that resolve an authenticated context.
 *
 * `getTenantCtx` and `getLegacyCtx` authenticate directly; `requirePermission`
 * and its siblings wrap `getTenantCtx`. `getOrgCtx` is the org-scoped
 * equivalent. Each either returns a context or throws — none can succeed
 * anonymously.
 *
 * `auth()` is included for the one route that uses it directly (the MFA
 * challenge, which runs during login and so has no tenant context to resolve
 * yet). It is safe under the carve-out for a reason worth stating: `auth()`
 * tries the cookie and then `resolveBearerSession()`, which resolves a NextAuth
 * JWE. An `iflk_` token is not a JWE, so an API key presenting itself there
 * resolves to no session and the route returns 401 — the key cannot borrow a
 * session by arriving on a route that only checks for one.
 */
const AUTH_CALL =
    /\b(getTenantCtx|getLegacyCtx|getOrgCtx|requirePermission|requireAnyPermission|requireAllPermissions|auth)\s*[<(]/;

/**
 * `[<(]` and not `\(` — the call may carry an explicit type argument, as in
 * `requirePermission<{ tenantSlug: string; membershipId: string }>('admin.members', …)`.
 * Requiring a bare paren reported 13 properly-authenticated admin routes as
 * open, which is the failure mode a guard must not have: it teaches the reader
 * that its output is noise, and the real finding is then indistinguishable
 * from the noise.
 */

/**
 * Shared handlers that authenticate on a route's behalf.
 *
 * A route may satisfy this guard by delegating, but only to a module named
 * here — and each one is itself asserted to authenticate below, so the
 * delegation cannot become a hole by the delegate changing. Keeping the list
 * explicit (rather than following imports arbitrarily) means adding a new
 * indirection is a reviewed act.
 */
const DELEGATES: ReadonlyArray<{ call: RegExp; source: string }> = [
    {
        call: /\bhandleIndexTiles\s*\(/,
        source: 'src/lib/agro/index-tiles-handler.ts',
    },
];

function routeFiles(): string[] {
    return collectSourceFiles({
        roots: [TENANT_API_DIR],
        extensions: ['.ts'],
        exclude: (rel) => !rel.endsWith('route.ts'),
        // Well below the real count (273 today). Not a target — it separates
        // "every route authenticates" from "no routes were examined", which
        // is the failure mode that would make this guard pass while the
        // carve-out stood wide open.
        floor: 200,
    });
}

describe('every route under /api/t authenticates', () => {
    const files = routeFiles();

    it('finds the routes it is meant to be checking (positive control)', () => {
        // An empty selection satisfies every assertion below. This is the
        // line that fails if the tree moves or the filter breaks.
        expect(files.length).toBeGreaterThan(200);
    });

    it('no route is reachable without resolving a context', () => {
        const delegateCalls = DELEGATES.map((d) => d.call);
        const unauthenticated = files
            .filter((full) => {
                const src = fs.readFileSync(full, 'utf8');
                if (AUTH_CALL.test(src)) return false;
                return !delegateCalls.some((re) => re.test(src));
            })
            .map((full) => path.relative(REPO_ROOT, full));

        if (unauthenticated.length > 0) {
            throw new Error(
                `${unauthenticated.length} route(s) under /api/t resolve no authenticated ` +
                    `context:\n\n  ${unauthenticated.join('\n  ')}\n\n` +
                    `The Edge lets any request bearing an \`iflk_\` token past ` +
                    `unauthenticated on this prefix (src/middleware.ts, "API-key ` +
                    `carve-out"), so such a route is open to the internet. Resolve a ` +
                    `context with getTenantCtx/requirePermission, or delegate to a ` +
                    `handler listed in DELEGATES in this file.`,
            );
        }
        expect(unauthenticated).toEqual([]);
    });

    it('every delegate authenticates, so delegation is not a hole', () => {
        for (const { source } of DELEGATES) {
            const full = path.join(REPO_ROOT, source);
            expect(fs.existsSync(full)).toBe(true);
            expect(AUTH_CALL.test(fs.readFileSync(full, 'utf8'))).toBe(true);
        }
    });

    it('control: the matcher rejects a route that only looks authenticated', () => {
        // Mechanism proof. A comment mentioning the helper, or a similarly
        // named local, must not satisfy the scan — otherwise the guard passes
        // on prose.
        expect(AUTH_CALL.test('// this route uses getTenantCtx elsewhere')).toBe(false);
        expect(AUTH_CALL.test('const notGetTenantCtxThing = 1;')).toBe(false);
        expect(AUTH_CALL.test('const ctx = await getTenantCtx(params, req);')).toBe(true);
        expect(AUTH_CALL.test('export const GET = requirePermission("admin.view", h);')).toBe(true);
        // The generic form, which an earlier version of this regex missed.
        expect(
            AUTH_CALL.test('requirePermission<{ tenantSlug: string }>("admin.members", h)'),
        ).toBe(true);
    });
});
