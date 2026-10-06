/**
 * Both parties on an Exchange thread can read every message (#1222).
 *
 * ── the defect, and why five months of green said nothing ──
 *
 * `ExchangeMessage` is not a manifest model, so the middleware's write path
 * takes `targetModel = isEncryptedModel(model) ? model : '*'` and the `'*'`
 * fan-out matches field NAMES across the whole manifest. `TaskComment: ['body']`
 * puts `body` in that flat set, so `ExchangeMessage.body` was encrypted — under
 * the WRITER's tenant DEK, because that is whose context the write runs in.
 *
 * `listThreadMessages` reads inside the VIEWING party's tenant context. So each
 * side read its own messages as text and the other side's as `v2:…`. Measured
 * on production: both messages on the only live thread were written by one
 * tenant, so the recipient could read neither.
 *
 * Nothing failed. The writer's own reads were perfect, every suite that
 * exercised one tenant passed, and the ciphertext was well-formed. The defect
 * was only visible from a context no test entered — and the pre-existing
 * `exchange-messaging-rls.test.ts` could not have caught it, because it creates
 * listings with no `description` at all through a bare `PrismaClient` with no
 * extensions.
 *
 * ── the fix, and what this file pins ──
 *
 * `ExchangeMessage.body` is now DECLARED in `ENCRYPTED_FIELDS` (so the
 * encryption is a decision, not an accident of the flat name set) and the model
 * is in `GLOBAL_KEK_MODELS` (so it uses the global KEK — the only key both
 * parties share). There is no per-tenant option: letting B decrypt A's message
 * via A's DEK would expose ALL of A's v2 data, not one message.
 *
 * The assertion that matters is the CROSS-party read, in the other tenant's own
 * context. A same-tenant read passed before the fix and proves nothing.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { withTenantDb, runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';
import { getCiphertextVersion } from '@/lib/security/encryption';

/** Bare client: no extensions, so it sees the RAW column. */
const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `xm-${randomUUID().slice(0, 8)}`;
let sellerTenant = '';
let buyerTenant = '';
let threadId = '';
let listingId = '';
const BODY_FROM_BUYER = 'Имате ли налична пшеница за октомври?';
const BODY_FROM_SELLER = 'Да — 40 тона, цена по договаряне.';
const messageIds: string[] = [];
// #1298 — stable per-side principals. Threads and messages are per PERSON now
// and the RLS policies name the actor, so a fresh random id per write would
// make every write a different person and put none of them in the audience.
const BUYER_USER = `u-xm-buyer-${randomUUID()}`;
const SELLER_USER = `u-xm-seller-${randomUUID()}`;
// A person at neither party farm — the outsider the isolation case needs.
const THIRD_USER = `u-xm-third-${randomUUID()}`;

/**
 * Run as a PERSON at a tenant.
 *
 * `withTenantDb` sets `app.tenant_id` and no actor, which since #1298 is not
 * enough: the message policy's WITH CHECK pins `senderUserId` to
 * `app.actor_user_id`, and the thread audience is keyed on it. A context-less
 * write is refused and a context-less read returns zero rows — fail-closed,
 * but SILENTLY, which is the shape worth not debugging twice.
 */
function asPerson<T>(
    tenantId: string,
    userId: string,
    fn: (db: never) => Promise<T>,
): Promise<T> {
    return runInTenantContext(
        makeRequestContext('ADMIN', { tenantId, userId, requestId: `req-${userId}` }),
        fn as never,
    ) as Promise<T>;
}

/** Read the raw stored column, past every extension. */
async function storedBody(id: string): Promise<string> {
    const rows = await raw.$queryRawUnsafe<Array<{ body: string }>>(
        `SELECT "body" FROM "ExchangeMessage" WHERE id = $1`,
        id,
    );
    return rows[0].body;
}

/** Read a message as a given tenant would — through the real extension chain. */
/**
 * Read as a given PERSON at a given tenant.
 *
 * The person is explicit rather than derived from the tenant, and that is not
 * fussiness: a first version mapped "not the buyer tenant" to `SELLER_USER`,
 * so the third-tenant case below was handed the LISTING CREATOR's identity —
 * who is in the audience — and read the message it was asserting it could not
 * see. The test caught it. A defaulted identity in a privacy test is a hole
 * shaped exactly like the bug.
 */
async function readAs(
    tenantId: string,
    userId: string,
    id: string,
): Promise<string | undefined> {
    return asPerson<string | undefined>(tenantId, userId, async (db: never) => {
        const row = await (db as unknown as {
            exchangeMessage: { findFirst(a: unknown): Promise<{ body: string } | null> };
        }).exchangeMessage.findFirst({ where: { id }, select: { body: true } });
        return row?.body;
    });
}

describeFn('an Exchange message is readable by BOTH parties', () => {
    beforeAll(async () => {
        await raw.$connect();
        const s = await raw.tenant.create({ data: { name: `${TAG}-seller`, slug: `${TAG}-s` } });
        const b = await raw.tenant.create({ data: { name: `${TAG}-buyer`, slug: `${TAG}-b` } });
        sellerTenant = s.id;
        buyerTenant = b.id;

        listingId = `xl-${randomUUID()}`;
        // `kind` is CULTURE | FERTILIZER | SEEDS | PRODUCT — not GRAIN, which is
        // what I guessed first; and `lat`/`lon` are NOT NULL with no default.
        await raw.$executeRawUnsafe(
            `INSERT INTO "ExchangeListing"
               ("id","sellerTenantId","sellerUserId","side","kind","commodity","quantityTonnes",
                "priceCurrency","regionCode","regionName","lat","lon","status","createdAt","updatedAt")
             VALUES ($1,$2,$3,'SELL','CULTURE','WHEAT',40,'BGN','BG-23','Sofia',42.70,23.32,'ACTIVE',NOW(),NOW())`,
            listingId,
            sellerTenant,
            // The listing's CREATOR is the seller-side principal, so it has to
            // be the same person the seller-side reads and writes run as.
            SELLER_USER,
        );
        threadId = `xt-${randomUUID()}`;
        // #1298 — `ExchangeThread` DOES carry an `inquirerUserId` now, and it
        // is NOT NULL: a thread is one per (listing, inquirer PERSON) rather
        // than per farm. This comment said the opposite until that landed.
        await raw.$executeRawUnsafe(
            `INSERT INTO "ExchangeThread"
               ("id","listingId","inquirerTenantId","inquirerUserId","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,NOW(),NOW())`,
            threadId,
            listingId,
            buyerTenant,
            BUYER_USER,
        );

        // Written through the REAL extension chain, each in its own author's
        // tenant context — which is the shape that produced the defect.
        for (const [tenant, user, body] of [
            [buyerTenant, BUYER_USER, BODY_FROM_BUYER],
            [sellerTenant, SELLER_USER, BODY_FROM_SELLER],
        ] as const) {
            const id = await asPerson<string>(tenant, user, async (db: never) => {
                const row = await (db as unknown as {
                    exchangeMessage: { create(a: unknown): Promise<{ id: string }> };
                }).exchangeMessage.create({
                    data: {
                        threadId,
                        senderTenantId: tenant,
                        // Must equal the actor: the policy's WITH CHECK pins it,
                        // so a party can only ever write as THEMSELVES.
                        senderUserId: user,
                        body,
                    },
                    select: { id: true },
                });
                return row.id;
            });
            messageIds.push(id);
        }
    });

    afterAll(async () => {
        // Best-effort, in dependency order — the pattern
        // `exchange-notify-after-commit.test.ts` already uses, and for the same
        // reason: sending a message writes a hash-chained `AuditLog` row, a DB
        // trigger refuses DELETE on that table (`IMMUTABLE_AUDIT_LOG`), and
        // `AuditLog_tenantId_fkey` then refuses the tenant delete. So the two
        // tenants this suite creates may survive, which is the compromise every
        // tenant-creating suite here makes; the per-worker database is dropped
        // at the end of the run.
        //
        // Wrapped rather than left to throw because an unwrapped failure here
        // fails the SUITE while every test passes — a shape that reads as a
        // broken test rather than a known trade-off.
        const attempt = async (fn: () => Promise<unknown>): Promise<void> => {
            try {
                await fn();
            } catch {
                /* best effort — see above */
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

    it('is still encrypted at rest — the fix changes the KEY, not the posture', async () => {
        for (const id of messageIds) {
            const stored = await storedBody(id);
            // `v1:` is the global KEK. Before the fix these were `v2:` — the
            // writer's tenant DEK — which is precisely what the other party
            // could not read.
            expect(getCiphertextVersion(stored)).toBe('v1');
        }
    });

    it('THE PROPERTY: each party reads the OTHER party\'s message', async () => {
        const [buyerMsg, sellerMsg] = messageIds;
        // The cross reads. These are what failed before the fix; the two
        // same-party reads below passed throughout and prove nothing alone.
        expect(await readAs(sellerTenant, SELLER_USER, buyerMsg)).toBe(BODY_FROM_BUYER);
        expect(await readAs(buyerTenant, BUYER_USER, sellerMsg)).toBe(BODY_FROM_SELLER);
    });

    it('and each party still reads its OWN message — no regression', async () => {
        const [buyerMsg, sellerMsg] = messageIds;
        expect(await readAs(buyerTenant, BUYER_USER, buyerMsg)).toBe(BODY_FROM_BUYER);
        expect(await readAs(sellerTenant, SELLER_USER, sellerMsg)).toBe(BODY_FROM_SELLER);
    });

    it('a THIRD tenant sees NOTHING — RLS does the access control, not the key', async () => {
        // This is the answer to the obvious objection against the global KEK:
        // "doesn't a deployment-wide key let every tenant read every message?"
        // No — and I had it backwards. I wrote this test expecting the third
        // tenant to decrypt the body, on the reasoning that the KEK is
        // deployment-wide and only RLS stands in the way. The row is not
        // returned AT ALL: `ExchangeMessage` carries
        // `exchange_message_party_isolation`, which joins through
        // `ExchangeThread` and `ExchangeListing` to confirm the reader is a
        // party to the thread.
        //
        // So the two controls are cleanly separated and each does its own job:
        // RLS decides WHO may see the row, encryption-at-rest decides what a
        // stolen database yields. Changing the key model does not widen access
        // by one row, which is exactly what makes the global KEK safe here.
        const third = await raw.tenant.create({ data: { name: `${TAG}-third`, slug: `${TAG}-3` } });
        try {
            expect(await readAs(third.id, THIRD_USER, messageIds[0])).toBeUndefined();
            // And the two real parties still can — otherwise "nobody can read
            // it" would satisfy this assertion too.
            expect(await readAs(buyerTenant, BUYER_USER, messageIds[0])).toBe(BODY_FROM_BUYER);
            expect(await readAs(sellerTenant, SELLER_USER, messageIds[0])).toBe(BODY_FROM_BUYER);
        } finally {
            // Best-effort for the same reason as afterAll: a read may audit,
            // and AuditLog cannot be deleted.
            await raw.tenant.deleteMany({ where: { id: third.id } }).catch(() => undefined);
        }
    });

    it('the raw column is NOT the plaintext — the test is reading a real decrypt', async () => {
        // Control. Without it, every assertion above would also pass if the
        // body were simply stored in the clear.
        const stored = await storedBody(messageIds[0]);
        expect(stored).not.toBe(BODY_FROM_BUYER);
        expect(stored).not.toContain('пшеница');
    });
});

describe('the DB gate is visible when it skips', () => {
    it('says so rather than passing silently', () => {
        if (!DB_AVAILABLE) {
            console.warn(
                '[exchange-message-both-parties-read] SKIPPED — no database. This is the only ' +
                    'place the CROSS-PARTY read is exercised, and a same-tenant read passed ' +
                    'throughout the five months the defect was live. ' +
                    'INTEGRATION_REQUIRE_DB=1 makes absence a failure.',
            );
        }
        expect(typeof DB_AVAILABLE).toBe('boolean');
    });
});
