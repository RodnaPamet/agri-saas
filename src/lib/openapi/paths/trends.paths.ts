/**
 * Тенденции — the market price chart and the news feed.
 *
 * «Тенденции» is the product noun, and since P2.6 it is the noun the nav
 * item and the page title use too (both said «Тренд»). The TAG stays
 * `Trends` — renaming a tag regroups somebody's generated SDK. See
 * docs/nav-vocabulary.md.
 *
 * Тенденции is one of five tabs on the phone, and until now neither of its two
 * routes was in the spec at all. The native client modelled `PriceSeries`,
 * `PricePoint`, `PricesResponse` and `NewsItem` by MEASURING live responses,
 * which is the state that cost it a whole money screen elsewhere: a struct
 * declared non-optional against a field the server may omit takes out the entire
 * payload, because these are arrays and one bad element fails all of them.
 *
 * ── the query schemas are the ROUTES' own ──
 *
 * `TrendPricesQuerySchema` and `TrendNewsQuerySchema` are imported from
 * `@/app-layer/schemas/trends.schemas`, which is what the handlers `.parse()`
 * with. So the documented parameters cannot drift from the validated ones —
 * they are the same object. That also carries the enums for free: `commodity`
 * is `TREND_CHARTABLE` (crops the farm sells PLUS inputs it buys) and
 * `category` is `NEWS_CATEGORIES` plus the `all` sentinel.
 *
 * ── three date fields, and they are NOT the same format ──
 *
 * Verified at the producer, not from the comments beside them:
 *
 *   TrendPoint.date            .toISOString().slice(0, 10)   -> date      (a DAY)
 *   TrendSeries.lastObservedAt .toISOString().slice(0, 10)   -> date      (a DAY)
 *   TrendPricesResponse.generatedAt  new Date().toISOString() -> date-time
 *   NewsItem.publishedAt       r.publishedAt.toISOString()    -> date-time
 *
 * A client that parses the first two as instants throws on a correct response.
 * This is the third payload in this spec carrying both formats at once, so it
 * is worth stating as a rule rather than a note: in this codebase a date-ish
 * string is a DAY whenever it came through `.slice(0, 10)`, and the only way to
 * know is to read the line that built it.
 *
 * ── why `lastObservedAt` exists, since a client must use it ──
 *
 * It is the newest observation ANYWHERE, not the newest point inside the
 * requested range. Without it a series that reported this week and one that
 * stopped reporting in March are indistinguishable — both hand back a `points`
 * array whose last entry looks equally current. Staleness is
 * `generatedAt − lastObservedAt` and must be computed against the SERVER's
 * clock, because the payload is Redis-cached for 6h and a rural device can be
 * hours off.
 */
import { z } from '@/lib/openapi/zod';
import {
    TrendPricesQuerySchema,
    TrendNewsQuerySchema,
} from '@/app-layer/schemas/trends.schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';
import { ManualPriceSeriesSchema } from '@/app-layer/schemas/market-manual.schemas';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

const TrendPointSchema = z
    .object({
        /** A DAY, `yyyy-mm-dd` — the producer slices the instant off. */
        date: z.string().date(),
        price: z.number(),
        /**
         * Distinct-tenant sample size, and ONLY on the listings-derived
         * series. Absent on feed series, which is a different claim from
         * zero: a feed price is not a sample of anything.
         */
        count: z.number().optional(),
    })
    .openapi('TrendPoint', {
        description:
            'One observation. `date` is a calendar day, not an instant. `count` appears only on listings-derived series, where it is the distinct-tenant sample size — its absence means the series is not sampled, not that the sample was zero.',
    });

const TrendSeriesSchema = z
    .object({
        source: z.string().openapi({
            description:
                'Which feed the quotes came from, e.g. `ec` or `alpha-vantage`. Series from different sources are NOT interchangeable: they quote different stages in different currencies, which is why they arrive as separate series rather than merged.',
            example: 'ec',
        }),
        region: z.string().openapi({
            description:
                'A COUNTRY code, not a Bulgarian oblast. Production carries `BG`, `EL`, `RO`, `EU` and — for Alpha Vantage — `GLOBAL`. The oblast codes used by Борса and the parcel registry do not appear here.',
            example: 'BG',
        }),
        // `stage` was the one field on this schema that the operation
        // description never mentioned (#1391), and it is the one a client is
        // least able to guess: the values are a feed's own vocabulary.
        stage: z.string().nullable().openapi({
            description:
                'The delivery point or market stage WITHIN the region — a feed\'s own vocabulary rather than ours, so treat it as an opaque label and do not parse it.' +
                '\n\nIt is what distinguishes two series that otherwise look identical: for wheat, the nine Bulgarian delivery points disagree by tens of euros, so a chart that merged them on `(source, region)` alone would average unrelated markets. `region` + `stage` together identify a series.' +
                '\n\n`National average` is the figure the dashboard prefers, because a farm is not tied to one depot — but not every commodity has one. Wheat, maize and barley do; sunflower\'s only Bulgarian series is `FGATE`. **Null is normal**, not missing data.',
            example: 'National average',
        }),
        unit: z.string(),
        currency: z.string(),
        label: z.string().nullable(),
        /**
         * Newest observation ANYWHERE, not the newest point in this range.
         * A DAY. Null when the series has never reported.
         */
        lastObservedAt: z.string().date().nullable(),
        points: z.array(TrendPointSchema),
    })
    .openapi('TrendSeries', {
        description:
            'One price line, grouped by (source, region, **stage**) so a chart can split lines that differ in unit, currency or delivery point — BG wheat has nine delivery points whose prices differ by tens of euros per tonne, so two series sharing a source and region are routinely different lines — series are NOT comparable across those without conversion. lastObservedAt is the newest observation anywhere, which is what distinguishes a series reporting this week from one that stopped months ago; both otherwise present a points array whose last entry looks equally current.',
    });

const TrendPricesResponseSchema = z
    .object({
        commodity: z.string(),
        range: z.enum(['1m', '3m', '1y', 'all']),
        /** ISO instant, from the SERVER's clock — see the module note. */
        generatedAt: z.string().datetime(),
        series: z.array(TrendSeriesSchema),
    })
    .openapi('TrendPricesResponse', {
        description:
            'Market price series for one commodity, grouped by source and region. Staleness is generatedAt minus a series’ lastObservedAt and must be computed against generatedAt rather than the device clock — the payload is cached for 6h and a rural device may be hours off.',
    });

const NewsItemSchema = z
    .object({
        id: z.string(),
        /** Origin feed slug. */
        source: z.string(),
        category: z.string(),
        title: z.string(),
        summary: z.string().nullable(),
        url: z.string(),
        imageUrl: z.string().nullable(),
        /** A full ISO instant. */
        publishedAt: z.string().datetime(),
        tags: z.array(z.string()).openapi({
            description:
                'Stable ASCII slugs, possibly empty, order not significant. IGNORE a slug you do not recognise rather than erroring on it — the vocabulary grows on the server, and a client that threw would break on a deploy it knew nothing about. `GET /trends/news/tags` carries the labels.',
            example: ['wheat', 'prices'],
        }),
    })
    .openapi('NewsItem', {
        description:
            'One aggregated agri-news article. summary and imageUrl are genuinely nullable — many feeds carry neither — so a client must render a headline-only item rather than treating it as malformed.',
    });

const TrendNewsResponseSchema = z
    .object({
        /** Echoes the requested filter; `all` when unfiltered. */
        category: z.string(),
        tags: z.array(z.string()).openapi({
            description:
                'The tags ACTUALLY APPLIED — sorted, de-duplicated, with unrecognised keys dropped. Compare it with what you sent: asking for two tags and getting one back is how you discover that a stored preference has been renamed away. An empty array means the feed is unfiltered.',
            example: ['wheat'],
        }),
        q: z.string().nullable().openapi({
            description: 'The search term applied, or null.',
        }),
        items: z.array(NewsItemSchema),
        nextCursor: z.string().nullable().openapi({
            description:
                'Pass back verbatim as `?cursor=` for the next page; null at the end of the feed. OPAQUE — do not parse or construct one. A cursor the server no longer recognises (the 60-day retention deleted its article) is IGNORED and you get the first page, never an error.',
        }),
    })
    .openapi('TrendNewsResponse', {
        description:
            'The aggregated news feed, newest first. category, tags and q each echo the filter that produced this payload, so a client holding a page can tell a stale response from the one it asked for — which matters more, not less, now that there are three filters to reconcile.',
    });

/** `{tenantSlug}` plus the commodity whose override is being cleared. */
const OverrideParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
    commodity: z.string().openapi({
        param: { name: 'commodity', in: 'path' },
        description:
            'Any spelling the vocabulary resolves — `Canola`, `rapeseed`, \u00abрапица\u00bb, `diesel`. ' +
            'One it does not cover is a 400 naming the value, never a silent no-op: ' +
            '"cleared nothing" and "cleared a commodity you misspelled" must not look the same.',
        example: 'wheat',
    }),
});

const PriceOverrideWriteResult = z
    .object({
        seriesId: z.string(),
        commodity: z.string().openapi({
            description: 'The CANONICAL commodity the spelling you sent resolved to.',
        }),
        pointsUpserted: z.number().int(),
        created: z.boolean().openapi({
            description:
                'True when this write created the override series rather than adding points to a ' +
                'run already in progress.',
        }),
    })
    .openapi('PriceOverrideWriteResult');

const PriceOverrideClearResult = z
    .object({
        commodity: z.string(),
        cleared: z.boolean().openapi({
            description:
                'FALSE when there was nothing to clear, which is a 200 and not an error. A ' +
                'superuser clearing an override that was never set has the outcome they wanted; a ' +
                '404 would make an idempotent retry look like a failure.',
        }),
        pointsRemoved: z.number().int().openapi({
            description:
                'Points removed from publication. They are NOT lost — the audit row for the clear ' +
                'carries every point\u2019s date and price, up to a stated cap, because the read path ' +
                'has no source filter and so "absent from the payload" has to mean deleted.',
        }),
    })
    .openapi('PriceOverrideClearResult');

export function registerTrendsPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/trends/prices',
        operationId: 'getTrendPrices',
        summary: 'Тенденции — market price series for one commodity',
        description:
            'The GLOBAL market-price series for one commodity, grouped by (source, region) so a chart can split lines that differ in unit or currency. The payload is tenant-AGNOSTIC — the tenant in the path authenticates the caller, it does not scope the data. ' +
            '\n\nLabels are localised to the READER’s own language column, not to a request cookie: a native client sends no `NEXT_LOCALE`, so a cookie-derived locale would hand the phone the unauthenticated `en` default. ' +
            '\n\nCarries a weak ETag; send `If-None-Match` and handle **304**. The ETag is derived from the payload, which differs by language, so it varies by locale correctly — hashing the query alone would have served a cached 304 in the wrong language. Cached 6h server-side.',
        tags: ['Trends'],
        params: TenantParams,
        query: TrendPricesQuerySchema,
        success: {
            status: 200,
            description: 'The series. May be EMPTY for a commodity nothing has quoted yet.',
            schema: TrendPricesResponseSchema,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/trends/news',
        operationId: 'getTrendNews',
        summary: 'Тенденции — aggregated agri-news feed',
        description:
            'The GLOBAL aggregated news feed, newest first, optionally filtered by `category`, by `tags` (comma-separated, ANY-OF) and by a `q` search over title and summary, paged by an opaque `cursor`. Tenant-agnostic payload; the tenant in the path authenticates the caller. ' +
            '\n\n**`tags` ignores keys it does not recognise rather than returning 400.** A client passes its stored preferences straight into this parameter, so a tag the server has since renamed would otherwise turn a saved preference into a broken feed. If every key is unrecognised the feed is UNFILTERED, not empty — read the `tags` echo in the response to tell that apart from a full feed. (`PUT /api/me/news-preferences` is deliberately the opposite and 400s on an unknown tag: there a person is choosing, and a typo is a client bug worth surfacing.) ' +
            '\n\n**Preferences are not applied implicitly.** The payload is cached under a key shared by every reader, so filtering by the caller\u2019s own preferences would write one person\u2019s feed into the entry everybody else reads. Resolve your preferences client-side and pass `tags`. ' +
            '\n\n`q` searches at most the last 60 days — `RETENTION_DAYS` deletes older rows on every pull — so finding nothing from last spring is correct behaviour, and an empty state should say so rather than read as a failure. Note that `q` travels in the query string, which iOS logs in full and unsuppressably; a crop name is low-sensitivity, but do not put anything stronger there. ' +
            '\n\nCarries a weak ETag; send `If-None-Match` and handle **304**. Cached 1h server-side, except a `q` search, which is a live read every time (the key space of a free-text query is unbounded and would evict the shared feed) — the ETag still answers 304 for a repeated identical search.',
        tags: ['Trends'],
        params: TenantParams,
        query: TrendNewsQuerySchema,
        success: {
            status: 200,
            description: 'The feed, newest first.',
            schema: TrendNewsResponseSchema,
        },
    });

    const NewsTagEntry = z.object({
        key: z.string().openapi({
            description:
                'Stable ASCII slug. Crop keys are the commodity slugs — the same values `GET /trends/prices` takes — so a tag and a Борса search agree by construction.',
            example: 'wheat',
        }),
        label: z.string().openapi({
            description: 'Bulgarian, and authoritative. Render this.',
            example: 'Пшеница',
        }),
        labelEn: z.string().openapi({
            description:
                'A speakable English label, for iOS Voice Control. A SECOND label, not a localisation mechanism — there is no fallback chain and no third language. Do not prefer it over `label` for display.',
            example: 'Wheat',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/trends/news/tags',
        operationId: 'getNewsTagCatalogue',
        summary: 'Новини — the tag vocabulary and its labels',
        description:
            'Every tag `NewsItem.tags` can contain, grouped, with Bulgarian and English labels. Build a tag filter or a preferences sheet from THIS rather than from a hard-coded list: the vocabulary is the server\'s, and a tag added here appears in the client with no app release.' +
            '\n\n**Exactly two groups, `crops` then `topics`, and that is contract.** Do not flatten them — the grouping is what a sectioned picker renders from, and a client decoding a flat array breaks the moment a third group is added.' +
            '\n\n**Treat an unrecognised tag key as a tag you cannot label, not as an error.** This list grows. An article may legitimately carry a key your build has never seen; show it using the `label` from this response rather than dropping the article.' +
            '\n\n**Tenant-agnostic.** The vocabulary is identical for every farm; the tenant in the path authenticates the caller. `Cache-Control: private, max-age=86400` — hold it for a day. It also carries a weak ETag, so `If-None-Match` gets a **304** if you revalidate sooner.' +
            '\n\n**No counts.** There is deliberately no "how many articles carry this tag" here: that varies per tenant and changes with every pull, and could not be correct inside a response cached for a day.',
        tags: ['Trends'],
        params: TenantParams,
        success: {
            status: 200,
            description:
                'The vocabulary. Never empty, and the two group keys are always present in this order.',
            schema: z
                .object({
                    groups: z.array(
                        z.object({
                            key: z.enum(['crops', 'topics']).openapi({
                                description:
                                    'Which half of the vocabulary. `crops` are the five commodities; `topics` are subject areas.',
                            }),
                            label: z.string().openapi({ example: 'Култури' }),
                            labelEn: z.string().openapi({ example: 'Crops' }),
                            tags: z.array(NewsTagEntry),
                        }),
                    ),
                })
                .openapi('NewsTagCatalogue'),
        },
    });

    // ── The superuser price override (#1587) ─────────────────────────────

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/price-overrides',
        operationId: 'upsertPlatformPriceOverride',
        summary: 'Type a price that wins for every farm',
        description:
            'Owner ruling 2026-10-10: a typed price **always wins** over the API, on every surface and for every farm, until a superuser CLEARS it. A manual override, not a stale-only fallback \u2014 chosen over "API unless missing or stale" and over "newest wins".' +
            '\n\n**The override is published as its own series**, with a fixed `source: "platform"`, `region: "BG"`, `stage: null`, and the unit it was typed in. It appears in the same market-prices payload \u0422\u0435\u043d\u0434\u0435\u043d\u0446\u0438\u0438 and \u0422\u0430\u0431\u043b\u043e already read, beside the API series \u2014 no new endpoint and no second fetch. The six-column natural key `(source, commodity, region, stage, currency, unit)` is what makes that safe: a `platform` series cannot collide or blend with a feed\u2019s.' +
            '\n\n**A client must prefer a marked override ACROSS unit groups, not within one.** This is the part that is easy to get wrong and silently lose. Ranking normally happens inside a `(unit, currency)` group, and the diesel bulletin is published in `EUR/1000l` while a typed diesel price is `EUR/l` \u2014 so an override in a different group is never compared against the feed and is never chosen. Marking the series is necessary and not sufficient.' +
            '\n\n**It carries every typed day of the current run**, not only the latest, so it draws as a real line rather than a single point and a farmer can see what the platform has been setting. `lastObservedAt` is the latest typed date.' +
            '\n\n**Units: the nine crops and fertilisers are `EUR/t`; diesel alone is `EUR/l`.** Asked of the owner directly after this issue had recorded "EUR per tonne, diesel included" via a relay. Diesel is ~1.95 EUR/l or ~1950 EUR/t, so the two are a factor of a thousand apart and a daily-typed field is where habit beats attention. The server does not special-case diesel; it REFUSES a second denomination for a commodity that already has one, because a series that changes denomination mid-history renders as one continuous line and is a lie.' +
            '\n\n**`source: "platform"` is distinct from `"manual"` and must stay so.** `manual` fills a gap \u2014 no free feed publishes MAP at all, and the Pink Sheet carries neither MAP nor ammonium nitrate \u2014 so it has no feed to outrank. Reusing it would retroactively convert every gap-fill row ever entered into an always-wins override, with no migration and no diff that looks like a behaviour change.' +
            '\n\n**Duplicate observation dates in one payload are refused**, naming the date. The feeds average genuine duplicate observations; two different prices typed for one day is a typo, and averaging a typo produces a number nobody entered.' +
            '\n\nGated on `admin.manage` **inside** `PLATFORM_TENANT_SLUG`. Both halves are load-bearing: `admin.manage` is held by the OWNER of EVERY tenant, so alone it would hand any farm\u2019s owner the global price cache. The gate FAILS CLOSED \u2014 unset slug means `404` for everyone, the owner included \u2014 so this route can exist before the platform farm does, and does nothing until it exists.',
        tags: ['Trends'],
        params: TenantParams,
        body: ManualPriceSeriesSchema,
        success: {
            status: 201,
            description: 'The override series, and how many points the write touched.',
            schema: PriceOverrideWriteResult,
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/admin/price-overrides/{commodity}',
        operationId: 'clearPlatformPriceOverride',
        summary: 'Clear the override, handing authority back to the feed',
        description:
            'Removes the platform override for one commodity, across every region and stage. The feed\u2019s price becomes authoritative again and the `platform` series is **absent from the payload entirely** \u2014 "no platform position" is a different claim from "a platform position of nothing".' +
            '\n\n**Clearing nothing is a 200 with `cleared: false`, not a 404.** A superuser clearing an override that was never set, or was already cleared, has exactly the outcome they wanted, and a client retrying a clear is the normal case.' +
            '\n\n**Re-typing after a clear starts a FRESH run.** Points from before the clear are not republished. A clear is an affirmative withdrawal, not a mute: if clearing hid points that reappeared on the next type, a superuser who cleared a wrong price would see it resurrected by an unrelated later entry.' +
            '\n\n**The typed history is not lost.** The audit row for the clear carries every point\u2019s date, price, unit and currency, up to a stated cap, and says how many it truncated. The rows themselves are deleted because the read path has NO source filter \u2014 which is why a `platform` series needs no read-side change to appear, and equally why anything left in the table would stay visible.' +
            '\n\nSame gate as the write, and it fails closed the same way.',
        tags: ['Trends'],
        params: OverrideParams,
        success: {
            status: 200,
            description:
                'What was cleared. `cleared: false` with `pointsRemoved: 0` when there was no override.',
            schema: PriceOverrideClearResult,
        },
    });
}
