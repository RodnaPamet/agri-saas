/**
 * Stock ledger writer + verifier.
 *
 * This is the ONLY module that may INSERT into StockTransaction. Every
 * append flows through `appendStockTransaction` so that, within one
 * advisory-locked step:
 *   1. the per-tenant hash chain (previousHash → entryHash) is extended,
 *   2. the row is inserted, and
 *   3. the denormalised `InventoryLot.quantityOnHand` cache is recomputed
 *      from the ledger sum.
 *
 * It runs inside the CALLER's `runInTenantContext` transaction (the `db`
 * handle) so the append is atomic with whatever drove it — a lot
 * receipt, an adjustment, or the spray-completion CONSUMPTION. The
 * StockTransaction table is append-only (DB trigger blocks UPDATE/DELETE);
 * corrections are posted as ADJUSTMENT entries, never edits.
 *
 * Direct `db.stockTransaction.create/update/delete` from usecases is
 * banned by `tests/guardrails/no-direct-stock-writes.test.ts`.
 *
 * @module inventory/stock-ledger
 */
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';
import { badRequest } from '@/lib/errors/types';
import {
    computeStockEntryHash,
    decimalToCanonical,
    toCanonicalTimestamp,
} from './stock-hash';

/** Hash-chain version for stock entries. */
export const STOCK_HASH_VERSION = 1;

const QUANTITY_SCALE = 4; // DECIMAL(16,4)
const COST_SCALE = 2; // DECIMAL(14,2)

export interface StockAppendInput {
    lotId: string;
    type:
        | 'RECEIPT'
        | 'CONSUMPTION'
        | 'HARVEST_IN'
        | 'TRANSFER'
        | 'ADJUSTMENT'
        | 'SALE_OUT'
        | 'DISPOSAL';
    /** Signed delta: positive = stock in, negative = stock out. */
    quantityDelta: number;
    unitId: string;
    occurredAt?: Date;
    logEntryId?: string | null;
    reason?: string | null;
    costAmount?: number | null;
    costCurrency?: string | null;
    actorUserId?: string | null;
    /**
     * Optional dedup key. When set, a second append with the SAME
     * `(tenantId, idempotencyKey)` is a no-op that returns the original
     * row (no second movement, no double-deduct) — backed by a partial
     * unique index, and race-free because the whole append runs under the
     * per-tenant advisory lock. Use a STABLE source key (e.g.
     * `spray:<operationParcelId>`), never the per-call `logEntryId`.
     */
    idempotencyKey?: string | null;
    /**
     * Conservation guard (opt-in). When true, the append is REJECTED
     * (`badRequest('negative_on_hand')`) if it would drive the lot's
     * on-hand below zero. The check runs under the per-tenant advisory
     * lock, so the read-then-write is race-free. Used by the manual
     * `adjustStock` correction path; the operational spray CONSUMPTION
     * deliberately leaves this UNSET — it records the true consumption
     * even when it exceeds tracked stock (clamping would falsify the
     * food-safety record) and lets `verifyLotBalances` flag any negative.
     */
    disallowNegative?: boolean;
}

export interface StockAppendResult {
    id: string;
    entryHash: string;
    previousHash: string | null;
    quantityOnHand: string;
    /** True when the append was deduplicated against an existing row. */
    deduplicated?: boolean;
}

/**
 * Append one row to the tenant's stock ledger and refresh the lot cache.
 * MUST be called inside a `runInTenantContext` transaction.
 */
export async function appendStockTransaction(
    db: PrismaTx,
    ctx: RequestContext,
    input: StockAppendInput,
): Promise<StockAppendResult> {
    // 1 — serialise appends for this tenant's chain (distinct lock
    //     namespace from the audit chain's `hashtext(tenantId)`).
    await db.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `stock:${ctx.tenantId}`,
    );

    // 1b — idempotency: a retried emit carrying the same dedup key is a
    //      no-op. The check-then-insert is race-free because we already
    //      hold the per-tenant advisory lock; the partial unique index is
    //      the DB backstop. Return the ORIGINAL row + the lot's current
    //      on-hand so the caller sees an identical result on retry.
    if (input.idempotencyKey) {
        const existing = await db.stockTransaction.findFirst({
            where: { tenantId: ctx.tenantId, idempotencyKey: input.idempotencyKey },
            select: { id: true, entryHash: true, previousHash: true, lotId: true },
        });
        if (existing) {
            const lot = await db.inventoryLot.findFirst({
                where: { id: existing.lotId, tenantId: ctx.tenantId },
                select: { quantityOnHand: true },
            });
            return {
                id: existing.id,
                entryHash: existing.entryHash,
                previousHash: existing.previousHash,
                quantityOnHand: decimalToCanonical(
                    (lot?.quantityOnHand ?? 0) as unknown as { toFixed(n: number): string },
                    QUANTITY_SCALE,
                )!,
                deduplicated: true,
            };
        }
    }

    // 1c — conservation guard (opt-in; see StockAppendInput.disallowNegative).
    //      Runs under the advisory lock so the sum read + the insert below
    //      are one race-free step: no concurrent append can slip between
    //      them and turn a green check into a negative balance.
    if (input.disallowNegative) {
        const guardAgg = await db.stockTransaction.aggregate({
            where: { tenantId: ctx.tenantId, lotId: input.lotId },
            _sum: { quantityDelta: true },
        });
        const current = Number(guardAgg._sum.quantityDelta ?? 0);
        const resulting = Math.round((current + input.quantityDelta) * 10 ** QUANTITY_SCALE) / 10 ** QUANTITY_SCALE;
        if (resulting < 0) {
            throw badRequest(
                'negative_on_hand',
                `Movement would drive lot on-hand to ${resulting} (below zero).`,
            );
        }
    }

    // 2 — the tail of the chain (deterministic total order). Read the
    //     tail's createdAt too — the append timestamp below is clamped
    //     strictly above it.
    const last = await db.stockTransaction.findFirst({
        where: { tenantId: ctx.tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { entryHash: true, createdAt: true },
    });
    const previousHash = last?.entryHash ?? null;

    // Stamp `createdAt` HERE — AFTER the advisory lock — so the ledger's
    // physical order matches the lock-serialized CHAIN order. Mirrors the
    // AuditLog writer (audit-writer.ts: `now` captured post-lock, inserted
    // as createdAt). The buggy default was CURRENT_TIMESTAMP = the
    // transaction's START time, captured BEFORE the lock (migration) — so
    // under concurrent appends with staggered pre-lock work, createdAt
    // order could disagree with the actual link order and fake a "DRIFT"
    // fork. We additionally CLAMP the timestamp strictly above the tail's
    // createdAt (+1ms) so the order is monotonic even for two appends in
    // the same millisecond: createdAt is the sole ordering key the writer
    // tail-pick and verifyStockChain agree on, and the cuid `id` tiebreak
    // is not time-ordered. Safe to nudge — createdAt is NOT part of the
    // entry hash (only occurredAt is).
    const nowMs = Date.now();
    const tailMs = last?.createdAt ? last.createdAt.getTime() : 0;
    const createdAt = new Date(Math.max(nowMs, tailMs + 1));

    const occurredAt = input.occurredAt ?? createdAt;
    const quantityCanonical = decimalToCanonical(input.quantityDelta, QUANTITY_SCALE)!;
    const costCanonical = decimalToCanonical(input.costAmount ?? null, COST_SCALE);

    const entryHash = computeStockEntryHash({
        tenantId: ctx.tenantId,
        lotId: input.lotId,
        type: input.type,
        quantityDelta: quantityCanonical,
        unitId: input.unitId,
        occurredAt: toCanonicalTimestamp(occurredAt),
        logEntryId: input.logEntryId ?? null,
        reason: input.reason ?? null,
        costAmount: costCanonical,
        costCurrency: input.costCurrency ?? null,
        actorUserId: input.actorUserId ?? ctx.userId ?? null,
        previousHash,
        version: STOCK_HASH_VERSION,
    });

    // 3 — append (INSERT is permitted; only UPDATE/DELETE are blocked).
    const row = await db.stockTransaction.create({
        data: {
            tenantId: ctx.tenantId,
            lotId: input.lotId,
            type: input.type,
            quantityDelta: input.quantityDelta,
            unitId: input.unitId,
            occurredAt,
            createdAt,
            logEntryId: input.logEntryId ?? null,
            reason: input.reason ?? null,
            costAmount: input.costAmount ?? null,
            costCurrency: input.costCurrency ?? null,
            actorUserId: input.actorUserId ?? ctx.userId ?? null,
            previousHash,
            entryHash,
            idempotencyKey: input.idempotencyKey ?? null,
        },
        select: { id: true, entryHash: true, previousHash: true },
    });

    // 4 — refresh the denormalised on-hand cache from the ledger sum.
    const agg = await db.stockTransaction.aggregate({
        where: { tenantId: ctx.tenantId, lotId: input.lotId },
        _sum: { quantityDelta: true },
    });
    const onHand = agg._sum.quantityDelta ?? 0;
    await db.inventoryLot.update({
        where: { id_tenantId: { id: input.lotId, tenantId: ctx.tenantId } },
        data: { quantityOnHand: onHand },
    });

    return {
        id: row.id,
        entryHash: row.entryHash,
        previousHash: row.previousHash,
        quantityOnHand: decimalToCanonical(onHand as unknown as { toFixed(n: number): string }, QUANTITY_SCALE)!,
    };
}

// ─── Lot genealogy (append-only provenance graph) ───────────────────

export interface LotLinkInput {
    /** The source/consumed lot (e.g. a seed or fertiliser lot). */
    parentLotId: string;
    /** The produced lot (e.g. the HARVEST_IN lot). */
    childLotId: string;
    type?: 'DERIVATION' | 'SPLIT' | 'MERGE';
    /** The HARVEST journal entry that recorded this derivation. */
    logEntryId?: string | null;
    note?: string | null;
    actorUserId?: string | null;
}

/**
 * Append one lot-genealogy edge. Like the ledger, LotLink is append-only
 * (a DB trigger blocks UPDATE/DELETE) and is the SECOND table written
 * only here, so `no-direct-stock-writes` can cover both. The write is
 * idempotent on the `(tenantId, parentLotId, childLotId)` unique edge
 * (`skipDuplicates`), and a self-edge (`parent === child`) is rejected
 * outright — a lot can never be its own ancestor. MUST run inside a
 * `runInTenantContext` transaction.
 */
export async function appendLotLink(
    db: PrismaTx,
    ctx: RequestContext,
    input: LotLinkInput,
): Promise<{ created: boolean }> {
    if (input.parentLotId === input.childLotId) {
        return { created: false };
    }
    const res = await db.lotLink.createMany({
        data: [
            {
                tenantId: ctx.tenantId,
                parentLotId: input.parentLotId,
                childLotId: input.childLotId,
                type: input.type ?? 'DERIVATION',
                logEntryId: input.logEntryId ?? null,
                note: input.note ?? null,
                actorUserId: input.actorUserId ?? ctx.userId ?? null,
            },
        ],
        skipDuplicates: true,
    });
    return { created: res.count > 0 };
}

export interface StockChainVerification {
    tenantId: string;
    totalEntries: number;
    valid: boolean;
    firstBreakAt?: number;
    firstBreakId?: string;
}

/**
 * Recompute the tenant's stock chain from scratch and report integrity.
 * Walks in the same total order the writer uses (createdAt ASC, id ASC).
 */
export async function verifyStockChain(
    db: PrismaTx,
    tenantId: string,
): Promise<StockChainVerification> {
    const rows = await db.stockTransaction.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
            id: true,
            lotId: true,
            type: true,
            quantityDelta: true,
            unitId: true,
            occurredAt: true,
            logEntryId: true,
            reason: true,
            costAmount: true,
            costCurrency: true,
            actorUserId: true,
            previousHash: true,
            entryHash: true,
        },
        // guardrail-allow: unbounded — integrity sweep must read the full chain.
    });

    let valid = true;
    let expectedPrev: string | null = null;
    let firstBreakAt: number | undefined;
    let firstBreakId: string | undefined;

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.previousHash !== expectedPrev && !(i === 0 && r.previousHash === null)) {
            valid = false;
            firstBreakAt = i;
            firstBreakId = r.id;
            break;
        }
        const recomputed = computeStockEntryHash({
            tenantId,
            lotId: r.lotId,
            type: r.type,
            quantityDelta: decimalToCanonical(r.quantityDelta as unknown as { toFixed(n: number): string }, QUANTITY_SCALE)!,
            unitId: r.unitId,
            occurredAt: toCanonicalTimestamp(r.occurredAt),
            logEntryId: r.logEntryId,
            reason: r.reason,
            costAmount: decimalToCanonical(
                (r.costAmount as unknown as { toFixed(n: number): string } | null),
                COST_SCALE,
            ),
            costCurrency: r.costCurrency,
            actorUserId: r.actorUserId,
            previousHash: r.previousHash,
            version: STOCK_HASH_VERSION,
        });
        if (recomputed !== r.entryHash) {
            valid = false;
            firstBreakAt = i;
            firstBreakId = r.id;
            break;
        }
        expectedPrev = r.entryHash;
    }

    return { tenantId, totalEntries: rows.length, valid, firstBreakAt, firstBreakId };
}

export interface LotBalanceDrift {
    lotId: string;
    lotCode: string;
    /** The denormalised `InventoryLot.quantityOnHand` cache (canonical 4dp). */
    cached: string;
    /** `SUM(StockTransaction.quantityDelta)` for the lot (canonical 4dp). */
    computed: string;
}

export interface LotNegativeBalance {
    lotId: string;
    lotCode: string;
    /** The ledger-derived on-hand that is below zero (canonical 4dp). */
    onHand: string;
}

export interface LotBalanceVerification {
    tenantId: string;
    lotsChecked: number;
    /** True when every lot's cache equals its ledger sum (cache consistency). */
    balanced: boolean;
    /** Lots whose cache disagrees with the ledger sum (empty when balanced). */
    drift: LotBalanceDrift[];
    /**
     * Lots whose AUTHORITATIVE ledger sum is below zero — a conservation
     * violation (more consumed than ever received). Distinct from `drift`:
     * the cache can faithfully mirror a negative sum, so this is a SEPARATE
     * anomaly the reconciliation must not silently pass.
     */
    negative: LotNegativeBalance[];
    /** The single "is the balance layer clean?" flag: balanced AND no negatives. */
    healthy: boolean;
}

/**
 * The full on-demand reconciliation result — BOTH integrity halves.
 * "Verified intact" can no longer hide a drifted or negative cache: the
 * admin reconcile returns the chain verification EXTENDED with the balance
 * verification (`healthy` folds cache-drift + negative on-hand together).
 */
export interface StockLedgerReconciliation extends StockChainVerification {
    balances: LotBalanceVerification;
}

/**
 * Reconcile every lot's denormalised `quantityOnHand` cache against the
 * AUTHORITATIVE ledger sum (`SUM(quantityDelta)`). The cache is refreshed
 * on every append, but a bug, a partial write, or an out-of-band edit
 * could drift it — this is the financial-integrity check the daily
 * reconciliation job runs alongside the hash-chain verification.
 * Canonical 4dp string comparison avoids Decimal/float equality noise.
 */
export async function verifyLotBalances(
    db: PrismaTx,
    tenantId: string,
): Promise<LotBalanceVerification> {
    const lots = await db.inventoryLot.findMany({
        where: { tenantId },
        select: { id: true, lotCode: true, quantityOnHand: true },
        // guardrail-allow: unbounded — reconciliation must read every lot.
    });
    const sums = await db.stockTransaction.groupBy({
        by: ['lotId'],
        where: { tenantId },
        _sum: { quantityDelta: true },
    });
    const sumByLot = new Map<string, unknown>(sums.map((s) => [s.lotId, s._sum.quantityDelta ?? 0]));

    const drift: LotBalanceDrift[] = [];
    const negative: LotNegativeBalance[] = [];
    for (const lot of lots) {
        const rawSum = sumByLot.get(lot.id) ?? 0;
        const cached = decimalToCanonical(
            lot.quantityOnHand as unknown as { toFixed(n: number): string },
            QUANTITY_SCALE,
        )!;
        const computed = decimalToCanonical(
            rawSum as { toFixed(n: number): string },
            QUANTITY_SCALE,
        )!;
        if (cached !== computed) {
            drift.push({ lotId: lot.id, lotCode: lot.lotCode, cached, computed });
        }
        // Conservation: the AUTHORITATIVE ledger sum must never be
        // negative. A negative sum means more was consumed than ever
        // received (over-consumption / untracked stock) — flag it even
        // when the cache faithfully mirrors it, so a "balanced" cache
        // can't hide an impossible on-hand.
        if (Number(rawSum) < 0) {
            negative.push({ lotId: lot.id, lotCode: lot.lotCode, onHand: computed });
        }
    }
    const balanced = drift.length === 0;
    return {
        tenantId,
        lotsChecked: lots.length,
        balanced,
        drift,
        negative,
        healthy: balanced && negative.length === 0,
    };
}
