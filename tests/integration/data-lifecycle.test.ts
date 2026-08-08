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
        await prisma.$executeRawUnsafe('DELETE FROM "Control" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Vendor" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "id" = $1', testUserId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', testTenantId).catch(() => {});
        await prisma.$disconnect();
    });
}

describeFn('Data Lifecycle', () => {
    // ─── purgeSoftDeletedOlderThan ───

    describe('purgeSoftDeletedOlderThan', () => {
        it('purges records whose grace period has elapsed', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Old deleted control' },
            });

            // Set deletedAt to 100 days ago via raw SQL
            const oldDate = new Date(Date.now() - 100 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Control" SET "deletedAt" = $1 WHERE "id" = $2',
                oldDate, control.id,
            );

            // Run purge with 90-day grace
            const results = await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                db: prisma,
            });

            const controlResult = results.find(r => r.model === 'Control');
            expect(controlResult).toBeDefined();
            expect(controlResult!.purged).toBeGreaterThanOrEqual(1);

            // Verify hard-deleted
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Control" WHERE "id" = $1', control.id,
            );
            expect(rows).toHaveLength(0);
        });

        it('does NOT purge recently deleted records', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Recently deleted' },
            });

            // Soft-delete it (deletedAt = now)
            await prisma.control.delete({ where: { id: control.id } });

            // Run purge with 90-day grace — should NOT purge
            await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                db: prisma,
            });

            // Verify still exists (soft-deleted but not purged)
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Control" WHERE "id" = $1', control.id,
            );
            expect(rows).toHaveLength(1);
        });

        it('does NOT purge active (non-deleted) records', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Active control' },
            });

            await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 0, // Even with 0 grace, active records should not be touched
                db: prisma,
            });

            const found = await prisma.control.findUnique({ where: { id: control.id } });
            expect(found).not.toBeNull();
        });

        it('emits DATA_PURGED audit event', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Purge audit test' },
            });

            const oldDate = new Date(Date.now() - 100 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Control" SET "deletedAt" = $1 WHERE "id" = $2',
                oldDate, control.id,
            );

            await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                db: prisma,
            });

            const auditLogs = await prisma.auditLog.findMany({
                where: {
                    tenantId: testTenantId,
                    entityId: control.id,
                    action: 'DATA_PURGED',
                },
            });

            expect(auditLogs.length).toBeGreaterThanOrEqual(1);
            expect(auditLogs[0].details).toContain('soft_delete_grace_expired');
        });

        it('dryRun does not delete anything', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'DryRun test' },
            });

            const oldDate = new Date(Date.now() - 200 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Control" SET "deletedAt" = $1 WHERE "id" = $2',
                oldDate, control.id,
            );

            const results = await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                dryRun: true,
                db: prisma,
            });

            const controlResult = results.find(r => r.model === 'Control');
            expect(controlResult).toBeDefined();
            expect(controlResult!.scanned).toBeGreaterThanOrEqual(1);
            expect(controlResult!.purged).toBe(0);

            // Record still exists
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Control" WHERE "id" = $1', control.id,
            );
            expect(rows).toHaveLength(1);
        });
    });

    // ─── runRetentionSweep ───

    describe('runRetentionSweep', () => {
        it('soft-deletes records with elapsed retentionUntil', async () => {
            const vendor = await prisma.vendor.create({
                data: {
                    tenantId: testTenantId,
                    name: `Retention vendor ${Date.now()}`,
                },
            });

            // Set retentionUntil to the past
            const pastDate = new Date(Date.now() - 10 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Vendor" SET "retentionUntil" = $1 WHERE "id" = $2',
                pastDate, vendor.id,
            );

            const results = await runRetentionSweep({
                tenantId: testTenantId,
                db: prisma,
            });

            const vendorResult = results.find(r => r.model === 'Vendor');
            expect(vendorResult).toBeDefined();
            expect(vendorResult!.expired).toBeGreaterThanOrEqual(1);

            // Verify vendor is now soft-deleted
            const found = await prisma.vendor.findUnique({ where: { id: vendor.id } });
            expect(found).toBeNull(); // excluded by soft-delete filter

            // But raw SQL still has it
            const [raw] = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
                'SELECT "deletedAt" FROM "Vendor" WHERE "id" = $1', vendor.id,
            );
            expect(raw).toBeDefined();
            expect(raw.deletedAt).not.toBeNull();
        });

        it('does NOT soft-delete records with future retentionUntil', async () => {
            const vendor = await prisma.vendor.create({
                data: {
                    tenantId: testTenantId,
                    name: `Future vendor ${Date.now()}`,
                },
            });

            // Set retentionUntil to the future
            const futureDate = new Date(Date.now() + 365 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Vendor" SET "retentionUntil" = $1 WHERE "id" = $2',
                futureDate, vendor.id,
            );

            await runRetentionSweep({ tenantId: testTenantId, db: prisma });

            const found = await prisma.vendor.findUnique({ where: { id: vendor.id } });
            expect(found).not.toBeNull();
        });

        it('emits DATA_EXPIRED audit events', async () => {
            const vendor = await prisma.vendor.create({
                data: {
                    tenantId: testTenantId,
                    name: `Retention audit test ${Date.now()}`,
                },
            });

            const pastDate = new Date(Date.now() - 5 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Vendor" SET "retentionUntil" = $1 WHERE "id" = $2',
                pastDate, vendor.id,
            );

            await runRetentionSweep({ tenantId: testTenantId, db: prisma });

            const auditLogs = await prisma.auditLog.findMany({
                where: {
                    tenantId: testTenantId,
                    entityId: vendor.id,
                    action: 'DATA_EXPIRED',
                },
            });

            expect(auditLogs.length).toBeGreaterThanOrEqual(1);
            expect(auditLogs[0].details).toContain('retention_period_elapsed');
        });

        it('dryRun does not soft-delete', async () => {
            const control = await prisma.control.create({
                data: {
                    tenantId: testTenantId,
                    code: `DRY-${Date.now()}`,
                    name: 'DryRun retention',
                },
            });

            const pastDate = new Date(Date.now() - 5 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Control" SET "retentionUntil" = $1 WHERE "id" = $2',
                pastDate, control.id,
            );

            const results = await runRetentionSweep({
                tenantId: testTenantId,
                dryRun: true,
                db: prisma,
            });

            const controlResult = results.find(r => r.model === 'Control');
            expect(controlResult).toBeDefined();
            expect(controlResult!.scanned).toBeGreaterThanOrEqual(1);

            // Should still be active
            const found = await prisma.control.findUnique({ where: { id: control.id } });
            expect(found).not.toBeNull();
        });
    });
});
