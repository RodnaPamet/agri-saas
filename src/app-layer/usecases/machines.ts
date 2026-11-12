/**
 * The machine read surface — #2948 stage 3, the `/machines` half.
 *
 * Three reads, all OWNER + ADMIN through `machines.view` at the route. The
 * MECHANISATOR half lives under `/farm-tasks` and is deliberately NOT here:
 * it authorises on "is this your open task" rather than on a permission flag,
 * and the Edge admits `farm-tasks` for that role while admitting no `machines`
 * prefix at all. Two different auth models, so two different modules.
 *
 * ## Every read answers in ONE transaction
 *
 * The fleet read is four queries — assets, live trackers, live telematics
 * links, latest positions — and they all run on the `db` handle
 * `runInTenantContext` provides, so they share one pool connection. Reaching
 * for the global client for any of them would take a SECOND connection while
 * the first is held, which is #1191's P0.8 deadlock at `PG_POOL_MAX`.
 *
 * ## An absent machine and a non-locatable one answer alike
 *
 * `findLocatableAsset` returns null for both, and both become the same 404.
 * Distinguishing them would turn these endpoints into an enumerator for the
 * asset register: "this id exists but is a barn" is information the caller did
 * not have.
 */
import type { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { MachineRepository } from '../repositories/MachineRepository';
import { runInTenantContext } from '@/lib/db-context';
import { codedBadRequest, codedNotFound } from '@/lib/errors/types';
import { DAY_KEY_PATTERN, farmDayRange, farmToday } from '@/lib/calendar-day-key';
import { simplifyTrack } from '@/lib/machines/track-simplify';
import {
    MAX_POSITIONS_PER_DAY,
    decimalToNumber,
    isDayRetained,
    isMoving,
    resolvePositionSource,
    type MachineRowView,
    type PositionView,
} from '@/lib/machines/fleet-view';

/** The shape `/track` returns. */
export interface MachineTrackView {
    date: string;
    points: Array<Omit<PositionView, 'moving'>>;
    /**
     * Rows were never READ — the per-day ceiling was exceeded. Distinct from
     * `simplified`, which means every row was read and the LINE was reduced.
     */
    truncated: boolean;
    /** False past the raw-retention window: we no longer hold this day. */
    retained: boolean;
    simplified: boolean;
    rawCount: number;
    toleranceM: number;
}

export interface WorkedParcelView {
    parcelId: string;
    name: string;
    minutesWorked: number;
    areaHa: number | null;
    confidence: number | null;
}

export interface MachineWorkedView {
    date: string;
    parcels: WorkedParcelView[];
    /** Always true: `WorkedParcel` is what SURVIVES the sweep. */
    retained: boolean;
    /**
     * When the derivation last PROCESSED this machine-day, or `null` — #2984.
     *
     * Read from the `MachineWorkedDay` marker, never from the rows. That is
     * what makes three states expressible out of two fields:
     *
     * | `parcels` | `derivedAt` | means |
     * |---|---|---|
     * | `[]` | `null` | not processed yet — «изчисляват се през нощта» |
     * | `[]` | timestamp | **it ran, and this machine worked no parcel** |
     * | rows | timestamp | the normal case |
     *
     * The middle row was inexpressible until the marker existed, because this
     * value was reduced out of the `WorkedParcel` rows and an idle day has
     * none — so a farm whose machine genuinely idled was told the figures were
     * still being computed, every time it looked, with no error and no metric.
     *
     * A marker whose `parcelsMatched` is 0 is therefore a real answer, and
     * `positionsConsidered` on that row is what separates "the machine idled"
     * from "the tracker reported nothing usable". The read does not surface
     * that second figure yet; the marker holds it when somebody asks.
     */
    derivedAt: string | null;
}

/** The whole fleet's configuration and liveness, in one call. */
export async function listMachines(
    ctx: RequestContext,
): Promise<{ machines: MachineRowView[] }> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const assets = await MachineRepository.listLocatableAssets(db, ctx);
        if (assets.length === 0) return { machines: [] };

        const ids = assets.map((a) => a.id);
        // Three reads over the SAME id list, then joined in memory. Not a loop
        // over assets — that is the D1 N+1 shape, and with a tracker, a link
        // and a position each it would be 3N queries for a fleet screen.
        const [trackerIds, providers, positions] = await Promise.all([
            MachineRepository.liveTrackerAssetIds(db, ctx, ids),
            MachineRepository.liveTelematicsProviders(db, ctx, ids),
            MachineRepository.latestPositions(db, ctx, ids),
        ]);

        const byAsset = new Map(positions.map((p) => [p.assetId, p]));

        return {
            machines: assets.map((a) => {
                const p = byAsset.get(a.id);
                const speedKph = decimalToNumber(p?.speedKph ?? null);
                return {
                    assetId: a.id,
                    name: a.name,
                    type: a.type,
                    positionSource: resolvePositionSource({
                        hasLiveTracker: trackerIds.has(a.id),
                        liveTelematicsProvider: providers.get(a.id) ?? null,
                    }),
                    lastPosition: p
                        ? {
                              lat: p.lat.toString(),
                              lon: p.lon.toString(),
                              recordedAt: p.recordedAt.toISOString(),
                              speedKph,
                              ignition: p.ignition,
                              moving: isMoving(speedKph),
                          }
                        : null,
                };
            }),
        };
    });
}

/**
 * Reject a malformed `date` before it reaches a query.
 *
 * `DAY_KEY_PATTERN` is shape only, so the round-trip is what rejects
 * `2026-02-31`: a parser is not a validator, and `new Date('2026-02-31')`
 * rolls forward to March rather than failing. A rolled-over date would answer
 * confidently about the wrong day.
 */
function parseDayKey(date: string | null): string {
    if (date === null || !DAY_KEY_PATTERN.test(date)) {
        throw codedBadRequest('DATE_REQUIRED', 'A `date` of the form YYYY-MM-DD is required.');
    }
    const roundTrip = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(roundTrip.getTime()) || roundTrip.toISOString().slice(0, 10) !== date) {
        throw codedBadRequest('DATE_INVALID', 'That date does not exist.');
    }
    return date;
}

/** One machine's simplified track for one Europe/Sofia day. */
export async function readMachineTrack(
    ctx: RequestContext,
    assetId: string,
    rawDate: string | null,
    now: Date = new Date(),
): Promise<MachineTrackView> {
    assertCanRead(ctx);
    const date = parseDayKey(rawDate);

    return runInTenantContext(ctx, async (db) => {
        const asset = await MachineRepository.findLocatableAsset(db, ctx, assetId);
        if (asset === null) throw codedNotFound('MACHINE_NOT_FOUND', 'No such machine.');

        const retained = isDayRetained(date, farmToday(now));
        // Outside the window the rows are gone, so there is nothing to read and
        // an empty `points` here MEANS the deletion rather than an idle machine
        // — which is exactly what `retained: false` is for. Skipping the query
        // also keeps a scan off a date range the sweep has emptied.
        if (!retained) {
            return {
                date,
                points: [],
                truncated: false,
                retained: false,
                simplified: false,
                rawCount: 0,
                toleranceM: 0,
            };
        }

        const range = farmDayRange(date);
        const rows = await MachineRepository.listDayPositions(db, ctx, assetId, range);
        const truncated = rows.length > MAX_POSITIONS_PER_DAY;
        const considered = truncated ? rows.slice(0, MAX_POSITIONS_PER_DAY) : rows;

        // `simplifyTrack` takes lon/lat as STRINGS and returns a subset of
        // these very objects by reference, so no coordinate is rebuilt from the
        // float its geometry used.
        const simplifiable = considered.map((r) => ({
            lat: r.lat.toString(),
            lon: r.lon.toString(),
            recordedAt: r.recordedAt,
            speedKph: decimalToNumber(r.speedKph),
            ignition: r.ignition,
        }));
        const result = simplifyTrack(simplifiable);

        return {
            date,
            points: result.points.map((p) => ({
                lat: p.lat,
                lon: p.lon,
                recordedAt: p.recordedAt.toISOString(),
                speedKph: p.speedKph,
                ignition: p.ignition,
            })),
            truncated,
            retained: true,
            simplified: result.simplified,
            rawCount: result.rawCount,
            toleranceM: result.toleranceM,
        };
    });
}

/** One machine's worked parcels for one calendar day. */
export async function readMachineWorked(
    ctx: RequestContext,
    assetId: string,
    rawDate: string | null,
): Promise<MachineWorkedView> {
    assertCanRead(ctx);
    const date = parseDayKey(rawDate);

    return runInTenantContext(ctx, async (db) => {
        const asset = await MachineRepository.findLocatableAsset(db, ctx, assetId);
        if (asset === null) throw codedNotFound('MACHINE_NOT_FOUND', 'No such machine.');

        // The `@db.Date` column is matched as a plain day. `farmDayRange` is
        // deliberately NOT used: that resolves a Sofia day to UTC INSTANTS,
        // which is the right thing for `MachinePosition.recordedAt` and the
        // wrong thing for a date column, where it would shift the day by the
        // offset and return the neighbour's rows.
        const day = new Date(`${date}T00:00:00Z`);
        const [rows, marker] = await Promise.all([
            MachineRepository.listWorkedParcels(db, ctx, assetId, day),
            MachineRepository.findWorkedDayMarker(db, ctx, assetId, day),
        ]);

        return {
            date,
            parcels: rows.map((r) => ({
                parcelId: r.parcelId,
                name: r.parcel.name,
                minutesWorked: r.minutesWorked,
                areaHa: decimalToNumber(r.areaHa),
                confidence: decimalToNumber(r.confidence),
            })),
            retained: true,
            // From the MARKER (#2984). The reduce over row timestamps this
            // replaces could only ever answer for a day that produced rows,
            // which is the one case that needed no help: an EMPTY day is
            // exactly where the answer matters, and it had nowhere to come
            // from. A re-derived day reports the latest run because the
            // marker is upserted rather than appended.
            derivedAt: marker?.derivedAt.toISOString() ?? null,
        };
    });
}
