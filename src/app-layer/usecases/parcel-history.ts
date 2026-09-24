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
import { codedBadRequest, codedNotFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { WEED_VALUES } from '@/lib/agriculture/weed-options';

/** Widest year a record may carry. Back-filling decades is the point. */
const MIN_YEAR = 1900;
/** Two ahead: an autumn-sown crop is recorded for the FOLLOWING harvest year. */
const YEARS_AHEAD = 2;
const MAX_CROP_TYPE_LENGTH = 80;
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
export async function getParcelHistory(ctx: RequestContext, parcelId: string): Promise<ParcelHistory> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const parcel = await requireParcel(db, ctx, parcelId);

        const [cropSeasons, operationLines, weedObservations] = await Promise.all([
            db.parcelCropSeason.findMany({
                where: { tenantId: ctx.tenantId, parcelId, deletedAt: null },
                // Newest harvest first; `createdAt` breaks the tie so a second
                // crop in the same year has a stable position rather than one
                // the query plan decides.
                orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
                select: {
                    id: true, year: true, cropType: true,
                    sownAt: true, harvestedAt: true, notes: true,
                },
            }),
            db.operationParcel.findMany({
                // DONE only: a PENDING line is a plan, not history.
                where: { tenantId: ctx.tenantId, parcelId, status: 'DONE' },
                orderBy: [{ completedAt: 'desc' }],
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
                where: { tenantId: ctx.tenantId, parcelId, deletedAt: null },
                orderBy: [{ observedAt: 'desc' }],
                select: {
                    id: true, observedAt: true,
                    weedKeys: true, otherWeeds: true, notes: true,
                },
            }),
        ]);

        return {
            parcel,
            cropSeasons,
            operations: operationLines.map((line) => ({
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
            weedObservations,
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
