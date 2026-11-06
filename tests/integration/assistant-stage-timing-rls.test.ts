/**
 * `AssistantStageTiming` is tenant-isolated under `app_user` — #2751.
 *
 * Required because a new model needs its policies proven against the live
 * database rather than asserted from the migration text, and because
 * `ALTER DEFAULT PRIVILEGES` (migration 20260323180000) already grants
 * `app_user` SELECT/INSERT/UPDATE/DELETE on every new table in `public` — so
 * this table is reachable by a tenant session the moment it exists. The RLS
 * is the only thing between it and a cross-farm read.
 *
 * ## The shape of the negatives, and why it is not optional
 *
 * Under RLS a write is refused with `42501` only when the row is VISIBLE.
 * When SELECT hides it, a DELETE or UPDATE affects ZERO rows and returns
 * NORMALLY. So every negative below asserts a row COUNT or a raised code,
 * never that a call returned — "it did not throw" is the reading that makes a
 * silent no-op look like a working policy.
 *
 * ## And the positives carry the same weight
 *
 * A silently unset session variable also yields zero rows, so a suite of
 * only-negatives passes against a connection that is bound to nothing at all.
 * Each case therefore asserts its OWN farm sees its row before asserting the
 * other farm does not.
 */
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prisma } from '@/lib/prisma';
import { withTenantDb } from '@/lib/db-context';
import { recordStageTiming } from '@/app-layer/ai/assistant/stage-timing-store';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `ast-${randomUUID().slice(0, 8)}`;

let farmA = '';
let farmB = '';

const TIMING = {
    totalMs: 1234,
    providerMs: 900,
    providerCalls: 2,
    toolSelectMs: 300,
    answerMs: 600,
    toolPhaseMs: 200,
    otherMs: 134,
    toolCallsMade: 1,
    halt: null,
} as const;

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    const a = await prisma.tenant.create({ data: { name: `${TAG}-a`, slug: `${TAG}-a` }, select: { id: true } });
    const b = await prisma.tenant.create({ data: { name: `${TAG}-b`, slug: `${TAG}-b` }, select: { id: true } });
    farmA = a.id;
    farmB = b.id;
    // One row per farm, written through the real store.
    await recordStageTiming(farmA, { ...TIMING, totalMs: 1111 });
    await recordStageTiming(farmB, { ...TIMING, totalMs: 2222 });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    // FK is ON DELETE CASCADE, so removing the tenants removes the timings.
    await prisma.tenant.deleteMany({ where: { id: { in: [farmA, farmB] } } }).catch(() => {});
});

describeFn('AssistantStageTiming is tenant-isolated', () => {
    it('the store wrote both rows — the positive control for everything below', async () => {
        // Privileged read: if this is not 2, no later assertion means anything,
        // because "no rows" and "the policy hid them" are the same observation.
        const n = await prisma.assistantStageTiming.count({
            where: { tenantId: { in: [farmA, farmB] } },
        });
        expect(n).toBe(2);
    });

    it('a farm sees its OWN timing under app_user', async () => {
        const rows = await withTenantDb(farmA, (db) =>
            db.assistantStageTiming.findMany({ select: { tenantId: true, totalMs: true } }),
        );
        const mine = rows.filter((r) => r.tenantId === farmA);
        expect(mine).toHaveLength(1);
        expect(mine[0].totalMs).toBe(1111);
    });

    it('and CANNOT see the other farm — the isolation this table needs', async () => {
        /*
         * The whole reason this test exists. A stage timing is not sensitive
         * on its own, but the table is keyed by tenant and a cross-farm read
         * would tell one operator how much another farm uses the assistant,
         * which is commercial information about a competitor.
         */
        const rows = await withTenantDb(farmA, (db) =>
            db.assistantStageTiming.findMany({ where: { tenantId: farmB }, select: { id: true } }),
        );
        expect(rows).toHaveLength(0);

        // Asserted as a COUNT rather than as an absence of rows in a list, so
        // an empty result from a broken query cannot pass as isolation.
        const n = await withTenantDb(farmA, (db) =>
            db.assistantStageTiming.count({ where: { tenantId: farmB } }),
        );
        expect(n).toBe(0);
    });

    it('a forged INSERT for another farm is REFUSED with 42501', async () => {
        /*
         * `tenant_isolation_insert`'s WITH CHECK. This is the negative that
         * raises rather than silently affecting zero rows, because an INSERT
         * violating WITH CHECK is an error — unlike a hidden-row UPDATE or
         * DELETE, which returns normally having done nothing.
         */
        await expect(
            withTenantDb(farmA, (db) =>
                db.assistantStageTiming.create({
                    data: { tenantId: farmB, ...TIMING },
                    select: { id: true },
                }),
            ),
        ).rejects.toThrow(/42501|row-level security/i);

        // And it really did not land — the raise is not the whole proof.
        const n = await prisma.assistantStageTiming.count({ where: { tenantId: farmB } });
        expect(n).toBe(1);
    });

    it('a DELETE aimed at another farm removes NOTHING, and returns normally', async () => {
        /*
         * The case where "it did not throw" is the wrong reading: SELECT hides
         * the row, so the statement matches nothing and succeeds. Asserting
         * the COUNT afterwards is the only way to tell that apart from a
         * delete that worked.
         */
        const deleted = await withTenantDb(farmA, (db) =>
            db.assistantStageTiming.deleteMany({ where: { tenantId: farmB } }),
        );
        expect(deleted.count).toBe(0);

        const survivors = await prisma.assistantStageTiming.count({ where: { tenantId: farmB } });
        expect(survivors).toBe(1);
    });
});
