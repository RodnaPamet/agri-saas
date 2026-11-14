/**
 * P9.4 (#2938) — channel cards, generated daily on their own queue.
 *
 * ## Why NOT an automation event, which the phase names first
 *
 * `emitAutomationEvent` feeds the rule builder: every entry in
 * `AUTOMATION_EVENTS` is offered to tenants as a TRIGGER they can build rules
 * on. A card-generation event there would appear in that catalogue as
 * something a farm can automate, which it is not — and the catalogue has
 * already rotted exactly that way once, when nine `TEST_PLAN_*` events
 * outlived their models and the suggestions rail went on recommending one at
 * 0.82 confidence. So: a job, with its own `runJob` span and context.
 *
 * ## Idempotence is the UNIQUE INDEX, not a flag
 *
 * `@@unique([channelId, cardKind, cardDay])` plus `createMany({
 * skipDuplicates: true })`, so a retry cannot double-post and there is no
 * `generated` boolean for anything to forget to set — the P5.5b pattern
 * (`NoticeScore.reportId`). It also makes the per-kind reading honest for
 * free: `createMany` returns the number of rows it actually inserted, so
 * "created" and "already there" are separate numbers rather than one guess.
 *
 * That is also why `attempts` can be more than 1 here, unlike
 * `statement-dispatch` (a retry would re-SEND) and `notice-score` (a retry
 * would re-SPEND): a retry re-inserts nothing.
 *
 * ## EVERY RUN REPORTS A PER-KIND DENOMINATOR
 *
 * Owner decision 2026-11-14, and the reason is the P9.3d auto-hide precedent:
 * one total `cards: 0` cannot distinguish "news had nothing new" from "the
 * query is broken" from "there is one active listing in the country". Measured
 * in production the sources are uneven by two orders of magnitude — 1,501 news
 * items against 1 active exchange listing — so some kinds are DORMANT and the
 * reading has to say which, rather than looking like a failure.
 *
 * It goes in the log FIELDS and not through the `[tag]` console convention:
 * `denominator-summary.cjs` collects those out of a JEST run, so a job's
 * tagged line is collected by nothing while breaching the
 * no-`console`-in-server-code rule.
 *
 * ## The card's text is NOT composed here
 *
 * `cardPayloadJson` carries the facts and the catalogue carries the framing,
 * because one channel is read in both languages and a sentence composed at
 * generation time would pick a language for every future reader. See that
 * column's docblock. `body` gets the headline as a plain-text fallback, which
 * is reproduced third-party text rather than authored copy.
 */
import { CROP_TAGS } from '@/lib/news/categorize';
import { dayKeyToInstant, farmDayRange, farmToday } from '@/lib/calendar-day-key';
import { resolvePlatformSystemUserId } from '@/lib/auth/system-user';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import { getMarketNews } from '@/app-layer/usecases/trends';

/** How fresh a news item must be to become today's card. */
export const CARD_NEWS_MAX_AGE_HOURS = 36;

/** Per-kind arithmetic, so "0 cards" is never one ambiguous number. */
export interface ChannelCardKindReading {
    /** Channels that exist and are not archived. */
    channels: number;
    /** Of those, the ones this kind can serve at all. */
    eligible: number;
    /** Of the eligible, the ones that had content today. */
    withContent: number;
    /** Rows actually inserted — `createMany`'s own count. */
    created: number;
    /**
     * True when this kind cannot produce anything for a STRUCTURAL reason
     * rather than because today was quiet. `eligible === 0` is the test, and
     * it is reported rather than inferred for the auto-hide reason: a dormant
     * kind and a broken one otherwise read identically.
     */
    dormant: boolean;
}

export interface ChannelCardsResult {
    cards: number;
    byKind: Record<string, ChannelCardKindReading>;
}

/**
 * The news tag that serves a channel, or null when none can.
 *
 * Measured 2026-11-14 across the 43 seeded channels, because the reach is
 * uneven and nothing about the key says so:
 *
 *   `crop:wheat`     -> `wheat`    — 5 of 10 crop channels have a `CROP_TAGS`
 *                                    entry; oats, rye, soybean, peas and
 *                                    lentils have none.
 *   `input:diesel`   -> `inputs`   — all 5 input channels share one TOPIC tag,
 *                                    so they get the same card. That is
 *                                    accepted: the alternative is no card at
 *                                    all for fuel and fertiliser, which are
 *                                    the two largest cash costs in an arable
 *                                    budget.
 *   `oblast:BG-16`   -> null       — the vocabulary carries NO regional tag.
 *
 * The oblast case is a DECISION, not an omission. National weather or subsidy
 * news pushed into 28 oblast channels is the same card 28 times, in surfaces
 * that exist to be local — so those channels are served by the LISTING card,
 * which keys on `ExchangeListing.regionCode`, or by nothing.
 */
export function newsTagForChannelKey(key: string): string | null {
    const colon = key.indexOf(':');
    if (colon === -1) return null;
    const prefix = key.slice(0, colon);
    const rest = key.slice(colon + 1);
    if (prefix === 'crop') {
        return (CROP_TAGS as readonly string[]).includes(rest) ? rest : null;
    }
    if (prefix === 'input') return 'inputs';
    return null;
}

interface ChannelRow {
    id: string;
    key: string;
}

export async function runChannelCards(now: Date = new Date()): Promise<ChannelCardsResult> {
    const dayKey = farmToday(now);
    const cardDay = dayKeyToInstant(dayKey);

    // BEFORE any transaction — the module docblock on `system-user` records
    // why: it reads and may write through the global client, so resolving it
    // inside one would want a second pool connection while the first is held
    // (#1191's P0.8 deadlock).
    const authorUserId = await resolvePlatformSystemUserId();

    const channels = await runWithoutRls({ reason: 'channel-card-generation' }, (db) =>
        db.channel.findMany({
            where: { archivedAt: null },
            select: { id: true, key: true },
            // Bounded, like every repository read here. 43 today; the cap is
            // a guardrail rather than a page — a channel past it would get no
            // card, which the reading would show as `channels` falling short.
            take: 500,
        }),
    );

    const news = await generateNewsCards(channels, { authorUserId, cardDay, dayKey, now });

    const byKind: Record<string, ChannelCardKindReading> = { NEWS: news };
    const cards = news.created;

    logger.info('channel_cards.reading', {
        component: 'channel-cards',
        dayKey,
        cards,
        // PER KIND, flattened into fields so each number is queryable on its
        // own. A nested object would be one blob to grep.
        newsChannels: news.channels,
        newsEligible: news.eligible,
        newsWithContent: news.withContent,
        newsCreated: news.created,
        newsDormant: news.dormant,
    });

    return { cards, byKind };
}

/**
 * One NEWS card per eligible channel that has a fresh item.
 *
 * ONE query per distinct TAG rather than one per channel: the five input
 * channels share `inputs`, so a per-channel read would ask the same question
 * five times. That is the D1 no-read-in-a-loop rule applied to a usecase call
 * rather than to Prisma directly.
 */
async function generateNewsCards(
    channels: readonly ChannelRow[],
    ctx: { authorUserId: string; cardDay: Date; dayKey: string; now: Date },
): Promise<ChannelCardKindReading> {
    const tagOf = new Map<string, string>();
    for (const c of channels) {
        const tag = newsTagForChannelKey(c.key);
        if (tag) tagOf.set(c.id, tag);
    }

    const reading: ChannelCardKindReading = {
        channels: channels.length,
        eligible: tagOf.size,
        withContent: 0,
        created: 0,
        dormant: tagOf.size === 0,
    };
    if (tagOf.size === 0) return reading;

    // The cutoff is a floor on the ITEM's publishedAt, not a window around
    // today: a feed that went quiet for a day should not produce a card from
    // a week-old headline, and one that published late last night should.
    const cutoff = new Date(ctx.now.getTime() - CARD_NEWS_MAX_AGE_HOURS * 3600_000);
    const { end } = farmDayRange(ctx.dayKey);

    const freshest = new Map<string, { title: string; url: string; source: string; publishedAt: string }>();
    for (const tag of new Set(tagOf.values())) {
        // `getMarketNews` and NOT a second Prisma query: the tag rule
        // (`tags: { hasSome }`) lives in `readNewsFromDb`, and a second
        // spelling of "which news matches this tag" is the #1664 class — the
        // two would diverge and the divergence would be invisible.
        const page = await getMarketNews('all', 5, { tags: [tag] });
        const item = page.items.find((i) => {
            const at = new Date(i.publishedAt);
            // Not in the future either: a feed with a bad date must not
            // pre-empt tomorrow's card.
            return at >= cutoff && at <= end;
        });
        if (item) {
            freshest.set(tag, {
                title: item.title,
                url: item.url,
                source: item.source,
                publishedAt: item.publishedAt,
            });
        }
    }

    const rows = [...tagOf.entries()].flatMap(([channelId, tag]) => {
        const item = freshest.get(tag);
        if (!item) return [];
        return [{
            channelId,
            authorUserId: ctx.authorUserId,
            // NULL: a card belongs to the platform, not to a farm, so the
            // author line renders no farm name (#2989's mapper reads this).
            authorTenantId: null,
            kind: 'CARD' as const,
            cardKind: 'NEWS' as const,
            cardDay: ctx.cardDay,
            // The FACTS. Framing copy is the reader's, from the catalogue.
            cardPayloadJson: {
                tag,
                title: item.title,
                url: item.url,
                source: item.source,
                publishedAt: item.publishedAt,
            },
            // The headline as a plain-text fallback, so a client that does not
            // yet render cards shows something readable rather than an empty
            // bubble. Reproduced third-party text, not authored copy.
            body: item.title,
        }];
    });
    reading.withContent = rows.length;

    if (rows.length > 0) {
        const written = await runWithoutRls({ reason: 'channel-card-generation' }, (db) =>
            db.channelPost.createMany({ data: rows, skipDuplicates: true }),
        );
        reading.created = written.count;
    }

    return reading;
}
