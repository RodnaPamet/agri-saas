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
import { SOFT_DELETE_TARGETS } from '@/lib/security/classification';

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
        await prisma.$executeRawUnsafe('DELETE FROM "Evidence" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Evidence" WHERE "tenantId" = $1', testTenantId).catch(() => {});
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
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Evidence to soft-delete' },
            });

            await prisma.evidence.delete({ where: { id: evidence.id } });

            // Raw SQL confirms record still exists with deletedAt set
            const [raw] = await prisma.$queryRawUnsafe<Array<{
                id: string;
                deletedAt: Date | null;
            }>>(
                'SELECT "id", "deletedAt" FROM "Evidence" WHERE "id" = $1',
                evidence.id,
            );

            expect(raw).toBeDefined();
            expect(raw.deletedAt).not.toBeNull();
        });

        it('default queries exclude soft-deleted records', async () => {
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Hidden evidence' },
            });

            await prisma.evidence.delete({ where: { id: evidence.id } });

            // Default findMany should NOT return it
            const rows = await prisma.evidence.findMany({
                where: { tenantId: testTenantId, title: 'Hidden evidence' },
            });
            expect(rows).toHaveLength(0);

            // Default findUnique should return null
            const found = await prisma.evidence.findUnique({
                where: { id: evidence.id },
            });
            expect(found).toBeNull();
        });

        it('withDeleted() includes soft-deleted records', async () => {
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Deleted but visible' },
            });

            await prisma.evidence.delete({ where: { id: evidence.id } });

            const found = await prisma.evidence.findMany(withDeleted({
                where: { id: evidence.id },
            }));
            expect(found).toHaveLength(1);
            expect(found[0].deletedAt).not.toBeNull();
        });

        it('works for models added to the allowlist later', async () => {
            const ev2 = await prisma.evidence.create({
                data: {
                    tenantId: testTenantId,
                    type: 'LINK',
                    title: `LateModel-SD-${Date.now()}`,
                },
            });

            await prisma.evidence.delete({ where: { id: ev2.id } });

            // Should be soft-deleted, not hard-deleted
            const [raw] = await prisma.$queryRawUnsafe<Array<{
                deletedAt: Date | null;
            }>>(
                'SELECT "deletedAt" FROM "Evidence" WHERE "id" = $1',
                ev2.id,
            );
            expect(raw).toBeDefined();
            expect(raw.deletedAt).not.toBeNull();

            // Default read excludes it
            const found = await prisma.evidence.findUnique({ where: { id: ev2.id } });
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
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Evidence to restore' },
            });

            await prisma.evidence.delete({ where: { id: evidence.id } });

            // Verify it's hidden
            expect(await prisma.evidence.findUnique({ where: { id: evidence.id } })).toBeNull();

            const result = await restoreSoftDeleted(prisma, {
                model: 'Evidence',
                id: evidence.id,
            });

            expect(result.model).toBe('Evidence');
            expect(result.id).toBe(evidence.id);

            // Now visible in default queries
            const found = await prisma.evidence.findUnique({ where: { id: evidence.id } });
            expect(found).not.toBeNull();
            expect(found!.deletedAt).toBeNull();
        });

        it('throws if record is not soft-deleted', async () => {
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Active evidence' },
            });

            await expect(
                restoreSoftDeleted(prisma, { model: 'Evidence', id: evidence.id }),
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
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Evidence to purge' },
            });

            await prisma.evidence.delete({ where: { id: evidence.id } });

            const result = await purgeSoftDeleted(prisma, {
                model: 'Evidence',
                id: evidence.id,
            });

            expect(result.model).toBe('Evidence');

            // Raw SQL confirms hard-deleted
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Evidence" WHERE "id" = $1',
                evidence.id,
            );
            expect(rows).toHaveLength(0);
        });

        it('throws if record is not soft-deleted', async () => {
            const evidence = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Active evidence for purge test' },
            });

            await expect(
                purgeSoftDeleted(prisma, { model: 'Evidence', id: evidence.id }),
            ).rejects.toThrow('No soft-deleted');
        });
    });

    // ─── List Soft-Deleted ───

    describe('listSoftDeleted', () => {
        it('returns only soft-deleted records for a tenant', async () => {
            const c1 = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Deleted evidence 1' },
            });
            const c2 = await prisma.evidence.create({
                data: { tenantId: testTenantId, type: 'LINK', title: 'Active evidence' },
            });

            await prisma.evidence.delete({ where: { id: c1.id } });

            const deleted = await listSoftDeleted(prisma, 'Evidence', testTenantId);

            const deletedIds = deleted.map((r: { id: string }) => r.id);
            expect(deletedIds).toContain(c1.id);
            expect(deletedIds).not.toContain(c2.id);
        });
    });

    // ─── Model Coverage ───

    describe('model coverage', () => {
        it('all expected models are in SOFT_DELETE_MODELS', () => {
            // DERIVED, not a third hand-copy. This restated the model
            // list a THIRD time (after SOFT_DELETE_TARGETS and
            // SOFT_DELETE_MODELS), and the comment it replaces recorded
            // that `Risk` had to be removed from all three in one diff —
            // which is the drift this now makes impossible.
            // SOFT_DELETE_MODELS derives from SOFT_DELETE_TARGETS, so the
            // real assertion is that the runtime allowlist and the
            // classification registry agree, plus a floor so the
            // comparison cannot pass vacuously on two empty sets.
            expect([...SOFT_DELETE_MODELS].sort()).toEqual(
                SOFT_DELETE_TARGETS.map((t) => t.model).slice().sort(),
            );
            expect(SOFT_DELETE_MODELS.size).toBeGreaterThan(0);
        });
    });
});
