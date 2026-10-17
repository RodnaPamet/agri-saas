/**
 * GAP O4-1 — middleware org-route guard structural ratchet.
 *
 * Static-file checks (no Edge runtime, no DB, no jsdom) that lock
 * the middleware-level org-access wiring against silent regression:
 *
 *   1. `src/middleware.ts` imports `isOrgPath` + `checkOrgAccess`
 *      from `@/lib/auth/guard`.
 *   2. The middleware applies the org gate AFTER the JWT-presence
 *      check (so unauth requests are redirected to /login first,
 *      not bounced to /no-tenant) and AFTER the tenant gate.
 *   3. The org-gate failure branches collapse to a single external
 *      response — 404 JSON for API routes, redirect to /no-tenant
 *      for app pages — anti-enumeration parity with the tenant
 *      gate and with `getOrgCtx` / `getOrgServerContext`.
 *   4. The auth.ts JWT callback populates `token.orgMemberships`
 *      from `dbUser.orgMemberships` so the middleware has a fresh
 *      claim to check against.
 *
 * The pure-function behaviour of `checkOrgAccess` lives in
 * `tests/integration/middleware-org-gate.test.ts`. This file guards
 * the wiring between that helper and the middleware export.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => blankNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

describe('GAP O4-1 — middleware org-route guard structural ratchet', () => {
    it('middleware.ts imports both isOrgPath and checkOrgAccess from the guard module', () => {
        const src = read('src/middleware.ts');
        expect(src).toMatch(
            /from\s+['"]@\/lib\/auth\/guard['"]/,
        );
        expect(src).toMatch(/\bisOrgPath\b/);
        expect(src).toMatch(/\bcheckOrgAccess\b/);
    });

    it('middleware.ts gates /org/* with checkOrgAccess against token.orgMemberships', () => {
        const src = read('src/middleware.ts');
        // The gate must read from token.orgMemberships — same JWT
        // surface as the tenant gate's token.memberships.
        expect(src).toMatch(/checkOrgAccess\([^)]*token\.orgMemberships/);
    });

    it('org-gate failure paths collapse to a single external response (anti-enumeration)', () => {
        // Both `no_org_access` and `cross_org` must produce the
        // SAME external surface — 404 for API, /no-tenant redirect
        // for pages. A future regression that splits 403 vs 404
        // would re-leak org existence.
        const src = read('src/middleware.ts');
        // Find the org-gate block.
        const block = src.match(/if\s*\(\s*isOrgPath\(pathname\)\s*\)\s*\{[\s\S]*?\n\s{4}\}/);
        expect(block).not.toBeNull();
        const blockSrc = block![0];
        // Single failure branch (one if `gateResult !== 'allow'` —
        // OR a switch that funnels both states to the same response).
        // Either pattern is acceptable; we only forbid two distinct
        // status codes for the two failure modes.
        const has403 = /status:\s*403/.test(blockSrc);
        const has404OrNoTenant = /status:\s*404/.test(blockSrc) || /no-tenant/.test(blockSrc);
        expect(has403).toBe(false);
        expect(has404OrNoTenant).toBe(true);
    });

    it('org gate runs AFTER the JWT-presence check (unauth users redirect to /login first)', () => {
        // Locks the order: JWT verify → ... → org gate. If the org
        // gate ran before the JWT check, an unauth user would
        // bounce to /no-tenant instead of /login.
        const src = read('src/middleware.ts');
        const tokenCheckIdx = src.indexOf('if (!token)');
        const orgGateIdx = src.indexOf('isOrgPath(pathname)');
        expect(tokenCheckIdx).toBeGreaterThan(0);
        expect(orgGateIdx).toBeGreaterThan(0);
        expect(orgGateIdx).toBeGreaterThan(tokenCheckIdx);
    });

    it('auth.ts JWT callback populates token.orgMemberships from dbUser.orgMemberships', () => {
        const src = read('src/auth.ts');
        // The JWT callback must include `orgMemberships` in the
        // Prisma `findUnique({ include: { ... } })` so the JWT has
        // the data it needs to gate org routes without a DB hit.
        expect(src).toMatch(/orgMemberships:\s*\{[\s\S]*?orderBy/);
        // And it must be assigned onto the JWT.
        expect(src).toMatch(/token\.orgMemberships\s*=/);
    });

    it('OrgMembershipEntry shape is exported for middleware + page consumption', () => {
        const src = read('src/auth.ts');
        expect(src).toMatch(
            /export interface OrgMembershipEntry\s*\{[\s\S]*?slug:\s*string[\s\S]*?role:[\s\S]*?organizationId:\s*string/,
        );
    });

    it('Session augmentation includes orgMemberships so server components can read it', () => {
        const src = read('src/auth.ts');
        // Module augmentation for `next-auth` Session.user must
        // declare orgMemberships.
        expect(src).toMatch(
            /interface Session[\s\S]*?orgMemberships\?:\s*OrgMembershipEntry\[\]/,
        );
    });
});
