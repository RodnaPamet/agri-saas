import { Prisma, LocationKind } from '@prisma/client';
import { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    EMPTY_BIN_TOTALS,
    fillFractionFor,
    summariseStoredByBin,
    type BinStoredTotals,
    type UnconvertibleStock,
} from '@/lib/grain/bin-fill';
import type { CreateBinInput, UpdateBinInput } from '../schemas/grain.schemas';

/**
 * Grain bins — physical grain storage. A bin is a `Location` row whose
 * `kind` is BIN or STORAGE (a FIELD is a growing area, never a bin) and
 * which carries a `capacityTonnes`. `InventoryLot.locationId` ties stored
 * grain lots to the bin.
 *
 * Shape mirrors `crop-planning.ts` / the other grain usecases:
 *   - authorize via assertCanRead/Write BEFORE data access,
 *   - sanitize user free text (name / description / key → sanitizePlainText),
 *   - emit a hash-chained audit event on EVERY mutation (entityType
 *     'Location', the grain-bin role recorded in the summary),
 *   - all DB access through runInTenantContext (RLS-bound) + bounded `take:`.
 *
 * Fill computation avoids N+1: list the bins, then ONE
 * `inventoryLot.groupBy({ by: ['locationId','unitId'] })` aggregate covering
 * every bin, reduced in memory by `@/lib/grain/bin-fill`. Grouping (rather
 * than fetching rows) is what makes the per-lot UNIT available for conversion
 * to tonnes, and what removes the farm-wide row cap that used to truncate
 * arbitrary bins' stock.
 */

const LIST_TAKE = 500;

const BIN_KINDS = ['BIN', 'STORAGE'] as const;

function dec(v: Prisma.Decimal | null | undefined): number | null {
    if (v == null) return null;
    return typeof v === 'number' ? v : Number(v.toString());
}

export interface BinDto {
    id: string;
    name: string;
    key: string | null;
    kind: 'BIN' | 'STORAGE';
    description: string | null;
    capacityTonnes: number | null;
    /**
     * Stored produce CONVERTED TO TONNES (the unit `capacityTonnes` is in),
     * so this is directly comparable to the capacity. Excludes stock in
     * non-weight units — see `unconvertible`.
     */
    storedTonnes: number;
    /** Number of stored produce lots in the bin, including unconvertible ones. */
    lotCount: number;
    /** storedTonnes / capacityTonnes; null without a capacity or when mixedUnits. */
    fillPct: number | null;
    /**
     * True when the bin holds produce that cannot be expressed in tonnes
     * (a COUNT/VOLUME unit), which makes any fill percentage a partial
     * truth. Forces `fillPct` to null.
     */
    mixedUnits: boolean;
    /** Per-unit breakdown of that unconvertible stock; empty when clean. */
    unconvertible: UnconvertibleStock[];
}

/**
 * ONE grouped aggregate covering EVERY requested bin.
 *
 * Grouping by `(locationId, unitId)` does two jobs. It carries each lot's
 * unit, so quantities can be converted to tonnes before summing — a bin
 * holding kg-denominated grain used to report 1000× its true fill. And it
 * bounds the result by `bins × units` instead of by lot count, which is what
 * the previous `take: 500` on a single farm-wide `findMany` silently
 * truncated (with no `orderBy`, so differently on each call).
 *
 * Still N+1-free: one aggregate for the whole list, plus one lookup of the
 * handful of `Unit` rows involved (`Unit` is a small global table, no RLS).
 */
async function storedTotalsForBins(
    db: PrismaTx,
    ctx: RequestContext,
    binIds: string[],
): Promise<Map<string, BinStoredTotals>> {
    if (binIds.length === 0) return new Map();

    const groups = await db.inventoryLot.groupBy({
        by: ['locationId', 'unitId'],
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            locationId: { in: binIds },
            item: { is: { category: 'HARVESTED_PRODUCE' } },
        },
        _sum: { quantityOnHand: true },
        _count: { _all: true },
    });
    if (groups.length === 0) return new Map();

    const unitIds = [...new Set(groups.map((g) => g.unitId))];
    const units = await db.unit.findMany({
        where: { id: { in: unitIds } },
        select: { id: true, key: true, symbol: true },
    });

    return summariseStoredByBin(
        groups.map((g) => ({
            locationId: g.locationId,
            unitId: g.unitId,
            quantity: dec(g._sum.quantityOnHand) ?? 0,
            lotCount: g._count._all,
        })),
        units,
    );
}

/**
 * List the tenant's grain bins (BIN/STORAGE Locations) with a computed fill.
 *
 * `storedTonnes` is the bin's HARVESTED_PRODUCE stock converted into tonnes,
 * so it is comparable to `capacityTonnes`; `fillPct` is the fraction of
 * capacity used. Stock in a unit with no tonnage (COUNT/VOLUME) is reported
 * via `unconvertible` and suppresses `fillPct` rather than being folded in at
 * face value. See `src/lib/grain/bin-fill.ts` for the rule and its rationale.
 */
export async function listBins(ctx: RequestContext, opts: { take?: number } = {}): Promise<BinDto[]> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bins = await db.location.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                kind: { in: [...BIN_KINDS] as LocationKind[] },
            },
            orderBy: [{ name: 'asc' }],
            select: { id: true, name: true, key: true, kind: true, description: true, capacityTonnes: true },
            take: opts.take ?? LIST_TAKE,
        });
        if (bins.length === 0) return [];

        const storedByBin = await storedTotalsForBins(db, ctx, bins.map((b) => b.id));

        return bins.map((bin): BinDto => {
            const totals = storedByBin.get(bin.id) ?? EMPTY_BIN_TOTALS;
            const capacity = dec(bin.capacityTonnes);
            return {
                id: bin.id,
                name: bin.name,
                key: bin.key,
                kind: bin.kind as 'BIN' | 'STORAGE',
                description: bin.description,
                capacityTonnes: capacity,
                storedTonnes: totals.storedTonnes,
                lotCount: totals.lotCount,
                fillPct: fillFractionFor(totals.storedTonnes, capacity, totals.mixedUnits),
                mixedUnits: totals.mixedUnits,
                unconvertible: totals.unconvertible,
            };
        });
    });
}

export async function getBin(ctx: RequestContext, id: string): Promise<BinDto> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bin = await db.location.findFirst({
            where: {
                id,
                tenantId: ctx.tenantId,
                deletedAt: null,
                kind: { in: [...BIN_KINDS] as LocationKind[] },
            },
            select: { id: true, name: true, key: true, kind: true, description: true, capacityTonnes: true },
        });
        if (!bin) throw notFound('Grain bin not found');

        // Same grouped aggregate as the list path — no per-bin row cap, so a
        // bin holding more than LIST_TAKE lots no longer under-reports.
        const totals = (await storedTotalsForBins(db, ctx, [bin.id])).get(bin.id)
            ?? EMPTY_BIN_TOTALS;
        const capacity = dec(bin.capacityTonnes);
        return {
            id: bin.id,
            name: bin.name,
            key: bin.key,
            kind: bin.kind as 'BIN' | 'STORAGE',
            description: bin.description,
            capacityTonnes: capacity,
            storedTonnes: totals.storedTonnes,
            lotCount: totals.lotCount,
            fillPct: fillFractionFor(totals.storedTonnes, capacity, totals.mixedUnits),
            mixedUnits: totals.mixedUnits,
            unconvertible: totals.unconvertible,
        };
    });
}

export async function createBin(ctx: RequestContext, input: CreateBinInput) {
    assertCanWrite(ctx);
    const name = sanitizePlainText(input.name ?? '');
    if (!name) throw badRequest('Bin name is required');
    const key = input.key != null ? sanitizePlainText(input.key) : null;
    const description = input.description != null ? sanitizePlainText(input.description) : null;
    if (input.capacityTonnes != null && input.capacityTonnes < 0) {
        throw badRequest('Bin capacity must be zero or positive');
    }
    const kind = input.kind ?? 'BIN';

    return runInTenantContext(ctx, async (db) => {
        const bin = await db.location.create({
            data: {
                tenantId: ctx.tenantId,
                name,
                key,
                description,
                kind,
                capacityTonnes: input.capacityTonnes ?? null,
                createdByUserId: ctx.userId ?? null,
            },
            select: { id: true, name: true, kind: true, capacityTonnes: true },
        });
        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Location',
            entityId: bin.id,
            details: `Created grain bin: ${name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Location',
                operation: 'created',
                after: { name, kind: bin.kind, capacityTonnes: input.capacityTonnes ?? null },
                summary: `Created grain ${kind.toLowerCase()} bin ${name}`,
            },
        });
        return { id: bin.id, name: bin.name, kind: bin.kind, capacityTonnes: dec(bin.capacityTonnes) };
    });
}

export async function updateBin(ctx: RequestContext, id: string, input: UpdateBinInput) {
    assertCanWrite(ctx);
    const data: Prisma.LocationUncheckedUpdateInput = {};
    if (input.name !== undefined) {
        const name = sanitizePlainText(input.name);
        if (!name) throw badRequest('Bin name is required');
        data.name = name;
    }
    if (input.key !== undefined) data.key = input.key != null ? sanitizePlainText(input.key) : null;
    if (input.description !== undefined) {
        data.description = input.description != null ? sanitizePlainText(input.description) : null;
    }
    if (input.kind !== undefined) data.kind = input.kind;
    if (input.capacityTonnes !== undefined) {
        if (input.capacityTonnes != null && input.capacityTonnes < 0) {
            throw badRequest('Bin capacity must be zero or positive');
        }
        data.capacityTonnes = input.capacityTonnes;
    }

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.location.findFirst({
            where: {
                id,
                tenantId: ctx.tenantId,
                deletedAt: null,
                kind: { in: [...BIN_KINDS] as LocationKind[] },
            },
            select: { id: true },
        });
        if (!existing) throw notFound('Grain bin not found');

        const bin = await db.location.update({
            where: { id },
            data,
            select: { id: true, name: true, kind: true, capacityTonnes: true },
        });
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Location',
            entityId: id,
            details: 'Grain bin updated',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Location',
                operation: 'updated',
                changedFields: Object.keys(input).filter(
                    (k) => (input as Record<string, unknown>)[k] !== undefined,
                ),
                after: { name: bin.name, kind: bin.kind, capacityTonnes: dec(bin.capacityTonnes) },
                summary: `Updated grain bin ${bin.name}`,
            },
        });
        return { id: bin.id, name: bin.name, kind: bin.kind, capacityTonnes: dec(bin.capacityTonnes) };
    });
}
