import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { badRequest, notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { InventoryRepository } from '../repositories/InventoryRepository';
import { JournalRepository } from '../repositories/JournalRepository';
import { createLogEntryWithAudit } from './journal-write';
import { ModuleSettingsRepository } from '../repositories/ModuleSettingsRepository';
import { AuditLogRepository } from '../repositories/AuditLogRepository';
import { resolveEnabledModules } from '@/lib/modules';
import { applyRate, convert, canConvert, isRateUnit } from '@/lib/units/unit-conversion';
import {
    appendStockTransaction,
    appendLotLink,
    verifyStockChain,
    verifyLotBalances,
    type StockLedgerReconciliation,
} from '@/lib/inventory/stock-ledger';
import { traceAgUsecase, traceUsecase, recordAgOperationMetrics } from '@/lib/observability';
import { logger } from '@/lib/observability/logger';
import { trace } from '@opentelemetry/api';

/**
 * Inventory — lots + the append-only stock ledger.
 *
 * Lot rows are created empty and filled by RECEIPT ledger entries (or
 * an initial-stock RECEIPT at creation). Every quantity change flows
 * through `appendStockTransaction` (the single hash-chained writer),
 * never a direct StockTransaction write. The lots list surfaces a
 * computed `lowStock` when an item's total on-hand drops below its
 * `reorderLevel`.
 *
 * `recordInputApplication` is the spray-completion bridge: called from
 * `markOperationParcel` inside its transaction, it writes the
 * INPUT_APPLICATION journal record and the CONSUMPTION ledger entry —
 * but only for the modules the tenant has enabled (WP-2).
 */

function toNum(d: unknown): number {
    if (d === null || d === undefined) return 0;
    return typeof d === 'number' ? d : Number(d as { toString(): string });
}

// ─── Reads ─────────────────────────────────────────────────────────

/**
 * Map a raw lot row (with item/unit/location includes) to the wire DTO —
 * Decimal `quantityOnHand` → number + computed `lowStock`. Shared by the
 * array and cursor-paginated list paths so both serialise identically
 * (see src/lib/dto/inventory.dto.ts::InventoryLotDTOSchema).
 */
function mapLotRow(l: {
    id: string;
    lotCode: string;
    item: { id: string; name: string; category: string; reorderLevel: unknown };
    unit: { id: string; symbol: string };
    location: { id: string; name: string } | null;
    quantityOnHand: unknown;
    expiresAt: Date | null;
    receivedAt: Date | null;
}) {
    const onHand = toNum(l.quantityOnHand);
    const reorder = l.item.reorderLevel !== null ? toNum(l.item.reorderLevel) : null;
    return {
        id: l.id,
        lotCode: l.lotCode,
        item: { id: l.item.id, name: l.item.name, category: l.item.category },
        unit: { id: l.unit.id, symbol: l.unit.symbol },
        location: l.location ? { id: l.location.id, name: l.location.name } : null,
        quantityOnHand: onHand,
        expiresAt: l.expiresAt,
        receivedAt: l.receivedAt,
        lowStock: reorder !== null ? onHand < reorder : false,
    };
}

export async function listLots(ctx: RequestContext, opts: { itemId?: string; take?: number } = {}) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const lots = await InventoryRepository.listLots(db, ctx, opts);
        return lots.map(mapLotRow);
    });
}

/**
 * Cursor-paginated lots — the dual-mode `GET /inventory/lots?limit=&cursor=`
 * path for inventory traceability on large fields. Returns
 * `{ items: InventoryLot[], pageInfo }`; items map identically to `listLots`.
 */
export async function listLotsPaginated(
    ctx: RequestContext,
    params: { limit?: number; cursor?: string; itemId?: string } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const page = await InventoryRepository.listLotsPaginated(db, ctx, params);
        return {
            items: (page.items as Parameters<typeof mapLotRow>[0][]).map(mapLotRow),
            pageInfo: page.pageInfo,
        };
    });
}

export async function getLot(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const lot = await InventoryRepository.getLot(db, ctx, id);
        if (!lot) throw notFound('Lot not found');
        const ledger = await InventoryRepository.lotLedger(db, ctx, id);
        return {
            id: lot.id,
            lotCode: lot.lotCode,
            item: lot.item,
            unit: lot.unit,
            location: lot.location,
            quantityOnHand: toNum(lot.quantityOnHand),
            expiresAt: lot.expiresAt,
            receivedAt: lot.receivedAt,
            ledger: ledger.map((t) => ({
                id: t.id,
                type: t.type,
                quantityDelta: toNum(t.quantityDelta),
                unitSymbol: t.unit.symbol,
                occurredAt: t.occurredAt,
                reason: t.reason,
                actor: t.actor ? { id: t.actor.id, name: t.actor.name } : null,
                entryHash: t.entryHash,
            })),
        };
    });
}

interface LedgerRowRaw {
    id: string;
    type: string;
    quantityDelta: unknown;
    unit: { symbol: string };
    occurredAt: Date;
    reason: string | null;
    actor: { id: string; name: string | null } | null;
    entryHash: string;
}

/**
 * Cursor-paginated ledger for a lot — the deep-history companion to
 * `getLot` (whose inline `ledger` is the recent first page). Each entry
 * has the same shape as the getLot ledger rows; `pageInfo` carries the
 * next cursor. Backed by the `[tenantId, lotId, createdAt]` index.
 */
export async function listLotLedger(
    ctx: RequestContext,
    lotId: string,
    params: { limit?: number; cursor?: string } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const lot = await InventoryRepository.getLot(db, ctx, lotId);
        if (!lot) throw notFound('Lot not found');
        const page = await InventoryRepository.lotLedgerPage(db, ctx, lotId, params);
        return {
            items: (page.items as LedgerRowRaw[]).map((t) => ({
                id: t.id,
                type: t.type,
                quantityDelta: toNum(t.quantityDelta),
                unitSymbol: t.unit.symbol,
                occurredAt: t.occurredAt,
                reason: t.reason,
                actor: t.actor ? { id: t.actor.id, name: t.actor.name } : null,
                entryHash: t.entryHash,
            })),
            pageInfo: page.pageInfo,
        };
    });
}

// ─── Writes ────────────────────────────────────────────────────────

export interface CreateLotInput {
    itemId: string;
    lotCode: string;
    locationId?: string | null;
    expiresAt?: string | null;
    receivedAt?: string | null;
    unitCostAmount?: number | null;
    unitCostCurrency?: string | null;
    /** Optional initial stock — posted as a RECEIPT ledger entry. */
    initialQuantity?: number | null;
}

export async function createLot(ctx: RequestContext, input: CreateLotInput) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const item = await InventoryRepository.getItem(db, ctx, input.itemId);
        if (!item) throw badRequest('Item not found.');

        const lotCode = sanitizePlainText(input.lotCode.trim());
        if (!lotCode) throw badRequest('Lot code is required.');

        const lot = await InventoryRepository.createLot(db, ctx, {
            itemId: item.id,
            lotCode,
            unitId: item.defaultUnitId,
            locationId: input.locationId ?? null,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            receivedAt: input.receivedAt ? new Date(input.receivedAt) : null,
            unitCostAmount: input.unitCostAmount ?? null,
            unitCostCurrency: input.unitCostCurrency ?? null,
        });

        if (input.initialQuantity && input.initialQuantity > 0) {
            await appendStockTransaction(db, ctx, {
                lotId: lot.id,
                type: 'RECEIPT',
                quantityDelta: input.initialQuantity,
                unitId: lot.unitId,
                costAmount: input.unitCostAmount ?? null,
                costCurrency: input.unitCostCurrency ?? null,
            });
        }

        await logEvent(db, ctx, {
            action: 'INVENTORY_LOT_CREATED',
            entityType: 'InventoryLot',
            entityId: lot.id,
            details: `Created lot ${lot.lotCode} for item ${item.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'InventoryLot',
                operation: 'created',
                after: { itemId: item.id, lotCode: lot.lotCode, initialQuantity: input.initialQuantity ?? 0 },
                summary: `Created inventory lot ${lot.lotCode}`,
            },
        });

        return { id: lot.id, lotCode: lot.lotCode };
    });
}

export async function receiveStock(ctx: RequestContext, lotId: string, quantity: number) {
    assertCanWrite(ctx);
    if (!(quantity > 0)) throw badRequest('Receipt quantity must be positive.');
    return runInTenantContext(ctx, async (db) => {
        const lot = await InventoryRepository.getLot(db, ctx, lotId);
        if (!lot) throw notFound('Lot not found');
        const res = await appendStockTransaction(db, ctx, {
            lotId,
            type: 'RECEIPT',
            quantityDelta: quantity,
            unitId: lot.unit.id,
        });
        await logEvent(db, ctx, {
            action: 'STOCK_RECEIVED',
            entityType: 'InventoryLot',
            entityId: lotId,
            details: `Received ${quantity} ${lot.unit.symbol} into lot ${lot.lotCode}`,
            detailsJson: {
                category: 'custom',
                summary: `Stock received into lot ${lot.lotCode}`,
                data: { lotId, quantity, onHand: res.quantityOnHand },
            },
        });
        return { quantityOnHand: res.quantityOnHand, entryHash: res.entryHash };
    });
}

export async function adjustStock(ctx: RequestContext, lotId: string, delta: number, reason: string) {
    assertCanWrite(ctx);
    if (!Number.isFinite(delta) || delta === 0) throw badRequest('Adjustment delta must be non-zero.');
    const cleanReason = sanitizePlainText((reason ?? '').trim());
    if (!cleanReason) throw badRequest('Adjustment reason is required.');
    return runInTenantContext(ctx, async (db) => {
        const lot = await InventoryRepository.getLot(db, ctx, lotId);
        if (!lot) throw notFound('Lot not found');
        const res = await appendStockTransaction(db, ctx, {
            lotId,
            type: 'ADJUSTMENT',
            quantityDelta: delta,
            unitId: lot.unit.id,
            reason: cleanReason,
            // Conservation guard: a manual count correction must never
            // create physically-impossible negative stock. Rejected
            // atomically under the advisory lock (see StockAppendInput).
            // The operational spray CONSUMPTION path does NOT set this —
            // it records the true consumption and lets reconciliation flag
            // any resulting negative.
            disallowNegative: true,
        });
        await logEvent(db, ctx, {
            action: 'STOCK_ADJUSTED',
            entityType: 'InventoryLot',
            entityId: lotId,
            details: `Adjusted lot ${lot.lotCode} by ${delta} ${lot.unit.symbol}: ${cleanReason}`,
            detailsJson: {
                category: 'custom',
                summary: `Stock adjusted on lot ${lot.lotCode}`,
                data: { lotId, delta, reason: cleanReason, onHand: res.quantityOnHand },
            },
        });
        return { quantityOnHand: res.quantityOnHand, entryHash: res.entryHash };
    });
}

// ─── Spray-completion bridge (WP-2 module-gated) ───────────────────

/** The OperationParcel fields recordInputApplication needs. */
export interface InputApplicationLine {
    id: string;
    parcelId: string;
    productItemId: string;
    doseValue: unknown; // Prisma Decimal
    doseUnitId: string;
}

export interface InputApplicationResult {
    journalEntryId: string | null;
    consumed: number;
    deductedFromLotId: string | null;
    /**
     * Why no deduction happened — OR (`over_consumption`) that the
     * deduction landed but drove the lot's on-hand below zero: the spray
     * consumed more than the tracked stock, so the ledger recorded the
     * true amount and the lot is now negative (flagged by reconciliation).
     */
    note?: 'inventory_disabled' | 'no_lot_available' | 'zero_quantity' | 'already_applied' | 'over_consumption';
}

/**
 * Emit the field record + stock effect of completing a spray line.
 * Runs INSIDE the caller's tenant transaction (`db`). Module-gated via a
 * non-throwing read of TenantModuleSettings on the same handle (so no
 * nested transaction): JOURNAL drives the LogEntry, INVENTORY drives the
 * CONSUMPTION. Lot selection is FEFO; if the product has no lot with
 * stock the consumption is skipped (the journal record still stands).
 */
export async function recordInputApplication(
    db: PrismaTx,
    ctx: RequestContext,
    line: InputApplicationLine,
): Promise<InputApplicationResult> {
    return traceAgUsecase('inventory.recordInputApplication', ctx, () =>
        recordInputApplicationImpl(db, ctx, line),
    );
}

async function recordInputApplicationImpl(
    db: PrismaTx,
    ctx: RequestContext,
    line: InputApplicationLine,
): Promise<InputApplicationResult> {
    const modules = resolveEnabledModules(await ModuleSettingsRepository.get(db, ctx));
    const journalOn = modules.includes('JOURNAL');
    const inventoryOn = modules.includes('INVENTORY');
    if (!journalOn && !inventoryOn) {
        return { journalEntryId: null, consumed: 0, deductedFromLotId: null, note: 'inventory_disabled' };
    }

    // Idempotency guard (layer 1): a spray line is applied at most once.
    // If an INPUT_APPLICATION journal entry already exists for this
    // operationParcelId, this is a retry / double-click — return the
    // existing entry without minting a duplicate record or a second
    // CONSUMPTION. The race-safe DB backstop is the `spray:<id>` dedup key
    // on the CONSUMPTION append below (layer 2), serialised by the stock
    // advisory lock.
    const existingApplication = await db.logEntry.findFirst({
        where: { tenantId: ctx.tenantId, operationParcelId: line.id, type: 'INPUT_APPLICATION' },
        select: { id: true },
    });
    if (existingApplication) {
        return {
            journalEntryId: existingApplication.id,
            consumed: 0,
            deductedFromLotId: null,
            note: 'already_applied',
        };
    }

    const [parcel, product] = await Promise.all([
        db.parcel.findFirst({
            where: { id: line.parcelId, tenantId: ctx.tenantId },
            select: { name: true, areaHa: true },
        }),
        db.item.findFirst({
            where: { id: line.productItemId, tenantId: ctx.tenantId },
            select: { id: true, name: true, defaultUnitId: true },
        }),
    ]);
    if (!parcel || !product) {
        return { journalEntryId: null, consumed: 0, deductedFromLotId: null, note: 'zero_quantity' };
    }

    const units = await db.unit.findMany({
        where: { id: { in: [line.doseUnitId, product.defaultUnitId] } },
        select: { id: true, measure: true, symbol: true, key: true },
    });
    const doseUnit = units.find((u) => u.id === line.doseUnitId);
    const productUnit = units.find((u) => u.id === product.defaultUnitId);

    // Dimensionally-correct consumption via the typed unit layer:
    //   - a RATE dose (L/ha) applied over the parcel area yields the rate's
    //     NUMERATOR unit, then converts into the product's stock unit
    //     (L/ha × ha = L; deducting into an mL lot scales ×1000), and
    //   - a flat dose converts dose-unit → product-unit when both are known.
    // Falls back to the legacy "assume the units match" multiply when a unit
    // isn't in the conversion catalog or the dimensions can't reconcile
    // (e.g. a volume rate into a weight lot — no density), so unregistered
    // units keep working exactly as before. The guards (`isRateUnit` /
    // `canConvert`) ensure the conversion helpers never throw here.
    const areaHa = parcel.areaHa !== null ? toNum(parcel.areaHa) : 0;
    const dose = toNum(line.doseValue);
    let consumedRaw: number;
    if (doseUnit?.measure === 'RATE' && doseUnit.key && isRateUnit(doseUnit.key)) {
        const applied = applyRate(dose, doseUnit.key, areaHa, 'ha');
        consumedRaw =
            productUnit?.key && canConvert(applied.unitKey, productUnit.key)
                ? convert(applied.value, applied.unitKey, productUnit.key)
                : applied.value;
    } else if (doseUnit?.key && productUnit?.key && canConvert(doseUnit.key, productUnit.key)) {
        consumedRaw = convert(dose, doseUnit.key, productUnit.key);
    } else {
        consumedRaw = doseUnit?.measure === 'RATE' ? dose * areaHa : dose;
    }
    const consumed = Math.round(consumedRaw * 1e4) / 1e4;

    // 1 — journal record (the compliant spray record).
    let journalEntryId: string | null = null;
    if (journalOn) {
        // Goes through the audited seam so the auto-generated record gets a
        // CREATE event too — these entries are freely editable, so the audit
        // trail is what makes that safe (see createLogEntryWithAudit).
        const entry = await createLogEntryWithAudit(db, ctx, {
            type: 'INPUT_APPLICATION',
            title: `Applied ${product.name} to ${parcel.name}`,
            operationParcelId: line.id,
            quantities:
                consumed > 0 && productUnit
                    ? [
                          {
                              measure: productUnit.measure,
                              value: consumed,
                              unitId: product.defaultUnitId,
                              label: 'Applied',
                          },
                      ]
                    : [],
        }, 'field_operation');
        journalEntryId = entry.id;
    }

    // 2 — stock effect (CONSUMPTION) against the FEFO lot.
    let deductedFromLotId: string | null = null;
    let note: InputApplicationResult['note'];
    if (inventoryOn && consumed > 0) {
        const lot = await InventoryRepository.getFefoLot(db, ctx, product.id);
        if (lot) {
            const res = await appendStockTransaction(db, ctx, {
                lotId: lot.id,
                type: 'CONSUMPTION',
                quantityDelta: -consumed,
                unitId: lot.unitId,
                logEntryId: journalEntryId,
                actorUserId: ctx.userId ?? null,
                // Idempotency layer 2 (race-safe DB backstop): keyed on the
                // STABLE operationParcelId, never the per-call logEntryId, so
                // a concurrent retry can't double-deduct the lot.
                idempotencyKey: `spray:${line.id}`,
                // Intentionally NOT disallowNegative: the spray HAPPENED, so
                // the ledger records the true consumption for traceability
                // even when it exceeds tracked stock. Clamping would falsify
                // the food-safety record; splitting across lots would break
                // the single-key idempotency this path relies on. An
                // over-draw surfaces here (note + warn) and is durably
                // flagged by verifyLotBalances at reconciliation.
            });
            deductedFromLotId = lot.id;
            if (Number(res.quantityOnHand) < 0) {
                note = 'over_consumption';
                logger.warn('spray consumption drove lot on-hand negative', {
                    component: 'usecase',
                    operation: 'inventory.recordInputApplication',
                    tenantId: ctx.tenantId,
                    lotId: lot.id,
                    operationParcelId: line.id,
                    consumed,
                    onHand: res.quantityOnHand,
                });
            }
        } else {
            note = 'no_lot_available';
        }
    } else if (consumed <= 0) {
        note = 'zero_quantity';
    }

    trace.getActiveSpan()?.setAttributes({
        'ag.operationParcelId': line.id,
        'ag.parcelId': line.parcelId,
        'ag.productItemId': line.productItemId,
        'ag.doseValue': toNum(line.doseValue),
        'ag.consumed': consumed,
        'ag.deductedFromLotId': deductedFromLotId ?? '',
        ...(note ? { 'ag.note': note } : {}),
    });

    return { journalEntryId, consumed, deductedFromLotId, note };
}

// ─── Ledger reconciliation (integrity sweep + drift alerting) ──────

/**
 * Re-walk the tenant's hash-chained stock ledger from scratch AND
 * reconcile every lot's on-hand cache against the authoritative ledger
 * sum — BOTH integrity halves, so an intact chain can't hide a drifted or
 * negative balance. The operator-facing "is my inventory ledger intact?"
 * check, surfaced at `POST /api/t/:slug/admin/ledger-reconciliation`.
 *
 * Observability is deliberately hand-rolled rather than reusing
 * `traceAgUsecase`: a reconciliation that RUNS cleanly but DETECTS drift
 * (no throw) is exactly the event the `AgLedgerReconciliationDrift` SLO
 * alert pages on. So the `ag.operation` metric outcome is keyed on the
 * COMBINED health (chain valid AND balance healthy), not on "did the
 * function throw" — a found break OR a balance drift/negative records
 * `ag_outcome="failure"` so the alert fires, while still returning the
 * report to the caller (200, not 500). An actual exception also records
 * failure via the `finally`. The span (via `traceUsecase`) carries the
 * full trace.
 */
export async function reconcileStockLedger(ctx: RequestContext): Promise<StockLedgerReconciliation> {
    assertCanAdmin(ctx);
    const startMs = performance.now();
    let healthy = false;
    try {
        const verification = await traceUsecase('inventory.reconcileStockLedger', ctx, async () => {
            const result = await runInTenantContext(ctx, async (db) => {
                const chain = await verifyStockChain(db, ctx.tenantId);
                const balances = await verifyLotBalances(db, ctx.tenantId);
                const v: StockLedgerReconciliation = { ...chain, balances };
                const clean = chain.valid && balances.healthy;
                const balanceIssue = balances.drift.length > 0 || balances.negative.length > 0;
                await logEvent(db, ctx, {
                    action: 'LEDGER_RECONCILIATION_RUN',
                    entityType: 'StockTransaction',
                    entityId: ctx.tenantId,
                    details: clean
                        ? `Stock ledger verified intact: chain OK across ${chain.totalEntries} entries, ${balances.lotsChecked} lot balances reconciled`
                        : !chain.valid
                            ? `Stock ledger DRIFT detected at entry ${chain.firstBreakAt} (${chain.firstBreakId})`
                            : `Stock ledger balance drift: ${balances.drift.length} cache mismatch(es), ${balances.negative.length} negative on-hand`,
                    detailsJson: {
                        category: 'data_lifecycle',
                        summary: clean
                            ? `Ledger reconciliation passed (${chain.totalEntries} entries, ${balances.lotsChecked} balances)`
                            : !chain.valid
                                ? `Ledger reconciliation FAILED — chain drift at entry ${chain.firstBreakAt}`
                                : `Ledger reconciliation FAILED — ${balances.drift.length} balance drift, ${balances.negative.length} negative on-hand`,
                        data: {
                            valid: chain.valid,
                            totalEntries: chain.totalEntries,
                            firstBreakAt: chain.firstBreakAt ?? null,
                            firstBreakId: chain.firstBreakId ?? null,
                            // Balance half — so "verified intact" can't hide a
                            // drifted or negative cache in the history rows.
                            balanced: balances.balanced,
                            balanceHealthy: balances.healthy,
                            lotsChecked: balances.lotsChecked,
                            driftCount: balances.drift.length,
                            negativeCount: balances.negative.length,
                            balanceIssue,
                        },
                    },
                });
                return v;
            });
            trace.getActiveSpan()?.setAttributes({
                'ag.operation': 'inventory.reconcileStockLedger',
                'ag.ledgerValid': result.valid,
                'ag.ledgerEntries': result.totalEntries,
                'ag.balanceHealthy': result.balances.healthy,
                'ag.balanceDriftCount': result.balances.drift.length,
                'ag.balanceNegativeCount': result.balances.negative.length,
                ...(result.firstBreakId ? { 'ag.firstBreakId': result.firstBreakId } : {}),
                ...(result.firstBreakAt !== undefined ? { 'ag.firstBreakAt': result.firstBreakAt } : {}),
            });
            return result;
        });
        healthy = verification.valid && verification.balances.healthy;
        return verification;
    } finally {
        recordAgOperationMetrics({
            operation: 'inventory.reconcileStockLedger',
            // Success only when BOTH halves are clean — a drifted/negative
            // balance fires the same drift alert as a broken chain.
            success: healthy,
            durationMs: Math.round(performance.now() - startMs),
        });
    }
}

/** A past reconciliation run, reconstructed from its audit row. */
export interface LedgerReconciliationRun {
    id: string;
    /** ISO timestamp of the run. */
    runAt: string;
    /** null when the audit row predates the structured payload. */
    valid: boolean | null;
    totalEntries: number | null;
    firstBreakAt: number | null;
    firstBreakId: string | null;
    /**
     * Balance-half status. null on rows written before the balance check
     * was reconciled here (chain-only runs) — the UI degrades to "—".
     */
    balanceHealthy: boolean | null;
    lotsChecked: number | null;
    driftCount: number | null;
    negativeCount: number | null;
    /** Display name (or email) of who ran it; null for system runs. */
    runBy: string | null;
}

/**
 * The reconciliation timeline — every `LEDGER_RECONCILIATION_RUN` audit
 * row, newest first, reshaped from its `detailsJson.data` into the wire
 * DTO the admin Ledger Integrity page renders. The audit log IS the
 * durable record of runs (no separate table), so this is a thin read
 * over `AuditLogRepository.listByAction` (backed by `[tenantId, action]`).
 */
export async function listLedgerReconciliationHistory(
    ctx: RequestContext,
    opts: { take?: number } = {},
): Promise<LedgerReconciliationRun[]> {
    assertCanRead(ctx);
    const rows = await runInTenantContext(ctx, (db) =>
        AuditLogRepository.listByAction(db, ctx, 'LEDGER_RECONCILIATION_RUN', opts.take ?? 50),
    );
    return rows.map((r) => {
        const data = (r.detailsJson as { data?: Record<string, unknown> } | null)?.data ?? {};
        return {
            id: r.id,
            runAt: r.createdAt.toISOString(),
            valid: typeof data.valid === 'boolean' ? data.valid : null,
            totalEntries: typeof data.totalEntries === 'number' ? data.totalEntries : null,
            firstBreakAt: typeof data.firstBreakAt === 'number' ? data.firstBreakAt : null,
            firstBreakId: typeof data.firstBreakId === 'string' ? data.firstBreakId : null,
            balanceHealthy: typeof data.balanceHealthy === 'boolean' ? data.balanceHealthy : null,
            lotsChecked: typeof data.lotsChecked === 'number' ? data.lotsChecked : null,
            driftCount: typeof data.driftCount === 'number' ? data.driftCount : null,
            negativeCount: typeof data.negativeCount === 'number' ? data.negativeCount : null,
            runBy: r.user?.name ?? r.user?.email ?? null,
        };
    });
}

// ─── Harvest → lot wiring (HARVEST_IN + genealogy) ─────────────────

/** What a HARVEST journal entry needs to mint an output lot. */
export interface HarvestLotInput {
    /** The HARVEST LogEntry that produced this lot (provenance link). */
    logEntryId: string;
    /** The harvested-produce Item the new lot holds. */
    itemId: string;
    /** Harvested amount (positive); posted as the HARVEST_IN delta. */
    quantity: number;
    /** Optional explicit lot code; auto-derived from the entry otherwise. */
    lotCode?: string | null;
    /** Storage Location the harvest lot lands in (a barn/silo). */
    locationId?: string | null;
    expiresAt?: string | null;
    /** The field harvested — drives both the recorded provenance and the
     *  DERIVATION genealogy (input lots consumed on this parcel). */
    parcelId?: string | null;
    /** Extra explicit parent lots to link (seed lots not auto-discovered). */
    sourceLotIds?: string[];
    costAmount?: number | null;
    costCurrency?: string | null;
}

export interface HarvestLotResult {
    lotId: string | null;
    lotCode: string | null;
    /** How many DERIVATION genealogy edges were recorded. */
    derivedFrom: number;
    note?: 'inventory_disabled' | 'item_not_found' | 'zero_quantity';
}

/**
 * Mint the inventory lot a HARVEST journal entry produces, post its
 * HARVEST_IN ledger entry, and record lot genealogy. Runs INSIDE the
 * caller's tenant transaction (`db`) — called from `journal.createLogEntry`
 * when a HARVEST entry carries a `harvest` payload. INVENTORY-module
 * gated: with inventory off the journal entry still stands, no lot is
 * minted. Genealogy: every input lot CONSUMED on `parcelId` (plus any
 * explicit `sourceLotIds`) becomes a DERIVATION parent of the harvest
 * lot, so the traceability walk threads seed-lot → field → harvest-lot.
 */
export async function recordHarvestLot(
    db: PrismaTx,
    ctx: RequestContext,
    input: HarvestLotInput,
): Promise<HarvestLotResult> {
    const modules = resolveEnabledModules(await ModuleSettingsRepository.get(db, ctx));
    if (!modules.includes('INVENTORY')) {
        return { lotId: null, lotCode: null, derivedFrom: 0, note: 'inventory_disabled' };
    }
    if (!(input.quantity > 0)) {
        return { lotId: null, lotCode: null, derivedFrom: 0, note: 'zero_quantity' };
    }

    const item = await InventoryRepository.getItem(db, ctx, input.itemId);
    if (!item) {
        return { lotId: null, lotCode: null, derivedFrom: 0, note: 'item_not_found' };
    }

    const lotCode =
        sanitizePlainText((input.lotCode ?? '').trim()) ||
        `HARV-${new Date().toISOString().slice(0, 10)}-${input.logEntryId.slice(-6)}`;

    const lot = await InventoryRepository.createLot(db, ctx, {
        itemId: item.id,
        lotCode,
        unitId: item.defaultUnitId,
        locationId: input.locationId ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        receivedAt: new Date(),
        ...(input.parcelId ? { attributesJson: { harvestedFromParcelId: input.parcelId } } : {}),
    });

    // HARVEST_IN — the output stock, chained + linked to the journal entry.
    await appendStockTransaction(db, ctx, {
        lotId: lot.id,
        type: 'HARVEST_IN',
        quantityDelta: input.quantity,
        unitId: lot.unitId,
        logEntryId: input.logEntryId,
        costAmount: input.costAmount ?? null,
        costCurrency: input.costCurrency ?? null,
        actorUserId: ctx.userId ?? null,
    });

    // Genealogy — input lots consumed on the field + any explicit sources.
    const parentIds = new Set<string>(input.sourceLotIds ?? []);
    if (input.parcelId) {
        for (const id of await InventoryRepository.findInputLotsConsumedOnParcel(db, ctx, input.parcelId)) {
            parentIds.add(id);
        }
    }
    parentIds.delete(lot.id); // never self-derive
    let derivedFrom = 0;
    for (const parentLotId of parentIds) {
        const { created } = await appendLotLink(db, ctx, {
            parentLotId,
            childLotId: lot.id,
            type: 'DERIVATION',
            logEntryId: input.logEntryId,
        });
        if (created) derivedFrom += 1;
    }

    await logEvent(db, ctx, {
        action: 'HARVEST_LOT_CREATED',
        entityType: 'InventoryLot',
        entityId: lot.id,
        details: `Harvest produced lot ${lot.lotCode} of ${item.name} (${input.quantity})`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'InventoryLot',
            operation: 'created',
            after: { itemId: item.id, lotCode: lot.lotCode, quantity: input.quantity, derivedFrom },
            summary: `Harvest lot ${lot.lotCode} created from ${derivedFrom} input lot(s)`,
        },
    });

    return { lotId: lot.id, lotCode: lot.lotCode, derivedFrom };
}

// ─── Traceability walk (seed-lot → field → harvest-lot) ────────────

const TRACE_MAX_DEPTH = 12;

export interface TraceLotNode {
    id: string;
    lotCode: string;
    item: { id: string; name: string; category: string };
    unitSymbol: string;
    quantityOnHand: number;
    /** Fields this lot touched — consumed-on parcels + (harvest) source field. */
    fields: { id: string; name: string }[];
}

export interface TraceLotEdge {
    parentLotId: string;
    childLotId: string;
    type: string;
}

export interface TraceLotResult {
    root: TraceLotNode;
    /** Upstream input/seed lots (BFS up the genealogy graph). */
    ancestors: TraceLotNode[];
    /** Downstream harvest/output lots (BFS down). */
    descendants: TraceLotNode[];
    edges: TraceLotEdge[];
}

/**
 * Walk a lot's provenance both ways: ancestors (the seed/input lots it
 * derives from) and descendants (the harvest lots derived from it),
 * annotating every lot with the fields it touched. This is the
 * food-safety recall query — "given this seed lot, which fields and which
 * harvest lots are implicated?" and its inverse.
 */
export async function traceLot(ctx: RequestContext, rootLotId: string): Promise<TraceLotResult> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const [root] = await InventoryRepository.getLotsByIds(db, ctx, [rootLotId]);
        if (!root) throw notFound('Lot not found');

        const edges: TraceLotEdge[] = [];
        const seen = new Set<string>([rootLotId]);

        // BFS up (ancestors) and down (descendants), one query per level.
        const ancestorIds = new Set<string>();
        let frontier = [rootLotId];
        for (let depth = 0; depth < TRACE_MAX_DEPTH && frontier.length; depth++) {
            const links = await InventoryRepository.listParentLinks(db, ctx, frontier);
            const next: string[] = [];
            for (const l of links) {
                edges.push({ parentLotId: l.parentLotId, childLotId: l.childLotId, type: l.type });
                if (!seen.has(l.parentLotId)) {
                    seen.add(l.parentLotId);
                    ancestorIds.add(l.parentLotId);
                    next.push(l.parentLotId);
                }
            }
            frontier = next;
        }

        const descendantIds = new Set<string>();
        frontier = [rootLotId];
        const seenDown = new Set<string>([rootLotId]);
        for (let depth = 0; depth < TRACE_MAX_DEPTH && frontier.length; depth++) {
            const links = await InventoryRepository.listChildLinks(db, ctx, frontier);
            const next: string[] = [];
            for (const l of links) {
                edges.push({ parentLotId: l.parentLotId, childLotId: l.childLotId, type: l.type });
                if (!seenDown.has(l.childLotId)) {
                    seenDown.add(l.childLotId);
                    descendantIds.add(l.childLotId);
                    next.push(l.childLotId);
                }
            }
            frontier = next;
        }

        const allIds = [rootLotId, ...ancestorIds, ...descendantIds];
        const lots = await InventoryRepository.getLotsByIds(db, ctx, allIds);

        // Fields per lot: consumed-on parcels + (harvest) recorded source field.
        const consumptions = await InventoryRepository.findConsumptionParcels(db, ctx, allIds);
        const fieldsByLot = new Map<string, Map<string, string>>();
        const addField = (lotId: string, id: string | undefined, name: string | undefined) => {
            if (!id || !name) return;
            if (!fieldsByLot.has(lotId)) fieldsByLot.set(lotId, new Map());
            fieldsByLot.get(lotId)!.set(id, name);
        };
        for (const c of consumptions) {
            addField(c.lotId, c.logEntry?.operationParcel?.parcel?.id, c.logEntry?.operationParcel?.parcel?.name);
        }
        // Harvest lots record their source field in attributesJson; resolve names in one query.
        const harvestParcelIds = new Map<string, string>(); // lotId → parcelId
        for (const l of lots) {
            const pid = (l.attributesJson as { harvestedFromParcelId?: string } | null)?.harvestedFromParcelId;
            if (pid) harvestParcelIds.set(l.id, pid);
        }
        if (harvestParcelIds.size) {
            const parcels = await db.parcel.findMany({
                where: { tenantId: ctx.tenantId, id: { in: [...new Set(harvestParcelIds.values())] } },
                select: { id: true, name: true },
            });
            const pname = new Map(parcels.map((p) => [p.id, p.name]));
            for (const [lotId, pid] of harvestParcelIds) addField(lotId, pid, pname.get(pid));
        }

        const toNode = (l: (typeof lots)[number]): TraceLotNode => ({
            id: l.id,
            lotCode: l.lotCode,
            item: { id: l.item.id, name: l.item.name, category: l.item.category },
            unitSymbol: l.unit.symbol,
            quantityOnHand: toNum(l.quantityOnHand),
            fields: [...(fieldsByLot.get(l.id) ?? new Map()).entries()].map(([id, name]) => ({ id, name })),
        });
        const byId = new Map(lots.map((l) => [l.id, l]));

        return {
            root: toNode(byId.get(rootLotId)!),
            ancestors: [...ancestorIds].map((id) => byId.get(id)).filter(Boolean).map((l) => toNode(l!)),
            descendants: [...descendantIds].map((id) => byId.get(id)).filter(Boolean).map((l) => toNode(l!)),
            edges,
        };
    });
}
