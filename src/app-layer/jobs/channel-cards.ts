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
import { translateFor } from '@/lib/i18n/server-messages';
import { RECIPIENT_FALLBACK_LOCALE } from '@/lib/email/recipient-locale';
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

/**
 * `oblast:BG-16` → `BG-16`, and anything else → null.
 *
 * The suffix IS the `ExchangeListing.regionCode`, verified against production
 * rows rather than assumed: the listings carry `BG-03`, `BG-08`, `BG-15` and
 * the channels are keyed `oblast:BG-01`, `oblast:BG-02`, `oblast:BG-03`
 * (measured 2026-11-15). So no mapping table is needed, and #3063's
 * instruction to check that rather than assume it is discharged.
 *
 * This is the route the NEWS card could not take. That docblock says so
 * itself: the news vocabulary carries no regional tag, so national news
 * pushed into 28 oblast channels would be the same card 28 times, and those
 * channels are "served by the LISTING card, which keys on
 * `ExchangeListing.regionCode`, or by nothing". This is that card.
 */
export function oblastRegionForChannelKey(key: string): string | null {
    const colon = key.indexOf(':');
    if (colon === -1) return null;
    if (key.slice(0, colon) !== 'oblast') return null;
    const rest = key.slice(colon + 1);
    return /^BG-\d{2}$/.test(rest) ? rest : null;
}

/**
 * Is this a channel a national SCHEME card belongs in?
 *
 * Owner ruling 2026-11-15: the 15 crop and topic channels, NOT the 28 oblast
 * ones. A support scheme is national and `SupportScheme.measureCode` is NULL
 * on both production rows, so there is nothing to narrow it by — the choice
 * was which fixed set of channels to use, and this follows the precedent the
 * NEWS card set when it declined to show one national item in every regional
 * channel.
 *
 * The cost is stated rather than discovered later: a farmer in several crop
 * channels sees the same scheme more than once.
 */
export function channelTakesSchemeCard(key: string): boolean {
    const colon = key.indexOf(':');
    if (colon === -1) return false;
    const prefix = key.slice(0, colon);
    return prefix === 'crop' || prefix === 'input';
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

    const ctx = { authorUserId, cardDay, dayKey, now };

    /*
     * SEQUENTIAL, not `Promise.all`. Each generator opens its own
     * `runWithoutRls` scope and writes with `createMany`, and running four
     * concurrently would hold four pool connections for a job that has all
     * night — #1191's P0.8 is what the pool budget is for, and a nightly
     * generator is the last thing that should be competing for it.
     */
    const news = await generateNewsCards(channels, ctx);
    const listing = await generateListingCards(channels, ctx);
    const scheme = await generateSchemeCards(channels, ctx);
    const event = await generateEventCards(channels, ctx);

    const byKind: Record<string, ChannelCardKindReading> = {
        NEWS: news, LISTING: listing, SCHEME: scheme, EVENT: event,
    };
    const cards = news.created + listing.created + scheme.created + event.created;

    logger.info('channel_cards.reading', {
        component: 'channel-cards',
        dayKey,
        cards,
        // PER KIND, flattened into fields so each number is queryable on its
        // own. A nested object would be one blob to grep.
        //
        // `withContent` and `dormant` are BOTH reported per kind because the
        // pair is what makes a zero readable. `created: 0, dormant: false`
        // means the rule ran and found nothing to say — the expected state for
        // LISTING today, with 1 ACTIVE listing in production against 28
        // eligible oblast channels. `created: 0, dormant: true` means the kind
        // cannot fire at all, which is EVENT until #3078 gives `AgriEvent` a
        // producer. One number could not tell those apart.
        newsChannels: news.channels,
        newsEligible: news.eligible,
        newsWithContent: news.withContent,
        newsCreated: news.created,
        newsDormant: news.dormant,
        listingEligible: listing.eligible,
        listingWithContent: listing.withContent,
        listingCreated: listing.created,
        listingDormant: listing.dormant,
        schemeEligible: scheme.eligible,
        schemeWithContent: scheme.withContent,
        schemeCreated: scheme.created,
        schemeDormant: scheme.dormant,
        eventEligible: event.eligible,
        eventWithContent: event.withContent,
        eventCreated: event.created,
        eventDormant: event.dormant,
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

/**
 * One LISTING card per oblast channel that has a live offer in its region.
 *
 * ## FOUR conditions, three of which are separate ways to be hidden
 *
 * `status: ACTIVE` is the obvious one. The other three each hide a listing for
 * a different reason, and a card that reproduced one of them would resurface
 * what another part of the product deliberately took down:
 *
 *   • `suppressedForDeletionAt` — #1655's freeze. The seller asked to be
 *     deleted, and the notice promises their account "stops being visible to
 *     other farms straight away". A card naming their listing breaks that
 *     promise in the one place nobody would look.
 *   • `removedByModerationAt` — a moderator took it down.
 *   • `expiresAt` — the expiry sweep's window; a lapsed offer is not an offer.
 *
 * All four are IN THE QUERY. #1655 states the rule for the browse feed and it
 * holds here for the same reason: a post-filter would shrink a page whose size
 * was already decided, and in a generator it would mean reading rows we are
 * not allowed to show in order to discard them.
 *
 * ## ONE listing per card, the newest — mirroring the NEWS card
 *
 * Not a count and not a digest. The NEWS card picks the freshest item per tag
 * and this picks the newest listing per region, so the two kinds read alike
 * and the client composes both from facts.
 *
 * ## It will be DORMANT-but-eligible, and that is the expected reading
 *
 * Measured 2026-11-15: 3 listings in production, 1 ACTIVE, across 3 distinct
 * regions. So the reading is `dormant: false, withContent: 0` — the 28 oblast
 * channels ARE eligible and there is simply nothing to put in them. That is a
 * different finding from `dormant: true`, which would mean the kind cannot
 * fire at all, and the pair is why both fields exist.
 */
async function generateListingCards(
    channels: readonly ChannelRow[],
    ctx: { authorUserId: string; cardDay: Date; dayKey: string; now: Date },
): Promise<ChannelCardKindReading> {
    const regionOf = new Map<string, string>();
    for (const c of channels) {
        const region = oblastRegionForChannelKey(c.key);
        if (region) regionOf.set(c.id, region);
    }

    const reading: ChannelCardKindReading = {
        channels: channels.length,
        eligible: regionOf.size,
        withContent: 0,
        created: 0,
        // The kind can fire: oblast channels exist and the join is available.
        // Only the CONTENT is missing, which `withContent` says.
        dormant: regionOf.size === 0,
    };
    if (regionOf.size === 0) return reading;

    const regions = [...new Set(regionOf.values())];

    // ONE query for every region, not one per channel — the D1 rule. 28
    // channels map to at most 28 regions and a per-channel read would ask the
    // same question for each.
    const listings = await runWithoutRls({ reason: 'channel-card-generation' }, (db) =>
        db.exchangeListing.findMany({
            where: {
                regionCode: { in: regions },
                status: 'ACTIVE',
                suppressedForDeletionAt: null,
                removedByModerationAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: ctx.now } }],
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
                id: true,
                regionCode: true,
                commodity: true,
                side: true,
                quantityTonnes: true,
                pricePerTonne: true,
                priceCurrency: true,
                description: true,
            },
            // Bounded like every repository read here. Generous against 28
            // regions, so the per-region pick below is never starved.
            take: 500,
        }),
    );

    // The newest per region, taken from one ordered read rather than 28.
    const newest = new Map<string, (typeof listings)[number]>();
    for (const l of listings) {
        if (!newest.has(l.regionCode)) newest.set(l.regionCode, l);
    }

    /*
     * THE FALLBACK BODY, and why it reuses the client's own catalogue keys.
     *
     * `ChannelPost` carries a CHECK constraint, `channel_post_says_something`,
     * so a null body is refused outright — the schema already encodes the
     * "empty bubble" concern the NEWS card's comment names. The first draft of
     * this generator wrote `body: l.description` and relied on null being
     * acceptable; the database said otherwise, which is the better answer.
     *
     * So a description-less listing needs a sentence, and composing one here
     * means choosing a language before any reader is known. Three things make
     * `RECIPIENT_FALLBACK_LOCALE` the honest choice rather than a shrug:
     *
     *   • it is the decision this product already made for exactly this
     *     problem — every outbound email resolves to `bg` when the reader's
     *     preference cannot be read, and 4 of 5 users carry `bg`;
     *   • the NEWS card's body is the SOURCE's headline, so that fallback was
     *     never matched to the reader's language either. This is no worse;
     *   • and it is only a FALLBACK. `composeCardText` builds the sentence
     *     from `cardPayloadJson` in the reader's own language, so a current
     *     client never sees this string.
     *
     * The keys are the ones the client composes with, not a second set, so
     * the two cannot word a listing differently — the #1664 class.
     */
    const fallbackBody = async (l: (typeof listings)[number]): Promise<string> => {
        if (l.description && l.description.trim().length > 0) return l.description;
        const loc = RECIPIENT_FALLBACK_LOCALE;
        // The slug's own catalogue entry, falling back to the slug: a missing
        // commodity is a thin card, never a failed run.
        const named = await translateFor(loc, `trends.commodities.${l.commodity}`);
        const commodity = named === `trends.commodities.${l.commodity}` ? l.commodity : named;
        const quantity = l.quantityTonnes.toString();
        if (l.pricePerTonne !== null) {
            return translateFor(loc, 'channels.card.listing.withPrice', {
                commodity,
                quantity,
                price: `${l.pricePerTonne.toString()} ${l.priceCurrency}`,
            });
        }
        return translateFor(loc, 'channels.card.listing.line', { commodity, quantity });
    };

    const rows = [];
    for (const [channelId, region] of regionOf.entries()) {
        const l = newest.get(region);
        if (!l) continue;
        rows.push({
            channelId,
            authorUserId: ctx.authorUserId,
            authorTenantId: null,
            kind: 'CARD' as const,
            cardKind: 'LISTING' as const,
            cardDay: ctx.cardDay,
            cardPayloadJson: {
                region,
                listingId: l.id,
                commodity: l.commodity,
                side: l.side,
                // Decimal columns as STRINGS: money and tonnages never pass
                // through a float in this repo, and JSON would make them one.
                quantityTonnes: l.quantityTonnes.toString(),
                pricePerTonne: l.pricePerTonne === null ? null : l.pricePerTonne.toString(),
                priceCurrency: l.priceCurrency,
            },
            /*
             * NULL when the seller wrote no description, and that is
             * deliberate rather than a gap.
             *
             * The NEWS card's `body` is the headline — the source's own text,
             * which belongs to no language we chose. A listing has no such
             * text, so the only fallback available would be a sentence
             * composed here from the commodity and the quantity — and
             * `commodityLabel` needs a TRANSLATOR, which means picking a
             * language at generation time for every future reader of a
             * channel that is read in both. That is exactly the mistake
             * `DueItem.reason` was corrected for, and the reason
             * `cardPayloadJson` holds facts at all.
             *
             * So a client one release behind shows an empty bubble for a
             * description-less listing. That is the lesser evil against
             * baking `bg` into a row, and `composeCardText` is where the
             * sentence belongs.
             */
            body: await fallbackBody(l),
        });
    }
    reading.withContent = rows.length;

    if (rows.length > 0) {
        const written = await runWithoutRls({ reason: 'channel-card-generation' }, (db) =>
            db.channelPost.createMany({ data: rows, skipDuplicates: true }),
        );
        reading.created = written.count;
    }

    return reading;
}

/**
 * One SCHEME card per crop and topic channel, for the soonest open scheme.
 *
 * Owner ruling: the 15 crop and topic channels, never the 28 oblast ones —
 * see `channelTakesSchemeCard`. Every eligible channel gets the SAME scheme,
 * which is the honest consequence of a national programme with no commodity
 * on it (`measureCode` is NULL on both production rows, so there is nothing
 * to narrow by).
 *
 * The body is the scheme's OWN title, exactly like the NEWS card's headline:
 * authoritative text we are reproducing rather than copy we are authoring, so
 * it carries no language choice of ours.
 */
async function generateSchemeCards(
    channels: readonly ChannelRow[],
    ctx: { authorUserId: string; cardDay: Date; dayKey: string; now: Date },
): Promise<ChannelCardKindReading> {
    const eligible = channels.filter((c) => channelTakesSchemeCard(c.key));

    const reading: ChannelCardKindReading = {
        channels: channels.length,
        eligible: eligible.length,
        withContent: 0,
        created: 0,
        dormant: eligible.length === 0,
    };
    if (eligible.length === 0) return reading;

    /*
     * STILL OPEN, which is a window and not a status.
     *
     * `status` is a free-text string defaulting to `"announced"`, so filtering
     * on it would pin a vocabulary this job does not own. The DATES are
     * unambiguous: a scheme is worth a card while its application window has
     * not closed. A null `applicationClosesAt` is treated as still open —
     * a scheme with no stated deadline is the common case for an announcement
     * and reading it as closed would hide exactly the news a farmer wants.
     */
    const schemes = await runWithoutRls({ reason: 'channel-card-generation' }, (db) =>
        db.supportScheme.findMany({
            where: {
                OR: [
                    { applicationClosesAt: null },
                    { applicationClosesAt: { gte: ctx.cardDay } },
                ],
            },
            // Soonest deadline first, so the card shows the one a farmer has
            // least time to act on. Nulls last: an open-ended announcement is
            // less urgent than a dated one.
            orderBy: [{ applicationClosesAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
            select: {
                id: true,
                title: true,
                authority: true,
                applicationOpensAt: true,
                applicationClosesAt: true,
                sourceUrl: true,
            },
            take: 1,
        }),
    );

    const scheme = schemes[0];
    if (!scheme) return reading;

    const rows = eligible.map((c) => ({
        channelId: c.id,
        authorUserId: ctx.authorUserId,
        authorTenantId: null,
        kind: 'CARD' as const,
        cardKind: 'SCHEME' as const,
        cardDay: ctx.cardDay,
        cardPayloadJson: {
            schemeId: scheme.id,
            title: scheme.title,
            authority: scheme.authority,
            // Day keys, not instants: both columns are `@db.Date`, and
            // handing a client a timestamp would invite a timezone to move a
            // deadline by a day.
            opensOn: scheme.applicationOpensAt
                ? scheme.applicationOpensAt.toISOString().slice(0, 10)
                : null,
            closesOn: scheme.applicationClosesAt
                ? scheme.applicationClosesAt.toISOString().slice(0, 10)
                : null,
            url: scheme.sourceUrl,
        },
        body: scheme.title,
    }));
    reading.withContent = rows.length;

    const written = await runWithoutRls({ reason: 'channel-card-generation' }, (db) =>
        db.channelPost.createMany({ data: rows, skipDuplicates: true }),
    );
    reading.created = written.count;

    return reading;
}

/**
 * One EVENT card per crop and topic channel, for the next upcoming event.
 *
 * ## It is DORMANT by construction, and that is the point of shipping it
 *
 * Owner ruling 2026-11-15: EVENT reads `AgriEvent`, not `NewsDerivedEvent`.
 * `AgriEvent` holds ZERO rows in production because nothing has ever written
 * one (#3078 is its missing producer), so this kind produces nothing until
 * that lands — and the reading says `dormant: true` every run rather than
 * letting `created: 0` read as "the rule works and nothing was due".
 *
 * `NewsDerivedEvent` was the alternative and holds 19 rows, every one
 * `PROPOSED` — no row has ever been reviewed. P9.3 settled the principle for
 * cards: a card is machine-written and renders as the platform's own data,
 * which is why `postToChannel` refuses `CARD` from a caller. Publishing an
 * unreviewed, confidence-scored extraction as a platform event card would
 * hand an AI guess the platform's voice, carrying a date a farmer might plan
 * around.
 *
 * Same channel set as SCHEME: a fair or a field day is national in the same
 * way a subsidy is, and `AgriEvent.place` is free text rather than a region
 * code, so there is no oblast join to make.
 */
async function generateEventCards(
    channels: readonly ChannelRow[],
    ctx: { authorUserId: string; cardDay: Date; dayKey: string; now: Date },
): Promise<ChannelCardKindReading> {
    const eligible = channels.filter((c) => channelTakesSchemeCard(c.key));

    const events = await runWithoutRls({ reason: 'channel-card-generation' }, (db) =>
        db.agriEvent.findMany({
            // Forward only. A past fair is not an event, and the index on
            // `startsAt` is what makes this cheap.
            where: { startsAt: { gte: ctx.now } },
            orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
            select: {
                id: true,
                title: true,
                startsAt: true,
                endsAt: true,
                place: true,
                url: true,
                category: true,
            },
            take: 1,
        }),
    );

    const reading: ChannelCardKindReading = {
        channels: channels.length,
        eligible: eligible.length,
        withContent: 0,
        created: 0,
        /*
         * DORMANT when there is nothing to read, not merely when no channel is
         * eligible — which is the opposite of how its three siblings compute
         * this field, and deliberate.
         *
         * For NEWS, LISTING and SCHEME the source exists and may be quiet, so
         * dormancy is about the CHANNELS. Here the source itself is empty with
         * no producer, so `created: 0` would otherwise be ambiguous between
         * "no event is coming up" and "nothing can ever write one". #3078 is
         * what makes this flip to false.
         */
        dormant: eligible.length === 0 || events.length === 0,
    };
    if (eligible.length === 0) return reading;

    const event = events[0];
    if (!event) return reading;

    const rows = eligible.map((c) => ({
        channelId: c.id,
        authorUserId: ctx.authorUserId,
        authorTenantId: null,
        kind: 'CARD' as const,
        cardKind: 'EVENT' as const,
        cardDay: ctx.cardDay,
        cardPayloadJson: {
            eventId: event.id,
            title: event.title,
            category: event.category,
            startsAt: event.startsAt.toISOString(),
            endsAt: event.endsAt ? event.endsAt.toISOString() : null,
            place: event.place,
            url: event.url,
        },
        body: event.title,
    }));
    reading.withContent = rows.length;

    const written = await runWithoutRls({ reason: 'channel-card-generation' }, (db) =>
        db.channelPost.createMany({ data: rows, skipDuplicates: true }),
    );
    reading.created = written.count;

    return reading;
}
