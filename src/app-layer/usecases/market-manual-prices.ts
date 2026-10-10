/**
 * Hand-entered market prices (#roadmap P2).
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Not every input a Bulgarian farm buys has a free machine-readable feed.
 * Verified, not assumed: the World Bank Pink Sheet carries urea and DAP and
 * carries neither MAP nor ammonium nitrate, and no free source publishes MAP
 * at all. The alternatives were to omit those two — leaving the fertiliser
 * view answering half the question — or to let a platform admin type them.
 *
 * It also de-risks every feed: an upstream that changes shape or goes away
 * has a fallback that does not need a deploy.
 *
 * ── Why the platform-SUPPORT gate, not the API key ───────────────────────
 *
 * The brief named `verifyPlatformApiKey`. That gate cannot satisfy the audit
 * requirement in the same brief, and the conflict is structural rather than
 * stylistic: `AuditLog.tenantId` is non-nullable with an FK, and its hash
 * chain is anchored per tenant, so a request with no session has no tenant to
 * hang a row on — `agri-events.ts` says outright that such writes "are not
 * written to `AuditLog`, and cannot be".
 *
 * The platform-support gate (`assertPlatformSupport` + `admin.manage` inside
 * `PLATFORM_TENANT_SLUG`) has a real session, so it produces a real audit row
 * with a real `userId`. `promotion-admin.ts` already curates a global
 * catalogue this way. Manual price entry moves money decisions; a structured
 * log line is not the trail that deserves.
 *
 * ── Provenance is not an implementation detail ───────────────────────────
 *
 * Everything written here carries `source: 'manual'`, which the read path
 * already returns and the UI renders. A farmer choosing when to buy urea is
 * entitled to know whether the number came from a feed or from someone typing
 * it last month.
 */
import { Prisma } from '@prisma/client';
import type { RequestContext } from '../types';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, codedBadRequest, internal } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { normalizeAnyCommodity } from '@/lib/market/commodity-vocabulary';
import type { ManualPriceSeriesInput } from '../schemas/market-manual.schemas';

/**
 * The provenance marker. Queryable, so "which of these numbers did a human
 * type?" is one `where` clause rather than an archaeology exercise.
 */
export const MANUAL_SOURCE = 'manual';

/**
 * A superuser's daily price OVERRIDE (#1587). A separate source from
 * `'manual'`, and the reason is not what I first wrote down.
 *
 * My initial justification was that reusing `'manual'` would collide on the
 * natural key with a tenant's own manual entry. That was wrong: there is no
 * such thing. `'manual'` is ALREADY platform-level — gated on
 * `assertPlatformSupport` plus `admin.manage` inside `PLATFORM_TENANT_SLUG`,
 * writing one global series. Both are "a platform admin typed this".
 *
 * The real distinction is what the typed number CLAIMS:
 *
 *   · `'manual'` FILLS A GAP. The module docblock above says why it exists —
 *     no free feed publishes MAP at all, and the Pink Sheet carries neither MAP
 *     nor ammonium nitrate. There is no feed for it to outrank.
 *   · `'platform'` OVERRIDES A LIVE FEED. Owner ruling 2026-10-10: a typed
 *     price always wins, for every farm and every surface, until it is cleared.
 *
 * So reusing `'manual'` would retroactively convert every gap-fill row ever
 * entered into an always-wins override, with no migration and no diff that
 * looks like a behaviour change. That is the decisive argument, and it is about
 * existing DATA rather than about keys.
 *
 * It is also what agrent-ios#266 ranks on: the phone puts a `'platform'` series
 * first ACROSS (unit, currency) groups, which it must, because a typed EUR/l
 * diesel price lands in a different group from the bulletin's EUR/1000l and
 * would otherwise never be compared against it.
 */
export const PLATFORM_OVERRIDE_SOURCE = 'platform';

export interface ManualPriceWriteResult {
    seriesId: string;
    commodity: string;
    pointsUpserted: number;
    /** True when this write created the series rather than adding to one. */
    created: boolean;
}

export async function upsertManualPriceSeries(
    ctx: RequestContext,
    input: ManualPriceSeriesInput,
): Promise<ManualPriceWriteResult> {
    return writePriceSeries(ctx, input, MANUAL_SOURCE);
}

/**
 * A superuser's price override for one commodity (#1587).
 *
 * The same write as above under a different provenance — NOT a copy of it. The
 * normalisation, the duplicate-date refusal, the unit/currency guard and the
 * point upsert are identical requirements, and the one that matters most is the
 * unit/currency guard: a series that changes denomination mid-history renders
 * as one continuous line and is a lie, which is no less true of an override
 * than of a gap-fill.
 *
 * Diesel is typed in EUR/l while the nine crops and fertilisers are EUR/t —
 * owner, asked directly, after #1587 recorded the opposite via a relay. The
 * caller supplies `unit`, so nothing here needs to know which is which; the
 * guard simply refuses a second denomination for the same commodity.
 */
export async function upsertPlatformPriceOverride(
    ctx: RequestContext,
    input: ManualPriceSeriesInput,
): Promise<ManualPriceWriteResult> {
    return writePriceSeries(ctx, input, PLATFORM_OVERRIDE_SOURCE);
}

/** What clearing an override removed. */
export interface ClearOverrideResult {
    /** The canonical commodity whose override was cleared. */
    commodity: string;
    /** False when there was nothing to clear — NOT an error. */
    cleared: boolean;
    /** Points removed from publication. Zero when `cleared` is false. */
    pointsRemoved: number;
}

/**
 * Clear a superuser's price override, so the feed's price is authoritative
 * again (#1587).
 *
 * ## Why this DELETES, when I said the points would be kept
 *
 * The v1.3 contract I published on #1587 says two things that pull against
 * each other: a cleared override is **absent from the payload entirely**, and
 * pre-clear points **stay in storage for audit**.
 *
 * They cannot both be satisfied by leaving rows in place, because the read path
 * has NO source filter — `readFromDb` in `trends.ts` selects on `{ commodity }`
 * alone, which is exactly why a `'platform'` series needs no read-side change
 * to appear. The same property means anything left in the table stays visible.
 * So "absent" requires either a deletion or a new column plus a read-side
 * filter.
 *
 * This takes the deletion and moves the trail into the audit row, which carries
 * every point's date and price. That is the right home for "what was once
 * true", and it keeps the read path filter-free — a filter would be a second
 * place for a cleared override to leak back from if anyone ever forgot it.
 *
 * The migration alternative (`clearedAt` plus a read filter) is defensible and
 * I am not claiming otherwise; it is more machinery for the same observable
 * behaviour, and it puts a nullable-column check on the hot read path.
 *
 * ## Re-typing after a clear starts a FRESH run
 *
 * My decision, recorded on #1587 so it can be disagreed with. A clear is an
 * affirmative "the platform has no position", not a mute. If clearing hid
 * points that reappeared on the next type, a superuser who cleared a wrong
 * price would see it resurrected by an unrelated later entry. Deletion makes
 * that structural rather than a rule somebody has to remember.
 *
 * ## Clearing nothing is not an error
 *
 * `cleared: false`, 200. A superuser clearing an override that expired or was
 * never set has got the outcome they wanted, and a 404 would make an idempotent
 * retry look like a failure.
 */
export async function clearPlatformPriceOverride(
    ctx: RequestContext,
    commodityRaw: string,
): Promise<ClearOverrideResult> {
    assertPlatformSupport(ctx);

    const commodity = normalizeAnyCommodity(commodityRaw);
    if (!commodity) {
        // CODED, for two reasons. A client needs to distinguish "you
        // misspelled a commodity" from "there was no override to clear" —
        // which is a 200 with `cleared: false` — and prose here would be a
        // fourth server-authored sentence on a ratchet that is meant to go
        // down. The value is echoed in `params` so the client can show what it
        // sent rather than guessing.
        throw codedBadRequest(
            'UNKNOWN_COMMODITY',
            'That is not a commodity this platform prices.',
            { commodity: commodityRaw },
        );
    }

    return runInTenantContext(ctx, async (db) => {
        // Every region and stage for this commodity. The override is a
        // platform-wide position on a commodity, so clearing it by commodity
        // alone is the honest scope — leaving a stray BG/ex-works row behind
        // would keep overriding one surface while the superuser believed they
        // had cleared it.
        const series = await db.marketPriceSeries.findMany({
            where: { source: PLATFORM_OVERRIDE_SOURCE, commodity },
            select: {
                id: true,
                region: true,
                stage: true,
                unit: true,
                currency: true,
                points: { select: { date: true, price: true }, orderBy: { date: 'asc' } },
            },
        });

        if (series.length === 0) {
            return { commodity, cleared: false, pointsRemoved: 0 };
        }

        const pointsRemoved = series.reduce((n, sx) => n + sx.points.length, 0);

        // The trail, captured BEFORE the delete — the whole reason this is safe
        // to delete at all. Bounded: a daily override left running for two
        // years is 730 points per series, and an unbounded JSON column on an
        // append-only audit table is a slow way to make a table unreadable.
        // When it truncates it SAYS so, rather than presenting a prefix as the
        // whole history.
        const AUDIT_POINT_CAP = 400;
        const flat = series.flatMap((sx) =>
            sx.points.map((pt) => ({
                region: sx.region,
                stage: sx.stage,
                date: pt.date.toISOString().slice(0, 10),
                price: pt.price.toString(),
                unit: sx.unit,
                currency: sx.currency,
            })),
        );
        const kept = flat.slice(0, AUDIT_POINT_CAP);

        await logEvent(db, ctx, {
            action: 'MARKET_PRICE_OVERRIDE_CLEARED',
            entityType: 'MarketPriceSeries',
            entityId: series[0].id,
            details:
                `Cleared the platform price override for ${commodity}: ` +
                `${series.length} series, ${pointsRemoved} point(s) removed from publication`,
            detailsJson: {
                category: 'data_lifecycle',
                entityName: 'MarketPriceSeries',
                operation: 'deleted',
                summary:
                    `Platform override cleared: ${commodity}, ` +
                    `${pointsRemoved} point(s). The feed's price is authoritative again.`,
                before: {
                    source: PLATFORM_OVERRIDE_SOURCE,
                    commodity,
                    seriesCount: series.length,
                    pointsRemoved,
                    // Named rather than implied: a reader of a truncated trail
                    // must know it is truncated.
                    pointsRecorded: kept.length,
                    pointsTruncated: flat.length - kept.length,
                    points: kept,
                },
            },
        });

        // Points go with the series. Asserted on the COUNT rather than on the
        // call returning, because a delete that removed nothing is a silent
        // success — the shape that already cost this project a permanently red
        // guard elsewhere.
        const deleted = await db.marketPriceSeries.deleteMany({
            where: { source: PLATFORM_OVERRIDE_SOURCE, commodity },
        });
        if (deleted.count !== series.length) {
            // `internal`, not `badRequest`: the caller did nothing wrong and
            // there is no input to correct. Reaching this means the rows moved
            // between the read and the delete, which is a server-side
            // invariant breaking, and a 4xx would send a superuser looking for
            // their own mistake.
            throw internal(
                `Expected to clear ${series.length} override series for ${commodity}, deleted ${deleted.count}`,
            );
        }

        return { commodity, cleared: true, pointsRemoved };
    });
}

async function writePriceSeries(
    ctx: RequestContext,
    input: ManualPriceSeriesInput,
    source: string,
): Promise<ManualPriceWriteResult> {
    assertPlatformSupport(ctx);

    // Inputs are deliberately allowed here — this path exists precisely to
    // name the fertilisers no feed covers. `normalizeAnyCommodity` is the
    // resolver that accepts them; the exchange's `normalizeCommodity` does not.
    const commodity = normalizeAnyCommodity(input.commodity);
    if (!commodity) {
        throw badRequest(`Unknown commodity: ${input.commodity}`);
    }

    const stage = input.stage ?? null;
    const region = input.region;
    const { unit, currency } = input;

    // Reject duplicate dates in the payload rather than silently keeping the
    // last one. The feeds average genuine duplicate observations; two
    // different prices typed for one day is a typo, and averaging a typo
    // produces a number nobody entered.
    const seen = new Set<string>();
    for (const p of input.points) {
        const key = p.date.toISOString().slice(0, 10);
        if (seen.has(key)) {
            throw badRequest(`Duplicate observation date in payload: ${key}`);
        }
        seen.add(key);
    }

    return runInTenantContext(ctx, async (db) => {
        // ── The unit/currency check ──────────────────────────────────────
        //
        // This CANNOT be delegated to the unique constraint. `currency` and
        // `unit` are part of the natural key by deliberate design, so a point
        // typed `BGN/t` against a `EUR/t` history does not collide — it mints
        // a SECOND series, which the chart then draws as a separate line in a
        // separate unit group. No error anywhere, and two half-histories.
        //
        // So: look first, and refuse, naming what is already stored. The
        // schema comment records that the silent-fork version of this bug has
        // already happened once and was remediated by hand-written SQL.
        const existing = await db.marketPriceSeries.findFirst({
            where: { source, commodity, region, stage },
            select: { id: true, unit: true, currency: true },
        });

        if (existing && (existing.unit !== unit || existing.currency !== currency)) {
            throw badRequest(
                `Series ${commodity}/${region} is already recorded in ${existing.currency} ${existing.unit}; ` +
                    `refusing to write ${currency} ${unit}. A series that changes denomination mid-history ` +
                    `renders as one continuous line and is a lie. Correct the entry, or use a new stage.`,
            );
        }

        const seriesId =
            existing?.id ??
            (
                await db.marketPriceSeries.create({
                    data: {
                        source,
                        commodity,
                        region,
                        stage,
                        label: input.label ?? null,
                        unit,
                        currency,
                    },
                    select: { id: true },
                })
            ).id;

        // Points are WRITES in a loop, which the N+1 rule does not cover (it
        // is about reads) — the same shape `persistItems` uses in the pull job.
        for (const p of input.points) {
            const price = new Prisma.Decimal(Math.round(p.price * 100) / 100);
            await db.marketPricePoint.upsert({
                where: { seriesId_date: { seriesId, date: p.date } },
                create: { seriesId, date: p.date, price },
                update: { price },
            });
        }

        const isOverride = source === PLATFORM_OVERRIDE_SOURCE;

        await logEvent(db, ctx, {
            // Distinct actions, because these are different events to anyone
            // reading the trail later: one filled a gap, one overrode a live
            // feed for every farm. A single action name would make them
            // indistinguishable in exactly the audit nobody runs until it
            // matters.
            action: isOverride
                ? 'MARKET_PRICE_OVERRIDE_UPSERT'
                : 'MARKET_PRICE_MANUAL_UPSERT',
            entityType: 'MarketPriceSeries',
            entityId: seriesId,
            details: isOverride
                ? `Platform override: ${input.points.length} price point(s) for ${commodity} (${region})`
                : `Hand-entered ${input.points.length} price point(s) for ${commodity} (${region})`,
            detailsJson: {
                // Six categories exist and 'market' is not one of them.
                // `data_lifecycle` is the honest fit: this is data arriving,
                // not an entity being created or a status changing.
                category: 'data_lifecycle',
                entityName: 'MarketPriceSeries',
                operation: existing ? 'appended' : 'created',
                summary:
                    `${isOverride ? 'Platform price override' : 'Manual price entry'}: ` +
                    `${commodity} ${region} ` +
                    `${input.points.length} point(s) in ${currency} ${unit}`,
                after: {
                    source: MANUAL_SOURCE,
                    commodity,
                    region,
                    stage,
                    unit,
                    currency,
                    points: input.points.length,
                    firstDate: input.points[0]?.date.toISOString().slice(0, 10),
                },
            },
        });

        return {
            seriesId,
            commodity,
            pointsUpserted: input.points.length,
            created: existing === null,
        };
    });
}
