/**
 * A parcel's history — what was sown, what was applied, what grew that nobody
 * planted.
 *
 * ## Why this exists
 *
 * `Parcel.cropType` is a single string, overwritten whenever the crop changes.
 * Last year's crop is destroyed the moment this year's is set, and no year is
 * attached to it, so the farm had no record of what any parcel grew before
 * today. That is the gap `ParcelCropSeason` fills, and it is the only part of
 * this history that is NOT derivable from data already held.
 *
 * ## Three sources, one timeline
 *
 * - **Crop seasons** — authored, back-fillable. New storage.
 * - **Completed field operations** — already recorded. `OperationParcel`
 *   carries the parcel, the product, the dose and `completedAt`, so "linked
 *   completed tasks" and "what fertiliser/treatment was applied" are the same
 *   rows read two ways, not two features. Only DONE lines appear: a PENDING
 *   operation is a plan, and a plan is not history.
 * - **Weed observations** — authored. New storage.
 *
 * Read-only assembly: nothing here writes, so the timeline can never disagree
 * with the operations register it reads from.
 */
import type { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import {
    encodeCursor, decodeCursor, keysetBefore,
    encodeNumericCursor, decodeNumericCursor, keysetBeforeNumeric,
} from '@/lib/exchange/cursor';
import { codedBadRequest, codedNotFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { WEED_VALUES } from '@/lib/agriculture/weed-options';

/** Widest year a record may carry. Back-filling decades is the point. */
const MIN_YEAR = 1900;
/** Two ahead: an autumn-sown crop is recorded for the FOLLOWING harvest year. */
const YEARS_AHEAD = 2;
const MAX_CROP_TYPE_LENGTH = 80;
/**
 * One page of each list. 100 matches the exchange reads; a parcel's history is
 * read on a screen, not exported, so a bigger page buys nothing a cursor does
 * not already give.
 */
const DEFAULT_PAGE_SIZE = 100;

const MAX_NOTES_LENGTH = 2000;
const MAX_OTHER_WEED_LENGTH = 120;
/** A cap, not a target — it exists so one request cannot store an essay. */
const MAX_WEED_ENTRIES = 50;

export interface ParcelHistoryCropSeason {
    id: string;
    year: number;
    cropType: string;
    sownAt: Date | null;
    harvestedAt: Date | null;
    notes: string | null;
}

export interface ParcelHistoryOperation {
    id: string;
    taskId: string;
    operationType: string | null;
    title: string;
    completedAt: Date | null;
    productName: string;
    doseValue: string;
    doseUnit: string;
    targetNote: string | null;
}

export interface ParcelHistoryWeedObservation {
    id: string;
    observedAt: Date;
    /** Catalogue binomials — validated against `WEED_VALUES` on write. */
    weedKeys: string[];
    /** Free text, for a species the catalogue does not carry. */
    otherWeeds: string[];
    notes: string | null;
}

export interface ParcelHistory {
    parcel: { id: string; name: string; cropType: string | null };
    cropSeasons: ParcelHistoryCropSeason[];
    operations: ParcelHistoryOperation[];
    weedObservations: ParcelHistoryWeedObservation[];
    /**
     * Opaque position of the next OLDER page, PER LIST, or null at the start of
     * that list. Three cursors because the screen is three sections with three
     * different sort keys, not one merged stream.
     */
    cropSeasonsCursor: string | null;
    operationsCursor: string | null;
    weedObservationsCursor: string | null;
}

/**
 * Resolve a parcel inside the tenant, or refuse.
 *
 * Every write below funnels through this rather than trusting the id: the
 * parcel FK is composite on `[parcelId, tenantId]`, so a cross-tenant id could
 * not be stored anyway — but it would fail as a database error rather than a
 * 404, which tells the caller the row exists.
 */
async function requireParcel(db: PrismaTx, ctx: RequestContext, parcelId: string) {
    const parcel = await db.parcel.findFirst({
        where: { id: parcelId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, name: true, cropType: true },
    });
    if (!parcel) throw codedNotFound('PARCEL_NOT_FOUND', 'Parcel not found.');
    return parcel;
}

function assertYear(year: number): void {
    const max = new Date().getUTCFullYear() + YEARS_AHEAD;
    if (!Number.isInteger(year) || year < MIN_YEAR || year > max) {
        throw codedBadRequest('CROP_SEASON_YEAR_INVALID', 'That harvest year is out of range.', {
            year,
        });
    }
}

/**
 * Split submitted weeds into the controlled half and the free-text half.
 *
 * Callers send one list; the storage keeps two. Doing the split HERE rather
 * than trusting the client is what guarantees `weedKeys` only ever holds
 * catalogue values — which is the property that makes it reportable. A client
 * that mislabels a free-text entry as a key cannot corrupt the column.
 */
function partitionWeeds(entries: string[]): { weedKeys: string[]; otherWeeds: string[] } {
    if (entries.length > MAX_WEED_ENTRIES) {
        throw codedBadRequest('WEED_ENTRIES_TOO_MANY', 'Too many weeds in one observation.', {
            count: entries.length,
        });
    }
    const weedKeys: string[] = [];
    const otherWeeds: string[] = [];
    for (const raw of entries) {
        const value = sanitizePlainText(raw).trim();
        if (!value) continue;
        if (WEED_VALUES.has(value)) {
            if (!weedKeys.includes(value)) weedKeys.push(value);
            continue;
        }
        if (value.length > MAX_OTHER_WEED_LENGTH) {
            throw codedBadRequest('WEED_NAME_TOO_LONG', 'That weed name is too long.');
        }
        if (!otherWeeds.includes(value)) otherWeeds.push(value);
    }
    return { weedKeys, otherWeeds };
}

function cleanNotes(notes: string | null | undefined): string | null {
    if (notes == null) return null;
    const value = sanitizePlainText(notes).trim();
    if (!value) return null;
    if (value.length > MAX_NOTES_LENGTH) {
        throw codedBadRequest('NOTES_TOO_LONG', 'Those notes are too long.');
    }
    return value;
}

/** The whole timeline for one parcel. */
export async function getParcelHistory(
    ctx: RequestContext,
    parcelId: string,
    options: {
        limit?: number;
        seasonsBefore?: string | null;
        operationsBefore?: string | null;
        weedsBefore?: string | null;
    } = {},
): Promise<ParcelHistory> {
    assertCanRead(ctx);
    // THREE cursors, not one. The screen is three sections with three different
    // sort keys (harvest year, completion date, observation date), not a single
    // merged stream — so there is no one position to page from, and pretending
    // otherwise would mean merging three orders server-side to serve a client
    // that immediately splits them again.
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), DEFAULT_PAGE_SIZE);
    const seasonsCur = decodeNumericCursor(options.seasonsBefore);
    const operationsCur = decodeCursor(options.operationsBefore);
    const weedsCur = decodeCursor(options.weedsBefore);

    return runInTenantContext(ctx, async (db) => {
        const parcel = await requireParcel(db, ctx, parcelId);

        const [cropSeasons, operationLines, weedObservations] = await Promise.all([
            db.parcelCropSeason.findMany({
                where: {
                    tenantId: ctx.tenantId, parcelId, deletedAt: null,
                    ...(seasonsCur ? keysetBeforeNumeric(seasonsCur, 'year') : {}),
                },
                // Newest harvest first, `id` breaking the tie. The tiebreak was
                // `createdAt` before pagination existed, which was fine as a
                // stable display order but cannot be a cursor key: two seasons
                // created in the same millisecond would straddle a page
                // boundary. `id` is unique, so the order is total.
                orderBy: [{ year: 'desc' }, { id: 'desc' }],
                take: limit + 1,
                select: {
                    id: true, year: true, cropType: true,
                    sownAt: true, harvestedAt: true, notes: true,
                },
            }),
            db.operationParcel.findMany({
                // DONE only: a PENDING line is a plan, not history.
                where: {
                    tenantId: ctx.tenantId, parcelId, status: 'DONE',
                    ...(operationsCur ? keysetBefore(operationsCur, 'completedAt') : {}),
                },
                orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
                take: limit + 1,
                select: {
                    id: true,
                    taskId: true,
                    completedAt: true,
                    doseValue: true,
                    targetNote: true,
                    product: { select: { name: true } },
                    doseUnit: { select: { symbol: true } },
                    task: { select: { operationType: true, title: true } },
                },
            }),
            db.parcelWeedObservation.findMany({
                where: {
                    tenantId: ctx.tenantId, parcelId, deletedAt: null,
                    ...(weedsCur ? keysetBefore(weedsCur, 'observedAt') : {}),
                },
                orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
                take: limit + 1,
                select: {
                    id: true, observedAt: true,
                    weedKeys: true, otherWeeds: true, notes: true,
                },
            }),
        ]);

        // Trim the over-fetched row and derive each cursor from the OLDEST row
        // of its own page. Done per list because each has its own key.
        const seasonsMore = cropSeasons.length > limit;
        const seasonsPage = seasonsMore ? cropSeasons.slice(0, limit) : cropSeasons;
        const opsMore = operationLines.length > limit;
        const opsPage = opsMore ? operationLines.slice(0, limit) : operationLines;
        const weedsMore = weedObservations.length > limit;
        const weedsPage = weedsMore ? weedObservations.slice(0, limit) : weedObservations;

        const lastSeason = seasonsPage.at(-1);
        const lastOp = opsPage.at(-1);
        const lastWeed = weedsPage.at(-1);

        return {
            parcel,
            cropSeasons: seasonsPage,
            cropSeasonsCursor:
                seasonsMore && lastSeason
                    ? encodeNumericCursor({ n: lastSeason.year, id: lastSeason.id })
                    : null,
            // `completedAt` is nullable on the column but NOT for a DONE line —
            // the write path sets it for any non-PENDING status, and the query
            // above filters to DONE. Guarded rather than asserted with `!`: if
            // that invariant ever breaks, the page simply reports no more rows
            // instead of encoding a cursor on `null` and paginating into
            // nothing.
            operationsCursor:
                opsMore && lastOp?.completedAt
                    ? encodeCursor({ at: lastOp.completedAt, id: lastOp.id })
                    : null,
            weedObservationsCursor:
                weedsMore && lastWeed
                    ? encodeCursor({ at: lastWeed.observedAt, id: lastWeed.id })
                    : null,
            operations: opsPage.map((line) => ({
                id: line.id,
                taskId: line.taskId,
                operationType: line.task?.operationType ?? null,
                title: line.task?.title ?? '',
                completedAt: line.completedAt,
                productName: line.product?.name ?? '',
                // Decimal -> string at the usecase seam. The wire carries the
                // exact value; a float would round a dose.
                doseValue: line.doseValue.toString(),
                doseUnit: line.doseUnit?.symbol ?? '',
                targetNote: line.targetNote,
            })),
            weedObservations: weedsPage,
        };
    });
}

export interface CropSeasonInput {
    parcelId: string;
    year: number;
    cropType: string;
    sownAt?: Date | null;
    harvestedAt?: Date | null;
    notes?: string | null;
}

/** Record what a parcel grew in a given harvest year. */
export async function createParcelCropSeason(ctx: RequestContext, input: CropSeasonInput) {
    assertCanWrite(ctx);
    assertYear(input.year);
    const cropType = sanitizePlainText(input.cropType).trim();
    if (!cropType || cropType.length > MAX_CROP_TYPE_LENGTH) {
        throw codedBadRequest('CROP_TYPE_INVALID', 'A crop is required.');
    }
    const notes = cleanNotes(input.notes);

    return runInTenantContext(ctx, async (db) => {
        await requireParcel(db, ctx, input.parcelId);
        const row = await db.parcelCropSeason.create({
            data: {
                tenantId: ctx.tenantId,
                parcelId: input.parcelId,
                year: input.year,
                cropType,
                sownAt: input.sownAt ?? null,
                harvestedAt: input.harvestedAt ?? null,
                notes,
                createdByUserId: ctx.userId,
            },
        });
        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'ParcelCropSeason',
            entityId: row.id,
            details: `Crop season recorded for parcel ${input.parcelId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ParcelCropSeason',
                operation: 'created',
                after: { parcelId: input.parcelId, year: input.year },
                summary: 'Parcel crop season',
            },
        });
        return row;
    });
}

/** Soft-delete a crop season. */
export async function deleteParcelCropSeason(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.parcelCropSeason.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, parcelId: true },
        });
        if (!existing) throw codedNotFound('CROP_SEASON_NOT_FOUND', 'That crop season was not found.');
        await db.parcelCropSeason.update({
            where: { id },
            data: { deletedAt: new Date(), deletedByUserId: ctx.userId },
        });
        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'ParcelCropSeason',
            entityId: id,
            details: `Crop season removed from parcel ${existing.parcelId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ParcelCropSeason',
                operation: 'deleted',
                after: { parcelId: existing.parcelId },
                summary: 'Parcel crop season',
            },
        });
        return { id };
    });
}

export interface WeedObservationInput {
    parcelId: string;
    observedAt: Date;
    /** One list from the client; stored as catalogue keys + free text. */
    weeds: string[];
    notes?: string | null;
}

/** Record which weeds were identified in a parcel on a date. */
export async function createParcelWeedObservation(ctx: RequestContext, input: WeedObservationInput) {
    assertCanWrite(ctx);
    const { weedKeys, otherWeeds } = partitionWeeds(input.weeds ?? []);
    if (weedKeys.length === 0 && otherWeeds.length === 0) {
        throw codedBadRequest('WEEDS_REQUIRED', 'Record at least one weed.');
    }
    const notes = cleanNotes(input.notes);

    return runInTenantContext(ctx, async (db) => {
        await requireParcel(db, ctx, input.parcelId);
        const row = await db.parcelWeedObservation.create({
            data: {
                tenantId: ctx.tenantId,
                parcelId: input.parcelId,
                observedAt: input.observedAt,
                weedKeys,
                otherWeeds,
                notes,
                createdByUserId: ctx.userId,
            },
        });
        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'ParcelWeedObservation',
            entityId: row.id,
            details: `Weed observation recorded for parcel ${input.parcelId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ParcelWeedObservation',
                operation: 'created',
                after: { parcelId: input.parcelId, weedCount: weedKeys.length + otherWeeds.length },
                summary: 'Parcel weed observation',
            },
        });
        return row;
    });
}

/** Soft-delete a weed observation. */
export async function deleteParcelWeedObservation(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.parcelWeedObservation.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, parcelId: true },
        });
        if (!existing) throw codedNotFound('WEED_OBSERVATION_NOT_FOUND', 'That observation was not found.');
        await db.parcelWeedObservation.update({
            where: { id },
            data: { deletedAt: new Date(), deletedByUserId: ctx.userId },
        });
        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'ParcelWeedObservation',
            entityId: id,
            details: `Weed observation removed from parcel ${existing.parcelId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ParcelWeedObservation',
                operation: 'deleted',
                after: { parcelId: existing.parcelId },
                summary: 'Parcel weed observation',
            },
        });
        return { id };
    });
}
