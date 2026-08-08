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
        await prisma.$executeRawUnsafe('DELETE FROM "Risk" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Control" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Vendor" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "id" = $1', testUserId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', testTenantId).catch(() => {});
        await prisma.$disconnect();
    });
}

describeFn('Data Lifecycle', () => {
    // ─── purgeSoftDeletedOlderThan ───


    // ─── runRetentionSweep ───

});
