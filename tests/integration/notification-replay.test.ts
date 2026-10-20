/**
 * `Last-Event-ID` replay reads the ROWS — P7.2 (#1991).
 *
 * ## Why this is an integration test
 *
 * The claim is "the database is the event log". A mocked `db` would let the
 * test assert the query it wrote rather than the ordering the rows actually
 * have — and ordering by `createdAt` versus by cuid is precisely the thing
 * that could be subtly wrong.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import {
    replayNotificationIdsAfter,
    REPLAY_LIMIT,
} from '@/app-layer/usecases/notification-replay';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `replay-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;
let me = '';
let other = '';

const ctx = () => makeRequestContext('ADMIN', { userId: me, tenantId: TENANT, tenantSlug: TAG });

/** Create a notification at a controlled time, so ordering is deterministic. */
async function notify(userId: string, at: Date, title = 'n') {
    const row = await prisma.notification.create({
        data: { tenantId: TENANT, userId, title, message: 'm', createdAt: at },
        select: { id: true },
    });
    return row.id;
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, name: TENANT, slug: TAG },
    });
    for (const which of ['me', 'other'] as const) {
        const email = `${TAG}-${which}@example.test`;
        const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        if (which === 'me') me = u.id;
        else other = u.id;
        await prisma.tenantMembership.create({
            data: { tenantId: TENANT, userId: u.id, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
        });
    }
}, 60_000);

afterEach(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.notification.deleteMany({ where: { tenantId: TENANT } });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    // Only what this suite creates repeatedly. The tenant, the users and any
    // audit rows are left: `AuditLog` is hash-chained with no cascade, and a
    // test deleting entries to tidy up deletes the evidence the chain exists
    // to protect. Every identifier here is TAG-scoped to one run.
    await prisma.notification.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$disconnect();
});

describeFn('replayNotificationIdsAfter', () => {
    const t0 = new Date('2026-10-20T10:00:00Z');
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

    it('returns what came after the cursor, oldest first', async () => {
        const first = await notify(me, at(0));
        const second = await notify(me, at(1));
        const third = await notify(me, at(2));

        const ids = await replayNotificationIdsAfter(ctx(), first);

        // Oldest first, so a client applying them in order ends at the newest
        // and the LAST id it sees is the next cursor.
        expect(ids).toEqual([second, third]);
    });

    it('excludes the cursor itself — the control', async () => {
        // Off-by-one in the obvious direction: a client that was sent the
        // cursor again would render a duplicate on every reconnect.
        const only = await notify(me, at(0));
        expect(await replayNotificationIdsAfter(ctx(), only)).toEqual([]);
    });

    it('replays the REST of the cursor’s millisecond — the batch case', async () => {
        // Not an edge case: measured in production on 2026-10-20, 8,778 of
        // 8,815 notification rows (99.6%) share their (userId, createdAt) with
        // at least one other row — 399 groups, the largest 22, almost all
        // stamped 09:00:00.xxx by the scheduled due-date run. `createdAt` is
        // timestamp(3), so one batch written in a millisecond is one timestamp.
        //
        // With a strict `>` a client reconnecting with any member of a batch
        // as its cursor is told nothing happened, while the other 21 are never
        // mentioned again. A silent loss, on the dominant producer, in the one
        // query whose whole job is "what did I miss".
        const batch = [
            await notify(me, at(0), 'b1'),
            await notify(me, at(0), 'b2'),
            await notify(me, at(0), 'b3'),
        ];
        const later = await notify(me, at(1), 'later');

        const ids = await replayNotificationIdsAfter(ctx(), batch[0]);

        // The cursor's siblings AND everything after, with the cursor itself
        // the only row removed.
        expect(ids.slice().sort()).toEqual([batch[1], batch[2], later].sort());
        expect(ids).not.toContain(batch[0]);
    });

    it('a repeated id is the ACCEPTED cost, and is bounded to one millisecond', async () => {
        // Taking the cursor's whole millisecond can re-send ids the client
        // already holds. That is the deliberate trade and the asymmetry is the
        // reason: the frame carries an id and the row is authoritative, so a
        // repeat costs a refetch of something the client has, while a loss
        // costs a notification nobody ever sees.
        //
        // What must NOT happen is the repeat being unbounded — a client that
        // reconnects mid-batch should see that batch again, not the history.
        const old1 = await notify(me, at(-10), 'old1');
        const old2 = await notify(me, at(-5), 'old2');
        const batch = [await notify(me, at(0), 'b1'), await notify(me, at(0), 'b2')];

        const ids = await replayNotificationIdsAfter(ctx(), batch[1]);

        expect(ids).toEqual([batch[0]]);
        expect(ids).not.toContain(old1);
        expect(ids).not.toContain(old2);
    });

    it('never returns ANOTHER person’s notifications', async () => {
        const mine = await notify(me, at(0));
        await notify(other, at(1));
        await notify(other, at(2));

        expect(await replayNotificationIdsAfter(ctx(), mine)).toEqual([]);
    });

    it('cannot use another person’s id as a cursor', async () => {
        // A `Last-Event-ID` is client-controlled. Resolving a cursor the
        // caller may not see would leak the existence of that row, and would
        // replay from a timestamp they never reached.
        await notify(me, at(0));
        const theirs = await notify(other, at(1));
        await notify(me, at(2));

        expect(await replayNotificationIdsAfter(ctx(), theirs)).toEqual([]);
    });

    it('replays nothing for an unknown or malformed cursor', async () => {
        await notify(me, at(0));
        // Unknown but well-shaped, then shapes that never came from here. A
        // cursor from a deleted notification is the same answer as nonsense:
        // "I cannot tell you what you missed", and the client refetches.
        for (const bad of ['c'.repeat(25), '', 'not-a-cuid!!', '../../etc/passwd', 'x']) {
            expect(await replayNotificationIdsAfter(ctx(), bad)).toEqual([]);
        }
    });

    it('is bounded, so a client away for a week is not sent everything', async () => {
        const cursor = await notify(me, at(0));
        for (let i = 1; i <= REPLAY_LIMIT + 10; i++) await notify(me, at(i));

        const ids = await replayNotificationIdsAfter(ctx(), cursor);
        expect(ids).toHaveLength(REPLAY_LIMIT);
    });

    it('orders by TIME, not by id', async () => {
        // cuids are roughly time-ordered as a side effect of their prefix, not
        // as a guarantee. Rows are written here in reverse time order, so an
        // implementation comparing ids would return them in insertion order
        // and this would fail.
        const cursor = await notify(me, at(0));
        const later = await notify(me, at(10));
        const middle = await notify(me, at(5));

        expect(await replayNotificationIdsAfter(ctx(), cursor)).toEqual([middle, later]);
    });
});
