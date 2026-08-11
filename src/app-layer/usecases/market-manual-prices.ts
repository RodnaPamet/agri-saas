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
import { badRequest } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { normalizeAnyCommodity } from '@/lib/market/commodity-vocabulary';
import type { ManualPriceSeriesInput } from '../schemas/market-manual.schemas';

/**
 * The provenance marker. Queryable, so "which of these numbers did a human
 * type?" is one `where` clause rather than an archaeology exercise.
 */
export const MANUAL_SOURCE = 'manual';

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
            where: { source: MANUAL_SOURCE, commodity, region, stage },
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
                        source: MANUAL_SOURCE,
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

        await logEvent(db, ctx, {
            action: 'MARKET_PRICE_MANUAL_UPSERT',
            entityType: 'MarketPriceSeries',
            entityId: seriesId,
            details: `Hand-entered ${input.points.length} price point(s) for ${commodity} (${region})`,
            detailsJson: {
                // Six categories exist and 'market' is not one of them.
                // `data_lifecycle` is the honest fit: this is data arriving,
                // not an entity being created or a status changing.
                category: 'data_lifecycle',
                entityName: 'MarketPriceSeries',
                operation: existing ? 'appended' : 'created',
                summary:
                    `Manual price entry: ${commodity} ${region} ` +
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
