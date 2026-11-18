/**
 * DB-backed SCIM 2.0 tenant-isolation + safety verification.
 *
 * The SCIM server (auth → usecases → routes) already exists and is
 * tenant-scoped + role-safe by construction; this suite is the MISSING
 * verification that proves those properties against a LIVE Postgres,
 * exercising the real usecases (not mocks — `tests/integration/scim.test.ts`
 * already covers the mocked unit-level contract).
 *
 * What it locks in:
 *   1. Cross-tenant LIST isolation — tenant A's ScimContext lists only
 *      tenant A's users; tenant B's users never appear.
 *   2. Cross-tenant FETCH/MODIFY fail-closed — get/patch/delete of a
 *      tenant-B user id under tenant A's context returns not-found and
 *      does NOT read or mutate B's row.
 *   3. Role safety — `scimCreateUser` can never provision ADMIN/OWNER
 *      regardless of the SCIM payload (`resolveScimRole` allow-list).
 *   4. Revoked-token auth — `authenticateScimRequest` rejects a revoked
 *      token (401 ScimAuthError); a live token resolves the correct
 *      `ctx.tenantId`, and tenant A's token resolves to tenant A ONLY.
 *   5. (Bonus) Group isolation — `scimListGroups` / `scimGetGroup` for
 *      tenant A never surface tenant B's groups (RLS + tenantId filter).
 *
 * Isolation model under test: the user usecases run on the GLOBAL prisma
 * client (no RLS), so their tenant safety comes ENTIRELY from the
 * explicit `tenantId: ctx.tenantId` predicate in every where-clause —
 * this suite is precisely the proof those predicates fail-close. The
 * group usecases additionally run inside `runInTenantContext` (RLS), so
 * they get defence-in-depth.
 *
 * Mirrors the structure of `tests/integration/rls-isolation.test.ts`:
 * `globalPrisma` via `PrismaPg` + `DB_URL`/`DB_AVAILABLE` from
 * `./db-helper`, create-in-`beforeAll` / clean-in-`afterAll`, and
 * `describeFn = DB_AVAILABLE ? describe : describe.skip`.
 */
// SCIM is turned OFF in production (owner ruling 2026-11-18). This suite
// exercises the dormant mechanism, so the flag is ON here; the off-state
// refusal is covered by tests/unit/scim-auth-metrics.test.ts.
jest.mock('@/lib/auth/tenant-sso-availability', () => ({
    isScimEnabled: async () => true,
    assertScimEnabled: async () => undefined,
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    authenticateScimRequest,
    hashToken,
    ScimAuthError,
    type ScimContext,
} from '@/lib/scim/auth';
import {
    scimListUsers,
    scimGetUser,
    scimCreateUser,
    scimPatchUser,
    scimDeleteUser,
} from '@/app-layer/usecases/scim-users';
import {
    scimListGroups,
    scimGetGroup,
} from '@/app-layer/usecases/scim-groups';

// Raw client (no middleware) — used ONLY for setup + cleanup, exactly
// like rls-isolation.test.ts. emailHash is provided explicitly because
// the raw client doesn't run the PII middleware that would populate it.
const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const BASE_URL = 'http://localhost:3000';

function makeScimRequest(token?: string): NextRequest {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    return new NextRequest('http://localhost:3000/api/scim/v2/Users', { headers });
}

/**
 * The SCIM usecases emit append-only AuditLog rows protected by the
 * `audit_log_immutable` DB trigger (DELETE/UPDATE raise
 * IMMUTABLE_AUDIT_LOG). Test cleanup must drop those rows so the
 * tenant FK can be deleted — the canonical pattern (see
 * audit-hash-chain.test.ts) momentarily sets
 * `session_replication_role = 'replica'` to bypass the trigger inside
 * one transaction. globalPrisma connects as the superuser, which the
 * setting requires.
 */
async function deleteAuditLogForTenant(tenantId: string): Promise<void> {
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId);
    });
}

describeFn('SCIM tenant isolation (DB-backed)', () => {
    const runId = randomUUID().slice(0, 8);

    // Two tenants, each with its own SCIM token + a user/membership.
    let tenantAId: string;
    let tenantBId: string;

    // Raw tokens (only the hash is stored at rest).
    const rawTokenA = `scim-a-${randomUUID()}`;
    const rawTokenB = `scim-b-${randomUUID()}`;
    const rawTokenRevoked = `scim-revoked-${randomUUID()}`;

    // Distinct emails per tenant so each gets its OWN User row (the
    // usecase resolves existing users by global emailHash) — makes the
    // "B never appears in A's list" assertion unambiguous.
    const emailA1 = `scim-a1-${runId}@a.example.com`;
    const emailA2 = `scim-a2-${runId}@a.example.com`;
    const emailB1 = `scim-b1-${runId}@b.example.com`;

    let ctxA: ScimContext;
    let ctxB: ScimContext;

    // Captured for the cross-tenant fetch/modify assertions.
    let userBId: string;
    let membershipBId: string;
    let scimGroupBId: string;

    beforeAll(async () => {
        // ── Tenants ──
        const tenantA = await globalPrisma.tenant.create({
            data: { name: `SCIM-Iso A ${runId}`, slug: `scim-iso-a-${runId}`, industry: 'Technology', maxRiskScale: 5 },
        });
        tenantAId = tenantA.id;

        const tenantB = await globalPrisma.tenant.create({
            data: { name: `SCIM-Iso B ${runId}`, slug: `scim-iso-b-${runId}`, industry: 'Technology', maxRiskScale: 5 },
        });
        tenantBId = tenantB.id;

        // ── SCIM tokens (store the SHA-256 hash, like the real mint path) ──
        await globalPrisma.tenantScimToken.create({
            data: { tenantId: tenantAId, label: 'A-live', tokenHash: hashToken(rawTokenA) },
        });
        await globalPrisma.tenantScimToken.create({
            data: { tenantId: tenantBId, label: 'B-live', tokenHash: hashToken(rawTokenB) },
        });
        // A revoked token belonging to tenant A — auth must reject it.
        await globalPrisma.tenantScimToken.create({
            data: {
                tenantId: tenantAId,
                label: 'A-revoked',
                tokenHash: hashToken(rawTokenRevoked),
                revokedAt: new Date(),
            },
        });

        ctxA = { tenantId: tenantAId, tokenId: 'tokA', tokenLabel: 'A-live' };
        ctxB = { tenantId: tenantBId, tokenId: 'tokB', tokenLabel: 'B-live' };

        // ── Seed users via the REAL usecase (parity with production path) ──
        // Tenant A: two users. Tenant B: one user (the cross-tenant target).
        await scimCreateUser(ctxA, { userName: emailA1, displayName: 'A One' }, BASE_URL);
        await scimCreateUser(ctxA, { userName: emailA2, displayName: 'A Two' }, BASE_URL);
        const createdB = await scimCreateUser(ctxB, { userName: emailB1, displayName: 'B One' }, BASE_URL);
        userBId = createdB.user.id;

        const mB = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { tenantId_userId: { tenantId: tenantBId, userId: userBId } },
        });
        membershipBId = mB.id;

        // ── A ScimGroup owned by tenant B (for the group-isolation bonus) ──
        const gB = await globalPrisma.scimGroup.create({
            data: {
                tenantId: tenantBId,
                externalId: `ext-b-${runId}`,
                displayName: `B Group ${runId}`,
                memberIds: [],
                membersJson: [],
            },
        });
        scimGroupBId = gB.id;
    });

    afterAll(async () => {
        // Leaf → root. AuditLog rows are produced by the usecase's audit
        // emission and reference the tenant; they need the trigger
        // bypass. Each step is independent so one failure can't strand
        // the rest (which would leave a tenant un-deletable on FK).
        for (const tid of [tenantAId, tenantBId].filter(Boolean)) {
            await deleteAuditLogForTenant(tid).catch(() => {});
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "ScimGroup" WHERE "tenantId" = $1`, tid).catch(() => {});
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "TenantScimToken" WHERE "tenantId" = $1`, tid).catch(() => {});
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "UserIdentityLink" WHERE "tenantId" = $1`, tid).catch(() => {});
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tid).catch(() => {});
        }
        // Users are global (no tenantId column); delete by the
        // deterministic lookup hash of the emails we created.
        for (const email of [emailA1, emailA2, emailB1]) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "User" WHERE "emailHash" = $1`,
                hashForLookup(email),
            ).catch(() => {});
        }
        for (const tid of [tenantAId, tenantBId].filter(Boolean)) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tid).catch(() => {});
        }
        await globalPrisma.$disconnect();
    });

    // ═══════════════════════════════════════════════════════════════
    // 1. Cross-tenant LIST isolation
    // ═══════════════════════════════════════════════════════════════
    describe('cross-tenant list isolation', () => {
        it('tenant A lists only tenant A users; tenant B users never appear', async () => {
            const { resources, total } = await scimListUsers(ctxA, BASE_URL, { count: 200 });

            const userNames = resources.map((u) => u.userName);
            expect(userNames).toEqual(expect.arrayContaining([emailA1, emailA2]));

            // Tenant B's user must NOT leak into tenant A's listing.
            expect(userNames).not.toContain(emailB1);
            for (const u of resources) {
                expect(u.userName.endsWith('@b.example.com')).toBe(false);
            }

            // `total` is the tenant-A membership count — also B-free.
            expect(total).toBeGreaterThanOrEqual(2);
        });

        it('tenant B lists only tenant B users; tenant A users never appear', async () => {
            const { resources } = await scimListUsers(ctxB, BASE_URL, { count: 200 });
            const userNames = resources.map((u) => u.userName);

            expect(userNames).toContain(emailB1);
            expect(userNames).not.toContain(emailA1);
            expect(userNames).not.toContain(emailA2);
        });

        it('userName filter under tenant A cannot match a tenant B user', async () => {
            // Even when A explicitly filters for B's exact userName, the
            // tenantId predicate fails it closed.
            const { resources } = await scimListUsers(ctxA, BASE_URL, {
                count: 200,
                filter: `userName eq "${emailB1}"`,
            });
            expect(resources).toHaveLength(0);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 2. Cross-tenant FETCH / MODIFY fail-closed
    // ═══════════════════════════════════════════════════════════════
    describe('cross-tenant fetch/modify fail-closed', () => {
        it('scimGetUser for a tenant B user id under tenant A returns null', async () => {
            const result = await scimGetUser(ctxA, userBId, BASE_URL);
            expect(result).toBeNull();
        });

        it('scimGetUser for the same id under tenant B (the owner) DOES resolve', async () => {
            // Proves the null above is isolation, not a non-existent id.
            const result = await scimGetUser(ctxB, userBId, BASE_URL);
            expect(result).not.toBeNull();
            expect(result?.userName).toBe(emailB1);
        });

        it('scimPatchUser of a tenant B user under tenant A returns null and does NOT mutate B', async () => {
            const before = await globalPrisma.tenantMembership.findUniqueOrThrow({
                where: { id: membershipBId },
            });

            const result = await scimPatchUser(
                ctxA,
                userBId,
                [{ op: 'replace', path: 'active', value: false }],
                BASE_URL,
            );
            expect(result).toBeNull();

            // B's membership row is byte-for-byte unchanged.
            const after = await globalPrisma.tenantMembership.findUniqueOrThrow({
                where: { id: membershipBId },
            });
            expect(after.status).toBe(before.status);
            expect(after.status).toBe('ACTIVE');
            expect(after.deactivatedAt).toEqual(before.deactivatedAt);
            expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
        });

        it('scimDeleteUser of a tenant B user under tenant A returns false and leaves B active', async () => {
            const ok = await scimDeleteUser(ctxA, userBId);
            expect(ok).toBe(false);

            const after = await globalPrisma.tenantMembership.findUniqueOrThrow({
                where: { id: membershipBId },
            });
            expect(after.status).toBe('ACTIVE');
            expect(after.deactivatedAt).toBeNull();
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 3. Role safety — SCIM can never provision ADMIN/OWNER
    // ═══════════════════════════════════════════════════════════════
    describe('role safety', () => {
        it('scimCreateUser with roles=[admin] provisions a non-privileged READER membership', async () => {
            const email = `scim-roleadmin-${runId}@a.example.com`;
            try {
                const created = await scimCreateUser(
                    ctxA,
                    { userName: email, displayName: 'Wannabe Admin', roles: [{ value: 'admin' }] },
                    BASE_URL,
                );
                expect(created.created).toBe(true);

                const membership = await globalPrisma.tenantMembership.findUniqueOrThrow({
                    where: { tenantId_userId: { tenantId: tenantAId, userId: created.user.id } },
                });
                // The SCIM payload asked for ADMIN; resolveScimRole's
                // allow-list blocks it and falls back to the default.
                expect(membership.role).toBe('READER');
                expect(membership.role).not.toBe('ADMIN');
                expect(membership.role).not.toBe('OWNER');
            } finally {
                // The AuditLog rows these create are dropped en-masse by
                // afterAll (trigger-bypass). Here we only need to undo the
                // membership + user so they don't bleed into other assertions.
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1 AND "userId" IN (SELECT "id" FROM "User" WHERE "emailHash" = $2)`, tenantAId, hashForLookup(email)).catch(() => {});
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "emailHash" = $1`, hashForLookup(email)).catch(() => {});
            }
        });

        it('scimCreateUser with roles=[owner] also falls back to READER (allow-list excludes OWNER)', async () => {
            const email = `scim-roleowner-${runId}@a.example.com`;
            try {
                const created = await scimCreateUser(
                    ctxA,
                    { userName: email, displayName: 'Wannabe Owner', roles: [{ value: 'owner' }] },
                    BASE_URL,
                );
                const membership = await globalPrisma.tenantMembership.findUniqueOrThrow({
                    where: { tenantId_userId: { tenantId: tenantAId, userId: created.user.id } },
                });
                expect(['READER', 'EDITOR', 'AUDITOR']).toContain(membership.role);
                expect(membership.role).not.toBe('OWNER');
                expect(membership.role).not.toBe('ADMIN');
            } finally {
                // The AuditLog rows these create are dropped en-masse by
                // afterAll (trigger-bypass). Here we only need to undo the
                // membership + user so they don't bleed into other assertions.
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1 AND "userId" IN (SELECT "id" FROM "User" WHERE "emailHash" = $2)`, tenantAId, hashForLookup(email)).catch(() => {});
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "emailHash" = $1`, hashForLookup(email)).catch(() => {});
            }
        });

        it('scimCreateUser with an allowed role (editor) DOES provision EDITOR — allow-list is not a blanket downgrade', async () => {
            const email = `scim-roleeditor-${runId}@a.example.com`;
            try {
                const created = await scimCreateUser(
                    ctxA,
                    { userName: email, displayName: 'Editor', roles: [{ value: 'editor' }] },
                    BASE_URL,
                );
                const membership = await globalPrisma.tenantMembership.findUniqueOrThrow({
                    where: { tenantId_userId: { tenantId: tenantAId, userId: created.user.id } },
                });
                expect(membership.role).toBe('EDITOR');
            } finally {
                // The AuditLog rows these create are dropped en-masse by
                // afterAll (trigger-bypass). Here we only need to undo the
                // membership + user so they don't bleed into other assertions.
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1 AND "userId" IN (SELECT "id" FROM "User" WHERE "emailHash" = $2)`, tenantAId, hashForLookup(email)).catch(() => {});
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "emailHash" = $1`, hashForLookup(email)).catch(() => {});
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 4. Revoked-token auth + tenant-context cross-check
    // ═══════════════════════════════════════════════════════════════
    describe('authenticateScimRequest token + tenant binding', () => {
        it('rejects a revoked token with a 401 ScimAuthError', async () => {
            await expect(
                authenticateScimRequest(makeScimRequest(rawTokenRevoked)),
            ).rejects.toMatchObject({ name: 'ScimAuthError', status: 401 });
            await expect(
                authenticateScimRequest(makeScimRequest(rawTokenRevoked)),
            ).rejects.toThrow(ScimAuthError);
        });

        it('rejects a completely unknown token with a 401', async () => {
            await expect(
                authenticateScimRequest(makeScimRequest(`never-issued-${randomUUID()}`)),
            ).rejects.toMatchObject({ name: 'ScimAuthError', status: 401 });
        });

        it('rejects a missing Authorization header', async () => {
            await expect(
                authenticateScimRequest(makeScimRequest()),
            ).rejects.toThrow(ScimAuthError);
        });

        it("tenant A's live token resolves to tenant A ONLY", async () => {
            const ctx = await authenticateScimRequest(makeScimRequest(rawTokenA));
            expect(ctx.tenantId).toBe(tenantAId);
            expect(ctx.tenantId).not.toBe(tenantBId);
        });

        it("tenant B's live token resolves to tenant B ONLY", async () => {
            const ctx = await authenticateScimRequest(makeScimRequest(rawTokenB));
            expect(ctx.tenantId).toBe(tenantBId);
            expect(ctx.tenantId).not.toBe(tenantAId);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 5. Group isolation (bonus — RLS + tenantId filter)
    // ═══════════════════════════════════════════════════════════════
    describe('cross-tenant group isolation', () => {
        it('tenant A lists no tenant B groups', async () => {
            const groups = await scimListGroups({ tenantId: tenantAId });
            const ids = groups.map((g) => g.id);
            expect(ids).not.toContain(scimGroupBId);
            for (const g of groups) {
                expect(g.tenantId).toBe(tenantAId);
            }
        });

        it('scimGetGroup for a tenant B group under tenant A returns null', async () => {
            const group = await scimGetGroup({ tenantId: tenantAId }, scimGroupBId);
            expect(group).toBeNull();
        });

        it('scimGetGroup for the same group under tenant B (owner) resolves', async () => {
            const group = await scimGetGroup({ tenantId: tenantBId }, scimGroupBId);
            expect(group).not.toBeNull();
            expect(group?.id).toBe(scimGroupBId);
        });
    });
});
