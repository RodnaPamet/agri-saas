/**
 * Data Lifecycle — Integration Tests
 *
 * Verifies:
 *   1. purgeSoftDeletedOlderThan only purges aged records
 *   2. Recently deleted records are NOT purged
 *   3. Active records are NOT purged
 *   4. purgeExpiredEvidenceOlderThan only purges long-archived evidence
 *   5. runRetentionSweep soft-deletes records with elapsed retentionUntil
 *   6. Audit events are emitted (DATA_PURGED, DATA_EXPIRED)
 *   7. dryRun does not mutate anything
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withSoftDeleteExtension } from '@/lib/soft-delete';
import {
    purgeSoftDeletedOlderThan,
    runRetentionSweep,
} from '@/app-layer/jobs/data-lifecycle';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { withPiiEncryptionExtension } from '@/lib/security/pii-middleware';

// Prisma 7 — soft-delete moved from `$use` to `$extends`. Wrap inline
// to mirror the production `src/lib/prisma.ts` composition.
const prisma = withPiiEncryptionExtension(
    withSoftDeleteExtension(
        new PrismaClient({
            adapter: new PrismaPg({ connectionString: DB_URL }),
        }),
    ),
);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const testTenantId = `dl-test-tenant-${Date.now()}`;
const testUserId = `dl-test-user-${Date.now()}`;

if (DB_AVAILABLE) {
    beforeAll(async () => {
        await prisma.tenant.create({
            data: { id: testTenantId, name: `DL Test ${Date.now()}`, slug: `dl-test-${Date.now()}` },
        });
        await prisma.user.create({
            data: { id: testUserId, email: `dl-test-${Date.now()}@example.com`, name: 'DL Test' },
        });
    });

    afterAll(async () => {
        // Clean up raw (bypass middleware)
        await prisma.$executeRawUnsafe('DELETE FROM "AuditLog" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Evidence" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Evidence" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "id" = $1', testUserId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', testTenantId).catch(() => {});
        await prisma.$disconnect();
    });
}

describeFn('Data Lifecycle', () => {
    // ─── purgeSoftDeletedOlderThan ───

    describe('purgeSoftDeletedOlderThan', () => {
        it('purges records whose grace period has elapsed', async () => {
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Old deleted evidence' },
            });

            // Set deletedAt to 100 days ago via raw SQL
            const oldDate = new Date(Date.now() - 100 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Evidence" SET "deletedAt" = $1 WHERE "id" = $2',
                oldDate, evidence.id,
            );

            // Run purge with 90-day grace
            const results = await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                db: prisma,
            });

            const evidenceResult = results.find(r => r.model === 'Evidence');
            expect(evidenceResult).toBeDefined();
            expect(evidenceResult!.purged).toBeGreaterThanOrEqual(1);

            // Verify hard-deleted
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Evidence" WHERE "id" = $1', evidence.id,
            );
            expect(rows).toHaveLength(0);
        });

        it('does NOT purge recently deleted records', async () => {
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Recently deleted' },
            });

            // Soft-delete it (deletedAt = now)
            await prisma.evidence.delete({ where: { id: evidence.id } });

            // Run purge with 90-day grace — should NOT purge
            await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                db: prisma,
            });

            // Verify still exists (soft-deleted but not purged)
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Evidence" WHERE "id" = $1', evidence.id,
            );
            expect(rows).toHaveLength(1);
        });

        it('does NOT purge active (non-deleted) records', async () => {
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Active practice' },
            });

            await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 0, // Even with 0 grace, active records should not be touched
                db: prisma,
            });

            const found = await prisma.evidence.findUnique({ where: { id: evidence.id } });
            expect(found).not.toBeNull();
        });

        it('emits DATA_PURGED audit event', async () => {
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Purge audit test' },
            });

            const oldDate = new Date(Date.now() - 100 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Evidence" SET "deletedAt" = $1 WHERE "id" = $2',
                oldDate, evidence.id,
            );

            await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                db: prisma,
            });

            const auditLogs = await prisma.auditLog.findMany({
                where: {
                    tenantId: testTenantId,
                    entityId: evidence.id,
                    action: 'DATA_PURGED',
                },
            });

            expect(auditLogs.length).toBeGreaterThanOrEqual(1);
            expect(auditLogs[0].details).toContain('soft_delete_grace_expired');
        });

        it('dryRun does not delete anything', async () => {
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'DryRun test' },
            });

            const oldDate = new Date(Date.now() - 200 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Evidence" SET "deletedAt" = $1 WHERE "id" = $2',
                oldDate, evidence.id,
            );

            const results = await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                dryRun: true,
                db: prisma,
            });

            const evidenceResult = results.find(r => r.model === 'Evidence');
            expect(evidenceResult).toBeDefined();
            expect(evidenceResult!.scanned).toBeGreaterThanOrEqual(1);
            expect(evidenceResult!.purged).toBe(0);

            // Record still exists
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Evidence" WHERE "id" = $1', evidence.id,
            );
            expect(rows).toHaveLength(1);
        });
    });

    // ─── runRetentionSweep ───

    describe('runRetentionSweep', () => {
        it('soft-deletes records with elapsed retentionUntil', async () => {
            // NOT Evidence: runRetentionSweep skips it deliberately
            // ("Evidence has its own specialized sweep"), so a record there
            // can never appear in these results. Contract is the surviving
            // model the sweep actually walks.
            const ev2 = await prisma.contract.create({
                data: {
                    tenantId: testTenantId,
                    counterparty: `Retention counterparty ${Date.now()}`,
                },
            });

            // Set retentionUntil to the past
            const pastDate = new Date(Date.now() - 10 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Contract" SET "retentionUntil" = $1 WHERE "id" = $2',
                pastDate, ev2.id,
            );

            const results = await runRetentionSweep({
                tenantId: testTenantId,
                db: prisma,
            });

            const evidenceRetentionResult = results.find(r => r.model === 'Contract');
            expect(evidenceRetentionResult).toBeDefined();
            expect(evidenceRetentionResult!.expired).toBeGreaterThanOrEqual(1);

            // Verify the record is now soft-deleted
            const found = await prisma.contract.findUnique({ where: { id: ev2.id } });
            expect(found).toBeNull(); // excluded by soft-delete filter

            // But raw SQL still has it
            const [raw] = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
                'SELECT "deletedAt" FROM "Contract" WHERE "id" = $1', ev2.id,
            );
            expect(raw).toBeDefined();
            expect(raw.deletedAt).not.toBeNull();
        });

        it('does NOT soft-delete records with future retentionUntil', async () => {
            const ev2 = await prisma.contract.create({
                data: {
                    tenantId: testTenantId,
                    counterparty: `Future evidence ${Date.now()}`,
                },
            });

            // Set retentionUntil to the future
            const futureDate = new Date(Date.now() + 365 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Contract" SET "retentionUntil" = $1 WHERE "id" = $2',
                futureDate, ev2.id,
            );

            await runRetentionSweep({ tenantId: testTenantId, db: prisma });

            const found = await prisma.contract.findUnique({ where: { id: ev2.id } });
            expect(found).not.toBeNull();
        });

        it('emits DATA_EXPIRED audit events', async () => {
            const ev2 = await prisma.contract.create({
                data: {
                    tenantId: testTenantId,
                    counterparty: `Retention audit test ${Date.now()}`,
                },
            });

            const pastDate = new Date(Date.now() - 5 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Contract" SET "retentionUntil" = $1 WHERE "id" = $2',
                pastDate, ev2.id,
            );

            await runRetentionSweep({ tenantId: testTenantId, db: prisma });

            const auditLogs = await prisma.auditLog.findMany({
                where: {
                    tenantId: testTenantId,
                    entityId: ev2.id,
                    action: 'DATA_EXPIRED',
                },
            });

            expect(auditLogs.length).toBeGreaterThanOrEqual(1);
            expect(auditLogs[0].details).toContain('retention_period_elapsed');
        });

        it('dryRun does not soft-delete', async () => {
            const evidence = await prisma.contract.create({
                data: {
                    tenantId: testTenantId,
                    counterparty: `DryRun retention ${Date.now()}`,
                },
            });

            const pastDate = new Date(Date.now() - 5 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Contract" SET "retentionUntil" = $1 WHERE "id" = $2',
                pastDate, evidence.id,
            );

            const results = await runRetentionSweep({
                tenantId: testTenantId,
                dryRun: true,
                db: prisma,
            });

            const evidenceResult = results.find(r => r.model === 'Contract');
            expect(evidenceResult).toBeDefined();
            expect(evidenceResult!.scanned).toBeGreaterThanOrEqual(1);

            // Should still be active
            const found = await prisma.contract.findUnique({ where: { id: evidence.id } });
            expect(found).not.toBeNull();
        });
    });
});
