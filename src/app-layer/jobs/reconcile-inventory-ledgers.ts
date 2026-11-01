/**
 * Inventory Ledger Reconciliation
 *
 * Daily cross-tenant integrity sweep over the append-only stock ledger.
 * For every tenant that holds inventory it asserts BOTH halves of ledger
 * correctness:
 *   1. hash-chain integrity — `verifyStockChain` re-walks the per-tenant
 *      SHA-256 chain (no tampering / out-of-band inserts), and
 *   2. balance integrity — `verifyLotBalances` checks every lot's
 *      denormalised `quantityOnHand` cache equals the authoritative ledger
 *      `SUM(quantityDelta)`.
 *
 * Drift on either axis is logged (per-tenant `logger.warn` with the
 * offending lot ids) and recorded on the `ag.operation` metric under
 * `inventory.reconcileStockLedger` with a FAILURE outcome — the same
 * signal the `AgLedgerReconciliationDrift` SLO alert (observability epic)
 * already pages on, so the daily job and the on-demand admin reconcile
 * share one alert. The job itself never throws on drift (the report is the
 * deliverable); it only fails on an infrastructure error.
 *
 * Cross-tenant pattern mirrors `lease-expiry-sweep.ts` — the privileged
 * worker prisma connection (superuser_bypass on RLS), bounded reads.
 *
 * Schedule: daily at 04:00 UTC (see schedules.ts).
 *
 * @module app-layer/jobs/reconcile-inventory-ledgers
 */
import prisma from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { recordAgOperationMetrics } from '@/lib/observability/metrics';
import { verifyStockChain, verifyLotBalances } from '@/lib/inventory/stock-ledger';
import type { PrismaTx } from '@/lib/db-context';
import type { JobRunResult } from './types';

const MAX_TENANTS = 10000;

export interface ReconcileInventoryLedgersOptions {
    /** Restrict the sweep to a single tenant (default: all with inventory). */
    tenantId?: string;
}

export interface TenantReconciliation {
    tenantId: string;
    chainValid: boolean;
    chainEntries: number;
    chainFirstBreakId?: string;
    lotsChecked: number;
    balanced: boolean;
    driftCount: number;
    /** Lots whose ledger sum is below zero (conservation violation). */
    negativeCount: number;
}

export interface ReconcileInventoryLedgersResult {
    result: JobRunResult;
    tenantsChecked: number;
    tenantsWithDrift: number;
    reconciliations: TenantReconciliation[];
}

export async function runReconcileInventoryLedgers(
    options: ReconcileInventoryLedgersOptions = {},
): Promise<ReconcileInventoryLedgersResult> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob(
        'reconcile-inventory-ledgers',
        async () => {
            // 1 — tenants to reconcile (those that hold inventory).
            let tenantIds: string[];
            if (options.tenantId) {
                tenantIds = [options.tenantId];
            } else {
                const rows = await prisma.inventoryLot.findMany({
                    distinct: ['tenantId'],
                    select: { tenantId: true },
                    take: MAX_TENANTS,
                });
                tenantIds = rows.map((r) => r.tenantId);
            }

            // 2 — per-tenant chain + balance verification. Each tenant's
            //     ledger is independent, so this is a bounded per-tenant
            //     loop, not an N+1 over one query's rows.
            const reconciliations: TenantReconciliation[] = [];
            let tenantsWithDrift = 0;

            for (const tenantId of tenantIds) {
                const tenantStart = performance.now();
                const chain = await verifyStockChain(prisma as unknown as PrismaTx, tenantId);
                const balances = await verifyLotBalances(prisma as unknown as PrismaTx, tenantId);
                // Drift on EITHER axis, plus the third check (`healthy`
                // folds in negative on-hand — a conservation violation the
                // cache can faithfully mirror, so `balanced` alone misses it).
                const hasDrift = !chain.valid || !balances.healthy;

                if (hasDrift) {
                    tenantsWithDrift += 1;
                    logger.warn('inventory ledger drift detected', {
                        component: 'job',
                        jobName: 'reconcile-inventory-ledgers',
                        tenantId,
                        chainValid: chain.valid,
                        chainFirstBreakId: chain.firstBreakId,
                        chainFirstBreakAt: chain.firstBreakAt,
                        balanced: balances.balanced,
                        driftLots: balances.drift.map((d) => ({
                            lotId: d.lotId,
                            lotCode: d.lotCode,
                            cached: d.cached,
                            computed: d.computed,
                        })),
                        negativeLots: balances.negative.map((n) => ({
                            lotId: n.lotId,
                            lotCode: n.lotCode,
                            onHand: n.onHand,
                        })),
                    });
                }

                // Feed the SAME ag.operation drift signal the on-demand
                // admin reconcile emits, so one SLO alert covers both.
                recordAgOperationMetrics({
                    operation: 'inventory.reconcileStockLedger',
                    success: !hasDrift,
                    durationMs: Math.round(performance.now() - tenantStart),
                });

                reconciliations.push({
                    tenantId,
                    chainValid: chain.valid,
                    chainEntries: chain.totalEntries,
                    chainFirstBreakId: chain.firstBreakId,
                    lotsChecked: balances.lotsChecked,
                    balanced: balances.balanced,
                    driftCount: balances.drift.length,
                    negativeCount: balances.negative.length,
                });
            }

            logger.info('inventory ledger reconciliation completed', {
                component: 'job',
                jobName: 'reconcile-inventory-ledgers',
                scope: options.tenantId ? 'tenant-scoped' : 'system-wide',
                ...(options.tenantId ? { tenantId: options.tenantId } : {}),
                tenantsChecked: tenantIds.length,
                tenantsWithDrift,
            });

            const durationMs = Math.round(performance.now() - startMs);
            const result: JobRunResult = {
                jobName: 'reconcile-inventory-ledgers',
                jobRunId,
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs,
                itemsScanned: tenantIds.length,
                itemsActioned: tenantsWithDrift,
                itemsSkipped: tenantIds.length - tenantsWithDrift,
                details: { tenantsChecked: tenantIds.length, tenantsWithDrift },
            };

            return { result, tenantsChecked: tenantIds.length, tenantsWithDrift, reconciliations };
        },
        { tenantId: options.tenantId },
    );
}
