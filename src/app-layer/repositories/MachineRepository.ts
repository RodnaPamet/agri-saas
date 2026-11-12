/**
 * Every Prisma query behind the machine read surface — #2948 stage 3.
 *
 * All reads are tenant-filtered in the `where` as well as being RLS'd, the
 * defence-in-depth the repository layer owes. All are bounded with `take:`.
 *
 * ## The last-position read is TWO queries on purpose
 *
 * "The latest position for each of N machines" is the classic N+1 shape, and
 * the D1 guardrail bans a Prisma read inside a loop. Postgres answers it in
 * one pass with `DISTINCT ON`, which Prisma's query API cannot express — but a
 * raw read brings a trap this schema walks straight into: `recordedAt` is
 * `timestamp(3)` WITHOUT time zone, and a raw `pg` read of such a column
 * applies the CLIENT's timezone, so the instants would come back shifted while
 * looking perfectly well-formed.
 *
 * So raw SQL selects the IDS only, and the rows are read back through the
 * typed client, which maps timestamps correctly. That is the `notice-score`
 * pattern CLAUDE.md records for the same reason in the other direction — the
 * anti-join is raw so the database does it under a LIMIT, and the row read
 * goes through Prisma because only Prisma decrypts. Two bounded queries, no
 * loop, and no instant is ever built by the raw driver.
 */
import { Prisma, type AssetType, type TelematicsProvider } from '@prisma/client';

import { PrismaTx } from '@/lib/db-context';
import {
    LOCATABLE_ASSET_WHERE,
    MAX_POSITIONS_PER_DAY,
} from '@/lib/machines/fleet-view';

import { RequestContext } from '../types';

/**
 * Ceiling on the fleet list.
 *
 * A farm's machine register is tens of rows, not thousands, so this is a
 * malfunction bound rather than a pagination strategy — and it is why the
 * fleet read needs no cursor. `AssetRepository.ASSET_LIST_CAP` is 1000 over
 * the whole register; this is narrower because the population is narrower.
 */
export const MACHINE_FLEET_CAP = 500;

/** Ceiling on one machine-day's worked-parcel rows. */
export const WORKED_PARCEL_CAP = 500;

export interface MachineAssetRow {
    id: string;
    name: string;
    type: AssetType;
}

export class MachineRepository {
    /**
     * The locatable machine register for this tenant, name-ordered.
     *
     * Ordered by NAME rather than by `createdAt` like the asset list: this is
     * a screen somebody scans for a particular machine, and an operator knows
     * its name, not when it was added.
     */
    static async listLocatableAssets(
        db: PrismaTx,
        ctx: RequestContext,
    ): Promise<MachineAssetRow[]> {
        return db.asset.findMany({
            where: { tenantId: ctx.tenantId, ...LOCATABLE_ASSET_WHERE },
            select: { id: true, name: true, type: true },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: MACHINE_FLEET_CAP,
        });
    }

    /**
     * One asset, if it is this tenant's and is locatable.
     *
     * Returns null rather than throwing so the caller can answer the SAME
     * not-found a nonexistent asset gets. A machine that exists but is a
     * BUILDING must not be distinguishable from one that does not exist —
     * otherwise the endpoint enumerates the asset register by type.
     */
    static async findLocatableAsset(
        db: PrismaTx,
        ctx: RequestContext,
        assetId: string,
    ): Promise<MachineAssetRow | null> {
        return db.asset.findFirst({
            where: { id: assetId, tenantId: ctx.tenantId, ...LOCATABLE_ASSET_WHERE },
            select: { id: true, name: true, type: true },
        });
    }

    /** Asset ids with a LIVE tracker box. */
    static async liveTrackerAssetIds(
        db: PrismaTx,
        ctx: RequestContext,
        assetIds: readonly string[],
    ): Promise<Set<string>> {
        if (assetIds.length === 0) return new Set();
        const rows = await db.machineTracker.findMany({
            where: {
                tenantId: ctx.tenantId,
                assetId: { in: [...assetIds] },
                removedAt: null,
            },
            select: { assetId: true },
            take: MACHINE_FLEET_CAP,
        });
        return new Set(rows.map((r) => r.assetId));
    }

    /**
     * Asset id → provider, for assets with a LIVE telematics link.
     *
     * `installedAt asc` then `id asc` so a machine that somehow carries two
     * live links resolves to a STABLE provider rather than whichever row the
     * planner returned first. The partial unique index is meant to prevent
     * that, and an ordering costs nothing if it never fires.
     */
    static async liveTelematicsProviders(
        db: PrismaTx,
        ctx: RequestContext,
        assetIds: readonly string[],
    ): Promise<Map<string, TelematicsProvider>> {
        if (assetIds.length === 0) return new Map();
        const rows = await db.machineTelematicsLink.findMany({
            where: {
                tenantId: ctx.tenantId,
                assetId: { in: [...assetIds] },
                removedAt: null,
            },
            select: { assetId: true, provider: true, installedAt: true, id: true },
            orderBy: [{ installedAt: 'asc' }, { id: 'asc' }],
            take: MACHINE_FLEET_CAP,
        });
        const out = new Map<string, TelematicsProvider>();
        for (const r of rows) if (!out.has(r.assetId)) out.set(r.assetId, r.provider);
        return out;
    }

    /**
     * The latest position for each of several assets.
     *
     * See this module's docblock for why it is raw-then-typed. The raw half
     * returns ids only; nothing it selects is a timestamp or a decimal.
     */
    static async latestPositions(
        db: PrismaTx,
        ctx: RequestContext,
        assetIds: readonly string[],
    ) {
        if (assetIds.length === 0) return [];
        // Parameterised through `Prisma.sql` — never interpolated. `IN` takes
        // `Prisma.join`, because a bare array parameter is not an IN-list.
        const ids = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
            SELECT DISTINCT ON ("assetId") "id"
            FROM "MachinePosition"
            WHERE "tenantId" = ${ctx.tenantId}
              AND "assetId" IN (${Prisma.join([...assetIds])})
            ORDER BY "assetId", "recordedAt" DESC
        `);
        if (ids.length === 0) return [];
        return db.machinePosition.findMany({
            where: { id: { in: ids.map((r) => r.id) }, tenantId: ctx.tenantId },
            select: {
                assetId: true,
                lat: true,
                lon: true,
                recordedAt: true,
                speedKph: true,
                ignition: true,
            },
            take: MACHINE_FLEET_CAP,
        });
    }

    /**
     * One machine's positions for one farm day, in recorded order.
     *
     * `take` is the ceiling PLUS ONE, so the caller can tell "exactly at the
     * cap" from "more than we read" — the `limit + 1` probe this repo uses for
     * `hasMore`. Reading the cap exactly and reporting `truncated: false`
     * would be a silent truncation.
     *
     * Ordered by `recordedAt` and NOT by arrival: a tracker buffers while out
     * of GSM coverage and replays, so insertion order draws the track in the
     * wrong sequence. `id` breaks the tie so the order is total — two positions
     * can share a device timestamp.
     */
    static async listDayPositions(
        db: PrismaTx,
        ctx: RequestContext,
        assetId: string,
        range: { start: Date; end: Date },
    ) {
        return db.machinePosition.findMany({
            where: {
                tenantId: ctx.tenantId,
                assetId,
                recordedAt: { gte: range.start, lt: range.end },
            },
            select: {
                lat: true,
                lon: true,
                recordedAt: true,
                speedKph: true,
                ignition: true,
            },
            orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
            take: MAX_POSITIONS_PER_DAY + 1,
        });
    }

    /**
     * One machine's worked parcels for one calendar day.
     *
     * `date` is `@db.Date`, so it is matched as an exact day rather than a
     * range — the row IS about a Europe/Sofia calendar day, stored as a date
     * precisely so a UTC boundary cannot split a night shift across two.
     */
    static async listWorkedParcels(
        db: PrismaTx,
        ctx: RequestContext,
        assetId: string,
        date: Date,
    ) {
        return db.workedParcel.findMany({
            where: { tenantId: ctx.tenantId, assetId, date },
            select: {
                parcelId: true,
                minutesWorked: true,
                areaHa: true,
                confidence: true,
                derivedAt: true,
                parcel: { select: { name: true } },
            },
            orderBy: [{ minutesWorked: 'desc' }, { parcelId: 'asc' }],
            take: WORKED_PARCEL_CAP,
        });
    }
}
