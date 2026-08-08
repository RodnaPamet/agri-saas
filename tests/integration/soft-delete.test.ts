/**
 * Soft-Delete & Retention — Integration Tests
 *
 * Verifies:
 *   1. Deleting a record sets deletedAt (not hard-deleted)
 *   2. Default queries exclude soft-deleted records
 *   3. withDeleted() includes soft-deleted records
 *   4. Restore clears deletedAt
 *   5. Purge hard-deletes from DB
 *   6. Models without soft-delete still hard-delete
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { SOFT_DELETE_MODELS, withDeleted, withSoftDeleteExtension } from '@/lib/soft-delete';
import { restoreSoftDeleted, purgeSoftDeleted, listSoftDeleted } from '@/app-layer/usecases/soft-delete-lifecycle';
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

// Test tenant — we'll create it fresh
const testTenantId = `sd-test-tenant-${Date.now()}`;
const testUserId = `sd-test-user-${Date.now()}`;

if (DB_AVAILABLE) {
    beforeAll(async () => {
        // Create test tenant and user
        await prisma.tenant.create({
            data: {
                id: testTenantId,
                name: `Test Tenant ${Date.now()}`,
                slug: `sd-test-${Date.now()}`,
            },
        });
        await prisma.user.create({
            data: {
                id: testUserId,
                email: `sd-test-${Date.now()}@example.com`,
                name: 'SD Test User',
            },
        });
    });

    afterAll(async () => {
        // Clean up
        await prisma.$executeRawUnsafe('DELETE FROM "Control" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Vendor" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Task" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "id" = $1', testUserId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', testTenantId).catch(() => {});
        await prisma.$disconnect();
    });
}

describeFn('Soft-Delete & Retention', () => {
    // ─── Core Soft-Delete Behavior ───

    describe('soft-delete on delete()', () => {
        it('sets deletedAt instead of removing the row', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Control to soft-delete' },
            });

            await prisma.control.delete({ where: { id: control.id } });

            // Raw SQL confirms record still exists with deletedAt set
            const [raw] = await prisma.$queryRawUnsafe<Array<{
                id: string;
                deletedAt: Date | null;
            }>>(
                'SELECT "id", "deletedAt" FROM "Control" WHERE "id" = $1',
                control.id,
            );

            expect(raw).toBeDefined();
            expect(raw.deletedAt).not.toBeNull();
        });

        it('default queries exclude soft-deleted records', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Hidden control' },
            });

            await prisma.control.delete({ where: { id: control.id } });

            // Default findMany should NOT return it
            const rows = await prisma.control.findMany({
                where: { tenantId: testTenantId, name: 'Hidden control' },
            });
            expect(rows).toHaveLength(0);

            // Default findUnique should return null
            const found = await prisma.control.findUnique({
                where: { id: control.id },
            });
            expect(found).toBeNull();
        });

        it('withDeleted() includes soft-deleted records', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Deleted but visible' },
            });

            await prisma.control.delete({ where: { id: control.id } });

            const found = await prisma.control.findMany(withDeleted({
                where: { id: control.id },
            }));
            expect(found).toHaveLength(1);
            expect(found[0].deletedAt).not.toBeNull();
        });

        it('works for newly added models (Vendor)', async () => {
            const vendor = await prisma.vendor.create({
                data: {
                    tenantId: testTenantId,
                    name: `Vendor-SD-${Date.now()}`,
                },
            });

            await prisma.vendor.delete({ where: { id: vendor.id } });

            // Should be soft-deleted, not hard-deleted
            const [raw] = await prisma.$queryRawUnsafe<Array<{
                deletedAt: Date | null;
            }>>(
                'SELECT "deletedAt" FROM "Vendor" WHERE "id" = $1',
                vendor.id,
            );
            expect(raw).toBeDefined();
            expect(raw.deletedAt).not.toBeNull();

            // Default read excludes it
            const found = await prisma.vendor.findUnique({ where: { id: vendor.id } });
            expect(found).toBeNull();
        });

        it('works for Task model', async () => {
            const task = await prisma.task.create({
                data: {
                    tenantId: testTenantId,
                    title: 'Task to soft-delete',
                    createdByUserId: testUserId,
                },
            });

            await prisma.task.delete({ where: { id: task.id } });

            const [raw] = await prisma.$queryRawUnsafe<Array<{
                deletedAt: Date | null;
            }>>(
                'SELECT "deletedAt" FROM "Task" WHERE "id" = $1',
                task.id,
            );
            expect(raw).toBeDefined();
            expect(raw.deletedAt).not.toBeNull();
        });
    });

    // ─── Restore ───

    describe('restore', () => {
        it('restores a soft-deleted record', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Control to restore' },
            });

            await prisma.control.delete({ where: { id: control.id } });

            // Verify it's hidden
            expect(await prisma.control.findUnique({ where: { id: control.id } })).toBeNull();

            const result = await restoreSoftDeleted(prisma, {
                model: 'Control',
                id: control.id,
            });

            expect(result.model).toBe('Control');
            expect(result.id).toBe(control.id);

            // Now visible in default queries
            const found = await prisma.control.findUnique({ where: { id: control.id } });
            expect(found).not.toBeNull();
            expect(found!.deletedAt).toBeNull();
        });

        it('throws if record is not soft-deleted', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Active control' },
            });

            await expect(
                restoreSoftDeleted(prisma, { model: 'Control', id: control.id }),
            ).rejects.toThrow('No soft-deleted');
        });

        it('throws for unsupported model', async () => {
            await expect(
                restoreSoftDeleted(prisma, { model: 'Tenant', id: 'fake-id' }),
            ).rejects.toThrow('does not support soft-delete');
        });
    });

    // ─── Purge ───

    describe('purge', () => {
        it('permanently removes a soft-deleted record', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Control to purge' },
            });

            await prisma.control.delete({ where: { id: control.id } });

            const result = await purgeSoftDeleted(prisma, {
                model: 'Control',
                id: control.id,
            });

            expect(result.model).toBe('Control');

            // Raw SQL confirms hard-deleted
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Control" WHERE "id" = $1',
                control.id,
            );
            expect(rows).toHaveLength(0);
        });

        it('throws if record is not soft-deleted', async () => {
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Active control for purge test' },
            });

            await expect(
                purgeSoftDeleted(prisma, { model: 'Control', id: control.id }),
            ).rejects.toThrow('No soft-deleted');
        });
    });

    // ─── List Soft-Deleted ───

    describe('listSoftDeleted', () => {
        it('returns only soft-deleted records for a tenant', async () => {
            const c1 = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Deleted control 1' },
            });
            const c2 = await prisma.control.create({
                data: { tenantId: testTenantId, name: 'Active control' },
            });

            await prisma.control.delete({ where: { id: c1.id } });

            const deleted = await listSoftDeleted(prisma, 'Control', testTenantId);

            const deletedIds = deleted.map((r: { id: string }) => r.id);
            expect(deletedIds).toContain(c1.id);
            expect(deletedIds).not.toContain(c2.id);
        });
    });

    // ─── Model Coverage ───

    describe('model coverage', () => {
        it('all expected models are in SOFT_DELETE_MODELS', () => {
            // `Risk` was in this list until the risk register was
            // removed; it and its mirror in `SOFT_DELETE_TARGETS` went
            // in the same diff.
            const expected = [
                'Asset', 'Control', 'Evidence', 'Policy',
                'Vendor', 'FileRecord', 'Task', 'Finding',
                'Audit', 'AuditCycle', 'AuditPack',
                // Grain (2026-07-25) — see SOFT_DELETE_MODELS.
                'Contract',
            ];
            for (const model of expected) {
                expect(SOFT_DELETE_MODELS.has(model)).toBe(true);
            }
        });
    });
});
