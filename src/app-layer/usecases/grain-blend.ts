import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { InventoryRepository } from '../repositories/InventoryRepository';
import { appendStockTransaction, appendLotLink } from '@/lib/inventory/stock-ledger';
import { canConvert, convert } from '@/lib/units/unit-conversion';
import { BIN_CAPACITY_UNIT_KEY } from '@/lib/grain/bin-fill';
import type { BlendLotsInput } from '../schemas/grain.schemas';

/**
 * Locations blended grain may be receipted into. A FIELD is a growing area,
 * so grain "stored" there is on-hand stock that no bin view can see.
 */
// See LocationKind: FIELD | BIN | STORAGE. (BARN/WAREHOUSE were listed here
// once; they are not enum members and could never match.)
const BLEND_OUTPUT_KINDS = ['BIN', 'STORAGE'] as const;

/**
 * Grain blending — consume N source lots into ONE blended output lot
 * (ENTERPRISE-grain, GRAIN module). The blended quality attributes
 * (moisture / testWeight / protein) are the QUANTITY-WEIGHTED AVERAGE of
 * the source lots' numeric `attributesJson`, with any provided overrides
 * winning.
 *
 * The stock effect goes through the LEDGER SEAM only — `appendStockTransaction`
 * (CONSUMPTION per source + a RECEIPT for the output) and `appendLotLink`
 * (one MERGE edge per source → output). A direct `stockTransaction` /
 * `lotLink` write is banned by `no-direct-stock-writes.test.ts`. The whole
 * flow runs inside ONE `runInTenantContext` transaction so the consume →
 * produce → genealogy is atomic.
 */

const QUALITY_KEYS = ['moisture', 'testWeight', 'protein'] as const;
type QualityKey = (typeof QUALITY_KEYS)[number];

/**
 * Quantity-weighted average of the source lots' numeric quality
 * attributes. PURE — given each lot's quantity + its `attributesJson`,
 * returns `{ moisture, testWeight, protein }` weighted by quantity
 * (keys absent from every source are omitted). Overrides replace the
 * computed value for that key.
 */
export function blendQuality(
    sources: Array<{ quantity: number; attributes: Record<string, unknown> | null | undefined }>,
    overrides?: Record<string, number>,
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of QUALITY_KEYS) {
        let weightedSum = 0;
        let weight = 0;
        for (const src of sources) {
            const raw = src.attributes?.[key];
            const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
            if (Number.isFinite(value) && src.quantity > 0) {
                weightedSum += value * src.quantity;
                weight += src.quantity;
            }
        }
        if (weight > 0) {
            out[key] = Math.round((weightedSum / weight) * 1e4) / 1e4;
        }
    }
    // Provided overrides win (for every key, not just the QUALITY_KEYS).
    if (overrides) {
        for (const [k, v] of Object.entries(overrides)) {
            if (Number.isFinite(v)) out[k] = v;
        }
    }
    return out;
}

export interface BlendLotsResult {
    outputLotId: string;
    outputLotCode: string;
    blendedQuantity: number;
    sourceCount: number;
    mergeLinks: number;
    attributes: Record<string, number>;
}

export async function blendLots(ctx: RequestContext, input: BlendLotsInput): Promise<BlendLotsResult> {
    assertCanWrite(ctx);

    if (!input.sourceLots.length) throw badRequest('At least one source lot is required');
    for (const s of input.sourceLots) {
        if (!(s.quantity > 0)) throw badRequest('Each blend quantity must be positive');
    }
    // A lot may not appear twice in one blend (the MERGE edge is per-pair).
    const ids = input.sourceLots.map((s) => s.lotId);
    if (new Set(ids).size !== ids.length) throw badRequest('A source lot may not be listed more than once');

    const overrides: Record<string, number> | undefined = input.qualityAttributes;

    return runInTenantContext(ctx, async (db) => {
        // Validate the output item belongs to the tenant.
        const outputItem = await InventoryRepository.getItem(db, ctx, input.outputItemId);
        if (!outputItem) throw badRequest('Output item not found or belongs to a different tenant');

        // Validate the output location belongs to the tenant AND can actually
        // hold stock. Without the kind check, blended grain could be receipted
        // into a FIELD — still counted as stock on hand, but invisible to every
        // bin view. `capacityTonnes` is captured for the room check below.
        let outputBin: { id: string; name: string; kind: string; capacityTonnes: unknown } | null = null;
        if (input.outputLocationId) {
            const loc = await db.location.findFirst({
                where: { id: input.outputLocationId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true, name: true, kind: true, capacityTonnes: true },
            });
            if (!loc) throw badRequest('Output location not found or belongs to a different tenant');
            if (!BLEND_OUTPUT_KINDS.includes(loc.kind as (typeof BLEND_OUTPUT_KINDS)[number])) {
                throw badRequest('Blended grain must be stored in a bin or storage location');
            }
            outputBin = loc;
        }

        // ── ONE query for every source lot ──
        const sourceLots = await db.inventoryLot.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, id: { in: ids } },
            select: { id: true, unitId: true, quantityOnHand: true, attributesJson: true, lotCode: true },
            take: ids.length,
        });
        const byId = new Map(sourceLots.map((l) => [l.id, l]));

        // Validate each requested lot: exists, same unit, sufficient on-hand.
        const unitIds = new Set<string>();
        let totalQuantity = 0;
        const blendInputs: Array<{ quantity: number; attributes: Record<string, unknown> | null }> = [];
        for (const s of input.sourceLots) {
            const lot = byId.get(s.lotId);
            if (!lot) throw notFound(`Source lot not found: ${s.lotId}`);
            const onHand = Number((lot.quantityOnHand as unknown as { toString(): string }).toString());
            if (onHand < s.quantity) {
                throw badRequest(`Insufficient quantity in lot ${lot.lotCode}: have ${onHand}, need ${s.quantity}`);
            }
            unitIds.add(lot.unitId);
            totalQuantity += s.quantity;
            blendInputs.push({
                quantity: s.quantity,
                attributes: (lot.attributesJson as Record<string, unknown> | null) ?? null,
            });
        }
        if (unitIds.size > 1) {
            throw badRequest('All source lots must share the same unit to blend');
        }
        const unitId = [...unitIds][0];
        // The output lot inherits the shared source unit (mixed-unit lots
        // are forbidden — same invariant the harvest path relies on).
        if (unitId !== outputItem.defaultUnitId) {
            // Lot unit is fixed at creation from the item default; for a blend
            // we use the SOURCE unit so the quantities reconcile. Reject when
            // the output item's default unit disagrees, to keep the ledger
            // single-unit per lot.
            throw badRequest('Output item default unit must match the source lots\' unit');
        }
        totalQuantity = Math.round(totalQuantity * 1e4) / 1e4;

        // Does the destination have room? Capacity is denominated in tonnes,
        // the blend is in the source lots' unit, so this only applies when the
        // unit converts to tonnes (a COUNT unit has no tonnage to compare).
        // Checked BEFORE any ledger write so a rejected blend leaves nothing
        // behind.
        if (outputBin && outputBin.capacityTonnes != null) {
            const unitRow = await db.unit.findFirst({
                where: { id: unitId },
                select: { key: true },
            });
            if (unitRow && canConvert(unitRow.key, BIN_CAPACITY_UNIT_KEY)) {
                const capacityTonnes = Number(
                    (outputBin.capacityTonnes as { toString(): string }).toString(),
                );
                if (capacityTonnes > 0) {
                    const incomingTonnes = convert(totalQuantity, unitRow.key, BIN_CAPACITY_UNIT_KEY);
                    // Existing contents of the destination, in tonnes.
                    const storedAgg = await db.inventoryLot.groupBy({
                        by: ['unitId'],
                        where: {
                            tenantId: ctx.tenantId,
                            deletedAt: null,
                            locationId: outputBin.id,
                        },
                        _sum: { quantityOnHand: true },
                    });
                    const storedUnits = await db.unit.findMany({
                        where: { id: { in: storedAgg.map((g) => g.unitId) } },
                        select: { id: true, key: true },
                    });
                    const keyById = new Map(storedUnits.map((u) => [u.id, u.key]));
                    let storedTonnes = 0;
                    for (const g of storedAgg) {
                        const key = keyById.get(g.unitId);
                        if (!key || !canConvert(key, BIN_CAPACITY_UNIT_KEY)) continue;
                        const qty = Number(
                            ((g._sum.quantityOnHand ?? 0) as unknown as { toString(): string }).toString(),
                        );
                        storedTonnes += convert(qty, key, BIN_CAPACITY_UNIT_KEY);
                    }
                    if (storedTonnes + incomingTonnes > capacityTonnes) {
                        throw badRequest(
                            `Blended output does not fit in ${outputBin.name}: capacity ${capacityTonnes} t, already holds ${
                                Math.round(storedTonnes * 1e3) / 1e3
                            } t, blend adds ${Math.round(incomingTonnes * 1e3) / 1e3} t`,
                        );
                    }
                }
            }
        }

        const attributes = blendQuality(blendInputs, overrides);

        // 1 — consume each source lot (negative delta).
        //
        // `disallowNegative` is load-bearing, not belt-and-braces. The
        // sufficiency check above reads `quantityOnHand` BEFORE the ledger
        // takes its per-tenant advisory lock, and the transaction runs under
        // READ COMMITTED — so two concurrent blends of the same lot both pass
        // that check and both consume, driving stock negative. The ledger's
        // guard re-reads the balance INSIDE the lock, making the read and the
        // insert one race-free step. The check above stays because it gives a
        // useful per-lot error message before any write happens.
        for (const s of input.sourceLots) {
            await appendStockTransaction(db, ctx, {
                lotId: s.lotId,
                type: 'CONSUMPTION',
                quantityDelta: -s.quantity,
                unitId,
                reason: 'Blended into output lot',
                actorUserId: ctx.userId ?? null,
                disallowNegative: true,
            });
        }

        // 2 — create the blended output lot.
        const lotCode =
            sanitizePlainText((input.outputLotCode ?? '').trim()) ||
            `BLEND-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
        const outputLot = await InventoryRepository.createLot(db, ctx, {
            itemId: outputItem.id,
            lotCode,
            unitId,
            locationId: input.outputLocationId ?? null,
            receivedAt: new Date(),
            attributesJson: { ...attributes, blendedFrom: ids } as Prisma.InputJsonValue,
        });

        // 3 — receipt the blended quantity into the output lot (positive delta).
        await appendStockTransaction(db, ctx, {
            lotId: outputLot.id,
            type: 'RECEIPT',
            quantityDelta: totalQuantity,
            unitId,
            reason: 'Blended output',
            actorUserId: ctx.userId ?? null,
        });

        // 4 — one MERGE genealogy edge per source → output lot.
        let mergeLinks = 0;
        for (const s of input.sourceLots) {
            const { created } = await appendLotLink(db, ctx, {
                parentLotId: s.lotId,
                childLotId: outputLot.id,
                type: 'MERGE',
            });
            if (created) mergeLinks += 1;
        }

        await logEvent(db, ctx, {
            action: 'LOTS_BLENDED',
            entityType: 'InventoryLot',
            entityId: outputLot.id,
            details: `Blended ${input.sourceLots.length} lot(s) into ${outputLot.lotCode} (${totalQuantity})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'InventoryLot',
                operation: 'created',
                after: {
                    lotCode: outputLot.lotCode,
                    blendedQuantity: totalQuantity,
                    sourceCount: input.sourceLots.length,
                    attributes,
                },
                summary: `Blended ${input.sourceLots.length} source lot(s) into ${outputLot.lotCode}`,
            },
        });

        return {
            outputLotId: outputLot.id,
            outputLotCode: outputLot.lotCode,
            blendedQuantity: totalQuantity,
            sourceCount: input.sourceLots.length,
            mergeLinks,
            attributes,
        };
    });
}
