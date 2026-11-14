/**
 * P9.4 (#2938) — the daily card generator, its identity, and its DENOMINATOR.
 *
 * ## The reading is a deliverable here, not instrumentation
 *
 * Owner decision 2026-11-14: build all four card kinds, and make a dormant one
 * visibly dormant. Measured in production the sources are uneven by two orders
 * of magnitude — 1,501 news items against 1 ACTIVE exchange listing — so
 * `cards: 0` has at least three causes and one number cannot separate them.
 * That is the P9.3d auto-hide precedent, where `hidden: 0` was ambiguous
 * between "the rule works and nothing warranted hiding" and "the threshold
 * cannot be reached".
 *
 * So this file asserts the per-kind arithmetic as hard as it asserts the rows.
 *
 * ## `getMarketNews` is MOCKED, and the reason is the cache
 *
 * It reads through a Redis-cached helper and there is no Redis here, so the
 * real call would fall through to the database and return whatever the shared
 * news table happens to hold — making every assertion about freshness depend
 * on another suite's fixtures. Mocked, the window is testable in both
 * directions.
 *
 * What that bounds: this file does NOT prove the tag rule itself
 * (`tags: { hasSome }` in `readNewsFromDb`). It proves which TAG each channel
 * asks for, which is the part #2938 got to decide.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { newsTagForChannelKey, runChannelCards } from '@/app-layer/jobs/channel-cards';
import { farmToday } from '@/lib/calendar-day-key';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const newsMock = jest.fn();
jest.mock('@/app-layer/usecases/trends', () => ({
    ...(jest.requireActual('@/app-layer/usecases/trends') as object),
    getMarketNews: (...a: unknown[]) => newsMock(...a),
}));

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/*
 * THE REAL KEYS, not suffixed ones — and this cost a run to learn.
 *
 * `newsTagForChannelKey` reads everything after the first colon and matches it
 * against `CROP_TAGS`, so a key uniquified as `crop:wheat-a1b2c3d4` maps to
 * NOTHING and the wheat channel silently got no card. The `input:` branch
 * returns `inputs` whatever follows the colon, so diesel worked anyway — which
 * is exactly why the failure looked like a bug in the generator rather than in
 * the fixture: one of the two eligible channels behaved.
 *
 * So the keys are real and acquired with `upsert`: `Channel.key` is unique and
 * the seed suite may already hold them. `created` records which rows are ours
 * to delete, so a shared channel survives this file.
 */
/** A crop channel whose commodity IS a news tag. */
const WHEAT = 'crop:wheat';
/** A crop channel whose commodity is NOT a news tag — oats has none. */
const OATS = 'crop:oats';
/** An input channel: shares the `inputs` topic tag. */
const DIESEL = 'input:diesel';
/** An oblast channel: no regional tag exists, so no news card can serve it. */
const OBLAST = 'oblast:BG-16';

const KEYS = [WHEAT, OATS, DIESEL, OBLAST];
const ids = new Map<string, string>();
/** Only the channels THIS file created, so a seeded one is not deleted. */
const created = new Set<string>();

function newsItem(title: string, publishedAt: Date, source = 'Investor.bg') {
    return {
        items: [{
            id: randomUUID(), title, url: `https://example.test/${randomUUID()}`,
            source, category: 'market', summary: null, imageUrl: null,
            publishedAt: publishedAt.toISOString(), tags: [],
        }],
        nextCursor: null,
    };
}

describeFn('#2938 — the daily channel-card generator', () => {
    beforeAll(async () => {
        await prisma.$connect();
        for (const key of KEYS) {
            const existing = await prisma.channel.findUnique({
                where: { key }, select: { id: true },
            });
            if (existing) {
                ids.set(key, existing.id);
                continue;
            }
            const c = await prisma.channel.create({
                data: {
                    key,
                    nameBg: 'Тест',
                    nameEn: 'Test',
                    kind: key.startsWith('crop:') ? 'CROP' : key.startsWith('input:') ? 'TOPIC' : 'OBLAST',
                },
                select: { id: true },
            });
            ids.set(key, c.id);
            created.add(c.id);
        }
    });

    afterAll(async () => {
        await prisma.channelPost.deleteMany({ where: { channelId: { in: [...ids.values()] } } });
        await prisma.channel.deleteMany({ where: { id: { in: [...created] } } });
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        newsMock.mockReset();
        await prisma.channelPost.deleteMany({ where: { channelId: { in: [...ids.values()] } } });
    });

    describe('which tag serves which channel', () => {
        it('maps a crop channel to its own tag, and only when one exists', () => {
            expect(newsTagForChannelKey('crop:wheat')).toBe('wheat');
            expect(newsTagForChannelKey('crop:maize')).toBe('maize');
            // The five crops with no tag in the vocabulary. A card for them
            // would need a tag somebody has to add to `CROP_TAGS` first.
            expect(newsTagForChannelKey('crop:oats')).toBeNull();
            expect(newsTagForChannelKey('crop:lentils')).toBeNull();
        });

        it('maps every input channel to the shared `inputs` topic tag', () => {
            // The SAME tag, so five input channels get the same card. Accepted
            // deliberately: the alternative is no card at all for fuel and
            // fertiliser, the two largest cash costs in an arable budget.
            expect(newsTagForChannelKey('input:diesel')).toBe('inputs');
            expect(newsTagForChannelKey('input:urea')).toBe('inputs');
        });

        it('maps an oblast channel to NOTHING', () => {
            // A DECISION, not an omission: the news vocabulary carries no
            // regional tag, and national weather or subsidy news pushed into
            // 28 oblast channels is the same card 28 times in surfaces that
            // exist to be local. They are served by the LISTING card.
            expect(newsTagForChannelKey('oblast:BG-16')).toBeNull();
            expect(newsTagForChannelKey('oblast:BG-23')).toBeNull();
        });

        it('returns null for a key with no prefix at all', () => {
            // The control for the parser: a key the seed could never write
            // must not fall into the crop branch by accident.
            expect(newsTagForChannelKey('wheat')).toBeNull();
            expect(newsTagForChannelKey('')).toBeNull();
        });
    });

    describe('generation', () => {
        it('writes ONE card per eligible channel and reports the per-kind arithmetic', async () => {
            newsMock.mockImplementation(async (_c: string, _l: number, f: { tags: string[] }) =>
                newsItem(`Заглавие за ${f.tags[0]}`, new Date()));

            const r = await runChannelCards();

            const news = r.byKind.NEWS!;
            // THE DENOMINATOR, asserted as hard as the rows. `channels` counts
            // every non-archived channel in the database, so it includes this
            // suite's four and any another suite left behind — hence `>=`.
            expect(news.channels).toBeGreaterThanOrEqual(4);
            expect(news.dormant).toBe(false);

            const posts = await prisma.channelPost.findMany({
                where: { channelId: { in: [...ids.values()] } },
                select: { channelId: true, kind: true, cardKind: true, cardDay: true, body: true, cardPayloadJson: true },
            });

            // wheat and diesel are eligible; oats and the oblast are not.
            expect(posts).toHaveLength(2);
            const byChannel = new Map(posts.map((p) => [p.channelId, p]));
            expect(byChannel.has(ids.get(WHEAT)!)).toBe(true);
            expect(byChannel.has(ids.get(DIESEL)!)).toBe(true);
            // THE NEGATIVES, which is where a too-generous mapping would show.
            expect(byChannel.has(ids.get(OATS)!)).toBe(false);
            expect(byChannel.has(ids.get(OBLAST)!)).toBe(false);

            const card = byChannel.get(ids.get(WHEAT)!)!;
            expect(card.kind).toBe('CARD');
            expect(card.cardKind).toBe('NEWS');
            // The FACTS, locale-independent — no composed sentence.
            const payload = card.cardPayloadJson as Record<string, unknown>;
            expect(payload.tag).toBe('wheat');
            expect(payload.title).toBe('Заглавие за wheat');
            expect(payload.source).toBe('Investor.bg');
            expect(payload.url).toEqual(expect.stringContaining('https://'));
            // The headline as a plain-text fallback, so a client that does not
            // render cards still shows something readable.
            expect(card.body).toBe('Заглавие за wheat');
            // The day, in Europe/Sofia.
            expect(card.cardDay?.toISOString().slice(0, 10)).toBe(farmToday());
        }, 60_000);

        it('asks ONCE per distinct tag, not once per channel', async () => {
            newsMock.mockImplementation(async (_c: string, _l: number, f: { tags: string[] }) =>
                newsItem(`T ${f.tags[0]}`, new Date()));

            await runChannelCards();

            // The D1 no-read-in-a-loop rule applied to a usecase call: the
            // five input channels share `inputs`, so a per-channel read would
            // ask the same question five times.
            const asked = newsMock.mock.calls.map((c) => (c[2] as { tags: string[] }).tags[0]);
            expect(new Set(asked).size).toBe(asked.length);
            expect(asked).toContain('wheat');
            expect(asked).toContain('inputs');
        }, 60_000);

        it('is IDEMPOTENT — a second run inserts nothing', async () => {
            newsMock.mockImplementation(async () => newsItem('Заглавие', new Date()));

            const first = await runChannelCards();
            const second = await runChannelCards();

            expect(first.byKind.NEWS!.created).toBeGreaterThanOrEqual(2);
            // ZERO on the second run, and this is the unique index doing it
            // rather than a flag: `skipDuplicates` reports what it actually
            // inserted, so "created" and "already there" stay separate
            // numbers. A retry therefore cannot double-post.
            expect(second.byKind.NEWS!.created).toBe(0);
            // And `withContent` is NOT zero on the second run — the content
            // was there, the rows were not written. Asserted because a
            // generator that reported 0/0 would look identical to one that
            // found nothing.
            expect(second.byKind.NEWS!.withContent).toBeGreaterThanOrEqual(2);

            expect(await prisma.channelPost.count({
                where: { channelId: { in: [...ids.values()] } },
            })).toBe(first.byKind.NEWS!.created);
        }, 60_000);

        it('writes NO card when the freshest item is too old', async () => {
            // 10 days back. A feed that went quiet must not produce a card
            // from a stale headline — the cutoff is a floor on the ITEM, not
            // a window around today.
            newsMock.mockImplementation(async () =>
                newsItem('Старо', new Date(Date.now() - 10 * 24 * 3600_000)));

            const r = await runChannelCards();

            expect(r.byKind.NEWS!.withContent).toBe(0);
            expect(r.byKind.NEWS!.created).toBe(0);
            // STILL NOT DORMANT: the channels were eligible and the content
            // was absent, which is a different fact from "this kind cannot
            // fire". That distinction is the whole reason the reading exists.
            expect(r.byKind.NEWS!.dormant).toBe(false);
            expect(r.byKind.NEWS!.eligible).toBeGreaterThanOrEqual(2);
            expect(await prisma.channelPost.count({
                where: { channelId: { in: [...ids.values()] } },
            })).toBe(0);
        }, 60_000);

        it('writes NO card for an item dated in the FUTURE', async () => {
            // A feed with a bad date must not pre-empt tomorrow's card, which
            // the unique index would then refuse for the real one.
            newsMock.mockImplementation(async () =>
                newsItem('Утре', new Date(Date.now() + 5 * 24 * 3600_000)));

            const r = await runChannelCards();
            expect(r.byKind.NEWS!.withContent).toBe(0);
        }, 60_000);

        it('skips an ARCHIVED channel', async () => {
            newsMock.mockImplementation(async () => newsItem('Заглавие', new Date()));
            await prisma.channel.update({
                where: { id: ids.get(WHEAT)! },
                data: { archivedAt: new Date() },
            });
            try {
                await runChannelCards();
                const wheat = await prisma.channelPost.count({
                    where: { channelId: ids.get(WHEAT)! },
                });
                expect(wheat).toBe(0);
                // The CONTROL: diesel is not archived and still got one, so
                // this asserts the filter rather than a run that did nothing.
                expect(await prisma.channelPost.count({
                    where: { channelId: ids.get(DIESEL)! },
                })).toBe(1);
            } finally {
                await prisma.channel.update({
                    where: { id: ids.get(WHEAT)! },
                    data: { archivedAt: null },
                });
            }
        }, 60_000);
    });
});
