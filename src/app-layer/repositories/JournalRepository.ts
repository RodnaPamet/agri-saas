import { Prisma, LogEntryType, LogEntryStatus } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { AssetRepository } from './AssetRepository';

export interface LogQuantityInput {
    measure:
        | 'COUNT'
        | 'WEIGHT'
        | 'VOLUME'
        | 'AREA'
        | 'LENGTH'
        | 'RATE'
        | 'OTHER';
    value: number;
    unitId: string;
    label?: string | null;
}

export interface CreateLogEntryInput {
    type:
        | 'ACTIVITY'
        | 'OBSERVATION'
        | 'INPUT_APPLICATION'
        | 'SEEDING'
        | 'TRANSPLANTING'
        | 'HARVEST'
        | 'IRRIGATION'
        | 'MAINTENANCE'
        | 'LAB_TEST'
        | 'GRAZING';
    title: string;
    occurredAt?: Date;
    status?: 'PLANNED' | 'DONE';
    notes?: string | null;
    conditionsJson?: Prisma.InputJsonValue;
    operationParcelId?: string | null;
    costAmount?: number | null;
    costCurrency?: string | null;
    quantities?: LogQuantityInput[];
    /** Feature-1 Location ids the entry happened at. */
    locationIds?: string[];
    /** Equipment ids used in the entry. */
    equipmentIds?: string[];
    /**
     * Crop-planning plan-vs-actual links — the planting + lifecycle
     * stage this entry realises. Mirrors `locationIds` → LogLocation:
     * each becomes a LogPlanting row, so a sow/transplant/harvest
     * journal entry records the ACTUAL date against the planned
     * Planting.
     */
    plantingLinks?: { plantingId: string; stage: 'SOW' | 'TRANSPLANT' | 'HARVEST' }[];
    /** Offline exactly-once handle (outbox-item id). See LogEntry.clientMutationId. */
    clientMutationId?: string | null;
}

export interface UpdateLogEntryInput {
    type?: CreateLogEntryInput['type'];
    title?: string;
    occurredAt?: Date;
    status?: 'PLANNED' | 'DONE';
    notes?: string | null;
    operationParcelId?: string | null;
    costAmount?: number | null;
    costCurrency?: string | null;
    /** When provided, fully REPLACES the existing quantity set. */
    quantities?: LogQuantityInput[];
    /** When provided, fully REPLACES the existing location links. */
    locationIds?: string[];
    /** When provided, fully REPLACES the existing equipment links. */
    equipmentIds?: string[];
}

export interface LogEntryFilters {
    // ARRAYS — multiple:true facets, parsed at the route.
    type?: LogEntryType[];
    status?: LogEntryStatus[];
    q?: string;
    /** ISO date — entries with occurredAt >= this. */
    occurredFrom?: string;
    /** ISO date — entries with occurredAt <= this. */
    occurredTo?: string;
    /** Filter to entries whose operation line is on a parcel of this crop (#10). */
    crop?: string[];
    /** Filter to entries logged against this location (#10). */
    locationId?: string;
    /**
     * Filter to entries linked (via LogPlanting) to a planting of this crop
     * plan — scopes the plan-detail Journal tab to just this plan's actuals.
     */
    cropPlanId?: string;
}

export interface LogEntryListParams {
    limit?: number;
    cursor?: string;
    filters?: LogEntryFilters;
}

/**
 * Shared include shape for a fully-hydrated journal entry (sans
 * `files` — that link is added per-query in `getById` with an explicit
 * tenant filter, since FileRecord has no [id, tenantId] barrier).
 */
const ENTRY_DETAIL_INCLUDE = {
    quantities: { include: { unit: { select: { id: true, symbol: true, name: true } } } },
    locations: { include: { location: { select: { id: true, name: true } } } },
    // `LogEquipment.asset` since the Equipment merge. Projected as the
    // old equipment shape (`category`) so the detail page renders unchanged.
    equipment: { include: { asset: { select: { id: true, name: true, type: true } } } },
} satisfies Prisma.LogEntryInclude;

/**
 * List include shape (dnevnik #10). Beyond the first-location label + counts,
 * it hydrates the linked `OperationParcel` prescription line so the on-screen
 * journal can render the regulated Bulgarian field-logbook columns — parcel +
 * culture, product + active ingredient, dose, treated area, PHI (карантинен
 * срок), and the БАБХ operation type — sourced from the SAME data the ДНЕВНИК
 * PDF (`farm-record-diary.ts`) prints. Free-hand entries with no operation
 * line simply leave those columns blank. `notes` + `conditionsJson` come back
 * as plain LogEntry scalars (this is an `include`, not a `select`).
 */
const ENTRY_LIST_INCLUDE = {
    locations: { include: { location: { select: { id: true, name: true } } } },
    operationParcel: {
        select: {
            doseValue: true,
            parcel: { select: { name: true, cropType: true, areaHa: true } },
            product: { select: { name: true, activeIngredient: true, quarantinePeriodDays: true } },
            doseUnit: { select: { symbol: true } },
            task: { select: { operationType: true, applicationTechnique: true } },
        },
    },
    _count: { select: { quantities: true, files: true } },
} satisfies Prisma.LogEntryInclude;

/**
 * Journal repository — LogEntry + its LogQuantity / LogLocation /
 * LogEquipment / LogEntryFile rows, tenant-scoped.
 *
 * LogEntry is NOT registered with the Prisma soft-delete middleware
 * (`SOFT_DELETE_MODELS` in `src/lib/soft-delete.ts`), so this
 * repository handles the soft-delete trio EXPLICITLY: reads filter
 * `deletedAt: null`, `delete` stamps `deletedAt` instead of removing
 * the row, and `purge` is the only hard-delete path.
 */
export class JournalRepository {
    // ─── Reads ───────────────────────────────────────────────────────

    static async list(db: PrismaTx, ctx: RequestContext, filters?: LogEntryFilters) {
        const where = JournalRepository._buildWhere(ctx, filters);
        return db.logEntry.findMany({
            where,
            orderBy: { occurredAt: 'desc' },
            include: ENTRY_LIST_INCLUDE,
            take: 200,
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: LogEntryListParams): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where = JournalRepository._buildWhere(ctx, params.filters);

        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            if (where.AND) {
                (where.AND as Prisma.LogEntryWhereInput[]).push(cursorWhere as Prisma.LogEntryWhereInput);
            } else {
                where.AND = [cursorWhere as Prisma.LogEntryWhereInput];
            }
        }

        const items = await db.logEntry.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            include: ENTRY_LIST_INCLUDE,
        });

        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    /**
     * Soft-deleted entries only — the Trash view. Deliberately a separate
     * method rather than an `includeDeleted` flag on `_buildWhere`, so the
     * live-list invariant (`deletedAt: null`) stays unconditional and can't be
     * switched off by a stray filter object.
     */
    static async listDeleted(db: PrismaTx, ctx: RequestContext) {
        return db.logEntry.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: { not: null } },
            include: ENTRY_LIST_INCLUDE,
            orderBy: { deletedAt: 'desc' },
            take: 200,
        });
    }

    private static _buildWhere(ctx: RequestContext, filters?: LogEntryFilters): Prisma.LogEntryWhereInput {
        const where: Prisma.LogEntryWhereInput = { tenantId: ctx.tenantId, deletedAt: null };

        // Guarded on `.length`: a CLEARED facet must OMIT the filter —
        // `{ in: [] }` matches nothing and would blank the table.
        if (filters?.type?.length) where.type = { in: filters.type };
        if (filters?.status?.length) where.status = { in: filters.status };
        if (filters?.occurredFrom || filters?.occurredTo) {
            where.occurredAt = {
                ...(filters.occurredFrom ? { gte: new Date(filters.occurredFrom) } : {}),
                ...(filters.occurredTo ? { lte: new Date(filters.occurredTo) } : {}),
            };
        }
        if (filters?.q) {
            where.OR = [
                { title: { contains: filters.q, mode: 'insensitive' } },
                { notes: { contains: filters.q, mode: 'insensitive' } },
            ];
        }
        // Culture (crop) — matches entries whose operation line sits on a
        // parcel of that crop. Free-hand entries (no operation line) don't
        // match, which is the intended agronomic-only scope. Accepts a
        // comma-separated multi-select.
        // crop used to split the comma-joined param HERE; parsing now
        // happens at the route like every other facet, so the repository
        // only ever sees a validated array.
        if (filters?.crop?.length) {
            where.operationParcel = { is: { parcel: { is: { cropType: { in: filters.crop } } } } };
        }
        // Location — entries logged against a location (LogLocation join).
        if (filters?.locationId) {
            where.locations = { some: { locationId: filters.locationId } };
        }
        // Crop plan — entries linked (LogPlanting) to a planting of this plan.
        // LogEntry → plantings (LogPlanting[]) → planting (Planting).cropPlanId.
        if (filters?.cropPlanId) {
            where.plantings = { some: { planting: { is: { cropPlanId: filters.cropPlanId } } } };
        }

        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.logEntry.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: {
                ...ENTRY_DETAIL_INCLUDE,
                files: {
                    where: { tenantId: ctx.tenantId },
                    include: { fileRecord: true },
                    orderBy: { createdAt: 'asc' },
                },
            },
        });
    }

    /** Find including soft-deleted rows — for restore / purge. */
    static async getByIdWithDeleted(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.logEntry.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { id: true, tenantId: true, deletedAt: true, title: true },
        });
    }

    // ─── Validation helpers ──────────────────────────────────────────

    /** Returns the subset of the given location ids that belong to the tenant. */
    static async validLocationIds(db: PrismaTx, ctx: RequestContext, ids: string[]): Promise<Set<string>> {
        if (!ids.length) return new Set();
        // Bounded by the caller's id set (Create/UpdateLogEntry Zod caps
        // locationIds at 100) — `take` makes the bound explicit so the
        // unbounded-findMany guardrail stays satisfied.
        const rows = await db.location.findMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            select: { id: true },
            take: ids.length,
        });
        return new Set(rows.map((r) => r.id));
    }

    /**
     * Returns the subset of the given equipment ids that belong to the
     * tenant. Since the `Equipment` merge these are `Asset` ids, and the
     * check also enforces machine-SHAPED — a caller cannot attach a barn
     * or a retired tractor to a journal entry.
     */
    static async validEquipmentIds(db: PrismaTx, ctx: RequestContext, ids: string[]): Promise<Set<string>> {
        return AssetRepository.validMachineIds(db, ctx, ids);
    }

    /** Returns the subset of the given parcel ids that belong to the tenant. */
    static async validParcelIds(db: PrismaTx, ctx: RequestContext, ids: string[]): Promise<Set<string>> {
        if (!ids.length) return new Set();
        // Bounded by the caller's id set (farm-task Zod caps parcelIds at 100).
        const rows = await db.parcel.findMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
            take: ids.length,
        });
        return new Set(rows.map((r) => r.id));
    }

    /**
     * List the tenant's active machines (newest first) for pickers.
     * Delegates to the asset register since the `Equipment` merge — kept
     * here so existing journal call sites don't all have to move.
     */
    static async listEquipment(db: PrismaTx, ctx: RequestContext, take = 200) {
        return AssetRepository.listMachines(db, ctx, take);
    }

    // ─── Mutations ───────────────────────────────────────────────────

    static async createLogEntry(db: PrismaTx, ctx: RequestContext, input: CreateLogEntryInput) {
        return db.logEntry.create({
            data: {
                tenantId: ctx.tenantId,
                type: input.type,
                status: input.status ?? 'DONE',
                occurredAt: input.occurredAt ?? new Date(),
                title: input.title,
                notes: input.notes ?? null,
                ...(input.conditionsJson !== undefined ? { conditionsJson: input.conditionsJson } : {}),
                operationParcelId: input.operationParcelId ?? null,
                ...(input.costAmount != null ? { costAmount: input.costAmount } : {}),
                costCurrency: input.costCurrency ?? null,
                clientMutationId: input.clientMutationId ?? null,
                createdByUserId: ctx.userId ?? null,
                ...(input.quantities && input.quantities.length
                    ? {
                          quantities: {
                              // tenantId is populated by Prisma from the parent
                              // via the composite [logEntryId, tenantId] relation
                              // FK — passing it explicitly is rejected.
                              create: input.quantities.map((q) => ({
                                  measure: q.measure,
                                  value: q.value,
                                  unitId: q.unitId,
                                  label: q.label ?? null,
                              })),
                          },
                      }
                    : {}),
                ...(input.locationIds && input.locationIds.length
                    ? {
                          locations: {
                              create: input.locationIds.map((locationId) => ({
                                  tenantId: ctx.tenantId,
                                  locationId,
                              })),
                          },
                      }
                    : {}),
                ...(input.equipmentIds && input.equipmentIds.length
                    ? {
                          equipment: {
                              create: input.equipmentIds.map((assetId) => ({
                                  tenantId: ctx.tenantId,
                                  assetId,
                              })),
                          },
                      }
                    : {}),
                ...(input.plantingLinks && input.plantingLinks.length
                    ? {
                          plantings: {
                              // tenantId is populated by Prisma from the parent
                              // LogEntry via the composite [logEntryId, tenantId]
                              // relation FK — and because LogPlanting.planting
                              // ALSO keys on tenantId, passing it explicitly is
                              // rejected ("Unknown argument tenantId"). Provide
                              // only plantingId + stage; tenantId flows from the
                              // parent (mirrors the `quantities` nested create).
                              create: input.plantingLinks.map((p) => ({
                                  plantingId: p.plantingId,
                                  stage: p.stage,
                              })),
                          },
                      }
                    : {}),
            },
            include: {
                quantities: true,
                locations: true,
                equipment: true,
            },
        });
    }

    /**
     * Offline exactly-once — fetch the entry a replayed request already minted
     * (same outbox id → same idempotency key), in the SAME shape `createLogEntry`
     * returns, so a re-send yields the original 201 body and no duplicate row.
     */
    static async findByClientMutationId(db: PrismaTx, ctx: RequestContext, clientMutationId: string) {
        return db.logEntry.findFirst({
            where: { tenantId: ctx.tenantId, clientMutationId },
            include: {
                quantities: true,
                locations: true,
                equipment: true,
            },
        });
    }

    static async updateLogEntry(db: PrismaTx, ctx: RequestContext, id: string, input: UpdateLogEntryInput) {
        // Scalar fields. `undefined` leaves a field untouched; explicit
        // null clears the nullable columns.
        const data: Prisma.LogEntryUncheckedUpdateInput = {};
        if (input.type !== undefined) data.type = input.type;
        if (input.title !== undefined) data.title = input.title;
        if (input.occurredAt !== undefined) data.occurredAt = input.occurredAt;
        if (input.status !== undefined) data.status = input.status;
        if (input.notes !== undefined) data.notes = input.notes;
        if (input.operationParcelId !== undefined) data.operationParcelId = input.operationParcelId;
        if (input.costAmount !== undefined) data.costAmount = input.costAmount;
        if (input.costCurrency !== undefined) data.costCurrency = input.costCurrency;

        // Child-collection replaces — only when the caller supplied the
        // array. `deleteMany` then `create` gives full-replace semantics
        // in one transaction (the wrapping usecase runs inside one tx).
        if (input.quantities !== undefined) {
            data.quantities = {
                deleteMany: {},
                create: input.quantities.map((q) => ({
                    measure: q.measure,
                    value: q.value,
                    unitId: q.unitId,
                    label: q.label ?? null,
                })),
            };
        }
        if (input.locationIds !== undefined) {
            data.locations = {
                deleteMany: {},
                create: input.locationIds.map((locationId) => ({
                    tenantId: ctx.tenantId,
                    locationId,
                })),
            };
        }
        if (input.equipmentIds !== undefined) {
            data.equipment = {
                deleteMany: {},
                create: input.equipmentIds.map((assetId) => ({
                    tenantId: ctx.tenantId,
                    assetId,
                })),
            };
        }

        return db.logEntry.update({
            where: { id },
            data,
            include: {
                quantities: true,
                locations: true,
                equipment: true,
            },
        });
    }

    /** Soft-delete: stamp deletedAt + deletedByUserId. */
    static async softDelete(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.logEntry.update({
            where: { id },
            data: { deletedAt: new Date(), deletedByUserId: ctx.userId ?? null },
        });
    }

    /** Restore a soft-deleted entry. */
    static async restore(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.logEntry.update({
            where: { id },
            data: { deletedAt: null, deletedByUserId: null },
        });
    }

    /** Hard delete — cascades to LogQuantity / LogLocation / LogEquipment / LogEntryFile. */
    static async purge(db: PrismaTx, ctx: RequestContext, id: string) {
        await db.logEntry.delete({ where: { id } });
        return true;
    }

    // ─── File links (photo logging) ──────────────────────────────────

    static async attachFile(
        db: PrismaTx,
        ctx: RequestContext,
        logEntryId: string,
        fileRecordId: string,
        caption?: string | null,
    ) {
        return db.logEntryFile.create({
            data: {
                tenantId: ctx.tenantId,
                logEntryId,
                fileRecordId,
                caption: caption ?? null,
            },
            include: { fileRecord: true },
        });
    }

    static async getFileLink(db: PrismaTx, ctx: RequestContext, logEntryId: string, fileRecordId: string) {
        return db.logEntryFile.findFirst({
            where: { logEntryId, fileRecordId, tenantId: ctx.tenantId },
            select: { id: true },
        });
    }

    /**
     * Full link row (with its FileRecord) for a (logEntry, fileRecord) pair —
     * used by the idempotent-upload path to return the ORIGINAL link when a
     * replayed photo re-attaches identical bytes, instead of a duplicate.
     */
    static async findFileLink(db: PrismaTx, ctx: RequestContext, logEntryId: string, fileRecordId: string) {
        return db.logEntryFile.findFirst({
            where: { logEntryId, fileRecordId, tenantId: ctx.tenantId },
            include: { fileRecord: true },
        });
    }

    static async detachFile(db: PrismaTx, ctx: RequestContext, logEntryId: string, fileRecordId: string) {
        await db.logEntryFile.deleteMany({
            where: { logEntryId, fileRecordId, tenantId: ctx.tenantId },
        });
        return true;
    }
}
