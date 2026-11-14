/**
 * #2989 — the display-name entry point, end to end.
 *
 * ## The assertion that matters is the LAST one in the first test
 *
 * `PersonProfile.published` defaults false. A writer that set `displayName`
 * and left `published` alone would pass every test about the column and
 * change NOTHING a reader can see — the person types their name, the channel
 * still shows the farm alone, and nothing says why. That is the dormancy this
 * whole issue is about, one level down.
 *
 * So these tests go through `readChannelFeed`: they assert the FEED changes,
 * not that a row was written. A test of the row would have passed against the
 * broken version.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { joinChannel, postToChannel, readChannelFeed } from '@/app-layer/usecases/channels';
import {
    readOwnProfile, setOwnDisplayName, DISPLAY_NAME_MAX_LENGTH,
} from '@/app-layer/usecases/person-profile';
import type { UserContext } from '@/app-layer/types';
import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const USER = `u-dn-${randomUUID()}`;
const FARM_ID = `t-dn-${randomUUID()}`;
const FARM_SLUG = `dn-${randomUUID()}`.slice(0, 40);
const KEY = `crop:dn-${randomUUID()}`;
let channelId = '';

const ctx: UserContext = {
    requestId: `req-${randomUUID()}`,
    userId: USER,
    email: `${USER}@example.test`,
};

describeFn('#2989 — setting a display name', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: KEY, nameBg: 'Тест', nameEn: 'Test', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;
        await prisma.tenant.create({
            data: { id: FARM_ID, name: 'ЗК Изгрев', slug: FARM_SLUG },
        });
        const email = `${USER}@example.test`;
        await prisma.user.create({ data: { id: USER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: FARM_ID, userId: USER, role: 'EDITOR', status: 'ACTIVE' },
        });
        await joinChannel(ctx, channelId);
    });

    afterAll(async () => {
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.personProfile.deleteMany({ where: { userId: USER } });
        await prisma.tenantMembership.deleteMany({ where: { userId: USER } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.tenant.deleteMany({ where: { id: FARM_ID } });
        await prisma.$disconnect();
    });

    async function authorOf(postId: string) {
        const feed = await readChannelFeed(ctx, channelId, { limit: 50 });
        return feed.posts.find((p) => p.id === postId)?.author ?? null;
    }

    it('the empty state reports NULL, which is the signal a client prompts from', async () => {
        expect(await readOwnProfile(ctx)).toEqual({ displayName: null, published: false });
    }, 60_000);

    it('setting a name PUBLISHES it, so the feed changes', async () => {
        const { postId } = await postToChannel(ctx, channelId, {
            body: 'Преди името.',
            tenantSlug: FARM_SLUG,
        });
        // Before: the designed fallback.
        expect(await authorOf(postId)).toEqual({ displayName: null, farmName: 'ЗК Изгрев', farmHandle: null });

        await setOwnDisplayName(ctx, { displayName: 'Иван Петров' });

        // After: the same post, now attributed. The row having been written is
        // NOT the property — this is.
        expect(await authorOf(postId)).toEqual({
            displayName: 'Иван Петров',
            farmName: 'ЗК Изгрев',
            // Null: this suite creates no `FarmBrand`, and a farm with no
            // published brand offers no handle (#3043).
            farmHandle: null,
        });
        expect(await readOwnProfile(ctx)).toEqual({
            displayName: 'Иван Петров',
            published: true,
        });
    }, 60_000);

    it('clearing it UNPUBLISHES, and the feed reverts to the farm alone', async () => {
        await setOwnDisplayName(ctx, { displayName: 'Иван Петров' });
        const { postId } = await postToChannel(ctx, channelId, {
            body: 'След името.',
            tenantSlug: FARM_SLUG,
        });
        expect(await authorOf(postId)).toMatchObject({ displayName: 'Иван Петров' });

        await setOwnDisplayName(ctx, { displayName: null });

        expect(await authorOf(postId)).toEqual({ displayName: null, farmName: 'ЗК Изгрев', farmHandle: null });
        // The row must not be left published-with-no-name: that state renders
        // nothing, reads as a bug, and would start showing a name again the
        // moment any other writer set one.
        const row = await prisma.personProfile.findUnique({
            where: { userId: USER },
            select: { displayName: true, published: true },
        });
        expect(row).toEqual({ displayName: null, published: false });
    }, 60_000);

    it('a blank name is the same as clearing it, not a published empty string', async () => {
        await setOwnDisplayName(ctx, { displayName: 'Иван Петров' });
        await setOwnDisplayName(ctx, { displayName: '   ' });
        expect(await readOwnProfile(ctx)).toEqual({ displayName: null, published: false });
    }, 60_000);

    it('markup is stripped rather than stored', async () => {
        await setOwnDisplayName(ctx, { displayName: '<b>Иван</b> Петров' });
        const { displayName } = await readOwnProfile(ctx);
        expect(displayName).not.toContain('<');
        expect(displayName).toContain('Иван');
    }, 60_000);

    it('an over-long name is refused with a code a client can act on', async () => {
        await expect(
            setOwnDisplayName(ctx, { displayName: 'и'.repeat(DISPLAY_NAME_MAX_LENGTH + 1) }),
        ).rejects.toMatchObject({ code: 'DISPLAY_NAME_TOO_LONG' });
    }, 60_000);

    it('the cap is measured AFTER stripping, so markup cannot smuggle length', async () => {
        // 60 real characters wrapped in tags that take it past the cap: the
        // name survives, because the check runs on what will be stored.
        const name = 'и'.repeat(DISPLAY_NAME_MAX_LENGTH);
        await setOwnDisplayName(ctx, { displayName: `<span>${name}</span>` });
        expect((await readOwnProfile(ctx)).displayName).toBe(name);
    }, 60_000);
});
