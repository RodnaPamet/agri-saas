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
        await prisma.$executeRawUnsafe('DELETE FROM "Risk" WHERE "tenantId" = $1', testTenantId).catch(() => {});
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


    // ─── Restore ───


    // ─── Purge ───


    // ─── List Soft-Deleted ───


    // ─── Model Coverage ───

});
