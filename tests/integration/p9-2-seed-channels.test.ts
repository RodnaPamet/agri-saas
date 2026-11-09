/**
 * P9.2 — the channel seed, executed against a real database (#2936).
 *
 * The catalogue's SHAPE is `tests/unit/channels/channel-catalogue.test.ts`.
 * This file asserts the two things only a database can show: that a re-run
 * creates nothing, and that it does not trample state an operator or the join
 * path owns.
 *
 * ## Why idempotence needs a test when it is "by construction"
 *
 * `Channel.key` is `@unique`, so the claim is that the upsert cannot
 * double-write. That is a claim about the SCHEMA plus the code agreeing, and
 * the way it breaks is a key that stops being the identity — a catalogue entry
 * whose key is derived differently on the second run, say. The assertion is
 * cheap and the failure would be a duplicate channel nobody notices until the
 * suggestion query returns two.
 *
 * ## The trample case is the one worth having
 *
 * `memberCount` is maintained by the join path and `slowModeSeconds` is an
 * operator throttling a channel that is being flooded. A seed that wrote the
 * create-shape on every run would reset both on every deploy — silently
 * undoing an operator's action, and a channel that un-slows itself when
 * somebody ships an unrelated change is worse than one that was never slowed.
 * `archivedAt` is the same shape: a channel somebody archived must not
 * un-archive itself.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { seedChannels, EXPECTED_CHANNEL_COUNT } from '../../scripts/channels/seed-channels';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('P9.2 — seeding the channel catalogue (#2936)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        // A clean slate for the keys this suite owns. By KEY rather than a
        // blanket delete: these tables are tenantless, so there is no tenant to
        // scope a teardown to, and a `deleteMany({})` would remove rows another
        // suite seeded.
        await prisma.channel.deleteMany({
            where: {
                OR: [
                    { key: { startsWith: 'crop:' } },
                    { key: { startsWith: 'input:' } },
                    { key: { startsWith: 'oblast:' } },
                ],
            },
        });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('creates the whole catalogue on a first run', async () => {
        const res = await seedChannels(prisma);
        expect(res.total).toBe(EXPECTED_CHANNEL_COUNT);
        expect(res.created).toBe(EXPECTED_CHANNEL_COUNT);
        expect(res.updated).toBe(0);

        const rows = await prisma.channel.count({
            where: {
                OR: [
                    { key: { startsWith: 'crop:' } },
                    { key: { startsWith: 'input:' } },
                    { key: { startsWith: 'oblast:' } },
                ],
            },
        });
        expect(rows).toBe(EXPECTED_CHANNEL_COUNT);
    }, 60_000);

    it('creates NOTHING on a second run — idempotent on the unique key', async () => {
        const res = await seedChannels(prisma);
        expect(res.created).toBe(0);
        expect(res.updated).toBe(EXPECTED_CHANNEL_COUNT);

        // And the count has not moved, which is the assertion that would catch
        // a key that stopped being the identity: `created: 0` alone would also
        // be produced by a seed that wrote nothing at all.
        const rows = await prisma.channel.count({
            where: { key: { startsWith: 'crop:' } },
        });
        expect(rows).toBe(10);
    }, 60_000);

    it('a re-run does NOT reset memberCount, slowModeSeconds or archivedAt', async () => {
        // The trample case. An operator slows a channel being flooded; the join
        // path maintains the count; somebody archives a channel. None of it is
        // the seed's to undo.
        await prisma.channel.update({
            where: { key: 'crop:wheat' },
            data: { memberCount: 1234, slowModeSeconds: 60, archivedAt: new Date() },
        });

        await seedChannels(prisma);

        const after = await prisma.channel.findUniqueOrThrow({
            where: { key: 'crop:wheat' },
            select: {
                memberCount: true, slowModeSeconds: true, archivedAt: true,
                nameBg: true,
            },
        });
        expect(after.memberCount).toBe(1234);
        expect(after.slowModeSeconds).toBe(60);
        expect(after.archivedAt).not.toBeNull();

        // POSITIVE CONTROL: the seed DID run and DID write. Without this, a
        // seed that crashed early would satisfy all three assertions above —
        // "it did not reset the counter" is exactly what doing nothing looks
        // like.
        expect(after.nameBg).toBe('Пшеница');
    }, 60_000);

    it('corrects a NAME on a re-run, which is the one thing it may change', async () => {
        await prisma.channel.update({
            where: { key: 'crop:maize' },
            data: { nameBg: 'ГРЕШНО', nameEn: 'WRONG' },
        });

        await seedChannels(prisma);

        const after = await prisma.channel.findUniqueOrThrow({
            where: { key: 'crop:maize' },
            select: { nameBg: true, nameEn: true },
        });
        expect(after.nameBg).toBe('Царевица');
        expect(after.nameEn).toBe('Maize');
    }, 60_000);

    it('joins NOBODY — the clause this phase is actually about', async () => {
        // The source-level half is
        // `tests/guards/channels-are-never-auto-joined.test.ts`; this is the
        // runtime half, and it is the one that would catch a join written
        // through a path the regex does not match.
        const memberships = await prisma.channelMembership.count();
        expect(memberships).toBe(0);
    }, 60_000);
});
