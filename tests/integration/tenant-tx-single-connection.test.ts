/**
 * #1223 — a tenant transaction must need only ONE pool connection.
 *
 * ## The invariant
 *
 * A transaction holding one of the pool's `max` connections and then asking
 * for a SECOND one cannot make progress once every slot is held in that same
 * state: nobody can acquire, so nobody can release. `pg` is given no
 * `connectionTimeoutMillis` (deliberately — see `pool-config.ts`), so the wait
 * is unbounded and what the caller sees is Prisma's own 5s interactive-
 * transaction timeout (`P2028`) or its 2s `maxWait` ("Unable to start a
 * transaction in the given time"). Neither error names a connection pool,
 * which is why this reads as a Prisma bug.
 *
 * The second connection came from `withEncryptionExtension`'s
 * `resolveTenantDekPair`, which awaits `getTenantDek(tenantId)` on every model
 * read and write — and `tenant-key-manager` reads the `Tenant` row through the
 * GLOBAL prisma client, never through the `tx` the caller holds. It is cached
 * per tenant per process, so the cost is one extra connection per COLD tenant:
 * a fresh container, or a sweep touching many tenants at once.
 *
 * ## Why these are executing tests and not a source guard
 *
 * A guard asserting "`prewarmTenantKeys` is called before `$transaction`"
 * would pass for any rearrangement that puts a second acquisition back by
 * another route — a `getTenantDek` from a policy, an audit read, a second
 * extension — and would keep passing if Prisma changed which client an
 * extension's queries run on. These assert the PROPERTY: N concurrent
 * transactions at N = `PG_POOL_MAX`, cold, complete.
 *
 * ## The positive control is the load-bearing test here
 *
 * Three green concurrency tests are also what a harness that never achieved
 * concurrency produces. `the instrument has teeth` therefore does the thing
 * the fix removes — takes an explicit second connection inside the
 * transaction — and asserts it still deadlocks. If that test ever goes green,
 * every other test in this file has stopped measuring anything.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import {
    withTenantDb,
    runInTenantContext,
    type PrismaTx,
} from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';
import { prisma } from '@/lib/prisma';
import { PG_POOL_MAX } from '@/lib/db/pool-config';
import {
    getTenantDek,
    clearTenantDekCache,
    clearTenantPreviousDekCache,
} from '@/lib/security/tenant-key-manager';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';
import { DB_URL, DB_AVAILABLE } from './db-helper';

/**
 * A BARE client for fixtures — no audit extension, so setup writes no
 * immutable `AuditLog` rows that would then block tenant cleanup, and its
 * pool is its OWN, so fixture work never consumes a slot the measurement
 * needs.
 */
const fixturePrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/**
 * Exactly `max`, which is where the cliff is. At `max - 1` one slot stays free
 * and the second acquisition always succeeds, so a passing run at `max - 1`
 * says nothing — that is the concurrency the P0.8 hardening test settled for.
 */
const CONCURRENCY = PG_POOL_MAX;

const suffix = randomUUID().slice(0, 8);
const TENANTS = Array.from(
    { length: CONCURRENCY },
    (_, i) => `t-1223-${i}-${suffix}`,
);

/**
 * Below `BUDGET.timeout` (25s) so an unfilled barrier reports itself. See the
 * comment at the `Promise.race` below.
 */
const BARRIER_TIMEOUT_MS = 18_000;

/**
 * Every transaction waits here until all `n` of them are open, which is what
 * makes the measurement a statement about the mechanism rather than about how
 * fast this box happens to schedule promises. `arrived` is asserted, so a
 * barrier that times out fails loudly instead of quietly degrading into an
 * unsynchronised burst that the fix would pass either way.
 */
function makeBarrier(n: number) {
    let arrived = 0;
    let release!: () => void;
    const open = new Promise<void>((r) => {
        release = r;
    });
    return {
        async arrive(): Promise<void> {
            arrived += 1;
            if (arrived >= n) release();
            // Bounded, and the bound sits BELOW `BUDGET.timeout` on purpose:
            // a barrier that never fills then surfaces as the `arrived`
            // assertion naming the barrier, rather than as twelve transaction
            // timeouts that look exactly like the defect.
            await Promise.race([
                open,
                new Promise<void>((r) => setTimeout(r, BARRIER_TIMEOUT_MS)),
            ]);
        },
        get arrived() {
            return arrived;
        },
    };
}

/**
 * The shapes pool exhaustion wears, and not one of them names a pool — which
 * is the whole reason this class of defect reads as a Prisma bug. Observed
 * before the fix: `Transaction API error: A query cannot be executed on an
 * expired transaction. The timeout for this transaction was 5000 ms, however
 * 5030 ms passed…`, and its sibling `A commit cannot be executed on…`. `P2028`
 * is the code Prisma attaches; the `maxWait` form is the 2s one.
 */
function isPoolStall(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
        msg.includes('P2028') ||
        msg.includes('Transaction already closed') ||
        msg.includes('Unable to start a transaction in the given time') ||
        msg.includes('Transaction API error')
    );
}

/**
 * Wait until this database has no backend `idle in transaction`, i.e. until
 * the global pool has actually taken back every connection the previous test
 * left stalled.
 *
 * This is NOT hygiene, it is a precondition that was measured. A test whose
 * transactions time out leaves its connections being reclaimed for some time
 * after Prisma has already rejected the caller, so the NEXT test starts with a
 * pool smaller than `max` and reports a partial stall count that belongs to
 * its predecessor — observed while taking the before-the-fix numbers, where
 * the warm control came back `stalls: 6` on a pool that had been fine seconds
 * earlier. Throwing here names that cause instead of attributing it to the
 * test that merely ran next.
 *
 * It runs on the FIXTURE client, whose pool is separate, so it can always ask
 * even when the global pool is fully held. `current_database()` scopes it to
 * this checkout's slot database — concurrent runs in other worktrees use their
 * own and are invisible here.
 */
async function awaitPoolReclaimed(): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
        const rows = await fixturePrisma.$queryRaw<Array<{ n: bigint }>>`
            SELECT count(*)::bigint AS n
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND state = 'idle in transaction'`;
        const idle = Number(rows[0]?.n ?? 0);
        if (idle === 0) return;
        if (Date.now() > deadline) {
            throw new Error(
                `pool not reclaimed: ${idle} backends still 'idle in transaction' ` +
                    `after 30s. The previous test's stalled transactions are still ` +
                    `holding connections, so this test cannot measure its own.`,
            );
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

/**
 * Prisma's defaults are `maxWait` 2s and `timeout` 5s, and a barrier-
 * synchronised sweep spends part of that budget WAITING for its siblings to
 * open — so on a loaded CI runner twelve transactions could exceed 5s between
 * BEGIN and the model read for reasons that have nothing to do with the
 * defect. These budgets are raised to take that out of the measurement.
 *
 * Raising them cannot hide the defect, and that is the point: the wait this
 * test is about is UNBOUNDED (no `connectionTimeoutMillis`), so with every slot
 * held no amount of extra time produces a free connection. The `the instrument
 * has teeth` control is the proof — it runs under these same raised budgets and
 * still stalls `CONCURRENCY`/`CONCURRENCY`. A budget that could be waited out
 * would turn that control green.
 */
const BUDGET = { timeout: 25_000, maxWait: 20_000 } as const;

/**
 * Run `body` in `CONCURRENCY` concurrent tenant transactions, one tenant each,
 * and report which rejected. Returns the messages rather than throwing so a
 * failing assertion can print WHAT failed.
 *
 * `via` picks the helper: both were changed, and both are exercised.
 * `runInTenantContext` is the preferred usecase API and the only one that
 * accepts transaction budgets; `withTenantDb` is the older helper and runs at
 * Prisma's DEFAULTS, which is the production shape.
 */
async function sweep(
    body: (tx: PrismaTx) => Promise<unknown>,
    via: 'runInTenantContext' | 'withTenantDb' = 'runInTenantContext',
): Promise<{ failures: string[]; stalls: number }> {
    const settled = await Promise.allSettled(
        TENANTS.map((tenantId) =>
            via === 'withTenantDb'
                ? withTenantDb(tenantId, (tx) => body(tx))
                : runInTenantContext(
                      makeRequestContext('OWNER', {
                          tenantId,
                          userId: `u-1223-${suffix}`,
                          requestId: `req-1223-${randomUUID()}`,
                      }),
                      (tx) => body(tx),
                      BUDGET,
                  ),
        ),
    );
    const rejected = settled.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    return {
        failures: rejected.map((r) =>
            r.reason instanceof Error ? r.reason.message : String(r.reason),
        ),
        stalls: rejected.filter((r) => isPoolStall(r.reason)).length,
    };
}

describeFn('a tenant transaction needs only one pool connection (#1223)', () => {
    beforeAll(async () => {
        // Each tenant gets a WRAPPED DEK at creation. Without one,
        // `getTenantDek` takes its lazy-init branch and WRITES — a different
        // and more expensive path than the steady state under test, and one
        // that would make this suite measure the backfill instead.
        await fixturePrisma.tenant.createMany({
            data: TENANTS.map((id) => ({
                id,
                name: `1223 ${id}`,
                slug: id,
                encryptedDek: generateAndWrapDek().wrapped,
            })),
        });
    }, 60_000);

    afterAll(async () => {
        await fixturePrisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
        await fixturePrisma.$disconnect();
        // The global singleton too, or jest reports open handles and the
        // worker lingers a second past the run.
        await prisma.$disconnect();
    }, 60_000);

    beforeEach(async () => {
        // COLD is the dangerous state and the default for every test here;
        // the warm control re-warms explicitly.
        clearTenantDekCache();
        clearTenantPreviousDekCache();
        await awaitPoolReclaimed();
    }, 60_000);

    test(
        'a cold-tenant burst at PG_POOL_MAX completes — withTenantDb, Prisma default budgets',
        async () => {
            // Deliberately the UNSYNCHRONISED shape, through the helper that
            // takes no options, so one test in this file runs at exactly the
            // 2s/5s budgets production runs at. Before the fix this stalled
            // 9/12 rather than 12/12 — some DEK lookups finish before all
            // twelve transactions are open, which is why the barrier test
            // below exists and why this one is not the primary evidence.
            const { failures, stalls } = await sweep(
                (tx) => tx.task.findFirst({ where: { status: 'OPEN' } }),
                'withTenantDb',
            );
            expect({ concurrency: CONCURRENCY, stalls, failures }).toEqual({
                concurrency: PG_POOL_MAX,
                stalls: 0,
                failures: [],
            });
        },
        120_000,
    );

    test(
        'a cold-tenant sweep with every transaction provably open completes',
        async () => {
            const barrier = makeBarrier(CONCURRENCY);
            const { failures, stalls } = await sweep(async (tx) => {
                // Hold here until all `CONCURRENCY` transactions have run
                // their `set_config` — i.e. until every pool slot is held by a
                // transaction that has not yet touched a model. THEN do the
                // model read whose DEK lookup used to want slot 13.
                await barrier.arrive();
                return tx.task.findFirst({ where: { status: 'OPEN' } });
            });
            // Asserted, not assumed: a barrier that timed out would have
            // measured an unsynchronised burst.
            expect(barrier.arrived).toBe(CONCURRENCY);
            expect({ stalls, failures }).toEqual({ stalls: 0, failures: [] });
        },
        120_000,
    );

    test(
        'a WARM tenant was never affected — the control that this is about the DEK read',
        async () => {
            for (const tenantId of TENANTS) await getTenantDek(tenantId);
            const barrier = makeBarrier(CONCURRENCY);
            const { failures, stalls } = await sweep(async (tx) => {
                await barrier.arrive();
                return tx.task.findFirst({ where: { status: 'OPEN' } });
            });
            expect(barrier.arrived).toBe(CONCURRENCY);
            expect({ stalls, failures }).toEqual({ stalls: 0, failures: [] });
        },
        120_000,
    );

    test(
        'the instrument has teeth — an explicit second connection still deadlocks',
        async () => {
            const barrier = makeBarrier(CONCURRENCY);
            const { stalls } = await sweep(async (tx) => {
                await barrier.arrive();
                // The thing the fix removes, done by hand: a query on the
                // GLOBAL client while this transaction holds a slot.
                // `$queryRaw` does not go through `$allModels`, so this is the
                // second acquisition and nothing else.
                await prisma.$queryRaw`SELECT 1`;
                return tx.task.findFirst({ where: { status: 'OPEN' } });
            });
            expect(barrier.arrived).toBe(CONCURRENCY);
            // EVERY one of them, not "at least one": with all `max` slots held
            // by transactions each waiting for a slot, there is no winner.
            expect(stalls).toBe(CONCURRENCY);
        },
        120_000,
    );
});
