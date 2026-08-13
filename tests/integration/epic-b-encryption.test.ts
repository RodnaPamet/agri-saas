/**
 * Epic B end-to-end — all four crypto layers cooperating against a
 * live Postgres.
 *
 * One test file walks the full chain:
 *   1. `createTenantWithDek` mints a tenant with a wrapped DEK from
 *      day one.
 *   2. A write via `runInTenantContext` lands ciphertext — the
 *      middleware resolves the tenant's DEK and emits `v2:`.
 *   3. A raw SQL read confirms the on-disk value starts with `v2:`
 *      and is NOT the plaintext. (This is the "what does an attacker
 *      with a DB dump see?" assertion.)
 *   4. A read via `runInTenantContext` returns plaintext — the
 *      middleware decrypts transparently.
 *   5. Cross-tenant read with the OTHER tenant's DEK cannot decrypt
 *      the first tenant's ciphertext — pins the per-tenant isolation
 *      guarantee.
 *   6. `runKeyRotation` re-wraps the DEK under the current primary
 *      KEK. Raw SQL confirms the wrapped-DEK ciphertext changed; the
 *      underlying DEK bytes are unchanged (decrypt still works).
 *   7. A post-rotation read still produces plaintext.
 *
 * No mocks — this is the authoritative "Epic B works as one system"
 * proof. Skips cleanly when the live DB isn't reachable.
 */

// Force the rate limiter off for this test file — the register
// route is wrapped in `withApiErrorHandling` which defaults to
// rate-limiting writes. We're issuing rapid consecutive writes
// against a known test tenant.
const originalRateLimitEnabled = process.env.RATE_LIMIT_ENABLED;
beforeAll(() => {
    process.env.RATE_LIMIT_ENABLED = '0';
});
afterAll(() => {
    if (originalRateLimitEnabled === undefined) {
        delete process.env.RATE_LIMIT_ENABLED;
    } else {
        process.env.RATE_LIMIT_ENABLED = originalRateLimitEnabled;
    }
});

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import {
    createTenantWithDek,
    getTenantDek,
    clearTenantDekCache,
} from '@/lib/security/tenant-key-manager';
import { runKeyRotation } from '@/app-layer/jobs/key-rotation';
import {
    unwrapDek,
    isWrappedDek,
} from '@/lib/security/tenant-keys';
import {
    getCiphertextVersion,
    decryptWithKey,
} from '@/lib/security/encryption';
import { registerEncryptionMiddleware } from '@/lib/db/encryption-middleware';
import { prisma } from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId = 'epic-b-user'): RequestContext {
    return {
        requestId: 'epic-b-req',
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

describeFn('Epic B — encryption, tenant DEKs, and rotation end-to-end', () => {
    let testPrisma: PrismaClient;
    let tenantA: string;
    let tenantB: string;
    let adminUserId: string;
    const slugs: string[] = [];
    const emails: string[] = [];

    beforeAll(async () => {
        testPrisma = prismaTestClient();
        await testPrisma.$connect();

        // Install encryption middleware on the runtime prisma client
        // (which runInTenantContext uses). Idempotent in production
        // via instrumentation.ts; in tests we wire it explicitly so
        // mocked tests elsewhere don't side-effect this suite.
        registerEncryptionMiddleware(prisma);

        const suffix = `epic-b-${Date.now()}`;
        const aSlug = `${suffix}-a`;
        const bSlug = `${suffix}-b`;
        slugs.push(aSlug, bSlug);

        const a = await createTenantWithDek({ name: 'A', slug: aSlug });
        const b = await createTenantWithDek({ name: 'B', slug: bSlug });
        tenantA = a.id;
        tenantB = b.id;

        // Real user for audit-log FK on rotation events.
        const adminEmail = `epic-b-admin-${Date.now()}@example.com`;
        emails.push(adminEmail);
        const admin = await testPrisma.user.create({
            data: { email: adminEmail, name: 'Epic B Admin' },
        });
        adminUserId = admin.id;
    });

    afterAll(async () => {
        try {
            await testPrisma.auditLog.deleteMany({
                where: { tenantId: { in: [tenantA, tenantB] } },
            });
            await testPrisma.task.deleteMany({
                where: { tenantId: { in: [tenantA, tenantB] } },
            });
            await testPrisma.tenant.deleteMany({
                where: { slug: { in: slugs } },
            });
            await testPrisma.user.deleteMany({
                where: { email: { in: emails } },
            });
        } catch {
            /* best effort */
        }
        clearTenantDekCache();
        await testPrisma.$disconnect();
    });

    test('tenant creation populates a wrapped DEK', async () => {
        const row = await testPrisma.tenant.findUnique({
            where: { id: tenantA },
            select: { encryptedDek: true },
        });
        expect(row?.encryptedDek).toBeTruthy();
        expect(isWrappedDek(row!.encryptedDek)).toBe(true);
    });

    test('write via runInTenantContext emits v2 ciphertext on disk', async () => {
        const plaintext = 'ransomware via supply-chain compromise on 2026-04-01';

        const created = await runInTenantContext(ctxFor(tenantA), (db) =>
            db.task.create({
                data: {
                    tenantId: tenantA,
                    createdByUserId: adminUserId,
                    type: 'TASK',
                    title: 'Epic B — end-to-end',
                    description: plaintext,
                    resolution: 'missing input validation',
                },
            }),
        );

        // Caller sees plaintext (middleware decrypted the create result).
        expect(created.description).toBe(plaintext);
        expect(created.resolution).toBe('missing input validation');

        // Raw SQL bypasses the middleware — confirms on-disk ciphertext.
        const raw = await testPrisma.$queryRawUnsafe<
            Array<{ id: string; description: string; resolution: string }>
        >(
            `SELECT id, "description", "resolution" FROM "Task" WHERE id = $1`,
            created.id,
        );
        expect(raw).toHaveLength(1);
        expect(getCiphertextVersion(raw[0].description)).toBe('v2');
        expect(getCiphertextVersion(raw[0].resolution)).toBe('v2');
        expect(raw[0].description).not.toContain('ransomware');
    });

    test('read via runInTenantContext returns plaintext', async () => {
        const found = await runInTenantContext(ctxFor(tenantA), (db) =>
            db.task.findFirst({
                where: {
                    tenantId: tenantA,
                    createdByUserId: adminUserId,
                    title: 'Epic B — end-to-end',
                },
            }),
        );
        expect(found).not.toBeNull();
        expect(found!.description).toBe(
            'ransomware via supply-chain compromise on 2026-04-01',
        );
        expect(found!.resolution).toBe('missing input validation');
    });

    test("tenant B's DEK cannot decrypt tenant A's v2 ciphertext", async () => {
        // Pull the raw ciphertext written by tenant A.
        const raw = await testPrisma.$queryRawUnsafe<
            Array<{ description: string }>
        >(
            `SELECT "description" FROM "Task" WHERE "tenantId" = $1 AND "title" = $2 LIMIT 1`,
            tenantA,
            'Epic B — end-to-end',
        );
        const cipher = raw[0].description;
        expect(getCiphertextVersion(cipher)).toBe('v2');

        // Try to decrypt with tenant B's DEK — expect AES-GCM failure.
        const dekB = await getTenantDek(tenantB);
        expect(() => decryptWithKey(dekB, cipher)).toThrow();

        // Sanity: tenant A's OWN DEK DOES decrypt it.
        const dekA = await getTenantDek(tenantA);
        const recovered = decryptWithKey(dekA, cipher);
        expect(recovered).toBe(
            'ransomware via supply-chain compromise on 2026-04-01',
        );
    });

    test('key rotation re-wraps the DEK (ciphertext changes, DEK bytes preserved)', async () => {
        // Capture the pre-rotation DEK + its wrapped form.
        const before = await testPrisma.tenant.findUnique({
            where: { id: tenantA },
            select: { encryptedDek: true },
        });
        const wrappedBefore = before!.encryptedDek!;
        const dekBefore = unwrapDek(wrappedBefore);

        await runKeyRotation({
            tenantId: tenantA,
            initiatedByUserId: adminUserId,
            requestId: 'epic-b-rotation',
        });

        const after = await testPrisma.tenant.findUnique({
            where: { id: tenantA },
            select: { encryptedDek: true },
        });
        const wrappedAfter = after!.encryptedDek!;

        // Envelope changed — new IV + fresh wrap.
        expect(wrappedAfter).not.toBe(wrappedBefore);

        // Underlying DEK bytes unchanged — existing ciphertexts stay readable.
        const dekAfter = unwrapDek(wrappedAfter);
        expect(dekAfter.equals(dekBefore)).toBe(true);
    });

    test('reads still decrypt cleanly after rotation', async () => {
        // The key-manager cache was invalidated by the rotation job —
        // next request re-resolves from the freshly-wrapped DEK row.
        const found = await runInTenantContext(ctxFor(tenantA), (db) =>
            db.task.findFirst({
                where: {
                    tenantId: tenantA,
                    createdByUserId: adminUserId,
                    title: 'Epic B — end-to-end',
                },
            }),
        );
        expect(found!.description).toBe(
            'ransomware via supply-chain compromise on 2026-04-01',
        );
    });
});
