/**
 * P0.8 — the Exchange notify must not fire until the sender's transaction has
 * COMMITTED, and must not need a second connection while it is open.
 *
 * ## What was wrong
 *
 * `sendExchangeMessageImpl` called `await notifyOtherParty(...)` from inside its
 * `runInTenantContext`. `notifyOtherParty` opens `withTenantDb` for the
 * RECIPIENT (it has to — their memberships are RLS-forced), and Prisma does not
 * nest transactions: that inner one is INDEPENDENT and commits on its own
 * connection. So the bell rows, the SSE publishes and the outbox rows were all
 * durable and delivered while the sender's transaction was still open, and a
 * sender transaction that then rolled back left the other party notified about
 * a message that does not exist. The publish is the unrecoverable half: a row
 * can be reconciled, an SSE push cannot be recalled.
 *
 * ## Why these tests and not a source guard
 *
 * The fix is one line at a call site, and a guard asserting that line would
 * pass for any rearrangement that puts the notify back inside a transaction by
 * another route. These assert the PROPERTY:
 *
 *   1. a transaction that rolls back AT COMMIT leaves 0 Notification rows, 0
 *      outbox rows and 0 publishes — paired with a positive control that the
 *      same flow DOES produce all three when it commits, because three zeroes
 *      are also what a broken fixture produces;
 *   2. concurrent sends produce no P2028.
 *
 * ## Forcing a rollback at the right instant
 *
 * The failure has to land AFTER the callback has queued its effect, i.e. at
 * COMMIT — a statement error inside the body would roll back before anything
 * was queued and the test would pass vacuously. There are no SAVEPOINTs
 * anywhere in `src/` (the single textual mention, in `exchange-messaging.ts`,
 * is a comment explaining their absence), so the instrument is a
 * `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`. Deferred constraint
 * triggers fire at the end of the transaction, which is exactly the window
 * under test.
 *
 * It keys on `threadId`, NOT on the message body, and that is a measurement
 * rather than a preference: `ExchangeMessage.body` is stored ENCRYPTED. The
 * model is not in `ENCRYPTED_FIELDS`, but `encryption-middleware`'s `'*'`
 * fan-out encrypts any field named `body` because `TaskComment: ['body']` is in
 * the manifest — so a trigger comparing the plaintext never matches, and the
 * first version of this test passed its send and failed its assertion.
 *
 * ## Fixture notes, both load-bearing
 *
 * **Two ADMINs, no OWNER, on the seller side.** The fan-out resolves
 * `role: { in: ['OWNER','ADMIN'] }`, so two ADMINs exercise it — and the
 * `tenant_membership_last_owner_guard` DB trigger makes an ACTIVE OWNER
 * membership undeletable, which would leak fixture rows into the shared test
 * database on every run.
 *
 * **The positive control runs FIRST and that is not cosmetic.** It primes the
 * per-process tenant-DEK cache for the seller tenant; see the concurrency
 * test's comment for why a cold tenant costs an extra connection.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import {
    sendExchangeMessage,
    listExchangeThreads,
} from '@/app-layer/usecases/exchange-messaging';
import {
    subscribeToNotifications,
    type NotificationEvent,
} from '@/lib/notifications/notification-bus';
import { PG_POOL_MAX } from '@/lib/db/pool-config';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

/**
 * A BARE client for fixtures — no audit extension, so setup writes no
 * immutable `AuditLog` rows that would then block tenant cleanup.
 */
const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** Raised by the deferred constraint trigger, never by the application. */
const ROLLBACK_SENTINEL = 'P0.8 forced rollback at COMMIT';
/** Ordinary prose: the trigger keys on the THREAD, not on this. */
const ROLLBACK_BODY = 'това съобщение не бива да съществува';

/**
 * `PG_POOL_MAX - 1`, and the minus one is a measurement. See the concurrency
 * test's comment.
 */
const CONCURRENT_SENDS = PG_POOL_MAX - 1;

const suffix = randomUUID().slice(0, 8);
const SELLER_TENANT = `t-p08-seller-${suffix}`;
const MAIN_BUYER = `t-p08-buyer-${suffix}`;
/**
 * Its own tenant, because `ExchangeThread` is unique on
 * `(listingId, inquirerTenantId)` — one buyer gets one thread per listing.
 */
const ROLLBACK_BUYER = `t-p08-rbuyer-${suffix}`;
/** One tenant per concurrent sender — see the concurrency test. */
const CONCURRENT_BUYERS = Array.from(
    { length: CONCURRENT_SENDS },
    (_, i) => `t-p08-cbuyer-${i}-${suffix}`,
);

const allTenants = [SELLER_TENANT, MAIN_BUYER, ROLLBACK_BUYER, ...CONCURRENT_BUYERS];

/** Seller-side admins — the recipients `notifyOtherParty` fans out to. */
const sellerUserIds: string[] = [];
let senderUserId = '';
let listingId = '';

async function makeUser(label: string): Promise<string> {
    const id = `u-p08-${label}-${randomUUID()}`;
    await globalPrisma.user.create({
        data: {
            id,
            email: `${label}.${suffix}@p08.example.test`,
            emailHash: `hash-${id}`,
            name: label,
            uiLanguage: 'bg',
        },
    });
    return id;
}

/** A thread on the shared listing, opened by `buyerTenantId`. */
async function seedThread(buyerTenantId: string): Promise<string> {
    const threadId = `ext-p08-${randomUUID()}`;
    await globalPrisma.exchangeThread.create({
        // #1298 — `inquirerUserId` is the buyer-side principal and is NOT
        // NULL: a thread is per PERSON now, not per farm.
        data: {
            id: threadId,
            listingId,
            inquirerTenantId: buyerTenantId,
            inquirerUserId: senderUserId,
        },
    });
    return threadId;
}

/** Count every row the notify fan-out can write, for the recipient tenant. */
async function sellerSideCounts() {
    const [notifications, outbox] = await Promise.all([
        globalPrisma.notification.count({ where: { tenantId: SELLER_TENANT } }),
        globalPrisma.notificationOutbox.count({ where: { tenantId: SELLER_TENANT } }),
    ]);
    return { notifications, outbox };
}

/** Listen on the real bus for every seller admin. Returns a stop function. */
function watchPublishes(): { events: NotificationEvent[]; stop: () => void } {
    const events: NotificationEvent[] = [];
    const stops = sellerUserIds.map((userId) =>
        subscribeToNotifications({
            tenantId: SELLER_TENANT,
            userId,
            send: (event) => events.push(event),
        }),
    );
    return {
        events,
        stop: () => {
            for (const s of stops) s();
        },
    };
}

const buyerCtx = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        userId: senderUserId,
        requestId: `req-p08-${randomUUID()}`,
    });

describeFn('Exchange notify fires only after the sender transaction commits', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.createMany({
            data: allTenants.map((id) => ({ id, name: `p08 ${id}`, slug: id })),
        });

        // TWO seller-side admins on purpose: the fan-out writes one bell row
        // per USER and one outbox row per ADDRESS, and a single-recipient
        // fixture cannot tell a working fan-out from a loop that runs once.
        sellerUserIds.push(await makeUser('admin-a'), await makeUser('admin-b'));
        senderUserId = await makeUser('sender');

        await globalPrisma.tenantMembership.createMany({
            data: sellerUserIds.map((userId) => ({
                tenantId: SELLER_TENANT,
                userId,
                role: 'ADMIN' as const,
                status: 'ACTIVE' as const,
            })),
        });

        listingId = `exl-p08-${randomUUID()}`;
        await globalPrisma.exchangeListing.create({
            data: {
                id: listingId,
                sellerTenantId: SELLER_TENANT,
                sellerUserId: sellerUserIds[0],
                side: 'SELL',
                commodity: 'Wheat',
                quantityTonnes: 25,
                regionCode: 'BG-16',
                regionName: 'Plovdiv',
                lat: 42.15,
                lon: 24.75,
            },
        });
    }, 120_000);

    afterAll(async () => {
        // Best-effort, in dependency order. `AuditLog` is append-only (a DB
        // trigger refuses DELETE), so the tenant rows this suite created may
        // survive — the same compromise every tenant-creating suite here makes.
        const attempt = async (fn: () => Promise<unknown>) => {
            try {
                await fn();
            } catch {
                /* best effort */
            }
        };
        await attempt(() =>
            globalPrisma.$executeRawUnsafe(
                `DROP TRIGGER IF EXISTS p08_force_rollback_trg ON "ExchangeMessage"`,
            ),
        );
        await attempt(() =>
            globalPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS p08_force_rollback()`),
        );
        await attempt(() =>
            globalPrisma.exchangeMessage.deleteMany({ where: { thread: { listingId } } }),
        );
        await attempt(() => globalPrisma.exchangeThread.deleteMany({ where: { listingId } }));
        await attempt(() => globalPrisma.exchangeListing.deleteMany({ where: { id: listingId } }));
        await attempt(() =>
            globalPrisma.notification.deleteMany({ where: { tenantId: { in: allTenants } } }),
        );
        await attempt(() =>
            globalPrisma.notificationOutbox.deleteMany({ where: { tenantId: { in: allTenants } } }),
        );
        await attempt(() =>
            globalPrisma.tenantMembership.deleteMany({ where: { tenantId: { in: allTenants } } }),
        );
        await attempt(() =>
            globalPrisma.auditLog.deleteMany({ where: { tenantId: { in: allTenants } } }),
        );
        await attempt(() =>
            globalPrisma.user.deleteMany({
                where: { id: { in: [...sellerUserIds, senderUserId] } },
            }),
        );
        await attempt(() => globalPrisma.tenant.deleteMany({ where: { id: { in: allTenants } } }));
        await globalPrisma.$disconnect();
    }, 120_000);

    // ── THE POSITIVE CONTROL ──
    //
    // The rollback assertion below is three zeroes, and three zeroes are also
    // what a fixture with no ACTIVE admin, a disabled tenant or a changed RLS
    // policy produces. Without this, that test proves the notification path is
    // silent — not that the rollback silenced it.
    it('a COMMITTED send writes bell rows, outbox rows and publishes', async () => {
        const threadId = await seedThread(MAIN_BUYER);
        const before = await sellerSideCounts();
        const watch = watchPublishes();

        try {
            const sent = await sendExchangeMessage(
                buyerCtx(MAIN_BUYER),
                threadId,
                'има ли още налично',
            );
            expect(sent.replayed).toBe(false);

            const after = await sellerSideCounts();
            // One bell row per seller-side USER, one outbox row per ADDRESS.
            expect(after.notifications - before.notifications).toBe(sellerUserIds.length);
            expect(after.outbox - before.outbox).toBe(sellerUserIds.length);
            // The publish is the half that cannot be taken back once sent.
            expect(watch.events).toHaveLength(sellerUserIds.length);
            expect(watch.events.every((e) => e.type === 'EXCHANGE_MESSAGE')).toBe(true);
        } finally {
            watch.stop();
        }
    }, 120_000);

    // ── THE ROLLBACK ──
    it('a send that rolls back AT COMMIT leaves 0 notifications, 0 outbox rows and 0 publishes', async () => {
        const threadId = await seedThread(ROLLBACK_BUYER);

        // DEFERRABLE INITIALLY DEFERRED so it fires at COMMIT — after the
        // callback has queued the notify. A plain AFTER-INSERT trigger would
        // abort the transaction before `afterCommit` was ever reached, and the
        // test would pass while proving nothing.
        await globalPrisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION p08_force_rollback() RETURNS trigger AS $fn$
            BEGIN
                IF NEW."threadId" = '${threadId}' THEN
                    RAISE EXCEPTION '${ROLLBACK_SENTINEL}';
                END IF;
                RETURN NULL;
            END
            $fn$ LANGUAGE plpgsql
        `);
        await globalPrisma.$executeRawUnsafe(`
            CREATE CONSTRAINT TRIGGER p08_force_rollback_trg
                AFTER INSERT ON "ExchangeMessage"
                DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW EXECUTE FUNCTION p08_force_rollback()
        `);

        const before = await sellerSideCounts();
        const watch = watchPublishes();

        try {
            await expect(
                sendExchangeMessage(buyerCtx(ROLLBACK_BUYER), threadId, ROLLBACK_BODY),
            ).rejects.toThrow(/forced rollback at COMMIT/);

            // The message itself is gone — proof the rollback really happened
            // rather than the trigger merely raising a notice.
            const messages = await globalPrisma.exchangeMessage.count({ where: { threadId } });
            expect(messages).toBe(0);

            const after = await sellerSideCounts();
            expect(after.notifications - before.notifications).toBe(0);
            expect(after.outbox - before.outbox).toBe(0);
            expect(watch.events).toEqual([]);
        } finally {
            watch.stop();
            await globalPrisma.$executeRawUnsafe(
                `DROP TRIGGER IF EXISTS p08_force_rollback_trg ON "ExchangeMessage"`,
            );
            await globalPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS p08_force_rollback()`);
        }
    }, 120_000);

    // ── CONCURRENCY ──
    //
    // `PG_POOL_MAX - 1` concurrent sends, from DISTINCT sender tenants, after a
    // warm-up read per tenant. Every one of those three qualifications is a
    // measurement rather than a convenience, and the roadmap's figure of 20 is
    // NOT reachable on this stack. Swept 2026-10-01 at max = 12, one
    // `withTenantDb` per task:
    //
    //   body                                   c=11  c=12  c=20  c=40
    //   raw `SELECT 1` on the tx                  ok    ok    ok     —
    //   model read, COLD tenant                   ok  FAIL  FAIL     —
    //   model read, WARM tenant                   ok    ok    ok    ok
    //   model write, WARM tenant                  ok    ok  FAIL     —
    //
    // Two things inside a tenant transaction reach for a SECOND pool
    // connection, and a transaction that holds one of `max` while waiting for
    // another deadlocks the pool — which surfaces as P2028, naming nothing
    // about connections:
    //
    //   • `withEncryptionExtension` awaits `resolveTenantDekPair` on EVERY
    //     model read and write, which reads the `Tenant` row through the global
    //     client. Cached per tenant per process, so it costs the extra
    //     connection ONCE per tenant — which is why the warm-up matters and why
    //     the cold row above fails at exactly `max`.
    //   • `appendAuditEntry` opens its own `$transaction` on the global client
    //     for every audited write, and is not cached. That is the write row's
    //     ceiling, and it is why this test sits at `max - 1`.
    //
    // NEITHER is the Exchange notify, and neither is fixed here. What this test
    // proves is the part P0.8 owns: a send no longer needs a connection for its
    // notify while its own transaction is open. Before the un-nesting a send
    // needed three at once (its own, the audit's, the notify's); it now needs
    // two, and the notify's is taken after the commit, when the sender is
    // holding nothing.
    //
    // Distinct sender tenants because `appendAuditEntry` takes
    // `pg_advisory_xact_lock(hashtext(tenantId))`: 11 sends from ONE tenant
    // serialise 22 audit appends inside 11 transactions that are each bounded
    // by Prisma's 5s timeout, which is a flake waiting to happen rather than a
    // property.
    it(`${CONCURRENT_SENDS} concurrent sends produce 0 P2028 errors`, async () => {
        // A concurrency of 0 or 1 would satisfy every matcher below without
        // testing anything — the empty-selection pass, derived from a constant.
        expect(CONCURRENT_SENDS).toBeGreaterThanOrEqual(10);

        const threads = await Promise.all(CONCURRENT_BUYERS.map((t) => seedThread(t)));

        // Warm the per-tenant DEK cache through the product's own read path —
        // a client opening the thread list before writing is the realistic
        // precondition, and it is what a long-running process is always in.
        for (const tenantId of CONCURRENT_BUYERS) {
            await listExchangeThreads(buyerCtx(tenantId));
        }

        const results = await Promise.allSettled(
            CONCURRENT_BUYERS.map((tenantId, i) =>
                sendExchangeMessage(buyerCtx(tenantId), threads[i], `паралелно ${i}`),
            ),
        );

        const rejected = results
            .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
            .map((r) => String(r.reason));

        // P2028 is Prisma's "Transaction API error" — both "already closed" and
        // "unable to start a transaction in the given time" land there, and
        // both are what pool starvation looks like from the application side.
        const p2028 = rejected.filter(
            (m) => m.includes('P2028') || m.includes('Transaction API error'),
        );

        // Named, not counted: a rejection list printed as a length tells the
        // next reader nothing about which failure they are looking at.
        expect(p2028).toEqual([]);
        expect(rejected).toEqual([]);

        // And the sends actually happened — zero failures is also what zero
        // attempts produces.
        const written = await globalPrisma.exchangeMessage.count({
            where: { threadId: { in: threads } },
        });
        expect(written).toBe(CONCURRENT_SENDS);
    }, 300_000);
});
