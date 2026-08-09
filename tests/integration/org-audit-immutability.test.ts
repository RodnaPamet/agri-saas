/**
 * Epic B — OrgAuditLog immutability + hash chain (integration).
 *
 * Real Postgres. Skipped if no DB is available (mirrors
 * `audit-immutability.test.ts`).
 *
 * Coverage:
 *   ✅ INSERT via appendOrgAuditEntry succeeds
 *   ❌ UPDATE blocked by trigger (org_audit_log_immutable)
 *   ❌ DELETE blocked by trigger
 *   ✅ Three-row chain: previousHash linkages correct, recompute matches
 *   ✅ verifyOrgAuditChain returns valid=true on a clean chain
 *   ✅ Tampering (raw INSERT bypassing the writer with a wrong hash)
 *      breaks the chain at the right index
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import {
    appendOrgAuditEntry,
    verifyOrgAuditChain,
} from '@/lib/audit/org-audit-writer';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('OrgAuditLog — immutability + hash chain', () => {
    let prisma: PrismaClient;
    let organizationId: string;
    let actorUserId: string;
    let targetUserId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        // Make sure the immutability trigger is enabled (parallel
        // suites may temporarily disable it for cleanup).
        try {
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "OrgAuditLog" ENABLE TRIGGER org_audit_log_immutable`,
            );
        } catch { /* migration may not have run on this DB yet */ }

        const org = await prisma.organization.upsert({
            where: { slug: 'org-audit-test' },
            update: {},
            create: { name: 'Org Audit Test', slug: 'org-audit-test' },
        });
        organizationId = org.id;

        const actor = await prisma.user.create({ data: { email: `actor-${Date.now()}@org-audit-test.local` } });
        actorUserId = actor.id;
        const target = await prisma.user.create({ data: { email: `target-${Date.now()}@org-audit-test.local` } });
        targetUserId = target.id;
    });

    afterAll(async () => {
        // Cleanup using the documented bypass — same pattern as
        // audit-immutability.test.ts.
        try {
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "OrgAuditLog" WHERE "organizationId" = $1`,
                    organizationId,
                );
            });
        } catch { /* tolerate */ }
        await prisma.$disconnect();
    });

    // ── Append + chain integrity ─────────────────────────────────

    it('appendOrgAuditEntry inserts a row with first-entry previousHash=null', async () => {
        const result = await appendOrgAuditEntry(
            {
                organizationId,
                actorUserId,
                action: 'ORG_MEMBER_ADDED',
                targetUserId,
                detailsJson: { role: 'ORG_ADMIN', provisionedTenantCount: 0 },
            },
            prisma,
        );
        expect(result.entryHash).toMatch(/^[0-9a-f]{64}$/);
        expect(result.previousHash).toBeNull();
    });

    it('three sequential appends produce a correctly-linked chain', async () => {
        const a = await appendOrgAuditEntry(
            {
                organizationId,
                actorUserId,
                action: 'ORG_MEMBER_ROLE_CHANGED',
                targetUserId,
                detailsJson: { previousRole: 'ORG_READER', newRole: 'ORG_ADMIN' },
            },
            prisma,
        );
        const b = await appendOrgAuditEntry(
            {
                organizationId,
                actorUserId,
                action: 'ORG_ADMIN_PROVISIONED_TO_TENANTS',
                targetUserId,
                detailsJson: { tenantCount: 2, tenantIds: ['t-a', 't-b'], role: 'AUDITOR' },
            },
            prisma,
        );
        const c = await appendOrgAuditEntry(
            {
                organizationId,
                actorUserId,
                action: 'ORG_MEMBER_REMOVED',
                targetUserId,
                detailsJson: { previousRole: 'ORG_ADMIN', deprovisionedTenantCount: 2 },
            },
            prisma,
        );

        // Each entry's previousHash points to its predecessor's
        // entryHash (within the same org chain).
        expect(b.previousHash).toBe(a.entryHash);
        expect(c.previousHash).toBe(b.entryHash);

        const verification = await verifyOrgAuditChain(organizationId, prisma);
        expect(verification.valid).toBe(true);
        expect(verification.totalEntries).toBeGreaterThanOrEqual(3);
        expect(verification.firstBreakAt).toBeUndefined();
    });

    // ── Append-only enforcement at the DB layer ──────────────────

    it('UPDATE on OrgAuditLog raises restrict_violation (immutability trigger)', async () => {
        // Grab any row from this org's chain.
        const rows: Array<{ id: string }> = await prisma.$queryRawUnsafe(
            `SELECT id FROM "OrgAuditLog" WHERE "organizationId" = $1 LIMIT 1`,
            organizationId,
        );
        expect(rows.length).toBeGreaterThan(0);

        let threw = false;
        try {
            await prisma.$executeRawUnsafe(
                `UPDATE "OrgAuditLog" SET "actorType" = 'TAMPERED' WHERE "id" = $1`,
                rows[0].id,
            );
        } catch (e) {
            threw = true;
            expect(String(e)).toMatch(/IMMUTABLE_ORG_AUDIT_LOG/);
        }
        expect(threw).toBe(true);
    });

    it('DELETE on OrgAuditLog raises restrict_violation (immutability trigger)', async () => {
        const rows: Array<{ id: string }> = await prisma.$queryRawUnsafe(
            `SELECT id FROM "OrgAuditLog" WHERE "organizationId" = $1 LIMIT 1`,
            organizationId,
        );
        expect(rows.length).toBeGreaterThan(0);

        let threw = false;
        try {
            await prisma.$executeRawUnsafe(
                `DELETE FROM "OrgAuditLog" WHERE "id" = $1`,
                rows[0].id,
            );
        } catch (e) {
            threw = true;
            expect(String(e)).toMatch(/IMMUTABLE_ORG_AUDIT_LOG/);
        }
        expect(threw).toBe(true);
    });

    // ── Tampering detection ──────────────────────────────────────

    it('verifyOrgAuditChain detects a wrong-hash row in the chain', async () => {
        // Use a fresh org so we can control the entire chain.
        const tamperOrg = await prisma.organization.create({
            data: { name: 'Org Audit Tamper', slug: `org-audit-tamper-${Date.now()}` },
        });
        try {
            const a = await appendOrgAuditEntry(
                {
                    organizationId: tamperOrg.id,
                    actorUserId,
                    action: 'ORG_MEMBER_ADDED',
                    targetUserId,
                    detailsJson: { role: 'ORG_READER' },
                },
                prisma,
            );

            // Insert a row that bypasses the writer (raw SQL) and
            // carries a forged hash. The writer's append would
            // compute the correct hash; we deliberately use one that
            // doesn't match the canonical payload.
            const bogusId = `oa-bogus-${Date.now()}`;
            const fakeHash = 'f'.repeat(64);
            await prisma.$executeRawUnsafe(
                `INSERT INTO "OrgAuditLog" (
                    "id", "organizationId", "actorUserId", "actorType",
                    "action", "targetUserId", "detailsJson", "occurredAt",
                    "entryHash", "previousHash", "version"
                 ) VALUES (
                    $1, $2, $3, 'USER',
                    'ORG_MEMBER_REMOVED'::"OrgAuditAction", $4, '{"forged":true}'::jsonb,
                    NOW(), $5, $6, 1
                 )`,
                bogusId,
                tamperOrg.id,
                actorUserId,
                targetUserId,
                fakeHash,
                a.entryHash,
            );

            const verification = await verifyOrgAuditChain(tamperOrg.id, prisma);
            expect(verification.valid).toBe(false);
            expect(verification.firstBreakId).toBe(bogusId);
        } finally {
            // Clean the forged + first row using the bypass.
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "OrgAuditLog" WHERE "organizationId" = $1`,
                    tamperOrg.id,
                );
            });
            await prisma.organization.delete({ where: { id: tamperOrg.id } });
        }
    });
});
