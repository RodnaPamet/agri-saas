/**
 * Nightly worked-parcel derivation — #2948 stage 4, with #2984's run marker.
 *
 * Turns a day of raw `MachinePosition` rows into `WorkedParcel` records: which
 * parcels a machine worked, for how long, and how confident the match is.
 *
 * ## It runs in SQL, and the projection is load-bearing
 *
 * #2948 §8 settles the shape: positions → `ST_MakeLine` ordered by
 * `recordedAt` → `ST_Intersects` against `Parcel.geometry` → lengths in
 * **EPSG:32635**. The alternative is pulling ~2,900 points per machine per day
 * into node and doing geometry by hand.
 *
 * SRID 4326 is DEGREES. `ST_Length` on it returns a number in degrees that
 * looks like a distance and is not — at this latitude a degree of longitude is
 * about 64 km and a degree of latitude about 111 km, so the error is not even
 * uniform. Bulgaria is UTM zone 35N, and every length here goes through it.
 *
 * `MachinePosition` stores `lat`/`lon` as decimals rather than a geometry
 * column, so the points are built with `ST_MakePoint(lon, lat)` — in that
 * order, which is the one every PostGIS signature takes and the opposite of
 * how the columns read.
 *
 * ## The three thresholds, and that they are guesses
 *
 * Ignition on (a parked machine is not working), speed between 2 and 15 km/h
 * (below is idling, above is transport — a sprayer works at 8–12 and a tractor
 * transports at 25+), and at least 5 continuous minutes inside the parcel (a
 * road clipping a corner is not work). #2948 says plainly that all three want
 * calibration against one real day; `derivedFrom` records which set produced a
 * row so a re-derivation under better numbers is distinguishable rather than
 * silently mixed in.
 *
 * ## `areaHa` is left NULL, deliberately
 *
 * Area worked is the swept path, which is the track length times the
 * IMPLEMENT's working width — and nothing in this product knows that width.
 * `Asset` has no such field and inventing one from the machine type would be a
 * guess dressed as a measurement. The schema's own comment on that column says
 * why that matters: "a derived area presented as a measurement is a number
 * somebody will put in a subsidy return." So minutes are reported, area is
 * not, until there is a width to multiply by.
 *
 * ## `confidence` measures how far INSIDE the parcel the work was
 *
 * The share of matched points that fall inside the parcel shrunk by 20 m.
 * A track along a road hugging a field edge intersects the parcel and scores
 * near zero; a machine working the field scores near one. It is a weak signal
 * on a small parcel — a 20 m buffer eats a narrow strip entirely, which is why
 * the value is surfaced rather than used to filter, and why the «Нов запис»
 * offer presents it as a suggestion.
 *
 * ## The marker is written in the SAME transaction as the parcels
 *
 * #2984: a marker written beside the upsert can claim a run that rolled back,
 * and this row is the ONLY evidence a run happened — a false one is worse than
 * a missing one. One transaction per (asset, day), not per tenant: a tenant
 * with forty machines would otherwise hold one transaction across forty
 * PostGIS scans, and a single bad asset would roll back the other thirty-nine.
 *
 * ## SIMULATED positions are EXCLUDED, and that is the owner's rule
 *
 * `MachinePositionSource.SIMULATED` exists because the owner required every
 * simulated position to be marked on the POSITION and not merely on the
 * asset — its enum docblock gives the reason and the limit in one sentence:
 * "marking only the asset leaves rows that outlive a reconfiguration still
 * claiming to be real. The thing that must never happen is simulated work
 * reaching a real farm's ДНЕВНИК, even as a «Нов запис» draft."
 *
 * A `WorkedParcel` row is exactly what fills that draft, and the table has no
 * column saying where it came from — `derivedFrom` records the MATCHER, not
 * the provenance of the positions. So a day containing simulated positions
 * would produce rows indistinguishable from real work. The hazard is not the
 * demo tenant, whose own rows are its own; it is a REAL farm that tried the
 * simulator once, whose simulated afternoon would then sit in its register
 * offering to be filed.
 *
 * Excluding them is therefore the conservative reading, and it has a cost
 * worth stating rather than discovering: a demo farm's worked-parcels screen
 * stays empty, WITH a marker saying the derivation ran — which is honest
 * about the derivation and misleading about the demo. Making the demo show
 * derived work needs a provenance column on `WorkedParcel` so the draft can
 * refuse it, which is a schema decision rather than a filter. Tracked
 * separately.
 *
 * ## Idempotent by unique index, so a re-run is safe
 *
 * `WorkedParcel` is keyed `(assetId, parcelId, date)` and the marker
 * `(assetId, date)`. A second run of the same day UPDATES both rather than
 * double-counting minutes, which is also why this job may carry the queue's
 * normal retry count instead of `attempts: 1` — unlike `statement-dispatch`,
 * where a retry re-SENDS, and `notice-score`, where a retry re-SPENDS.
 */
import { randomUUID } from 'node:crypto';

import { farmDayRange, farmToday } from '@/lib/calendar-day-key';
import { withTenantDb } from '@/lib/db-context';
import { workedParcelMatchesSql } from '@/lib/db/geo';
import { logger } from '@/lib/observability/logger';
import { runJob } from '@/lib/observability/job-runner';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

import type { JobRunResult } from './types';

/**
 * The matcher's identity, recorded on every row it writes.
 *
 * Bump it whenever a threshold or the geometry changes, so a row produced by
 * the old rule stays distinguishable after the raw positions behind it are
 * swept and cannot be re-derived.
 */
export const DERIVED_FROM = 'v1:ignition+speed2-15kph+5min+inward20m';

/** Below this, a position is idling rather than working. */
const MIN_SPEED_KPH = 2;
/** Above this, it is transport. */
const MAX_SPEED_KPH = 15;
/** A run inside one parcel shorter than this is not work. */
const MIN_RUN_MINUTES = 5;
/**
 * A gap longer than this ends a run.
 *
 * A tracker reports about every 30 s, so 10 minutes is twenty missed reports —
 * long enough to ride out a tunnel or a cold start, short enough that leaving
 * a field for an hour and coming back counts as two runs rather than one long
 * one whose "continuous minutes" would be mostly absence.
 */
const RUN_GAP_MINUTES = 10;
/** How far inside the boundary a point must be to count toward confidence. */
const INWARD_BUFFER_M = 20;

/**
 * Which position sources may be derived — an ALLOWLIST.
 *
 * Never `!= 'SIMULATED'`: a sixth source added later must be excluded until
 * somebody decides it belongs, which is the direction a denylist gets wrong.
 * One constant, used by the matcher, by the count that reports what the
 * matcher was allowed to see, and by the target enumeration — three places
 * that must agree or the marker reports a number the matcher never looked at.
 */
const DERIVABLE_SOURCES = ['TRACKER', 'TELEMATICS'] as const;

interface ParcelMatch {
    parcel_id: string;
    minutes: number;
    inside_points: number;
    matched_points: number;
}

export interface WorkedParcelDerivationPayload {
    /** Limit to one tenant. Default: every tenant with positions that day. */
    tenantId?: string;
    /**
     * The Europe/Sofia calendar day to derive, `YYYY-MM-DD`. Defaults to
     * YESTERDAY in Sofia — the job runs after midnight, and "today" would
     * derive a day still in progress and then have to be re-run anyway.
     */
    date?: string;
}

/**
 * Yesterday, as a farm calendar date.
 *
 * Built on `farmToday` rather than a local `Intl.DateTimeFormat`, which is
 * what the first draft did: the farm day rule already lives in
 * `@/lib/calendar-day-key` (`FARM_TIME_ZONE` is Europe/Sofia) and a second
 * copy here would be a second place for it to be wrong. Arithmetic on the
 * DAY KEY, not on an instant, so the subtraction cannot land an hour either
 * side of a DST change.
 */
export function sofiaYesterday(now: Date = new Date()): string {
    const d = new Date(`${farmToday(now)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

/**
 * Derive one (asset, day) and write both tables in one transaction.
 *
 * Returns the number of parcels matched, or null when the asset had no usable
 * positions at all — which is still a RUN, and still gets a marker.
 */
export async function deriveAssetDay(
    tenantId: string,
    assetId: string,
    date: string,
): Promise<{ parcels: number; positions: number }> {
    // One source for the day's instants, used by the matcher and by the
    // reading below. See `farmDayRange`.
    const { start, end } = farmDayRange(date);

    return withTenantDb(tenantId, async (db) => {
        /*
         * One statement, read inside-out:
         *
         *   filtered  — the day's positions that could be work at all
         *   hits      — those that fall inside some parcel of this tenant
         *   marked    — a 1 wherever a gap ends the previous run
         *   runs      — a running sum of those marks, giving each run an id
         *   per_run   — one row per (parcel, run) with its span and points
         *   kept      — runs that lasted at least MIN_RUN_MINUTES
         *
         * The day boundary is computed in Europe/Sofia and compared against
         * `recordedAt`, which is a timestamp: `AT TIME ZONE` twice converts the
         * local midnight to the instant it happened, so a night shift stays on
         * one day. Doing this in JS and passing two instants would work too,
         * and would put the timezone rule in a second place.
         */
        /*
         * The geometry lives in `@/lib/db/geo` — `geo-raw-sql-containment`
         * allows raw `ST_*` in that file and nowhere else, so the spatial
         * surface stays auditable in one place. This job owns the THRESHOLDS,
         * which are policy rather than geometry, and passes them in.
         *
         * `$queryRaw` with a `Prisma.sql` fragment, not `$queryRawUnsafe` with
         * positional parameters. That is not a style preference: the previous
         * version numbered its own placeholders, and removing one left an
         * unreferenced parameter that Postgres answered with 42P18 — "could
         * not determine data type of parameter $1". Interpolation cannot
         * produce that class of bug.
         */
        const matches = await db.$queryRaw<ParcelMatch[]>(
            workedParcelMatchesSql({
                tenantId,
                assetId,
                dayStart: start,
                dayEnd: end,
                sources: DERIVABLE_SOURCES,
                minSpeedKph: MIN_SPEED_KPH,
                maxSpeedKph: MAX_SPEED_KPH,
                runGapMinutes: RUN_GAP_MINUTES,
                minRunMinutes: MIN_RUN_MINUTES,
                inwardBufferM: INWARD_BUFFER_M,
            }),
        );

        const considered = await db.machinePosition.count({
            where: {
                tenantId,
                assetId,
                source: { in: [...DERIVABLE_SOURCES] },
                recordedAt: { gte: start, lt: end },
            },
        });

        for (const m of matches) {
            // `confidence` is NULL rather than 0 when nothing could be
            // measured: zero asserts "measured, and badly", which is a
            // different claim from "no basis to judge".
            const confidence =
                m.matched_points > 0
                    ? Math.min(1, m.inside_points / m.matched_points)
                    : null;
            await db.workedParcel.upsert({
                where: {
                    assetId_parcelId_date: {
                        assetId,
                        parcelId: m.parcel_id,
                        date: new Date(`${date}T00:00:00Z`),
                    },
                },
                create: {
                    tenantId,
                    assetId,
                    parcelId: m.parcel_id,
                    date: new Date(`${date}T00:00:00Z`),
                    minutesWorked: m.minutes,
                    areaHa: null,
                    confidence,
                    derivedFrom: DERIVED_FROM,
                    derivedAt: new Date(),
                },
                update: {
                    minutesWorked: m.minutes,
                    areaHa: null,
                    confidence,
                    derivedFrom: DERIVED_FROM,
                    derivedAt: new Date(),
                },
            });
        }

        // THE MARKER, in this same transaction — #2984. Written whether or not
        // `matches` is empty, which is the entire point: an idle machine's day
        // is an answer, and without this row the read cannot tell it from a day
        // nobody has processed.
        await db.machineWorkedDay.upsert({
            where: { assetId_date: { assetId, date: new Date(`${date}T00:00:00Z`) } },
            create: {
                tenantId,
                assetId,
                date: new Date(`${date}T00:00:00Z`),
                derivedFrom: DERIVED_FROM,
                derivedAt: new Date(),
                positionsConsidered: considered,
                parcelsMatched: matches.length,
            },
            update: {
                derivedFrom: DERIVED_FROM,
                derivedAt: new Date(),
                positionsConsidered: considered,
                parcelsMatched: matches.length,
            },
        });

        return { parcels: matches.length, positions: considered };
    });
}

export async function runWorkedParcelDerivation(
    payload: WorkedParcelDerivationPayload = {},
): Promise<{ result: JobRunResult }> {
    return runJob('worked-parcel-derivation', async () => {
        const jobRunId = `wpd-${randomUUID()}`;
        const startedAt = new Date();
        const date = payload.date ?? sofiaYesterday();
        const { start: dayStart, end: dayEnd } = farmDayRange(date);

        /*
         * The population is "machines that reported that day", derived from
         * the positions themselves rather than from the tracker list: a
         * tracker can be registered and silent, and deriving from the
         * registration would write a marker claiming a run for a machine that
         * sent nothing — which is exactly the false claim #2984 is about.
         *
         * Privileged, because this crosses tenants. The per-asset work below
         * then runs under each tenant's own context.
         */
        const targets = await prisma.$queryRaw<
            Array<{ tenantId: string; assetId: string }>
        >(Prisma.sql`
            SELECT DISTINCT p."tenantId", p."assetId"
            FROM "MachinePosition" p
            WHERE p."recordedAt" >= ${dayStart}
              AND p."recordedAt" <  ${dayEnd}
              -- Same allowlist as the matcher, from the same constant. A
              -- machine whose whole day was simulated is not a machine that
              -- reported, so it gets no marker at all rather than one
              -- claiming a run over nothing.
              AND p."source"::text IN (${Prisma.join([...DERIVABLE_SOURCES])})
              ${
                  payload.tenantId
                      ? Prisma.sql`AND p."tenantId" = ${payload.tenantId}`
                      : Prisma.empty
              }
        `);

        let actioned = 0;
        let skipped = 0;
        let parcelsWritten = 0;

        for (const t of targets) {
            try {
                const out = await deriveAssetDay(t.tenantId, t.assetId, date);
                actioned += 1;
                parcelsWritten += out.parcels;
            } catch (err) {
                // Per-asset tolerant, like `statement-dispatch`: one machine
                // whose geometry is broken must not stop the other thirty-nine,
                // and the skipped count is the finding rather than the failure.
                skipped += 1;
                logger.warn('worked-parcel-derivation.asset_failed', {
                    component: 'worked-parcel-derivation',
                    jobRunId,
                    tenantId: t.tenantId,
                    assetId: t.assetId,
                    date,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        /*
         * The DENOMINATOR, in the log FIELDS and not a console `[tag]` line.
         *
         * That convention is collected by a jest reporter out of a test run, so
         * a scheduled job's tagged line is collected by nothing while still
         * breaching the no-`console`-in-server-code rule — the P9.3d note. In
         * fields it is also queryable, which is what an operator asking "did
         * last night's derivation run" actually needs.
         *
         * `machinesConsidered: 0` is a real answer — no machine reported — and
         * is distinguishable from the job not having run, because this line is
         * absent in that case.
         */
        logger.info('worked-parcel-derivation.reading', {
            component: 'worked-parcel-derivation',
            jobRunId,
            date,
            machinesConsidered: targets.length,
            machinesDerived: actioned,
            machinesSkipped: skipped,
            parcelsWritten,
        });

        const completedAt = new Date();
        return {
            result: {
                jobName: 'worked-parcel-derivation',
                jobRunId,
                success: true,
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
                durationMs: completedAt.getTime() - startedAt.getTime(),
                itemsScanned: targets.length,
                itemsActioned: actioned,
                itemsSkipped: skipped,
                details: { date, parcelsWritten, derivedFrom: DERIVED_FROM },
            },
        };
    });
}
