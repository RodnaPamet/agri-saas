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
import { PriceOverrideDaySchema } from '@/app-layer/schemas/market-manual.schemas';

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
            'Any spelling the vocabulary resolves \u2014 `Canola`, `rapeseed`, \u00abрапица\u00bb, `diesel`. ' +
            'A spelling it does not cover is a coded 400, and a commodity it knows but the owner ' +
            'has not opened to overrides is a DIFFERENT coded 400: a typo and a scope decision ' +
            'are different things to fix. Never a silent no-op \u2014 "cleared nothing" and "cleared ' +
            'a commodity you misspelled" must not look the same.',
        example: 'wheat',
    }),
});

const PriceOverrideRow = z
    .object({
        commodity: z.string(),
        entryUnit: z.string().openapi({
            description:
                'What to TYPE in, and what the POST will store the value under \u2014 `EUR/t` for the ' +
                'nine crops and fertilisers, `EUR/l` for diesel. Surfaced so a client does NOT ' +
                'hold its own copy of that split: the thing being duplicated is a UNIT, and a ' +
                'cross-repo copy has no guard that can see both sides. When two copies disagree ' +
                'the failure is not an error, it is a price wrong by 1000\u00d7 that renders as a number.',
        }),
        entryCurrency: z.string(),
        typed: z
            .object({
                value: z.number(),
                currency: z.string(),
                unit: z.string(),
                date: z.string(),
            })
            .nullable()
            .openapi({
                description:
                    'The CURRENT run only. `null` after a clear, even though the typed history is ' +
                    'kept and the audit row for the clear carries it.',
            }),
        api: z
            .object({
                value: z.number(),
                currency: z.string(),
                unit: z.string(),
                date: z.string(),
                source: z.string(),
            })
            .nullable()
            .openapi({
                description:
                    'The feed\u2019s current price, so the form can show what the override is replacing. ' +
                    'A hand-entered `manual` price is NOT reported here: it is a typed price too, and ' +
                    'presenting it as the API\u2019s would say the override is replacing a feed when it is ' +
                    'replacing somebody\u2019s typing.',
            }),
        apiFeed: z
            .enum(['ec-agrifood', 'world-bank', 'oil-bulletin', 'none'])
            .openapi({
                description:
                    'A DIFFERENT claim from `api`, and both are needed. `none` means no feed exists ' +
                    'for this commodity EVER \u2014 so a typed price is the only source and clearing it ' +
                    'leaves nothing, which a client should say before confirming. `api: null` with a ' +
                    'real feed means the feed exists but has no current point. One empty column for ' +
                    'both would tell the owner their override is replacing something when it is ' +
                    'replacing nothing, and would read as a broken feed.',
            }),
    })
    .openapi('PriceOverrideRow');

const PriceOverrideForm = z
    .object({ commodities: z.array(PriceOverrideRow) })
    .openapi('PriceOverrideForm');

const PriceOverrideWriteResult = z
    .object({
        written: z.number().int().openapi({
            description: 'Points written. Equal to `prices.length` on success, by construction.',
        }),
        series: z.array(
            z.object({
                commodity: z.string(),
                seriesId: z.string(),
                unit: z.string(),
                currency: z.string(),
            }),
        ),
    })
    .openapi('PriceOverrideWriteResult');

const PriceOverrideClearResult = z
    .object({
        commodity: z.string(),
        cleared: z.boolean().openapi({
            description:
                'FALSE when there was no live override, which is a 200 and not an error. A ' +
                'superuser clearing an override that was never set has the outcome they wanted, and ' +
                'a client retrying a clear is the normal case.',
        }),
        pointsWithdrawn: z.number().int().openapi({
            description:
                'Points withdrawn from publication. They are NOT deleted \u2014 the series and its ' +
                'points are MARKED, so the typed history and the audit trail of what was typed both ' +
                'survive.',
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
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/market-prices/overrides',
        operationId: 'readPriceOverrideForm',
        summary: '\u00ab\u0426\u0435\u043d\u0438\u00bb \u2014 what is typed, and what the feed says',
        description:
            'One row for EVERY commodity a superuser may override, not only those with an override: the form is a list of fields rather than a list of existing entries, so a commodity with neither a typed nor a feed price is a row with both null, which is a true statement about it.' +
            '\n\nEach row carries `entryUnit`, the denomination the POST will store the value under. Read it rather than holding a copy: the nine crops and fertilisers are `EUR/t` and diesel alone is `EUR/l`, and a client with its own copy of that split is a second source of truth whose disagreement is not an error but a price wrong by a factor of a thousand.' +
            '\n\n`apiFeed: "none"` and `api: null` are different claims and both matter \u2014 see the field descriptions. Three of the ten commodities have no free feed anywhere, so for those a typed price is not an override at all, it is the only source.',
        tags: ['Trends'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'A row per overridable commodity, in a fixed order.',
            schema: PriceOverrideForm,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/market-prices/overrides',
        operationId: 'upsertPriceOverrideDay',
        summary: 'Type a day of prices that win for every farm',
        description:
            'Owner ruling 2026-10-10: a typed price **always wins** over the API, on every surface and for every farm, until a superuser CLEARS it. A manual override, not a stale-only fallback \u2014 chosen over "API unless missing or stale" and over "newest wins".' +
            '\n\n**One DAY, all or nothing.** Up to ten commodities in one transaction, so a refusal on the tenth rolls back the first nine. A day that half-commits is worse than one that failed, because the superuser cannot tell which prices are live \u2014 and these move every farm\u2019s calculator.' +
            '\n\n**Unit and currency are NOT accepted from you.** They are derived server-side per commodity, and that is deliberate: a caller that could choose the unit could put a per-tonne figure into the litre series, and the six-column natural key `(source, commodity, region, stage, currency, unit)` would dutifully create it. `entryUnit` on the GET tells you what will be used, as a label and a sanity check \u2014 never as an input.' +
            '\n\n**The override is published as its own series** with a fixed `source: "platform"`, region `BG`, in the derived unit. It appears in the same market-prices payload \u0422\u0435\u043d\u0434\u0435\u043d\u0446\u0438\u0438 and \u0422\u0430\u0431\u043b\u043e already read, beside the feed\u2019s series. For the calculator\u2019s reference price it SUPPRESSES every feed series for that commodity \u2014 suppressed, not averaged and not offered as comparable, because consumers group by currency or refuse and never blend.' +
            '\n\n**A client must prefer a marked override ACROSS unit groups, not within one.** Ranking normally happens inside a `(unit, currency)` group, and the diesel bulletin is published in `EUR/1000l` while a typed diesel price is `EUR/l` \u2014 so an override in a different group is never compared against the feed and is never chosen. Marking the series is necessary and not sufficient.' +
            '\n\n**The 400s this raises, by `error.code`, so a client can switch on them rather than show a generic message:**' +
            '\n\n- `DUPLICATE_COMMODITY` \u2014 the same commodity appears twice in one day, with it named in `params.commodity`. The feeds average genuine duplicate observations; two prices typed for one commodity on one day is a typo, and averaging a typo produces a number nobody entered while taking the last silently discards the first.' +
            '\n- `UNKNOWN_COMMODITY` \u2014 a spelling the vocabulary does not resolve, echoed in `params.commodity`.' +
            '\n- `COMMODITY_NOT_OVERRIDABLE` \u2014 a commodity the vocabulary KNOWS but the owner has not opened to overrides. A different thing to fix from a typo: `oats` has no feed either and is a plausible thing to try, but widening the list is a decision rather than a retry.' +
            '\n- `OVERRIDE_DENOMINATION_CHANGED` \u2014 a live override for that commodity is recorded in a different unit or currency from the one the server now derives, with both in `params` as `stored` and `expected`. Clear it before typing a new one: two live overrides for one commodity in different denominations is an ambiguity no consumer can resolve, so this refuses rather than minting a second series.' +
            '\n\nAny of them refuses the WHOLE day, before anything is written.' +
            '\n\n**`clientMutationId` is recorded, not relied on.** Send it in the body or as `Idempotency-Key` \u2014 both are honoured, so you need not discover which. But idempotency here comes from the point upsert on `(seriesId, date)`: re-sending a day produces the identical state. These are GLOBAL tables with no `tenantId`, so the `(tenantId, clientMutationId)` convention used by the cost batch is not available and is not needed \u2014 a cost sheet accumulates, a price day does not.' +
            '\n\nGated on `admin.manage` **inside** `PLATFORM_TENANT_SLUG`. Both halves are load-bearing: `admin.manage` is held by the OWNER of EVERY tenant, so alone it would hand any farm\u2019s owner the global price cache. The gate FAILS CLOSED \u2014 unset slug means 404 for everyone, the owner included.',
        tags: ['Trends'],
        params: TenantParams,
        body: PriceOverrideDaySchema,
        success: {
            status: 200,
            description: 'How many points were written, and the series they landed in.',
            schema: PriceOverrideWriteResult,
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/admin/market-prices/overrides/{commodity}',
        operationId: 'clearPriceOverride',
        summary: 'Clear the override, handing authority back to the feed',
        description:
            'Ends the override run for one commodity, across every region and stage. The feed becomes authoritative again and the `platform` series is **absent from the payload entirely** \u2014 "no platform position" is a different claim from "a platform position of nothing".' +
            '\n\n**It MARKS; it does not delete.** The series and its points are stamped, so the typed history survives and so does the audit trail of what was typed. The read path excludes a cleared series and its stamped points, which is what makes "cleared" and "absent" the same thing to a client without the rows going anywhere.' +
            '\n\n**Re-typing after a clear starts a FRESH run.** Points from before the clear are never republished. A clear is an affirmative withdrawal, not a mute: if clearing hid points that reappeared on the next type, a superuser who cleared a wrong price would see it resurrected by an unrelated later entry. This is why the stamp is on the POINT as well as the series \u2014 the natural key is unique, so a re-type resolves to the same series row, and un-clearing that row alone would bring the whole previous run back.' +
            '\n\n**Clearing nothing is a 200 with `cleared: false`**, not a 404. A client retrying a clear is the normal case rather than the odd one.' +
            '\n\nFor a commodity whose `apiFeed` is `"none"`, clearing leaves the calculator with NO price for that crop \u2014 a client should say so before confirming, because it will look like data loss otherwise. A request body is ignored.' +
            '\n\nSame gate as the write, failing closed the same way.',
        tags: ['Trends'],
        params: OverrideParams,
        success: {
            status: 200,
            description:
                'What was cleared. `cleared: false` with `pointsWithdrawn: 0` when there was no live override.',
            schema: PriceOverrideClearResult,
        },
    });
}
