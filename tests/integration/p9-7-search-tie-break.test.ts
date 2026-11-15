/**
 * Paging must not drop rows that SHARE a `createdAt` (#2941, found by the
 * agrent-ios session asking whether `before` is strict `<`).
 *
 * ## Why ties are not hypothetical here
 *
 * `createdAt` is `timestamp(3)` — milliseconds — and Postgres `now()` is
 * TRANSACTION-STABLE, so every row written by one statement in one
 * transaction carries an identical timestamp. P9.4's card generator inserts
 * up to ten cards with one `createMany`, so ten rows with the same
 * `createdAt` is the normal case rather than a coincidence.
 *
 * With `ORDER BY createdAt DESC, id DESC` and a cursor on `createdAt` alone,
 * `createdAt < cursor` excludes EVERY row tied with the boundary row — so a
 * page boundary falling inside such a group silently loses the rest of it.
 * The reader sees a short page and no indication that anything is missing.
 *
 * This file pins the fix: the cursor is `(createdAt, id)`, so a tie is broken
 * by the same second key the ordering uses.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { joinChannel, searchChannelPosts } from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';
import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `tie-${randomUUID().slice(0, 8)}`;
const ME = `u-${TAG}`;
const NEEDLE = `игла${TAG}`;
let channelId = '';

function ctx(): UserContext {
    return { requestId: `req-${randomUUID()}`, userId: ME, email: `${ME}@example.test` };
}

describeFn('#2941 — paging does not drop rows sharing a createdAt', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: `topic:${TAG}`, nameBg: 'Тест', nameEn: 'T', kind: 'TOPIC' },
            select: { id: true },
        });
        channelId = c.id;
        const email = `${ME}@example.test`;
        await prisma.user.create({
            data: { id: ME, email, emailHash: hashForLookup(email) },
        });
        await joinChannel(ctx(), channelId);

        /*
         * FIVE POSTS, ONE STATEMENT — so all five share a `createdAt`,
         * exactly as P9.4's card generator produces them. `createMany` with
         * the column's `now()` default is what makes the tie, not a contrived
         * timestamp: writing an explicit identical date would prove the query
         * handles a value I chose rather than one the product creates.
         */
        await prisma.channelPost.createMany({
            data: Array.from({ length: 5 }, (_, i) => ({
                channelId,
                authorUserId: ME,
                kind: 'POST' as const,
                body: `${NEEDLE} ${i}`,
            })),
        });
    });

    afterAll(async () => {
        await prisma.channelPost.deleteMany({ where: { channelId } });
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.user.deleteMany({ where: { id: ME } });
        await prisma.$disconnect();
    });

    it('all five rows really do share one timestamp — the premise', async () => {
        const rows = await prisma.channelPost.findMany({
            where: { channelId }, select: { createdAt: true },
        });
        expect(rows).toHaveLength(5);
        // THE PREMISE, asserted rather than assumed: if Prisma or Postgres
        // ever stopped sharing the transaction timestamp, the case below would
        // pass for the wrong reason and prove nothing about ties.
        expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(1);
    }, 60_000);

    it('pages through ALL of them, two at a time, losing none', async () => {
        const seen: string[] = [];
        let before: Date | undefined;
        let beforeId: string | undefined;

        for (let page = 0; page < 5; page += 1) {
            const r = await searchChannelPosts(ctx(), {
                q: NEEDLE, scope: 'joined', limit: 2, before, beforeId,
            });
            seen.push(...r.hits.map((h) => h.post.id));
            if (!r.hasMore) break;
            const last = r.hits.at(-1)!;
            before = last.post.createdAt;
            beforeId = last.post.id;
        }

        // FIVE DISTINCT ROWS. With a cursor on `createdAt` alone this returns
        // two: the first page, and then nothing, because every remaining row
        // is tied with the boundary and `lt` excludes them all.
        expect(new Set(seen).size).toBe(5);
    }, 60_000);
});
