/**
 * #2989 — a channel post shows name + farm, executed against a real database.
 *
 * ## The control that matters most is the NEGATIVE one
 *
 * `PersonProfile` has row-level security DISABLED — measured on the migrated
 * database, `relrowsecurity` false, and the P6 migration that created it says
 * "no policy, because nothing reaches it under app_user". `resolveAuthors` is
 * the reader that comment says did not exist, so the `published: true` clause
 * in its `where` is the ONLY thing withholding an unpublished display name.
 * That is the inverted posture P5.6a names: RLS is normally the backstop, and
 * here the clause is the whole fence.
 *
 * So "an UNPUBLISHED profile renders the farm alone" is not a nicety — it is
 * the assertion that fails if that clause is ever dropped, and a suite with
 * only the happy path would pass while every unpublished name in the product
 * was being published to every channel.
 *
 * ## Both read paths, deliberately
 *
 * The feed and `readPostReplies` go through `toPostView`, and #2961 is the
 * case where a second read path was added and returned something the first
 * one hid. A test of the feed alone would not notice a reply path that
 * forgot the author rule.
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

/** Publishes a display name. */
const NAMED = `u-2989-named-${randomUUID()}`;
/** Has a profile row that is NOT published — the negative control. */
const UNPUBLISHED = `u-2989-unpub-${randomUUID()}`;
/** Has no profile row at all. */
const NAMELESS = `u-2989-none-${randomUUID()}`;

const FARM_ID = `t-2989-${randomUUID()}`;
const FARM_SLUG = `farm-2989-${randomUUID()}`.slice(0, 40);
const FARM_NAME = 'ЗК Победа';
/** A farm nobody in this suite is a member of. */
const OTHER_FARM_ID = `t-2989-other-${randomUUID()}`;
const OTHER_FARM_SLUG = `other-2989-${randomUUID()}`.slice(0, 40);

const KEY = `crop:p2989-${randomUUID()}`;
let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

describeFn('#2989 — the channel author line', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: KEY, nameBg: 'Тест', nameEn: 'Test', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;

        await prisma.tenant.createMany({
            data: [
                { id: FARM_ID, name: FARM_NAME, slug: FARM_SLUG },
                { id: OTHER_FARM_ID, name: 'ЗК Другаде', slug: OTHER_FARM_SLUG },
            ],
        });
        // Real User rows: PersonProfile.userId is a foreign key. `emailHash`
        // is supplied explicitly because this raw client carries no PII
        // middleware to derive it, and the column is NOT NULL — the same note
        // `native-refresh-tokens` and `user-session-rls` both carry.
        for (const id of [NAMED, UNPUBLISHED, NAMELESS]) {
            const email = `${id}@example.test`;
            await prisma.user.create({
                data: { id, email, emailHash: hashForLookup(email) },
            });
            await prisma.tenantMembership.create({
                data: { tenantId: FARM_ID, userId: id, role: 'EDITOR', status: 'ACTIVE' },
            });
            await joinChannel(ctxFor(id), channelId);
        }
        await prisma.personProfile.create({
            data: { userId: NAMED, displayName: 'Иван Петров', published: true },
        });
        await prisma.personProfile.create({
            // Set but NOT published — the P6 default, and the state every real
            // person is in until they answer the composer's prompt.
            data: { userId: UNPUBLISHED, displayName: 'Георги Иванов', published: false },
        });
    });

    afterAll(async () => {
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.personProfile.deleteMany({
            where: { userId: { in: [NAMED, UNPUBLISHED, NAMELESS] } },
        });
        await prisma.tenantMembership.deleteMany({
            where: { userId: { in: [NAMED, UNPUBLISHED, NAMELESS] } },
        });
        await prisma.user.deleteMany({ where: { id: { in: [NAMED, UNPUBLISHED, NAMELESS] } } });
        await prisma.tenant.deleteMany({ where: { id: { in: [FARM_ID, OTHER_FARM_ID] } } });
        await prisma.$disconnect();
    });

    async function authorOf(postId: string) {
        const feed = await readChannelFeed(ctxFor(NAMELESS), channelId, { limit: 50 });
        const post = feed.posts.find((p) => p.id === postId);
        expect(post).toBeDefined();
        return post!.author;
    }

    it('a published name and a recorded farm render as both', async () => {
        const { postId } = await postToChannel(ctxFor(NAMED), channelId, {
            body: 'Поливам рано сутрин.',
            tenantSlug: FARM_SLUG,
        });
        expect(await authorOf(postId)).toEqual({
            displayName: 'Иван Петров',
            farmName: FARM_NAME,
            // Null throughout this suite: it creates no `FarmBrand`, and a
            // farm with no published brand offers no handle (#3043).
            farmHandle: null,
        });
    }, 60_000);

    it('an UNPUBLISHED profile renders the farm ALONE, never the private name', async () => {
        // The negative control, and the reason this suite exists. Nothing in
        // the database withholds this name; the `published: true` clause does.
        const { postId } = await postToChannel(ctxFor(UNPUBLISHED), channelId, {
            body: 'Сеитбата започна.',
            tenantSlug: FARM_SLUG,
        });
        const author = await authorOf(postId);
        expect(author).toEqual({ displayName: null, farmName: FARM_NAME, farmHandle: null });
        // Said twice on purpose: the value must not appear, however the shape
        // of the object changes later.
        expect(JSON.stringify(author)).not.toContain('Георги');
    }, 60_000);

    it('no farm sent records NULL and renders the name alone — never a guess', async () => {
        // The author IS a member of a farm, so a read-time "oldest membership"
        // rule would have found one. Absence here proves nothing guessed.
        const { postId } = await postToChannel(ctxFor(NAMED), channelId, {
            body: 'Без стопанство.',
        });
        expect(await authorOf(postId)).toEqual({
            displayName: 'Иван Петров',
            farmName: null,
            farmHandle: null,
        });
    }, 60_000);

    it('neither half is a legitimate state, and renders as neither', async () => {
        const { postId } = await postToChannel(ctxFor(NAMELESS), channelId, {
            body: 'Анонимен принос.',
        });
        expect(await authorOf(postId)).toEqual({ displayName: null, farmName: null, farmHandle: null });
    }, 60_000);

    it('a farm the author is NOT a member of is refused, and writes nothing', async () => {
        const before = await prisma.channelPost.count({ where: { channelId } });
        await expect(
            postToChannel(ctxFor(NAMED), channelId, {
                body: 'Чуждо стопанство.',
                tenantSlug: OTHER_FARM_SLUG,
            }),
        ).rejects.toMatchObject({ code: 'NOT_A_MEMBER_OF_THAT_FARM' });
        expect(await prisma.channelPost.count({ where: { channelId } })).toBe(before);
    }, 60_000);

    it('a farm slug that does not exist is refused with the SAME code', async () => {
        // One code for both, so this is not an enumeration oracle for slugs.
        await expect(
            postToChannel(ctxFor(NAMED), channelId, {
                body: 'Няма такова.',
                tenantSlug: `nope-${randomUUID()}`.slice(0, 40),
            }),
        ).rejects.toMatchObject({ code: 'NOT_A_MEMBER_OF_THAT_FARM' });
    }, 60_000);

    it('a HIDDEN post is not attributed, while its neighbour still is', async () => {
        const hidden = await postToChannel(ctxFor(NAMED), channelId, {
            body: 'Ще бъде скрито.',
            tenantSlug: FARM_SLUG,
        });
        const visible = await postToChannel(ctxFor(NAMED), channelId, {
            body: 'Остава видимо.',
            tenantSlug: FARM_SLUG,
        });
        await prisma.channelPost.update({
            where: { id: hidden.postId },
            data: { removedByModerationAt: new Date() },
        });

        expect(await authorOf(hidden.postId)).toBeNull();
        // The control: without it, "always null" would satisfy the assertion
        // above and the author line would be gone for everybody.
        expect(await authorOf(visible.postId)).toEqual({
            displayName: 'Иван Петров',
            farmName: FARM_NAME,
            // Null throughout this suite: it creates no `FarmBrand`, and a
            // farm with no published brand offers no handle (#3043).
            farmHandle: null,
        });
    }, 60_000);

    it('REPLIES carry the author line too — the other read path', async () => {
        const parent = await postToChannel(ctxFor(NAMED), channelId, {
            body: 'Въпрос към канала.',
            tenantSlug: FARM_SLUG,
        });
        await replyToPost(ctxFor(UNPUBLISHED), parent.postId, {
            body: 'Отговор.',
            tenantSlug: FARM_SLUG,
        });
        const { replies } = await readPostReplies(ctxFor(NAMELESS), parent.postId, {});
        expect(replies).toHaveLength(1);
        // Same rule as the feed: unpublished name withheld, farm shown.
        expect(replies[0].author).toEqual({ displayName: null, farmName: FARM_NAME, farmHandle: null });
    }, 60_000);

    it('one page resolves SEVERAL authors correctly, from one lookup each', async () => {
        // Not a timing assertion — the N+1 is held statically by the D1
        // guardrail. What this covers is the MAP: a page mixing authors and
        // farms must not cross-label them, which a single-entry cache or a
        // last-write-wins map would.
        const a = await postToChannel(ctxFor(NAMED), channelId, {
            body: 'Първи.', tenantSlug: FARM_SLUG,
        });
        const b = await postToChannel(ctxFor(NAMELESS), channelId, { body: 'Втори.' });
        const c = await postToChannel(ctxFor(UNPUBLISHED), channelId, {
            body: 'Трети.', tenantSlug: FARM_SLUG,
        });
        const feed = await readChannelFeed(ctxFor(NAMELESS), channelId, { limit: 50 });
        const byId = new Map(feed.posts.map((p) => [p.id, p.author]));
        expect(byId.get(a.postId)).toEqual({ displayName: 'Иван Петров', farmName: FARM_NAME, farmHandle: null });
        expect(byId.get(b.postId)).toEqual({ displayName: null, farmName: null, farmHandle: null });
        expect(byId.get(c.postId)).toEqual({ displayName: null, farmName: FARM_NAME, farmHandle: null });
    }, 60_000);
});
