/**
 * Epic 8 — Regression Guards
 *
 * These tests serve as deployment gates ensuring:
 *   1. PII encryption infrastructure is present and functional
 *   2. Hash-based lookups work for encrypted fields
 *   3. Soft-delete middleware intercepts all critical entity deletes
 *   4. (GAP-21 post-condition) Legacy plaintext columns are GONE on
 *      auth-identity models — there is no `User.email` plaintext
 *      column to query.
 *   5. Hard-delete is only possible via explicit raw SQL (purge path)
 *
 * Failing any of these tests means Epic 8 protections have regressed.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { SOFT_DELETE_MODELS, withDeleted, withSoftDeleteExtension } from '@/lib/soft-delete';
import { encryptField, decryptField, hashForLookup, isEncryptedValue } from '@/lib/security/encryption';
import { withPiiEncryptionExtension, _getPiiFieldMap } from '@/lib/security/pii-middleware';
import { DB_URL, DB_AVAILABLE } from './db-helper';

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

const testTenantId = `rg-tenant-${Date.now()}`;
const testUserId = `rg-user-${Date.now()}`;
const testEmail = `rg-test-${Date.now()}@example.com`;

if (DB_AVAILABLE) {
    beforeAll(async () => {
        await prisma.tenant.create({
            data: { id: testTenantId, name: `RG Test ${Date.now()}`, slug: `rg-test-${Date.now()}` },
        });
        await prisma.user.create({
            data: { id: testUserId, email: testEmail, name: 'Regression Guard' },
        });
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe('DELETE FROM "AuditLog" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Evidence" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Evidence" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Asset" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "id" = $1', testUserId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', testTenantId).catch(() => {});
        await prisma.$disconnect();
    });
}

// ═══════════════════════════════════════════════════════════════
// 1. Encryption Infrastructure
// ═══════════════════════════════════════════════════════════════

describe('Encryption Infrastructure', () => {
    it('encryptField produces versioned ciphertext', () => {
        const ct = encryptField('test@example.com');
        expect(ct).toMatch(/^v1:/);
        expect(ct).not.toBe('test@example.com');
    });

    it('decryptField recovers original plaintext', () => {
        const ct = encryptField('hello world');
        expect(decryptField(ct)).toBe('hello world');
    });

    it('isEncryptedValue detects v1: prefix', () => {
        expect(isEncryptedValue('v1:abc')).toBe(true);
        expect(isEncryptedValue('plaintext')).toBe(false);
        expect(isEncryptedValue('')).toBe(false);
    });

    it('hashForLookup is deterministic', () => {
        const h1 = hashForLookup('user@example.com');
        const h2 = hashForLookup('user@example.com');
        expect(h1).toBe(h2);
        expect(h1.length).toBeGreaterThan(0);
    });

    it('hashForLookup differs for different inputs', () => {
        const h1 = hashForLookup('a@example.com');
        const h2 = hashForLookup('b@example.com');
        expect(h1).not.toBe(h2);
    });

    it('PII field map covers all expected models', () => {
        // VendorContact + AuditorAccount left the registry with the GRC
        // teardown — both are KILL models dropped in phase 3.
        const expectedModels = ['User', 'NotificationOutbox', 'UserIdentityLink'];
        for (const model of expectedModels) {
            const fields = _getPiiFieldMap(model);
            expect(fields).toBeDefined();
            expect(fields!.length).toBeGreaterThan(0);
        }
    });

    it('User model maps email with hash and name without hash', () => {
        const fields = _getPiiFieldMap('User')!;
        const emailField = fields.find(f => f.plain === 'email');
        const nameField = fields.find(f => f.plain === 'name');
        expect(emailField).toBeDefined();
        expect(emailField!.encrypted).toBe('emailEncrypted');
        expect(emailField!.hash).toBe('emailHash');
        expect(nameField).toBeDefined();
        expect(nameField!.encrypted).toBe('nameEncrypted');
        expect(nameField!.hash).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════
// 2. Dual-Write Verification (DB)
// ═══════════════════════════════════════════════════════════════

describeFn('Dual-Write Verification', () => {
    it('User.emailEncrypted is populated on create and contains ciphertext', async () => {
        const raw = await prisma.$queryRawUnsafe<Array<{ emailEncrypted: string | null }>>(
            'SELECT "emailEncrypted" FROM "User" WHERE "id" = $1',
            testUserId,
        );
        expect(raw).toHaveLength(1);
        expect(raw[0].emailEncrypted).not.toBeNull();
        expect(isEncryptedValue(raw[0].emailEncrypted!)).toBe(true);
    });

    it('User.emailHash is populated on create', async () => {
        const raw = await prisma.$queryRawUnsafe<Array<{ emailHash: string | null }>>(
            'SELECT "emailHash" FROM "User" WHERE "id" = $1',
            testUserId,
        );
        expect(raw).toHaveLength(1);
        expect(raw[0].emailHash).not.toBeNull();
        expect(raw[0].emailHash!.length).toBeGreaterThan(10);
    });

    it('User.email plaintext column is GONE post-GAP-21', async () => {
        // Querying the dropped column raises a Postgres "column does
        // not exist" error. We assert the failure shape rather than a
        // returned value — the column is intentionally absent.
        const result = await prisma
            .$queryRawUnsafe<Array<{ email: string }>>(
                'SELECT "email" FROM "User" WHERE "id" = $1',
                testUserId,
            )
            .then(() => ({ ok: true as const }))
            .catch((err: unknown) => ({
                ok: false as const,
                msg: err instanceof Error ? err.message : String(err),
            }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.msg).toMatch(/column .* does not exist/i);
        }
    });

    it('emailHash matches hashForLookup of the plaintext email', async () => {
        const raw = await prisma.$queryRawUnsafe<Array<{ emailHash: string }>>(
            'SELECT "emailHash" FROM "User" WHERE "id" = $1',
            testUserId,
        );
        const expectedHash = hashForLookup(testEmail);
        expect(raw[0].emailHash).toBe(expectedHash);
    });

    it('lookup by emailHash returns the correct user', async () => {
        const hash = hashForLookup(testEmail);
        const raw = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            'SELECT "id" FROM "User" WHERE "emailHash" = $1',
            hash,
        );
        expect(raw).toHaveLength(1);
        expect(raw[0].id).toBe(testUserId);
    });

    it('Prisma read returns decrypted email (middleware active)', async () => {
        const user = await prisma.user.findUnique({ where: { id: testUserId } });
        expect(user).not.toBeNull();
        expect(user!.email).toBe(testEmail);
    });
});

// ═══════════════════════════════════════════════════════════════
// 3. Soft-Delete Guards
// ═══════════════════════════════════════════════════════════════

describeFn('Soft-Delete Guards', () => {


    it('deleting a soft-delete model sets deletedAt instead of hard-deleting', async () => {
        const ev2 = await prisma.evidence.create({
            data: { tenantId: testTenantId, type: 'LINK', title: `SD Guard ${Date.now()}` },
        });

        await prisma.evidence.delete({ where: { id: ev2.id } });

        const found = await prisma.evidence.findUnique({ where: { id: ev2.id } });
        expect(found).toBeNull();

        const raw = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
            'SELECT "deletedAt" FROM "Evidence" WHERE "id" = $1',
            ev2.id,
        );
        expect(raw).toHaveLength(1);
        expect(raw[0].deletedAt).not.toBeNull();
    });

    it('withDeleted() reveals soft-deleted records', async () => {
        const asset = await prisma.asset.create({
            data: { tenantId: testTenantId, name: `WithDeleted Guard ${Date.now()}`, type: 'TRACTOR' },
        });

        await prisma.asset.delete({ where: { id: asset.id } });

        const withoutDeleted = await prisma.asset.findUnique({ where: { id: asset.id } });
        expect(withoutDeleted).toBeNull();

        const withDel = await prisma.asset.findFirst(withDeleted({
            where: { id: asset.id },
        }));
        expect(withDel).not.toBeNull();
        expect(withDel!.deletedAt).not.toBeNull();
    });

    it('hard-delete only possible via raw SQL (purge path)', async () => {
        const evidence = await prisma.evidence.create({
            data: { tenantId: testTenantId, type: 'LINK', title: `Purge guard ${Date.now()}` },
        });

        // Normal delete = soft-delete
        await prisma.evidence.delete({ where: { id: evidence.id } });

        // Still exists in DB
        let raw = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            'SELECT "id" FROM "Evidence" WHERE "id" = $1', evidence.id,
        );
        expect(raw).toHaveLength(1);

        // Raw SQL delete = actual hard-delete
        await prisma.$executeRawUnsafe(
            'DELETE FROM "Evidence" WHERE "id" = $1', evidence.id,
        );
        raw = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            'SELECT "id" FROM "Evidence" WHERE "id" = $1', evidence.id,
        );
        expect(raw).toHaveLength(0);
    });
});
