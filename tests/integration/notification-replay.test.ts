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
