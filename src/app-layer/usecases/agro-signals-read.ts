/**
 * Reading agro signals for a date range — #3077.
 *
 * Its own module rather than an addition to `agro-signals.ts`, which is a
 * WRITE path: that file evaluates weather, claims rows and notifies, and runs
 * from a job. This is a plain read a phone makes while a farmer looks at a
 * calendar, and the two have nothing in common but the table.
 *
 * ## Why this exists at all
 *
 * The lunar calendar must not advise sowing on a frost or spray-warning day
 * (owner, 2026-11-15), and the signal is keyed per BLOCK — so a day-level
 * boolean computed on the server would either over-suppress a farm with
 * twelve blocks or say nothing about which one. The client composes the
 * suppression where it holds the location, which means it needs the rows.
 *
 * `GET /api/t/{slug}/calendar` already returns these rows in its unified event
 * stream, and was considered instead: it exposes the location only as
 * `titleParams.name` and inside an `href`, so a client would have to parse a
 * URL to recover `locationId`. That is the coupling that broke the iOS client
 * for four days in #1087, so it is not something to ask a client to do.
 */
import type { AgroSignalKind } from '@prisma/client';

import type { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { DEFAULT_FROST_THRESHOLDS } from '@/lib/agro/rules';

/**
 * Rows per request.
 *
 * A bound rather than a page, because the caller asks for a DATE RANGE and
 * the natural volume is (blocks x warned days) — a 62-day span on a 50-block
 * farm with a bad fortnight is still only hundreds. A `take` is required by
 * the unbounded-findMany guardrail, and `truncated` is reported rather than
 * silently dropping rows: a client that showed no warning on a block because
 * the list was cut off would be the exact failure this feature exists to
 * prevent.
 */
export const AGRO_SIGNALS_MAX_ROWS = 2000;

export interface AgroSignalRow {
    locationId: string;
    kind: AgroSignalKind;
    /** Free severity label per kind — `UNSUITABLE`, `HIGH`, `FROST`. */
    level: string | null;
    /** `YYYY-MM-DD`. */
    signalDate: string;
}

export interface AgroSignalsView {
    signals: AgroSignalRow[];
    /**
     * The last day a FORECAST actually informed, `YYYY-MM-DD`, or null when
     * this farm has no weather at all.
     *
     * This is the field that keeps the client honest. Beyond it an absent
     * signal means *not knowable*, not *clear* — and a client that hard-coded
     * the horizon instead would drift silently the day `forecast_days`
     * changes. Derived from the newest observation held rather than from the
     * configured horizon, so a pull that partially failed reports the shorter
     * truth.
     *
     * It is ONE value for the farm, which is a deliberate simplification: a
     * block whose own pull failed can have a shorter horizon than this, so
     * treat it as the best case. Per-block horizons would be more precise and
     * are not worth the payload until something needs them.
     */
    horizon: string | null;
    /** The frost rule's threshold, so a client can explain the warning. */
    frostThresholdC: number;
    /** True when the row cap was hit and the list is incomplete. */
    truncated: boolean;
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

export async function listAgroSignals(
    ctx: RequestContext,
    range: { from: Date; to: Date },
): Promise<AgroSignalsView> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const rows = await db.agroSignal.findMany({
            where: {
                tenantId: ctx.tenantId,
                signalDate: { gte: range.from, lte: range.to },
            },
            select: { locationId: true, kind: true, level: true, signalDate: true },
            orderBy: [{ signalDate: 'asc' }, { locationId: 'asc' }],
            take: AGRO_SIGNALS_MAX_ROWS + 1,
        });

        // The newest observation this farm holds, which is what the forecast
        // actually reached. Not filtered to the requested range: the horizon
        // is a fact about the farm, and a client asking about last month still
        // needs to know how far forward anything is known.
        const newest = await db.weatherObservation.findFirst({
            where: { tenantId: ctx.tenantId },
            select: { obsDate: true },
            orderBy: { obsDate: 'desc' },
        });

        const truncated = rows.length > AGRO_SIGNALS_MAX_ROWS;
        return {
            signals: rows.slice(0, AGRO_SIGNALS_MAX_ROWS).map((r) => ({
                locationId: r.locationId,
                kind: r.kind,
                level: r.level,
                signalDate: dayKey(r.signalDate),
            })),
            horizon: newest ? dayKey(newest.obsDate) : null,
            frostThresholdC: DEFAULT_FROST_THRESHOLDS.tempMinC,
            truncated,
        };
    });
}
