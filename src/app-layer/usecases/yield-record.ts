import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { canConvert, convert } from '@/lib/units/unit-conversion';
import { tonnesPerHectare } from '@/lib/grain/moisture';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { traceAgUsecase } from '@/lib/observability';
import { trace } from '@opentelemetry/api';
import { emitAutomationEvent } from '../automation';
import { ModuleSettingsRepository } from '../repositories/ModuleSettingsRepository';
import { resolveEnabledModules } from '@/lib/modules';
import type {
    CreateYieldRecordInput,
    UpdateYieldRecordInput,
} from '../schemas/grain.schemas';

/**
 * Yield records — actual harvest production totals (ENTERPRISE-grain, GRAIN
 * module). Gross tonnes realised against a Planting / field / Season with
 * the moisture basis + area for a t/ha derivation.
 *
 * Shape mirrors `crop-planning.ts`:
 *   - authorize via assertCanRead/Write BEFORE data access,
 *   - sanitize user free text (commodity / valuationNotes →
 *     sanitizePlainText) — valuationNotes is ALSO encrypted at rest by the
 *     Epic B manifest,
 *   - the NUMERIC magnitudes (grossTonnes / moisturePct / areaHa) stay
 *     PLAINTEXT Decimals so the yield rollups can SUM them,
 *   - emit a hash-chained audit event on EVERY mutation,
 *   - all DB access through runInTenantContext (RLS-bound) + bounded `take:`.
 */

const LIST_TAKE = 500;

/** Prisma Decimal | null → plain number | null. */
function dec(v: Prisma.Decimal | null | undefined): number | null {
    if (v == null) return null;
    return typeof v === 'number' ? v : Number(v.toString());
}

function parseDate(value: string | null | undefined, label: string): Date | null {
    if (value == null) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw badRequest(`${label} must be a valid date`);
    return d;
}

/**
 * Shape a YieldRecord row into a DTO.
 *
 * Two derived figures ride along:
 *
 *   `netTonnesStd` — grossTonnes expressed at the 14% standard moisture
 *     basis. Read from the database-generated column rather than computed
 *     here, so the number a reader sees is the same one the rollups SUM.
 *     Null when moisture was never measured: that record's comparable
 *     weight is unknown, and pretending otherwise is what made two
 *     harvests at different moistures look identical.
 *
 *   `tPerHa` — via the shared `tonnesPerHectare` helper, over the HARVESTED
 *     area. It is the moisture-adjusted tonnage where one exists, so two
 *     fields are ranked on one basis, and falls back to gross where
 *     moisture is unknown (with `tPerHaBasis` saying which was used, so a
 *     reader is never left guessing). The season recap and the year-end PDF
 *     call the SAME helper — that divergence (7.0 t/ha on screen, 4.2 in
 *     the PDF) came from two call sites picking different denominators.
 */
function toDto(row: {
    id: string;
    plantingId: string | null;
    locationId: string | null;
    seasonId: string | null;
    commodity: string | null;
    harvestedAt: Date | null;
    grossTonnes: Prisma.Decimal | null;
    moisturePct: Prisma.Decimal | null;
    areaHa: Prisma.Decimal | null;
    netTonnesStd?: Prisma.Decimal | null;
    valuationNotes: string | null;
    createdAt: Date;
    updatedAt: Date;
    planting?: { id: string; successionNumber: number } | null;
    location?: { id: string; name: string } | null;
    season?: { id: string; name: string } | null;
}) {
    const grossTonnes = dec(row.grossTonnes);
    const areaHa = dec(row.areaHa);
    const netTonnesStd = dec(row.netTonnesStd);
    // Adjusted where we have it, gross otherwise — and the DTO says which,
    // so a t/ha shown next to another t/ha is never silently on a different
    // basis. The zero-guard lives in the helper (area 0 → null, not 0 t/ha).
    const tPerHa = tonnesPerHectare(netTonnesStd ?? grossTonnes, areaHa);
    return {
        id: row.id,
        plantingId: row.plantingId,
        locationId: row.locationId,
        seasonId: row.seasonId,
        commodity: row.commodity,
        harvestedAt: row.harvestedAt,
        grossTonnes,
        moisturePct: dec(row.moisturePct),
        areaHa,
        netTonnesStd,
        tPerHa,
        /** Which tonnage `tPerHa` was computed from. */
        tPerHaBasis: (netTonnesStd != null ? 'standard-moisture' : 'gross') as
            | 'standard-moisture'
            | 'gross',
        valuationNotes: row.valuationNotes,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        planting: row.planting ?? null,
        location: row.location ?? null,
        season: row.season ?? null,
    };
}

const YIELD_INCLUDE = {
    planting: { select: { id: true, successionNumber: true } },
    location: { select: { id: true, name: true } },
    season: { select: { id: true, name: true } },
} satisfies Prisma.YieldRecordInclude;

export interface YieldRecordListFilters {
    seasonId?: string;
    locationId?: string;
    plantingId?: string;
}

export async function listYieldRecords(
    ctx: RequestContext,
    filters: YieldRecordListFilters = {},
    opts: { take?: number } = {},
) {
    assertCanRead(ctx);
    const rows = await runInTenantContext(ctx, (db) =>
        db.yieldRecord.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                ...(filters.seasonId ? { seasonId: filters.seasonId } : {}),
                ...(filters.locationId ? { locationId: filters.locationId } : {}),
                ...(filters.plantingId ? { plantingId: filters.plantingId } : {}),
            },
            orderBy: [{ harvestedAt: 'desc' }, { createdAt: 'desc' }],
            include: YIELD_INCLUDE,
            take: opts.take ?? LIST_TAKE,
        }),
    );
    return rows.map(toDto);
}

export async function getYieldRecord(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    const row = await runInTenantContext(ctx, async (db) => {
        const record = await db.yieldRecord.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: YIELD_INCLUDE,
        });
        if (!record) throw notFound('Yield record not found');
        return record;
    });
    return toDto(row);
}

export async function createYieldRecord(ctx: RequestContext, input: CreateYieldRecordInput) {
    return traceAgUsecase('yield-record.createYieldRecord', ctx, () => createYieldRecordImpl(ctx, input));
}

async function createYieldRecordImpl(ctx: RequestContext, input: CreateYieldRecordInput) {
    assertCanWrite(ctx);

    const commodity = input.commodity != null ? sanitizePlainText(input.commodity) : null;
    const valuationNotes = input.valuationNotes != null ? sanitizePlainText(input.valuationNotes) : null;
    if (input.grossTonnes != null && input.grossTonnes < 0) {
        throw badRequest('Gross tonnes must be zero or positive');
    }
    if (input.areaHa != null && input.areaHa < 0) {
        throw badRequest('Area must be zero or positive');
    }
    const harvestedAt = parseDate(input.harvestedAt, 'Harvested-at date');

    const row = await runInTenantContext(ctx, async (db) => {
        // Validate optional FKs belong to the tenant.
        if (input.plantingId) {
            const planting = await db.planting.findFirst({
                where: { id: input.plantingId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!planting) throw badRequest('Planting not found or belongs to a different tenant');
        }
        if (input.locationId) {
            const location = await db.location.findFirst({
                where: { id: input.locationId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!location) throw badRequest('Location not found or belongs to a different tenant');
        }
        if (input.seasonId) {
            const season = await db.season.findFirst({
                where: { id: input.seasonId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!season) throw badRequest('Season not found or belongs to a different tenant');
        }

        const record = await db.yieldRecord.create({
            data: {
                tenantId: ctx.tenantId,
                plantingId: input.plantingId ?? null,
                locationId: input.locationId ?? null,
                seasonId: input.seasonId ?? null,
                commodity,
                harvestedAt,
                grossTonnes: input.grossTonnes ?? null,
                moisturePct: input.moisturePct ?? null,
                areaHa: input.areaHa ?? null,
                valuationNotes,
            },
            include: YIELD_INCLUDE,
        });
        await logEvent(db, ctx, {
            action: 'HARVEST_YIELD_RECORDED',
            entityType: 'YieldRecord',
            entityId: record.id,
            details: `Recorded yield: ${commodity ?? 'harvest'} (${input.grossTonnes ?? 0} t)`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'YieldRecord',
                operation: 'created',
                after: { commodity, grossTonnes: input.grossTonnes ?? null, seasonId: input.seasonId ?? null },
                summary: `Recorded ${input.grossTonnes ?? 0} t of ${commodity ?? 'harvest'}`,
            },
        });
        return record;
    });
    trace.getActiveSpan()?.setAttributes({
        'ag.yieldRecordId': row.id,
        'ag.commodity': commodity ?? '',
        'ag.grossTonnes': input.grossTonnes ?? 0,
        'ag.areaHa': input.areaHa ?? 0,
        'ag.plantingId': input.plantingId ?? '',
    });

    // Field-workflow automation trigger (Epic 60 bus) — fires AFTER the
    // tx commits. Mirrors the HARVEST_YIELD_RECORDED audit action.
    await emitAutomationEvent(ctx, {
        event: 'HARVEST_YIELD_RECORDED',
        entityType: 'YieldRecord',
        entityId: row.id,
        actorUserId: ctx.userId,
        stableKey: row.id,
        data: {
            yieldRecordId: row.id,
            commodity,
            grossTonnes: input.grossTonnes ?? null,
            areaHa: input.areaHa ?? null,
            plantingId: input.plantingId ?? null,
            seasonId: input.seasonId ?? null,
        },
    });

    return toDto(row);
}

// ─── Journal-minted yield (harvest reconciliation) ──────────────────

/** A journal HARVEST entry's payload, as far as the yield side needs it. */
export interface HarvestYieldInput {
    /** The HARVEST LogEntry that produced the stock lot. */
    logEntryId: string;
    /** The harvested-produce Item the lot holds — names the commodity. */
    itemId: string;
    /** Harvested amount in the item's DEFAULT unit (which is the lot's unit). */
    quantity: number;
    /** Parcel harvested, when the entry named one — resolves the field. */
    parcelId?: string | null;
    /** Plantings this entry realises; the first is taken as the yield's. */
    plantingIds?: string[];
    /** The entry's occurrence date — the harvest date. */
    occurredAt: Date;
}

export interface HarvestYieldResult {
    yieldRecordId: string | null;
    grossTonnes: number | null;
    /** Commodity name taken from the harvested item. */
    commodity: string | null;
    /** Planting the yield realises, when the entry linked one. */
    plantingId: string | null;
    /** Season resolved through the planting's crop plan. */
    seasonId: string | null;
    /** Why nothing new was recorded. Absent on a fresh record. */
    note?: 'already_recorded' | 'zero_quantity' | 'item_not_found' | 'unit_not_mass' | 'grain_disabled';
}

/**
 * Record the PRODUCTION side of a journal harvest — a YieldRecord linked to
 * the entry that minted the stock lot, so one farmer action lands both the
 * yield figure and the stock.
 *
 * This is the chosen reconciliation direction, and the direction matters.
 * `recordHarvestLot` requires a `logEntryId` as its provenance anchor (it is
 * written onto StockTransaction.logEntryId and LotLink.logEntryId), so
 * driving it from the yield page would mean fabricating a HARVEST journal
 * entry the farmer never wrote, or widening the ledger's provenance model —
 * either way a SECOND writer of stock. Going journal → yield adds none: the
 * inventory ledger keeps exactly one writer, and this function only ever
 * INSERTs a YieldRecord.
 *
 * Runs INSIDE the caller's tenant transaction (`db`), so the yield row and
 * the stock lot commit together or not at all. Authorization is the
 * caller's (`journal.createLogEntry` has already asserted write) — mirrors
 * `recordHarvestLot`, which is likewise tx-bound and caller-authorized.
 *
 * Returns a `note` instead of throwing when it cannot record, because a
 * harvest whose produce is counted in crates rather than weighed must still
 * succeed as a journal entry + stock lot. The UI gates the option on the
 * same rule, so the note is a backstop, not the normal path.
 */
export async function recordYieldFromHarvest(
    db: PrismaTx,
    ctx: RequestContext,
    input: HarvestYieldInput,
): Promise<HarvestYieldResult> {
    const empty = { yieldRecordId: null, grossTonnes: null, commodity: null, plantingId: null, seasonId: null } as const;

    // GRAIN-module gated, the same shape recordHarvestLot uses for INVENTORY.
    // The UI gate (a server-resolved `grainEnabled` prop) is the one users
    // meet; this is the one an API client meets. Production figures belong to
    // the grain module, so a tenant without it never grows a YieldRecord.
    const modules = resolveEnabledModules(await ModuleSettingsRepository.get(db, ctx));
    if (!modules.includes('GRAIN')) {
        return { ...empty, note: 'grain_disabled' };
    }
    if (!(input.quantity > 0)) {
        return { ...empty, note: 'zero_quantity' };
    }

    // Idempotency — a replayed offline journal create must not double-count
    // production. The unique index on (logEntryId, tenantId) is the real
    // guarantee; this read turns the collision into a clean no-op.
    const existing = await db.yieldRecord.findFirst({
        where: { logEntryId: input.logEntryId, tenantId: ctx.tenantId },
        select: { id: true, grossTonnes: true },
    });
    if (existing) {
        return {
            ...empty,
            yieldRecordId: existing.id,
            grossTonnes: dec(existing.grossTonnes),
            note: 'already_recorded',
        };
    }

    const item = await db.item.findFirst({
        where: { id: input.itemId, tenantId: ctx.tenantId, deletedAt: null },
        select: { name: true, defaultUnit: { select: { key: true } } },
    });
    if (!item) {
        return { ...empty, note: 'item_not_found' };
    }

    // A yield record is measured in tonnes, so the harvest quantity has to
    // BE a mass. `canConvert` is dimensional: crates ('each') or a volume
    // ('l') are refused here rather than silently reinterpreted as tonnes.
    const unitKey = item.defaultUnit?.key ?? null;
    if (!unitKey || !canConvert(unitKey, 't')) {
        return { ...empty, note: 'unit_not_mass' };
    }
    // Decimal(14,3) — round at the column's precision so the stored value
    // and the value we report back are the same number.
    const grossTonnes = Math.round(convert(input.quantity, unitKey, 't') * 1e3) / 1e3;

    // Season comes from the planting's crop plan (CropPlan.seasonId is
    // required), which is what puts this production in the right bucket on
    // the per-season portfolio view. The field falls back to the planting's
    // parcel when the harvest payload named none.
    const plantingId = input.plantingIds?.[0] ?? null;
    let seasonId: string | null = null;
    let parcelId = input.parcelId ?? null;
    if (plantingId) {
        const planting = await db.planting.findFirst({
            where: { id: plantingId, tenantId: ctx.tenantId, deletedAt: null },
            select: { parcelId: true, cropPlan: { select: { seasonId: true } } },
        });
        if (planting) {
            seasonId = planting.cropPlan?.seasonId ?? null;
            parcelId = parcelId ?? planting.parcelId;
        }
    }

    // YieldRecord.locationId is the FIELD (a Location); the harvest payload
    // names a Parcel, which belongs to one.
    let locationId: string | null = null;
    if (parcelId) {
        const parcel = await db.parcel.findFirst({
            where: { id: parcelId, tenantId: ctx.tenantId, deletedAt: null },
            select: { locationId: true },
        });
        locationId = parcel?.locationId ?? null;
    }

    const commodity = sanitizePlainText(item.name);
    const record = await db.yieldRecord.create({
        data: {
            tenantId: ctx.tenantId,
            logEntryId: input.logEntryId,
            plantingId,
            locationId,
            seasonId,
            commodity,
            harvestedAt: input.occurredAt,
            grossTonnes,
            // areaHa stays NULL deliberately: a journal harvest does not say
            // how much area was cut. Defaulting to the parcel's total area
            // would silently assume a whole-field harvest and understate
            // t/ha on a partial one, so "unknown" is the honest value and
            // toDto already renders tPerHa as null for it.
            areaHa: null,
            // Likewise moisture — nothing in the journal measures it.
            moisturePct: null,
            valuationNotes: null,
        },
        select: { id: true },
    });

    await logEvent(db, ctx, {
        action: 'HARVEST_YIELD_RECORDED',
        entityType: 'YieldRecord',
        entityId: record.id,
        details: `Recorded yield from journal harvest: ${commodity} (${grossTonnes} t)`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'YieldRecord',
            operation: 'created',
            after: { commodity, grossTonnes, seasonId, logEntryId: input.logEntryId },
            summary: `Recorded ${grossTonnes} t of ${commodity} from a journal harvest`,
            source: 'journal_harvest',
        },
    });

    return { yieldRecordId: record.id, grossTonnes, commodity, plantingId, seasonId };
}

export async function updateYieldRecord(ctx: RequestContext, id: string, input: UpdateYieldRecordInput) {
    assertCanWrite(ctx);

    const data: Prisma.YieldRecordUncheckedUpdateInput = {};
    if (input.commodity !== undefined) {
        data.commodity = input.commodity != null ? sanitizePlainText(input.commodity) : null;
    }
    if (input.valuationNotes !== undefined) {
        data.valuationNotes = input.valuationNotes != null ? sanitizePlainText(input.valuationNotes) : null;
    }
    if (input.plantingId !== undefined) data.plantingId = input.plantingId;
    if (input.locationId !== undefined) data.locationId = input.locationId;
    if (input.seasonId !== undefined) data.seasonId = input.seasonId;
    if (input.harvestedAt !== undefined) data.harvestedAt = parseDate(input.harvestedAt, 'Harvested-at date');
    if (input.grossTonnes !== undefined) {
        if (input.grossTonnes != null && input.grossTonnes < 0) {
            throw badRequest('Gross tonnes must be zero or positive');
        }
        data.grossTonnes = input.grossTonnes;
    }
    if (input.moisturePct !== undefined) data.moisturePct = input.moisturePct;
    if (input.areaHa !== undefined) {
        if (input.areaHa != null && input.areaHa < 0) {
            throw badRequest('Area must be zero or positive');
        }
        data.areaHa = input.areaHa;
    }

    const row = await runInTenantContext(ctx, async (db) => {
        const existing = await db.yieldRecord.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!existing) throw notFound('Yield record not found');
        if (input.plantingId) {
            const planting = await db.planting.findFirst({
                where: { id: input.plantingId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!planting) throw badRequest('Planting not found or belongs to a different tenant');
        }
        if (input.locationId) {
            const location = await db.location.findFirst({
                where: { id: input.locationId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!location) throw badRequest('Location not found or belongs to a different tenant');
        }
        if (input.seasonId) {
            const season = await db.season.findFirst({
                where: { id: input.seasonId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!season) throw badRequest('Season not found or belongs to a different tenant');
        }

        const record = await db.yieldRecord.update({ where: { id }, data, include: YIELD_INCLUDE });
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'YieldRecord',
            entityId: id,
            details: 'Yield record updated',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'YieldRecord',
                operation: 'updated',
                changedFields: Object.keys(input).filter(
                    (k) => (input as Record<string, unknown>)[k] !== undefined,
                ),
                after: { commodity: record.commodity, grossTonnes: dec(record.grossTonnes) },
                summary: 'Yield record updated',
            },
        });
        return record;
    });
    return toDto(row);
}

export async function deleteYieldRecord(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.yieldRecord.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, commodity: true },
        });
        if (!existing) throw notFound('Yield record not found');

        await db.yieldRecord.update({
            where: { id },
            data: { deletedAt: new Date(), deletedByUserId: ctx.userId ?? null },
            select: { id: true },
        });
        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'YieldRecord',
            entityId: id,
            details: `Deleted yield record: ${existing.commodity ?? 'harvest'}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'YieldRecord',
                operation: 'deleted',
                before: { commodity: existing.commodity },
                summary: `Deleted yield record for ${existing.commodity ?? 'harvest'}`,
            },
        });
        return { id, deleted: true };
    });
}
