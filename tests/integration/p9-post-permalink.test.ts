/**
 * #3030 — one post, read by its own id, for the permalink page.
 *
 * ## Why this read did not already exist
 *
 * #3030's premise was that "the read path is built; this is a page over it".
 * Measured, it was not: `readChannelFeed` returns TOP-LEVEL posts for a
 * channel (`parentPostId: null`), and `readPostReplies` reads the parent only
 * to VALIDATE it — `select: { id: true, parentPostId: true }` — and returns
 * the replies alone. Nothing returned a single post, which is exactly what a
 * permalink is.
 *
 * ## The cases that matter are the ones a 404 would get wrong
 *
 * Resolving a live post is the easy half and a wrong implementation gets it
 * right too. What this file is for:
 *
 *   - a REMOVED post answers 200 with the collapse applied, not 404, because
 *     the link may be sitting in somebody's push from before the removal — and
 *     "that never existed" is a different statement from "that is gone";
 *   - a REPLY resolves by its OWN id and reports `parentPostId`, which is the
 *     only thing the page can link up by. `…/replies` refuses a reply as a
 *     parent (threads are one level deep, P9.3b), so this is the one read that
 *     accepts one;
 *   - a genuinely absent id is `CHANNEL_POST_NOT_FOUND`, which is honest
 *     because `channel_post_select` admits any authenticated caller: a null
 *     row is an absent row rather than a policy refusal.
 *
 * ## The farm handle is the #1664 control
 *
 * `readPost` resolves handles through `runWithoutRls` OUTSIDE its transaction,
 * delegating to `ExchangeRepository.listPublishedFarmBrands`. Inside, the read
 * would return ZERO ROWS SILENTLY — `FarmBrand` is tenant-scoped and the
 * transaction runs in a USER context, so the handle would simply be null and
 * nothing would fail. That is why a non-null handle is asserted here as a
 * POSITIVE: every negative in this file passes just as well against a
 * resolver that answers null for everything.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    joinChannel, postToChannel, replyToPost, readPost,
} from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';

import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const AUTHOR = `u-3030-a-${randomUUID()}`;
const READER = `u-3030-r-${randomUUID()}`;

const FARM = `t-3030-${randomUUID()}`;
const FARM_SLUG = `p3030-${randomUUID()}`.slice(0, 40);
const FARM_HANDLE = `pobeda3030-${randomUUID()}`.slice(0, 30).toLowerCase();

const KEY = `crop:p3030-${randomUUID()}`;
let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

describeFn('#3030 — a post is readable by its own id', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: KEY, nameBg: 'Постоянни връзки', nameEn: 'Permalinks', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;

        await prisma.tenant.create({
            data: { id: FARM, slug: FARM_SLUG, name: 'ЗК Победа' },
        });
        for (const userId of [AUTHOR, READER]) {
            const email = `${userId}@example.test`;
            // `emailHash` explicitly: this raw client carries no PII
            // middleware to derive it and the column is NOT NULL.
            await prisma.user.create({
                data: { id: userId, email, emailHash: hashForLookup(email) },
            });
            await prisma.tenantMembership.create({
                data: { tenantId: FARM, userId, role: 'EDITOR', status: 'ACTIVE' },
            });
            await joinChannel(ctxFor(userId), channelId);
        }

        // Published, WITH a displayName: `listPublishedFarmBrands` drops any
        // row whose handle or displayName is null, so a fixture without it
        // cannot express the success state at all (#3043 lost two cases to
        // exactly that).
        await prisma.farmBrand.create({
            data: {
                tenantId: FARM,
                handle: FARM_HANDLE,
                displayName: 'ЗК Победа',
                published: true,
            },
        });
        await prisma.publicFarmProfile.create({
            data: { handle: FARM_HANDLE, displayName: 'ЗК Победа' },
        });
    });

    afterAll(async () => {
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.publicFarmProfile.deleteMany({ where: { handle: FARM_HANDLE } });
        await prisma.farmBrand.deleteMany({ where: { tenantId: FARM } });
        await prisma.tenantMembership.deleteMany({
            where: { userId: { in: [AUTHOR, READER] } },
        });
        await prisma.user.deleteMany({ where: { id: { in: [AUTHOR, READER] } } });
        await prisma.tenant.deleteMany({ where: { id: FARM } });
        await prisma.$disconnect();
    });

    async function makePost(body: string) {
        const { postId } = await postToChannel(ctxFor(AUTHOR), channelId, {
            body,
            tenantSlug: FARM_SLUG,
        });
        return postId;
    }

    it('returns a live post, its channel, and the author line', async () => {
        const postId = await makePost('Публикация с постоянна връзка');

        // Read by a DIFFERENT person: a channel is public to any authenticated
        // caller (P9.1), and a permalink somebody pastes is read by somebody
        // who is not the author.
        const got = await readPost(ctxFor(READER), postId);

        expect(got.post.id).toBe(postId);
        expect(got.post.body).toBe('Публикация с постоянна връзка');
        expect(got.post.deleted).toBe(false);
        expect(got.channelId).toBe(channelId);
        // Top-level, so there is nothing to link up to.
        expect(got.parentPostId).toBeNull();
        expect(got.post.author?.farmName).toBe('ЗК Победа');
        // THE POSITIVE CONTROL for the privileged read outside the
        // transaction. Resolved inside it, this is null with no error.
        expect(got.post.author?.farmHandle).toBe(FARM_HANDLE);
    }, 60_000);

    it('accepts a REPLY by its own id and reports its parent', async () => {
        const parentId = await makePost('Въпрос');
        const { postId: replyId } = await replyToPost(ctxFor(READER), parentId, {
            body: 'Отговор',
        });

        const got = await readPost(ctxFor(AUTHOR), replyId);

        expect(got.post.id).toBe(replyId);
        expect(got.post.body).toBe('Отговор');
        // The whole reason the field is returned: the page offers the parent's
        // permalink, because a reply has no replies of its own to render.
        expect(got.parentPostId).toBe(parentId);
        expect(got.channelId).toBe(channelId);
    }, 60_000);

    it('answers 200 with the collapse for a post removed by a MODERATOR', async () => {
        const postId = await makePost('Съдържание за премахване');

        // The POSITIVE half first, so the assertions below are known to be
        // about the removal rather than about a reader that always withholds.
        const before = await readPost(ctxFor(READER), postId);
        expect(before.post.body).toBe('Съдържание за премахване');
        expect(before.post.author).not.toBeNull();

        await prisma.channelPost.update({
            where: { id: postId },
            data: { removedByModerationAt: new Date() },
        });

        const after = await readPost(ctxFor(READER), postId);
        // PRESENT, not 404 — the link may predate the removal.
        expect(after.post.id).toBe(postId);
        expect(after.post.deleted).toBe(true);
        expect(after.post.body).toBe('');
        // Nobody is named above content nobody can read (#2989).
        expect(after.post.author).toBeNull();
        // Still addressable: the page can still say which channel it was in.
        expect(after.channelId).toBe(channelId);
    }, 60_000);

    it('collapses an author RETRACTION the same way, so the two are indistinguishable', async () => {
        const postId = await makePost('Съдържание за оттегляне');
        await prisma.channelPost.update({
            where: { id: postId },
            data: { deletedAt: new Date() },
        });

        const got = await readPost(ctxFor(READER), postId);
        // The SAME observable as the moderator case above, which is the point:
        // the three removal columns are collapsed precisely so a reader cannot
        // tell a moderator's act from the author's.
        expect(got.post.deleted).toBe(true);
        expect(got.post.body).toBe('');
        expect(got.post.author).toBeNull();
    }, 60_000);

    it('refuses an id that names no post', async () => {
        await expect(
            readPost(ctxFor(READER), `cp-absent-${randomUUID()}`),
        ).rejects.toMatchObject({ code: 'CHANNEL_POST_NOT_FOUND' });
    }, 60_000);
});
