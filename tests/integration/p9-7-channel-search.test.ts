/**
 * Social search over channel posts (P9.7, #2941).
 *
 * ## The case this file exists for is the HIDDEN post
 *
 * The three removal columns empty a post's body in `toPostView` — at READ
 * time. The column still holds the text. So a search matching on `body` and
 * collapsing afterwards would hand back an empty row that nonetheless proves a
 * post containing the needle EXISTS, and a few narrowing queries recover what
 * it said. Search would become a disclosure channel for precisely the content
 * moderation took down.
 *
 * Every other case here is ordinary; that one is the reason the filter is in
 * the `where`.
 *
 * ## Membership is relevance, not security
 *
 * #2941 asked for membership filtering to prevent a leak. Measured, there is
 * nothing to leak: `channel_post_select` admits any authenticated caller and
 * P9.1 states there is no private channel. So `scope` is tested as a RELEVANCE
 * default — `all` genuinely returns more, and that is correct rather than a
 * hole.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { joinChannel, postToChannel, searchChannelPosts } from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';
import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const ME = `u-srch-${TAG}`;
const OTHER = `u-srch-other-${TAG}`;
/** A unique needle, so no other suite's rows can satisfy an assertion. */
const NEEDLE = `пшеница${TAG}`;
let joined = '';
let notJoined = '';

function ctx(userId = ME): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

describeFn('#2941 — searching channel posts', () => {
    beforeAll(async () => {
        await prisma.$connect();
        for (const u of [ME, OTHER]) {
            const email = `${u}@example.test`;
            await prisma.user.create({
                data: { id: u, email, emailHash: hashForLookup(email) },
            });
        }
        const a = await prisma.channel.create({
            data: { key: `topic:srch-a-${TAG}`, nameBg: 'Присъединен', nameEn: 'Joined', kind: 'TOPIC' },
            select: { id: true },
        });
        const b = await prisma.channel.create({
            data: { key: `topic:srch-b-${TAG}`, nameBg: 'Друг', nameEn: 'Other', kind: 'TOPIC' },
            select: { id: true },
        });
        joined = a.id;
        notJoined = b.id;
        await joinChannel(ctx(), joined);
        // OTHER joins both, so there is somebody who may post in each.
        await joinChannel(ctx(OTHER), joined);
        await joinChannel(ctx(OTHER), notJoined);
    });

    afterAll(async () => {
        await prisma.channelPost.deleteMany({ where: { channelId: { in: [joined, notJoined] } } });
        await prisma.channel.deleteMany({ where: { id: { in: [joined, notJoined] } } });
        await prisma.user.deleteMany({ where: { id: { in: [ME, OTHER] } } });
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await prisma.channelPost.deleteMany({ where: { channelId: { in: [joined, notJoined] } } });
    });

    it('finds a post in a channel I joined, case-insensitively', async () => {
        await postToChannel(ctx(OTHER), joined, { body: `Цената на ${NEEDLE.toUpperCase()} пада` });

        const r = await searchChannelPosts(ctx(), { q: NEEDLE });

        expect(r.hits).toHaveLength(1);
        expect(r.hits[0]!.channelId).toBe(joined);
        expect(r.hits[0]!.channelNameBg).toBe('Присъединен');
        // Bulgarian is the product's language; a case-sensitive search in it
        // would be useless.
        expect(r.hits[0]!.post.body).toContain(NEEDLE.toUpperCase());
        expect(r.scope).toBe('joined');
    }, 60_000);

    it('does NOT return a HIDDEN post — the disclosure this filter exists for', async () => {
        const { postId } = await postToChannel(ctx(OTHER), joined, {
            body: `Тайна за ${NEEDLE}`,
        });
        // THE CONTROL, in the same channel and the same needle: a visible post
        // IS found, so a zero below is the filter rather than a broken query.
        await postToChannel(ctx(OTHER), joined, { body: `Видима за ${NEEDLE}` });

        await prisma.channelPost.update({
            where: { id: postId },
            data: { removedByModerationAt: new Date() },
        });

        const r = await searchChannelPosts(ctx(), { q: NEEDLE });

        // ONE hit, and it is the visible one. If the removed post were matched
        // and collapsed afterwards there would be two, the second with an
        // empty body — which would tell the searcher that a post containing
        // their needle exists.
        expect(r.hits).toHaveLength(1);
        expect(r.hits[0]!.post.body).toContain('Видима');
        expect(r.hits.some((h) => h.post.id === postId)).toBe(false);
    }, 60_000);

    it('excludes an author RETRACTION and an AUTO-HIDE too, not just moderation', async () => {
        const a = await postToChannel(ctx(OTHER), joined, { body: `Оттеглена ${NEEDLE}` });
        const b = await postToChannel(ctx(OTHER), joined, { body: `Скрита ${NEEDLE}` });
        await postToChannel(ctx(OTHER), joined, { body: `Остава ${NEEDLE}` });

        await prisma.channelPost.update({ where: { id: a.postId }, data: { deletedAt: new Date() } });
        await prisma.channelPost.update({ where: { id: b.postId }, data: { autoHiddenAt: new Date() } });

        const r = await searchChannelPosts(ctx(), { q: NEEDLE });
        // All three removal columns, not only the moderation one — a filter
        // naming one of three is the shape that looks right and leaks twice.
        expect(r.hits).toHaveLength(1);
        expect(r.hits[0]!.post.body).toContain('Остава');
    }, 60_000);

    it('defaults to JOINED channels, and `all` genuinely widens', async () => {
        await postToChannel(ctx(OTHER), joined, { body: `В моя канал ${NEEDLE}` });
        await postToChannel(ctx(OTHER), notJoined, { body: `В чужд канал ${NEEDLE}` });

        const mine = await searchChannelPosts(ctx(), { q: NEEDLE });
        expect(mine.hits).toHaveLength(1);
        expect(mine.hits[0]!.channelId).toBe(joined);
        expect(mine.scope).toBe('joined');

        const everywhere = await searchChannelPosts(ctx(), { q: NEEDLE, scope: 'all' });
        // TWO: the wider scope is not a hole. Every channel post is readable
        // by every authenticated caller, so this is relevance, not access.
        expect(everywhere.hits).toHaveLength(2);
        expect(everywhere.scope).toBe('all');
    }, 60_000);

    it('refuses a needle shorter than the minimum', async () => {
        await expect(searchChannelPosts(ctx(), { q: 'п' }))
            .rejects.toMatchObject({ code: 'SEARCH_TOO_SHORT' });
        // Whitespace is trimmed first, so a padded single character is the
        // same refusal rather than a scan.
        await expect(searchChannelPosts(ctx(), { q: '  п  ' }))
            .rejects.toMatchObject({ code: 'SEARCH_TOO_SHORT' });
    }, 60_000);

    it('returns hits NEWEST first, with no relevance ordering', async () => {
        await postToChannel(ctx(OTHER), joined, { body: `${NEEDLE} ${NEEDLE} ${NEEDLE} първа` });
        await new Promise((r) => setTimeout(r, 5));
        await postToChannel(ctx(OTHER), joined, { body: `${NEEDLE} втора` });

        const r = await searchChannelPosts(ctx(), { q: NEEDLE });

        // The SECOND post is first, though the first contains the needle three
        // times. There is deliberately no scoring — #2868 removed
        // `CONTENT_DEMOTED` because there is no ranking here to demote within,
        // and a relevance score would introduce the first one.
        expect(r.hits[0]!.post.body).toContain('втора');
        expect(r.hits[1]!.post.body).toContain('първа');
    }, 60_000);
});
