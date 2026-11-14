/**
 * #3043 — a post's author carries the handle of the farm they posted AS.
 *
 * For agrent-ios #596: a direct message is startable from a channel post. The
 * open route takes a HANDLE, and until now a post carried the farm's NAME and
 * no way to address it.
 *
 * ## The cases that matter are the two NULLS
 *
 * Returning a handle for a farm with a published page is the easy half and the
 * one a wrong implementation also gets right. What this file is really for:
 *
 *   - a farm with a brand and NO published projection yields null, because the
 *     projection is what `/f/{handle}` serves and a handle whose page does not
 *     serve is worse than no handle;
 *   - a HIDDEN post yields no `author` object at all, so there is nothing to
 *     offer «Пиши» above — the collapse the field deliberately lives inside.
 *
 * ## Both read paths, because the mapper is one and the selects are two
 *
 * `toPostView` is the single place the author line is built, which is what
 * stops the feed and the thread disagreeing (#2961 drifted exactly there). So
 * the handle is asserted through BOTH `readChannelFeed` and `readPostReplies`:
 * a mapper shared by two selects is only as good as the narrower select.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    joinChannel, postToChannel, readChannelFeed, replyToPost, readPostReplies,
} from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';

import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** Posts as a farm whose page IS published. */
const PUBLISHED_AUTHOR = `u-3043-pub-${randomUUID()}`;
/** Posts as a farm with a brand and NO projection — the negative control. */
const UNPUBLISHED_AUTHOR = `u-3043-unpub-${randomUUID()}`;
/** Posts as a farm with no brand at all. */
const BRANDLESS_AUTHOR = `u-3043-nobrand-${randomUUID()}`;

const PUB_FARM = `t-3043-pub-${randomUUID()}`;
const PUB_SLUG = `pub-3043-${randomUUID()}`.slice(0, 40);
const PUB_HANDLE = `pobeda-${randomUUID()}`.slice(0, 30).toLowerCase();

const UNPUB_FARM = `t-3043-unpub-${randomUUID()}`;
const UNPUB_SLUG = `unpub-3043-${randomUUID()}`.slice(0, 40);
const UNPUB_HANDLE = `tihost-${randomUUID()}`.slice(0, 30).toLowerCase();

const NOBRAND_FARM = `t-3043-nb-${randomUUID()}`;
const NOBRAND_SLUG = `nb-3043-${randomUUID()}`.slice(0, 40);

const KEY = `crop:p3043-${randomUUID()}`;
let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

const FARMS: [string, string, string][] = [
    [PUB_FARM, PUB_SLUG, 'ЗК Победа'],
    [UNPUB_FARM, UNPUB_SLUG, 'ЗК Тихост'],
    [NOBRAND_FARM, NOBRAND_SLUG, 'ЗК Безимения'],
];
const MEMBERS: [string, string][] = [
    [PUBLISHED_AUTHOR, PUB_FARM],
    [UNPUBLISHED_AUTHOR, UNPUB_FARM],
    [BRANDLESS_AUTHOR, NOBRAND_FARM],
];

describeFn('#3043 — the author line carries a farm handle', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: KEY, nameBg: 'Дръжки', nameEn: 'Handles', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;

        await prisma.tenant.createMany({
            data: FARMS.map(([id, slug, name]) => ({ id, slug, name })),
        });

        for (const [userId, tenantId] of MEMBERS) {
            const email = `${userId}@example.test`;
            // `emailHash` explicitly: this raw client carries no PII
            // middleware to derive it and the column is NOT NULL.
            await prisma.user.create({
                data: { id: userId, email, emailHash: hashForLookup(email) },
            });
            await prisma.tenantMembership.create({
                data: { tenantId, userId, role: 'EDITOR', status: 'ACTIVE' },
            });
            await joinChannel(ctxFor(userId), channelId);
        }

        // A brand AND its projection — the published farm.
        // `displayName` is REQUIRED for this to count as published, and the
        // first draft omitted it — `listPublishedFarmBrands` drops any row
        // whose handle or displayName is null, because they are nullable
        // COLUMNS that the publication preconditions guarantee. A fixture
        // without it cannot express the success state at all, which is how
        // both positive cases failed while all four negatives passed.
        await prisma.farmBrand.create({
            data: {
                tenantId: PUB_FARM,
                handle: PUB_HANDLE,
                displayName: 'ЗК Победа',
                published: true,
            },
        });
        await prisma.publicFarmProfile.create({
            data: { handle: PUB_HANDLE, displayName: 'ЗК Победа' },
        });

        // NOT published — the state that must yield no handle. A projection is
        // deliberately NOT created for it either, so the row is consistent
        // with how an unpublished farm really looks.
        await prisma.farmBrand.create({
            data: { tenantId: UNPUB_FARM, handle: UNPUB_HANDLE, published: false },
        });
    });

    afterAll(async () => {
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.publicFarmProfile.deleteMany({
            where: { handle: { in: [PUB_HANDLE, UNPUB_HANDLE] } },
        });
        await prisma.farmBrand.deleteMany({
            where: { tenantId: { in: [PUB_FARM, UNPUB_FARM, NOBRAND_FARM] } },
        });
        await prisma.tenantMembership.deleteMany({
            where: { userId: { in: MEMBERS.map(([u]) => u) } },
        });
        await prisma.user.deleteMany({ where: { id: { in: MEMBERS.map(([u]) => u) } } });
        await prisma.tenant.deleteMany({ where: { id: { in: FARMS.map(([id]) => id) } } });
        await prisma.$disconnect();
    });

    async function feedAuthorFor(postId: string) {
        const page = await readChannelFeed(ctxFor(PUBLISHED_AUTHOR), channelId, {});
        return page.posts.find((p) => p.id === postId)?.author;
    }

    it('carries the handle of a farm whose page is PUBLISHED', async () => {
        const { postId } = await postToChannel(ctxFor(PUBLISHED_AUTHOR), channelId, {
            body: 'Публикуван стопан',
            tenantSlug: PUB_SLUG,
        });

        const author = await feedAuthorFor(postId);
        expect(author?.farmName).toBe('ЗК Победа');
        expect(author?.farmHandle).toBe(PUB_HANDLE);
    }, 60_000);

    it('is NULL when the farm has a brand that is NOT published', async () => {
        // The real negative, and it is `FarmBrand.published` that decides —
        // the same authority the exchange uses for listing attribution, via
        // the same repository method. An earlier draft of this case asserted
        // the PROJECTION instead, which would have let the two surfaces
        // disagree about whether a farm is publicly reachable.
        //
        // The withdrawal argument is why that authority is the right one: a
        // farm taking its page down stops being returned, so attribution
        // reverts on the next read with nothing to back-fill.
        const { postId } = await postToChannel(ctxFor(UNPUBLISHED_AUTHOR), channelId, {
            body: 'Непубликуван стопан',
            tenantSlug: UNPUB_SLUG,
        });

        const author = await feedAuthorFor(postId);
        // The NAME is still shown — this field adds navigability, not
        // information, and withholding the name would be a different change.
        expect(author?.farmName).toBe('ЗК Тихост');
        expect(author?.farmHandle).toBeNull();
    }, 60_000);

    it('is NULL when the farm has no brand at all', async () => {
        const { postId } = await postToChannel(ctxFor(BRANDLESS_AUTHOR), channelId, {
            body: 'Без марка',
            tenantSlug: NOBRAND_SLUG,
        });

        const author = await feedAuthorFor(postId);
        expect(author?.farmName).toBe('ЗК Безимения');
        expect(author?.farmHandle).toBeNull();
    }, 60_000);

    it('is NULL when the post names no farm', async () => {
        const { postId } = await postToChannel(ctxFor(PUBLISHED_AUTHOR), channelId, {
            body: 'Без стопанство',
        });

        const author = await feedAuthorFor(postId);
        expect(author?.farmName).toBeNull();
        expect(author?.farmHandle).toBeNull();
    }, 60_000);

    it('reaches the THREAD read too, not only the feed', async () => {
        // One mapper, two selects. #2961 drifted exactly here, so the handle is
        // asserted through the narrower path as well.
        const { postId } = await postToChannel(ctxFor(PUBLISHED_AUTHOR), channelId, {
            body: 'Родител',
            tenantSlug: PUB_SLUG,
        });
        await replyToPost(ctxFor(PUBLISHED_AUTHOR), postId, {
            body: 'Отговор',
            tenantSlug: PUB_SLUG,
        });

        const page = await readPostReplies(ctxFor(PUBLISHED_AUTHOR), postId, {});
        expect(page.replies).not.toHaveLength(0);
        expect(page.replies[0].author?.farmHandle).toBe(PUB_HANDLE);
    }, 60_000);

    it('a HIDDEN post offers no author at all, so no handle either', async () => {
        // The reason the field lives INSIDE `author`: a handle hung outside
        // that collapse would let a client offer «Пиши» above content nobody
        // can read, which is the attribution the collapse exists to prevent.
        const { postId } = await postToChannel(ctxFor(PUBLISHED_AUTHOR), channelId, {
            body: 'Ще бъде скрит',
            tenantSlug: PUB_SLUG,
        });
        await prisma.channelPost.update({
            where: { id: postId },
            data: { removedByModerationAt: new Date() },
        });

        const author = await feedAuthorFor(postId);
        expect(author).toBeNull();
    }, 60_000);
});
