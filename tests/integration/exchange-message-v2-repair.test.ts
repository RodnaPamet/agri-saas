/**
 * Repairing the `v2:` rows the fan-out already wrote (#1222).
 *
 * Declaring `ExchangeMessage.body` and pinning the model to the global KEK
 * fixes every FUTURE write. It does nothing for rows already encrypted under a
 * tenant's DEK — and those are the ones with the user-visible problem:
 * production's only Exchange thread has two messages, both written by one
 * tenant, so the recipient can read neither.
 *
 * `repairMisplacedV2` is the migration. This file is what makes it safe to run
 * against production: the plaintext must survive the round-trip, and both
 * parties must be able to read it afterwards. A repair that moved the envelope
 * without preserving the content would look identical from the outside.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { withTenantDb } from '@/lib/db-context';
import { encryptWithKey, getCiphertextVersion } from '@/lib/security/encryption';
import { getTenantDek } from '@/lib/security/tenant-key-manager';
import { repairMisplacedV2, countMisplacedV2 } from '@/app-layer/usecases/global-key-rotation';

const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `xr-${randomUUID().slice(0, 8)}`;
const ORIGINAL = 'Остават 12 тона, цената е по договаряне.';
let sellerTenant = '';
let buyerTenant = '';
let threadId = '';
let listingId = '';
let messageId = '';

async function storedBody(id: string): Promise<string> {
    const rows = await raw.$queryRawUnsafe<Array<{ body: string }>>(
        `SELECT "body" FROM "ExchangeMessage" WHERE id = $1`,
        id,
    );
    return rows[0].body;
}

async function readAs(tenantId: string, id: string): Promise<string | undefined> {
    return withTenantDb(tenantId, async (db) => {
        const row = await db.exchangeMessage.findFirst({ where: { id }, select: { body: true } });
        return row?.body;
    });
}

describeFn('repairMisplacedV2 moves a tenant-DEK row onto the global KEK', () => {
    beforeAll(async () => {
        await raw.$connect();
        const s = await raw.tenant.create({ data: { name: `${TAG}-seller`, slug: `${TAG}-s` } });
        const b = await raw.tenant.create({ data: { name: `${TAG}-buyer`, slug: `${TAG}-b` } });
        sellerTenant = s.id;
        buyerTenant = b.id;

        listingId = `xl-${randomUUID()}`;
        await raw.$executeRawUnsafe(
            `INSERT INTO "ExchangeListing"
               ("id","sellerTenantId","sellerUserId","side","kind","commodity","quantityTonnes",
                "priceCurrency","regionCode","regionName","lat","lon","status","createdAt","updatedAt")
             VALUES ($1,$2,$3,'SELL','CULTURE','WHEAT',40,'BGN','BG-23','Sofia',42.70,23.32,'ACTIVE',NOW(),NOW())`,
            listingId,
            sellerTenant,
            `u-${randomUUID()}`,
        );
        threadId = `xt-${randomUUID()}`;
        await raw.$executeRawUnsafe(
            `INSERT INTO "ExchangeThread"("id","listingId","inquirerTenantId","createdAt","updatedAt")
             VALUES ($1,$2,$3,NOW(),NOW())`,
            threadId,
            listingId,
            buyerTenant,
        );

        // Reproduce the DEFECT exactly: a body encrypted under the SELLER's
        // tenant DEK, written with a bare client so no extension intervenes.
        // This is the shape the fan-out produced before the fix.
        const sellerDek = await getTenantDek(sellerTenant);
        messageId = `xm-${randomUUID()}`;
        await raw.$executeRawUnsafe(
            `INSERT INTO "ExchangeMessage"("id","threadId","senderTenantId","senderUserId","body","createdAt")
             VALUES ($1,$2,$3,$4,$5,NOW())`,
            messageId,
            threadId,
            sellerTenant,
            `u-${randomUUID()}`,
            encryptWithKey(sellerDek, ORIGINAL),
        );
    });

    afterAll(async () => {
        const attempt = async (fn: () => Promise<unknown>): Promise<void> => {
            try {
                await fn();
            } catch {
                /* best effort — AuditLog is append-only, so tenants may survive */
            }
        };
        await attempt(() =>
            raw.$executeRawUnsafe(`DELETE FROM "ExchangeMessage" WHERE "threadId" = $1`, threadId),
        );
        await attempt(() => raw.$executeRawUnsafe(`DELETE FROM "ExchangeThread" WHERE id = $1`, threadId));
        await attempt(() => raw.$executeRawUnsafe(`DELETE FROM "ExchangeListing" WHERE id = $1`, listingId));
        await attempt(() =>
            raw.tenant.deleteMany({ where: { id: { in: [sellerTenant, buyerTenant] } } }),
        );
        await raw.$disconnect();
    });

    it('after the fix a stale v2 row is unreadable by BOTH parties, not just one', async () => {
        // I wrote this expecting the seller — the WRITER — to still read it,
        // because that was the symptom before the fix. It is not what happens
        // after it, and the difference is a deployment-order consequence worth
        // stating.
        //
        // `ExchangeMessage` is now in `GLOBAL_KEK_MODELS`, so
        // `resolveTenantDekPair` returns the empty pair for it and the
        // middleware never resolves ANY tenant DEK on this model. A leftover
        // `v2:` value therefore cannot be decrypted by anyone: `decryptValue`
        // throws for a v2 envelope with no primary DEK, `decryptResultNode`
        // catches it, and the raw ciphertext is returned.
        //
        // So the fix briefly makes the broken rows MORE broken — the sender
        // loses access too — until `repairMisplacedV2` runs. On production that
        // window is the minutes between the deploy and the repair call, over
        // two rows on one thread, and the repair is unaffected by the change
        // because it calls `getTenantDek` directly rather than through the
        // middleware.
        expect(getCiphertextVersion(await storedBody(messageId))).toBe('v2');
        for (const tenant of [sellerTenant, buyerTenant]) {
            const seen = await readAs(tenant, messageId);
            expect(seen).not.toBe(ORIGINAL);
            expect(getCiphertextVersion(seen ?? '')).toBe('v2');
        }
    });

    it('countMisplacedV2 SEES it — otherwise the repair has no signal', async () => {
        expect(await countMisplacedV2()).toBeGreaterThanOrEqual(1);
    });

    it('the repair moves it to v1 and PRESERVES the plaintext', async () => {
        const results = await repairMisplacedV2();
        const mine = results.find((r) => r.model === 'ExchangeMessage' && r.column === 'body');
        expect(mine).toBeDefined();
        expect(mine!.repaired).toBeGreaterThanOrEqual(1);

        const after = await storedBody(messageId);
        expect(getCiphertextVersion(after)).toBe('v1');
        // The content survived. A repair that moved the envelope and lost the
        // text would satisfy every other assertion in this file.
        expect(await readAs(sellerTenant, messageId)).toBe(ORIGINAL);
    });

    it('THE POINT: the buyer can now read the seller\'s message', async () => {
        expect(await readAs(buyerTenant, messageId)).toBe(ORIGINAL);
    });

    it('a second repair is a no-op — it converges', async () => {
        const again = await repairMisplacedV2();
        const mine = again.find((r) => r.model === 'ExchangeMessage' && r.column === 'body');
        // Already v1, so not selected by the `LIKE 'v2:%'` filter at all.
        expect(mine?.repaired ?? 0).toBe(0);
    });

    it('and the stored value is still NOT the plaintext', async () => {
        // Control: the repair encrypts under the KEK, it does not decrypt to
        // plaintext at rest. Without this, "both parties can read it" would
        // also be satisfied by a repair that simply stored the text.
        const after = await storedBody(messageId);
        expect(after).not.toBe(ORIGINAL);
        expect(after).not.toContain('тона');
    });
});

describe('the DB gate is visible when it skips', () => {
    it('says so rather than passing silently', () => {
        if (!DB_AVAILABLE) {
            console.warn(
                '[exchange-message-v2-repair] SKIPPED — no database. This is the only proof that ' +
                    'repairMisplacedV2 preserves the plaintext, and it is about to be run against ' +
                    "production's two live rows. INTEGRATION_REQUIRE_DB=1 makes absence a failure.",
            );
        }
        expect(typeof DB_AVAILABLE).toBe('boolean');
    });
});
