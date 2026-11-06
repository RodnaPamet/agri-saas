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
import { isUniqueViolation } from '@/lib/errors/prisma';
import { WorkItemRepository } from '../repositories/WorkItemRepository';
import { taskParcelIds } from './task';
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
    /**
     * Kilograms per decare, as a STRING, or null.
     *
     * A string for the reason `doseValue` is one: the column is
     * `Decimal(10,2)` and the wire carries the exact value, where a float
     * would round. See the schema comment for why this is NOT `YieldRecord`
     * and must never be summed into one.
     */
    yieldKgPerDca: string | null;
}

export interface ParcelHistoryOperation {
    id: string;
    taskId: string;
    operationType: string | null;
    title: string;
    completedAt: Date | null;
    productName: string;
    /**
     * `Item.category` — the HARD signal for what was applied.
     *
     * `operationType` cannot answer it: it is caller-settable, has four values
     * of which only two carry the product-versus-fertiliser derivation, and is
     * NULL on a third of the operation lines in production. The category comes
     * off the item itself, so it is right retroactively and cannot be
     * contradicted by what the operation was labelled.
     *
     * Null rather than `''` when the relation is missing, unlike its
     * `productName` neighbour: an empty string is a plausible NAME but not a
     * plausible CATEGORY, so collapsing it would invent a value rather than
     * report an absence.
     */
    productCategory: string | null;
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

/**
 * A yield in kg/дка must be non-negative and not absurd.
 *
 * `MAX_YIELD_KG_PER_DCA` is 100 000 — derived, not rounded. Field crops sit
 * around 300-1200 kg/дка and intensive greenhouse production reaches roughly
 * 50-100 kg/m², which is 50 000-100 000 kg/дка, so the ceiling admits the
 * highest real case and refuses a figure that can only be a typo or a unit
 * mistake (a total in kg entered where a rate belongs).
 *
 * NEGATIVE is refused rather than clamped: a negative yield is not a small
 * harvest, it is a mis-keyed one, and clamping to zero would record a crop
 * failure the farmer did not report.
 */
const MAX_YIELD_KG_PER_DCA = 100_000;

function assertYieldKgPerDca(value: number | null): void {
    if (value === null) return;
    if (!Number.isFinite(value) || value < 0 || value > MAX_YIELD_KG_PER_DCA) {
        throw codedBadRequest(
            'YIELD_OUT_OF_RANGE',
            'A yield must be between 0 and 100000 kg per decare.',
            { max: MAX_YIELD_KG_PER_DCA },
        );
    }
}

function assertYear(year: number): void {
    const max = new Date().getUTCFullYear() + YEARS_AHEAD;
    if (!Number.isInteger(year) || year < MIN_YEAR || year > max) {
        // `min`/`max` alongside the rejected `year`: the refusal used to say
        // "out of range" and name only what was sent, leaving a farmer to
        // guess at the range. The bound is computed, so it cannot be a
        // constant in the sentence (#1918).
        throw codedBadRequest('CROP_SEASON_YEAR_INVALID', `That harvest year is out of range — it must be between ${MIN_YEAR} and ${max}.`, {
            year,
            min: MIN_YEAR,
            max,
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
        throw codedBadRequest('WEED_ENTRIES_TOO_MANY', `Too many weeds in one observation — at most ${MAX_WEED_ENTRIES}.`, {
            count: entries.length,
            max: MAX_WEED_ENTRIES,
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
            throw codedBadRequest('WEED_NAME_TOO_LONG', `That weed name is too long — at most ${MAX_OTHER_WEED_LENGTH} characters.`, {
                max: MAX_OTHER_WEED_LENGTH,
            });
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
        throw codedBadRequest('NOTES_TOO_LONG', `Those notes are too long — at most ${MAX_NOTES_LENGTH} characters.`, {
            max: MAX_NOTES_LENGTH,
        });
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
                    yieldKgPerDca: true,
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
                    product: { select: { name: true, category: true } },
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
            // Mapped rather than passed through, which it was until
            // `yieldKgPerDca` arrived: every other field on this row is a
            // primitive, so the raw rows were already wire-shaped. A Decimal is
            // not — it would serialise as an object — so the seam is explicit
            // now, like the operation rows' `doseValue` below.
            cropSeasons: seasonsPage.map((r) => ({
                id: r.id,
                year: r.year,
                cropType: r.cropType,
                sownAt: r.sownAt,
                harvestedAt: r.harvestedAt,
                notes: r.notes,
                yieldKgPerDca: r.yieldKgPerDca?.toString() ?? null,
            })),
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
                productCategory: line.product?.category ?? null,
                // Decimal -> string at the usecase seam. The wire carries the
                // exact value; a float would round a dose.
                // `?? ''` like the product and unit fields above: a bare
                // activity line (#2316) has no dose, and the history row
                // renders it as absent rather than as a zero dose.
                doseValue: line.doseValue?.toString() ?? '',
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
    /** kg per decare — the farmer's own figure, NOT `YieldRecord`. */
    yieldKgPerDca?: number | null;
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
    assertYieldKgPerDca(input.yieldKgPerDca ?? null);

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
                yieldKgPerDca: input.yieldKgPerDca ?? null,
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

/**
 * Correct a crop season in place (owner ruling 2026-11-06).
 *
 * ## Partial, and `undefined` is not `null`
 *
 * A field OMITTED leaves the stored value alone; an explicit `null` clears a
 * nullable one. That distinction is the house convention across this API and
 * the phone sends only what changed, so collapsing the two would silently blank
 * every field a client did not mention.
 *
 * The non-nullable fields — `year`, `cropType` — therefore refuse an explicit
 * `null` rather than accepting it as "clear": there is no empty crop season, and
 * a nullable-looking type on a required column is how a required field quietly
 * becomes optional.
 *
 * ## `parcelId` is NOT updatable, and that is the point of the omission
 *
 * Moving a season to a different parcel is not a correction — it is two
 * operations (delete here, record there) with two audit entries, and this is an
 * agronomic record that feeds the БАБХ register. An edit that relocated one
 * would leave the receiving parcel with a season nobody recorded against it.
 *
 * ## The edit is AUDITED, not silent
 *
 * `logEvent` with the canonical `UPDATE` verb, which is right here because this
 * genuinely is a field update of the row and `changedFields` says what moved —
 * exactly the distinction `docs/app-layer.md` draws against a domain verb. The
 * owner chose a tracked correction over a silent one; without the entry, an
 * edited dose or date would leave no trace of what it said before.
 */
export async function updateParcelCropSeason(
    ctx: RequestContext,
    id: string,
    input: {
        year?: number;
        cropType?: string;
        sownAt?: Date | null;
        harvestedAt?: Date | null;
        notes?: string | null;
        yieldKgPerDca?: number | null;
    },
) {
    assertCanWrite(ctx);

    const data: Record<string, unknown> = {};
    const changed: string[] = [];

    if (input.year !== undefined) {
        assertYear(input.year);
        data.year = input.year;
        changed.push('year');
    }
    if (input.cropType !== undefined) {
        const cropType = sanitizePlainText(input.cropType).trim();
        if (!cropType || cropType.length > MAX_CROP_TYPE_LENGTH) {
            throw codedBadRequest('CROP_TYPE_INVALID', 'A crop is required.');
        }
        data.cropType = cropType;
        changed.push('cropType');
    }
    if (input.sownAt !== undefined) {
        data.sownAt = input.sownAt;
        changed.push('sownAt');
    }
    if (input.harvestedAt !== undefined) {
        data.harvestedAt = input.harvestedAt;
        changed.push('harvestedAt');
    }
    if (input.notes !== undefined) {
        data.notes = cleanNotes(input.notes);
        changed.push('notes');
    }
    if (input.yieldKgPerDca !== undefined) {
        assertYieldKgPerDca(input.yieldKgPerDca);
        data.yieldKgPerDca = input.yieldKgPerDca;
        changed.push('yieldKgPerDca');
    }

    // Refused rather than treated as a no-op. A request that changes nothing is
    // a client bug, and answering 200 to it would hide the bug AND write an
    // audit entry claiming an edit that did not happen.
    if (changed.length === 0) {
        throw codedBadRequest('NO_FIELDS_TO_UPDATE', 'No fields to update.');
    }

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.parcelCropSeason.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, parcelId: true, year: true, cropType: true },
        });
        if (!existing) throw codedNotFound('CROP_SEASON_NOT_FOUND', 'That crop season was not found.');

        const row = await db.parcelCropSeason.update({ where: { id }, data });
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ParcelCropSeason',
            entityId: id,
            details: `Crop season corrected on parcel ${existing.parcelId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ParcelCropSeason',
                operation: 'updated',
                // INSIDE detailsJson, not at the top level — `changedFields` is
                // not on `AuditEventPayload` and tsc caught me inventing it
                // there. `contract.ts:500` is the canonical shape.
                changedFields: changed,
                // BEFORE and AFTER for the two identifying fields only. The
                // notes are free text on an encrypted-adjacent surface and
                // `details` is dropped by the audit stream anyway — the point
                // of the pair is that a reader can tell WHICH season this was
                // and what it became, not to mirror the row.
                before: { year: existing.year, cropType: existing.cropType },
                after: { year: row.year, cropType: row.cropType },
                summary: 'Parcel crop season corrected',
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

/**
 * Who may record a weed observation against a TASK's parcel.
 *
 * The third instance of the assignee self-serve rule, after `setTaskStatus`
 * ("a restricted MECHANISATOR … must be able to complete their own farm
 * tasks") and `markOperationParcel`. Owner decision 2026-10-08: a mechanisator
 * closing their own task records what weeds they met, and without this they
 * got a 403 from `assertCanWrite` on the only write the closing form makes.
 *
 * Two gates, and the second applies to EVERYONE:
 *
 *   1. general task write, OR being the task's assignee;
 *   2. the parcel must be among the task's parcels.
 *
 * (2) is the SCOPE for an assignee — it is what stops "assigned to one task"
 * becoming "may write to any parcel" — and for a privileged caller it is a
 * correctness check that the post was not mis-addressed. Either way, posting a
 * parcel that is not on the task is a client error rather than a permission
 * one, which is why it is a coded 400 and not a 403.
 *
 * The parcel set comes from `taskParcelIds`, the same function behind
 * `GET /tasks/{taskId}/parcels`, so the parcels an assignee can SEE are
 * exactly the ones they can POST against.
 */
async function assertMayObserveForTask(
    db: PrismaTx,
    ctx: RequestContext,
    taskId: string,
    parcelId: string,
): Promise<void> {
    const task = await WorkItemRepository.findBareById(db, ctx, taskId);
    if (!task) throw codedNotFound('TASK_NOT_FOUND', 'Task not found');

    const isAssignee = !!ctx.userId && task.assigneeUserId === ctx.userId;
    if (!ctx.permissions.canWrite && !isAssignee) {
        assertCanWrite(ctx); // throws the canonical 403 for a non-assignee
    }

    const allowed = await taskParcelIds(db, ctx, taskId);
    if (!allowed.includes(parcelId)) {
        throw codedBadRequest(
            'PARCEL_NOT_ON_TASK',
            'That parcel is not on this task.',
        );
    }
}

/**
 * Record which weeds were identified in a parcel on a date.
 *
 * `scope.taskId` switches the authorization from "general write" to the
 * task-scoped self-serve rule above. It is a PARAMETER rather than a body
 * field because the route carries it in the path: an optional field that
 * GRANTS authorization when present makes omitting it the safe default rather
 * than the enforced one.
 */
export async function createParcelWeedObservation(
    ctx: RequestContext,
    input: WeedObservationInput,
    scope?: { taskId: string },
    idempotencyKey?: string | null,
) {
    // Unscoped keeps its cheap pre-flight check. The scoped branch cannot:
    // deciding it requires reading the task, so it happens inside the
    // transaction below — where the task row and the parcel set are read
    // under the same tenant binding as the write they authorise.
    if (!scope) assertCanWrite(ctx);
    const { weedKeys, otherWeeds } = partitionWeeds(input.weeds ?? []);
    if (weedKeys.length === 0 && otherWeeds.length === 0) {
        throw codedBadRequest('WEEDS_REQUIRED', 'Record at least one weed.');
    }
    const notes = cleanNotes(input.notes);

    try {
        return await runInTenantContext(ctx, async (db) => {
            if (scope) await assertMayObserveForTask(db, ctx, scope.taskId, input.parcelId);
            await requireParcel(db, ctx, input.parcelId);

            // The replay read sits AFTER both gates, and that placement is the
            // whole of its security. An earlier draft of this checked the key
            // before entering the transaction, which was fine while the only
            // caller was the parcel route — `assertCanWrite` had already run.
            // The task-scoped route made it wrong: its authorisation needs a
            // database read, so it lives in here, and a pre-check outside
            // would have let ANY authenticated tenant member hand over a key
            // and receive the row it names. A UUID is impractical to guess,
            // but impracticality is not an authorisation check.
            if (idempotencyKey) {
                const existing = await db.parcelWeedObservation.findFirst({
                    where: {
                        tenantId: ctx.tenantId,
                        parcelId: input.parcelId,
                        clientMutationId: idempotencyKey,
                        deletedAt: null,
                    },
                });
                // Returns before `logEvent`, which is the point: a deduped row
                // alone would still have written a second audit entry.
                if (existing) return existing;
            }

            const row = await db.parcelWeedObservation.create({
                data: {
                    tenantId: ctx.tenantId,
                    parcelId: input.parcelId,
                    observedAt: input.observedAt,
                    weedKeys,
                    otherWeeds,
                    notes,
                    createdByUserId: ctx.userId,
                    clientMutationId: idempotencyKey || null,
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
                    after: {
                        parcelId: input.parcelId,
                        weedCount: weedKeys.length + otherWeeds.length,
                    },
                    summary: 'Parcel weed observation',
                },
            });
            return row;
        });
    } catch (err) {
        // Race backstop: two replays reach the unique
        // (tenantId, clientMutationId) index together. The loser's INSERT
        // fails, so the transaction above is ALREADY rolled back by the time
        // this runs — which is why the re-read opens a FRESH tenant context.
        // A caught JS error does not un-poison an aborted Postgres
        // transaction; catching outside it is what makes the recovery legal.
        //
        // Re-reading without re-running the gates is safe HERE and only here:
        // both of them evaluated true inside the transaction that just failed,
        // microseconds ago, in this same request.
        if (idempotencyKey && isUniqueViolation(err)) {
            const winner = await runInTenantContext(ctx, (db) =>
                db.parcelWeedObservation.findFirst({
                    where: {
                        tenantId: ctx.tenantId,
                        parcelId: input.parcelId,
                        clientMutationId: idempotencyKey,
                        deletedAt: null,
                    },
                }),
            );
            if (winner) return winner;
        }
        throw err;
    }
}

/** Soft-delete a weed observation. */
/**
 * Correct a weed observation in place (owner ruling 2026-11-06).
 *
 * Same partial-update contract as `updateParcelCropSeason`: omitted leaves a
 * value alone, explicit `null` clears a nullable one, and the non-nullable
 * fields refuse `null`.
 *
 * ## `weeds` replaces the list WHOLE, and cannot empty it
 *
 * The client sends one list and the server partitions it into catalogue keys
 * and free text, exactly as on create — so an update carrying `weeds` replaces
 * both stored columns together. They are two halves of one field and updating
 * one without the other would leave a row whose `weedKeys` and `otherWeeds`
 * came from different submissions.
 *
 * An empty list is refused with the same `WEEDS_REQUIRED` as create. The
 * remedy for "this observation should not exist" is DELETE, which keeps a
 * soft-delete tombstone; emptying it in place would leave an observation
 * asserting that somebody looked at a parcel and found nothing, which is a
 * different agronomic claim.
 *
 * ## `clientMutationId` is untouched
 *
 * It is the create path's idempotency key, scoped unique per (tenant, parcel).
 * An update must not rewrite it: the key identifies the SUBMISSION that made
 * the row, not the row's current contents, and clearing or reusing it would
 * make a later replay of the original create return this edited row.
 */
export async function updateParcelWeedObservation(
    ctx: RequestContext,
    id: string,
    input: { observedAt?: Date; weeds?: string[]; notes?: string | null },
) {
    assertCanWrite(ctx);

    const data: Record<string, unknown> = {};
    const changed: string[] = [];

    if (input.observedAt !== undefined) {
        data.observedAt = input.observedAt;
        changed.push('observedAt');
    }
    if (input.weeds !== undefined) {
        const { weedKeys, otherWeeds } = partitionWeeds(input.weeds);
        if (weedKeys.length === 0 && otherWeeds.length === 0) {
            throw codedBadRequest('WEEDS_REQUIRED', 'Record at least one weed.');
        }
        data.weedKeys = weedKeys;
        data.otherWeeds = otherWeeds;
        changed.push('weeds');
    }
    if (input.notes !== undefined) {
        data.notes = cleanNotes(input.notes);
        changed.push('notes');
    }

    if (changed.length === 0) {
        throw codedBadRequest('NO_FIELDS_TO_UPDATE', 'No fields to update.');
    }

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.parcelWeedObservation.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, parcelId: true, observedAt: true },
        });
        if (!existing) {
            throw codedNotFound('WEED_OBSERVATION_NOT_FOUND', 'That observation was not found.');
        }

        const row = await db.parcelWeedObservation.update({ where: { id }, data });
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ParcelWeedObservation',
            entityId: id,
            details: `Weed observation corrected on parcel ${existing.parcelId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ParcelWeedObservation',
                operation: 'updated',
                changedFields: changed,
                // The DATE is the identifying fact for an observation, so the
                // before/after pair carries it. The weed list itself is not
                // mirrored here: it is the content, and `changedFields` already
                // says it moved.
                before: { observedAt: existing.observedAt.toISOString() },
                after: { observedAt: row.observedAt.toISOString() },
                summary: 'Parcel weed observation corrected',
            },
        });
        return row;
    });
}

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
