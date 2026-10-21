/**
 * `publishFreshNotifications` — #2142.
 *
 * Seven publish sites sent `{ id: row.dedupeKey }` because `createMany`
 * returns no ids. Since P7.2 that id is the client's `Last-Event-ID`, which
 * `replayNotificationIdsAfter` resolves as a `Notification.id` — so a
 * dedupeKey meant the next reconnect replayed nothing at all.
 */
import {
    publishFreshNotifications,
    type FreshNotificationRow,
} from '@/app-layer/notifications/publish-fresh';
import {
    subscribeToNotifications,
    __resetNotificationBusForTests,
} from '@/lib/notifications/notification-bus';
import { runWithAfterCommit, pendingAfterCommitCount } from '@/lib/db/after-commit';

const tick = () => new Promise((r) => setImmediate(r));

/** `afterCommit` with no transaction frame open fires via an un-awaited
 *  `void runEffect(...)`, so the publish lands a microtask later. */
async function settle(): Promise<void> {
    await tick();
    await tick();
}

describe('publishFreshNotifications', () => {
    let findMany: jest.Mock;
    let db: { notification: { findMany: jest.Mock } };
    let seen: Array<{ userId: string; id: string }>;
    let release: () => void;

    const row = (over: Partial<FreshNotificationRow> = {}): FreshNotificationRow => ({
        tenantId: 't-1',
        userId: 'u-1',
        dedupeKey: 't-1:LOW_STOCK:item-1:u-1:2026-10-21',
        ...over,
    });

    beforeEach(() => {
        __resetNotificationBusForTests();
        seen = [];
        findMany = jest.fn();
        db = { notification: { findMany } };
        release = subscribeToNotifications({
            tenantId: 't-1',
            userId: 'u-1',
            send: (e) => seen.push({ userId: 'u-1', id: e.id }),
        });
    });

    afterEach(() => {
        release();
        __resetNotificationBusForTests();
    });

    it('publishes the ROW id, not the dedupeKey it looked up by', async () => {
        const r = row();
        findMany.mockResolvedValue([{ id: 'notif-1', dedupeKey: r.dedupeKey }]);

        const n = await publishFreshNotifications(db as never, 'notify.test', [r]);
        await settle();

        expect(n).toBe(1);
        expect(seen).toEqual([{ userId: 'u-1', id: 'notif-1' }]);
        expect(seen[0].id).not.toContain('LOW_STOCK');
    });

    it('reads once for a whole batch, bounded by the input', async () => {
        // The sweeps insert many rows at a time — low-stock produced 8,778 of
        // 8,815 production rows. One read per row would turn a batch insert
        // into N round-trips.
        const rows = [row({ dedupeKey: 'k1' }), row({ dedupeKey: 'k2' }), row({ dedupeKey: 'k3' })];
        findMany.mockResolvedValue([
            { id: 'n1', dedupeKey: 'k1' },
            { id: 'n2', dedupeKey: 'k2' },
            { id: 'n3', dedupeKey: 'k3' },
        ]);

        await publishFreshNotifications(db as never, 'notify.test', rows);
        await settle();

        expect(findMany).toHaveBeenCalledTimes(1);
        const arg = findMany.mock.calls[0][0];
        expect(arg.where.dedupeKey.in).toEqual(['k1', 'k2', 'k3']);
        // `take` bounded by the input, so a shared dedupeKey cannot make this
        // read the whole table.
        expect(arg.take).toBe(3);
        expect(seen.map((s) => s.id)).toEqual(['n1', 'n2', 'n3']);
    });

    it('publishes nothing and reads nothing for an empty batch', async () => {
        const n = await publishFreshNotifications(db as never, 'notify.test', []);
        await settle();

        expect(n).toBe(0);
        expect(findMany).not.toHaveBeenCalled();
        expect(seen).toEqual([]);
    });

    it('skips a row that cannot be resolved rather than inventing an id', async () => {
        // Possible only if something deleted it between the insert and this
        // read. Publishing the dedupeKey as a fallback would put the broken
        // cursor straight back.
        const rows = [row({ dedupeKey: 'k1' }), row({ dedupeKey: 'gone' })];
        findMany.mockResolvedValue([{ id: 'n1', dedupeKey: 'k1' }]);

        const n = await publishFreshNotifications(db as never, 'notify.test', rows);
        await settle();

        expect(n).toBe(1);
        expect(seen.map((s) => s.id)).toEqual(['n1']);
        expect(seen.map((s) => s.id)).not.toContain('gone');
    });

    it('publishes AFTER the commit, not inside the transaction', async () => {
        // The whole reason the id is read eagerly and published later: a
        // subscriber that receives an event for a row that is not yet
        // committed renders a notification the next poll cannot find — and if
        // the transaction then rolls back, one for a row that never existed.
        //
        // This needs a transaction frame to mean anything. `afterCommit` with
        // NO frame open fires immediately via an un-awaited
        // `void runEffect(...)`, so a first version of this case asserted an
        // empty `seen` right after the call and failed: the helper awaits its
        // own read, which is enough yielding for the effect to land. The
        // property is about the FRAME, so the test opens one.
        findMany.mockResolvedValue([{ id: 'n1', dedupeKey: 'k1' }]);

        await runWithAfterCommit(async () => {
            await publishFreshNotifications(db as never, 'notify.test', [row({ dedupeKey: 'k1' })]);
            // Still inside. One effect queued, nothing delivered.
            expect(pendingAfterCommitCount()).toBe(1);
            await settle();
            expect(seen).toEqual([]);
        });

        // The frame closed, so the effect ran.
        await settle();
        expect(seen.map((s) => s.id)).toEqual(['n1']);
    });

    it('routes each row to its own subscriber', async () => {
        // A batch spans recipients — a sweep notifies every member of a farm.
        // Publishing them all to the first row's channel would deliver other
        // people's notifications.
        const other: string[] = [];
        const release2 = subscribeToNotifications({
            tenantId: 't-1',
            userId: 'u-2',
            send: (e) => other.push(e.id),
        });
        findMany.mockResolvedValue([
            { id: 'n1', dedupeKey: 'k1' },
            { id: 'n2', dedupeKey: 'k2' },
        ]);

        await publishFreshNotifications(db as never, 'notify.test', [
            row({ dedupeKey: 'k1', userId: 'u-1' }),
            row({ dedupeKey: 'k2', userId: 'u-2' }),
        ]);
        await settle();
        release2();

        expect(seen.map((s) => s.id)).toEqual(['n1']);
        expect(other).toEqual(['n2']);
    });
});
