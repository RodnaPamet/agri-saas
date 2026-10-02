/**
 * The `'*'` fan-out no longer reaches a model that did not ask for it (#1222).
 *
 * ## What this pins, and why nothing did before
 *
 * `encryption-middleware.ts` resolved a non-manifest model to `'*'`, and the
 * `'*'` branch matches field NAMES across the whole manifest. So
 * `ExchangeListing.description` was encrypted because `Task`, `AccessReview`
 * and `CostEntry` each declare a `description` — three unrelated models
 * deciding a fourth model's fate. 18 (model, field) pairs were affected.
 *
 * Five months of green said nothing, for a reason worth keeping: the existing
 * `exchange-messaging-rls.test.ts` creates listings with **no `description` at
 * all**, through a bare `PrismaClient` carrying no extensions, and asserts on
 * ids. Nothing in the repo wrote an exchange row through the real client and
 * read the raw column back.
 *
 * ## Both arms, because one of them is the control
 *
 * `expect(plaintext)` alone would pass against a broken extension chain — if
 * encryption stopped working entirely, every column would read plaintext and
 * this file would agree. So the declared half is asserted in the same test:
 * `Location.description` IS in `ENCRYPTED_FIELDS` and must still come back
 * `v2:`. Narrowing without that control is indistinguishable from breaking.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInTenantContext } from '@/lib/db-context';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { DELIBERATELY_PLAINTEXT, ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const bare = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TENANT = `t-reach-${randomUUID()}`;
const ctx = { requestId: 'reach', userId: 'u-reach', tenantId: TENANT, role: 'ADMIN' } as never;

const rawColumn = async (table: string, column: string, id: string): Promise<string | null> => {
    const rows = await bare.$queryRawUnsafe<Array<Record<string, string | null>>>(
        `SELECT "${column}" AS v FROM "${table}" WHERE id = $1`,
        id,
    );
    return rows[0]?.v ?? null;
};

describeFn('#1222 the narrowed fan-out', () => {
    beforeAll(async () => {
        await createTenantWithDek({ id: TENANT, name: 'reach', slug: TENANT });
    });

    afterAll(async () => {
        await bare.exchangeListing.deleteMany({ where: { sellerTenantId: TENANT } });
        await bare.location.deleteMany({ where: { tenantId: TENANT } });
        await bare.tenant.deleteMany({ where: { id: TENANT } });
        await bare.$disconnect();
    });

    it('control: the two models under test are classified OPPOSITELY', () => {
        // If someone later declares ExchangeListing, this test would assert the
        // wrong thing while still passing its own logic. Pin the premise.
        expect(DELIBERATELY_PLAINTEXT['ExchangeListing.description']).toBeDefined();
        expect((ENCRYPTED_FIELDS as Record<string, readonly string[]>).ExchangeListing).toBeUndefined();
        expect((ENCRYPTED_FIELDS as Record<string, readonly string[]>).Location).toContain('description');
    });

    it('an UNDECLARED model carrying a manifest field name is NOT encrypted', async () => {
        const id = `exl-${randomUUID()}`;
        await runInTenantContext(ctx, async (db) =>
            db.exchangeListing.create({
                data: {
                    id, sellerTenantId: TENANT, sellerUserId: 'u-reach',
                    side: 'SELL', commodity: 'Wheat', quantityTonnes: 10,
                    regionCode: 'BG-16', regionName: 'Plovdiv', lat: 42.1, lon: 24.7,
                    description: 'REACH_PLAINTEXT_EXPECTED',
                },
            }),
        );
        const raw = await rawColumn('ExchangeListing', 'description', id);
        // Before the narrowing this was `v2:…` — measured, not assumed.
        expect(raw).toBe('REACH_PLAINTEXT_EXPECTED');
        expect(raw?.startsWith('v1:')).toBe(false);
        expect(raw?.startsWith('v2:')).toBe(false);
    });

    it('CONTROL: a DECLARED model is still encrypted', async () => {
        // The half that makes the assertion above mean something. A broken
        // extension chain would make every column plaintext.
        const id = `loc-${randomUUID()}`;
        await runInTenantContext(ctx, async (db) =>
            db.location.create({
                data: { id, tenantId: TENANT, name: 'reach', description: 'REACH_ENCRYPTED_EXPECTED' },
            }),
        );
        const raw = await rawColumn('Location', 'description', id);
        expect(raw?.startsWith('v2:')).toBe(true);
        expect(raw).not.toContain('REACH_ENCRYPTED_EXPECTED');
    });

    it('a DECLARED field still round-trips through the app client', async () => {
        // Encryption that cannot be read back is not protection, it is loss.
        const id = `loc-${randomUUID()}`;
        await runInTenantContext(ctx, async (db) =>
            db.location.create({
                data: { id, tenantId: TENANT, name: 'roundtrip', description: 'ROUND_TRIP' },
            }),
        );
        const read = await runInTenantContext(ctx, async (db) =>
            db.location.findUnique({ where: { id }, select: { description: true } }),
        );
        expect(read?.description).toBe('ROUND_TRIP');
    });
});
