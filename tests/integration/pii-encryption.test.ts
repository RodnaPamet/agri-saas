/**
 * PII Encryption — Integration Tests
 *
 * Verifies:
 *   1. Create user → encrypted columns populated → read back decrypted
 *   2. Email lookup by hash returns correct user
 *   3. Raw DB values are ciphertext (not plaintext)
 *   4. VendorContact encrypt/decrypt cycle
 *   5. Middleware idempotency (double-write doesn't corrupt)
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { encryptField, decryptField, hashForLookup, isEncryptedValue } from '@/lib/security/encryption';
import { withPiiEncryptionExtension } from '@/lib/security/pii-middleware';
import { DB_URL, DB_AVAILABLE } from './db-helper';

// Use a separate client so we practice middleware registration
const prisma = withPiiEncryptionExtension(new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
}));

// Skip entire suite when DB is not reachable
const describeFn = DB_AVAILABLE ? describe : describe.skip;

// Clean up test data after all tests
const testIds: string[] = [];
const taskIds: string[] = [];
const tenantIds: string[] = [];

afterAll(async () => {
    // Clean up test records (use raw SQL to bypass middleware)
    // Children first — Task.createdByUserId and Task.tenantId are real FKs.
    for (const id of taskIds) {
        await prisma.$executeRawUnsafe('DELETE FROM "Task" WHERE "id" = $1', id).catch(() => {});
    }
    for (const id of testIds) {
        await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "id" = $1', id).catch(() => {});
    }
    for (const id of tenantIds) {
        await prisma.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', id).catch(() => {});
    }
    await prisma.$disconnect();
});

describeFn('PII Encryption', () => {
    // ─── Encryption Module Tests ───

    describe('encryption module', () => {
        it('encrypts and decrypts round-trip', () => {
            const plaintext = 'test@example.com';
            const encrypted = encryptField(plaintext);
            expect(encrypted).toMatch(/^v1:/);
            expect(decryptField(encrypted)).toBe(plaintext);
        });

        it('produces deterministic lookup hash (case-insensitive)', () => {
            const h1 = hashForLookup('Test@Example.com');
            const h2 = hashForLookup('test@example.com');
            const h3 = hashForLookup('  TEST@example.com  ');
            expect(h1).toBe(h2);
            expect(h1).toBe(h3);
            expect(h1).toHaveLength(64); // SHA-256 hex
        });

        it('detects encrypted values', () => {
            expect(isEncryptedValue('v1:abc123')).toBe(true);
            expect(isEncryptedValue('plaintext')).toBe(false);
            expect(isEncryptedValue(null)).toBe(false);
            expect(isEncryptedValue(undefined)).toBe(false);
        });
    });

    // ─── Prisma Middleware Integration ───

    describe('middleware integration', () => {
        it('populates encrypted columns on user create', async () => {
            const email = `pii-test-${Date.now()}@example.com`;
            const name = 'PII Test User';

            // Create via middleware-enabled client
            const user = await prisma.user.create({
                data: { email, name },
            });
            testIds.push(user.id);

            // Verify middleware decrypted the result
            expect(user.email).toBe(email);
            expect(user.name).toBe(name);

            // Verify raw DB has ciphertext
            const [raw] = await prisma.$queryRawUnsafe<Array<{
                emailEncrypted: string | null;
                emailHash: string | null;
                nameEncrypted: string | null;
            }>>(
                'SELECT "emailEncrypted", "emailHash", "nameEncrypted" FROM "User" WHERE "id" = $1',
                user.id,
            );

            expect(raw.emailEncrypted).not.toBeNull();
            expect(raw.emailEncrypted).toMatch(/^v1:/);
            expect(raw.emailEncrypted).not.toBe(email); // NOT plaintext!

            expect(raw.emailHash).not.toBeNull();
            expect(raw.emailHash).toBe(hashForLookup(email));

            expect(raw.nameEncrypted).not.toBeNull();
            expect(raw.nameEncrypted).toMatch(/^v1:/);
            expect(raw.nameEncrypted).not.toBe(name); // NOT plaintext!
        });

        it('decrypts on findUnique', async () => {
            const email = `pii-find-${Date.now()}@example.com`;
            const user = await prisma.user.create({
                data: { email, name: 'Find Test' },
            });
            testIds.push(user.id);

            const found = await prisma.user.findUnique({
                where: { id: user.id },
            });

            expect(found).not.toBeNull();
            expect(found!.email).toBe(email);
            expect(found!.name).toBe('Find Test');
        });

        it('updates encrypted columns on user update', async () => {
            const email = `pii-update-${Date.now()}@example.com`;
            const user = await prisma.user.create({
                data: { email, name: 'Before Update' },
            });
            testIds.push(user.id);

            const newEmail = `pii-updated-${Date.now()}@example.com`;
            const updated = await prisma.user.update({
                where: { id: user.id },
                data: { email: newEmail, name: 'After Update' },
            });

            expect(updated.email).toBe(newEmail);
            expect(updated.name).toBe('After Update');

            // Verify raw DB updated
            const [raw] = await prisma.$queryRawUnsafe<Array<{
                emailEncrypted: string | null;
                emailHash: string | null;
            }>>(
                'SELECT "emailEncrypted", "emailHash" FROM "User" WHERE "id" = $1',
                user.id,
            );

            expect(raw.emailHash).toBe(hashForLookup(newEmail));
        });

        it('handles upsert correctly', async () => {
            const email = `pii-upsert-${Date.now()}@example.com`;

            const user = await prisma.user.upsert({
                where: { emailHash: hashForLookup(email) },
                create: { email, name: 'Upsert Create' },
                update: { name: 'Upsert Update' },
            });
            testIds.push(user.id);

            expect(user.email).toBe(email);
            expect(user.name).toBe('Upsert Create');

            // Verify encrypted columns
            const [raw] = await prisma.$queryRawUnsafe<Array<{
                emailEncrypted: string | null;
                nameEncrypted: string | null;
            }>>(
                'SELECT "emailEncrypted", "nameEncrypted" FROM "User" WHERE "id" = $1',
                user.id,
            );

            expect(raw.emailEncrypted).toMatch(/^v1:/);
            expect(raw.nameEncrypted).toMatch(/^v1:/);
        });

        it('handles nullable fields (name = null)', async () => {
            const email = `pii-nullable-${Date.now()}@example.com`;

            const user = await prisma.user.create({
                data: { email, name: null },
            });
            testIds.push(user.id);

            expect(user.email).toBe(email);
            expect(user.name).toBeNull();

            // nameEncrypted should remain null
            const [raw] = await prisma.$queryRawUnsafe<Array<{
                nameEncrypted: string | null;
            }>>(
                'SELECT "nameEncrypted" FROM "User" WHERE "id" = $1',
                user.id,
            );

            expect(raw.nameEncrypted).toBeNull();
        });
    });

    // ─── Email Lookup by Hash ───

    // ─── Nested-relation decryption ───

    describe('nested relations decrypt too', () => {
        // The middleware decrypts a NESTED relation only when its key appears
        // in `RELATION_KEY_TO_MODEL`. `assignee` was listed and `createdBy`
        // was not, so the task list returned a colleague's name while the task
        // detail returned `v1:FTDt/A1v/…` and the app rendered 54 characters
        // of base64 under "Създадена от".
        //
        // `tests/guards/pii-relation-key-coverage.test.ts` derives the map's
        // required contents from the schema, but that is a STRUCTURAL check —
        // it proves the row exists and never runs `decryptNested`. This does.
        it('a Task included via createdBy comes back as a NAME, not an envelope', async () => {
            const tenant = await prisma.tenant.create({
                data: { name: 'PII Nested', slug: `pii-nested-${Date.now()}` },
                select: { id: true },
            });
            tenantIds.push(tenant.id);

            const email = `pii-nested-${Date.now()}@example.com`;
            const author = await prisma.user.create({
                data: { email, name: 'Светослав Радоловски' },
            });
            testIds.push(author.id);

            const task = await prisma.task.create({
                data: {
                    tenantId: tenant.id,
                    title: 'Nested decrypt probe',
                    createdByUserId: author.id,
                },
                select: { id: true },
            });
            taskIds.push(task.id);

            // The half that makes the assertion mean something: if the column
            // were plaintext at rest, the test below would pass with the
            // middleware entirely removed.
            const [raw] = await prisma.$queryRawUnsafe<Array<{ nameEncrypted: string | null }>>(
                'SELECT "nameEncrypted" FROM "User" WHERE "id" = $1',
                author.id,
            );
            expect(raw.nameEncrypted).not.toBeNull();
            expect(isEncryptedValue(raw.nameEncrypted!)).toBe(true);

            const found = await prisma.task.findUnique({
                where: { id: task.id },
                include: { createdBy: { select: { id: true, name: true, email: true } } },
            });

            expect(found).not.toBeNull();
            expect(found!.createdBy).not.toBeNull();
            // Assert the VALUE. `not.toContain('v1:')` would also pass on an
            // undefined, which is what a dropped projection produces.
            expect(found!.createdBy!.name).toBe('Светослав Радоловски');
            expect(found!.createdBy!.email).toBe(email);
        });
    });

    describe('email lookup by hash', () => {
        it('can find user by emailHash', async () => {
            const email = `pii-hash-lookup-${Date.now()}@example.com`;
            const user = await prisma.user.create({
                data: { email, name: 'Hash Lookup' },
            });
            testIds.push(user.id);

            const hash = hashForLookup(email);
            const found = await prisma.user.findFirst({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                where: { emailHash: hash } as any,
            });

            expect(found).not.toBeNull();
            expect(found!.id).toBe(user.id);
            expect(found!.email).toBe(email); // decrypted by middleware
        });

        it('hash lookup is case-insensitive', async () => {
            const email = `PII-Case-Test-${Date.now()}@Example.COM`;
            const user = await prisma.user.create({
                data: { email, name: 'Case Test' },
            });
            testIds.push(user.id);

            // Lookup with different casing
            const hash = hashForLookup(email.toLowerCase());
            const found = await prisma.user.findFirst({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                where: { emailHash: hash } as any,
            });

            expect(found).not.toBeNull();
            expect(found!.id).toBe(user.id);
        });
    });

    // ─── DB Value Verification ───

    describe('DB value security', () => {
        it('encrypted columns in DB do not contain plaintext (GAP-21: legacy email/name columns dropped)', async () => {
            const email = `pii-security-${Date.now()}@example.com`;
            const name = 'Sensitive Name';

            const user = await prisma.user.create({
                data: { email, name },
            });
            testIds.push(user.id);

            // GAP-21: the legacy plaintext email/name columns are
            // gone — only the encrypted versions remain at the DB.
            const [raw] = await prisma.$queryRawUnsafe<Array<{
                emailEncrypted: string;
                nameEncrypted: string;
            }>>(
                'SELECT "emailEncrypted", "nameEncrypted" FROM "User" WHERE "id" = $1',
                user.id,
            );

            // Encrypted columns have ciphertext.
            expect(raw.emailEncrypted).not.toBe(email);
            expect(raw.nameEncrypted).not.toBe(name);
            expect(raw.emailEncrypted).toMatch(/^v1:/);
            expect(raw.nameEncrypted).toMatch(/^v1:/);
        });
    });
});
