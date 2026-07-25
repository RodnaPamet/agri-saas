/**
 * Contract Delivery-Window Sweep (grain fulfilment)
 *
 * Daily cross-tenant sweep: for every ACTIVE grain contract whose
 * delivery window is closing or has already closed, fire a
 * CONTRACT_DELIVERY_DUE notification to the tenant's active OWNER/ADMIN
 * members so the grain moves — or the contract is renegotiated — before
 * it becomes a default.
 *
 * Before this job, `deliveryStart` / `deliveryEnd` were write-only
 * decoration: the form captured them, the list printed the start date,
 * and nothing ever asked whether a window had run out. The
 * `[tenantId, deliveryStart]` index backed no query at all.
 *
 * ## Scope: ACTIVE only
 *
 * Mirrors `deriveContractWindowState`, which the list badge uses — the
 * badge on screen and the notification in the bell come from the SAME
 * predicate, so they cannot disagree. DRAFT is unsigned, CANCELLED is
 * void, and DELIVERED / SETTLED are already fulfilled; flagging any of
 * them would train operators to ignore the signal.
 *
 * ## Dedupe: one alert per phase, not per day
 *
 * The key buckets on (contract, recipient, deliveryEnd, phase) where
 * phase is `closing` or `overdue`. A contract therefore alerts at most
 * twice — once as the window approaches, once when it lapses — instead
 * of every morning for a month. Moving the delivery date mints a fresh
 * bucket, which is correct: a renegotiated window is a new deadline.
 *
 * The message carries the OUTSTANDING tonnage (from the GrainDelivery
 * ledger), because "your window closes in 3 days" is far less useful
 * than "300 t of 500 t still to deliver by Friday".
 *
 * Reads/writes use the privileged worker prisma connection
 * (cross-tenant, same pattern as `lease-expiry-sweep`). The
 * `[tenantId, status, deliveryEnd]` index on Contract backs the window
 * scan.
 *
 * Schedule: daily at 07:30 UTC (see schedules.ts)
 *
 * @module app-layer/jobs/contract-delivery-window-sweep
 */
import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { publishNotificationEvent } from '@/lib/notifications/notification-bus';
import { CLOSING_SOON_DAYS, daysUntil } from '@/lib/grain/contract-window';
import type { JobRunResult } from './types';

export interface ContractDeliveryWindowSweepOptions {
    /** Restrict the sweep to a single tenant (default: all tenants). */
    tenantId?: string;
    /** Reminder window in days before deliveryEnd (default 14). */
    withinDays?: number;
    /** Injectable clock for deterministic tests. */
    now?: Date;
}

export interface ContractDeliveryWindowSweepResult {
    result: JobRunResult;
    /** Contracts inside the alerting window (approaching or overdue). */
    flagged: number;
    notified: number;
}

const DEFAULT_WITHIN_DAYS = CLOSING_SOON_DAYS;

/** How far back to keep nagging about a lapsed window. Past this the
 *  contract needs a human decision, not another notification. */
const OVERDUE_LOOKBACK_DAYS = 90;

/** Contracts scanned per run. Bounded like every other sweep. */
const SCAN_TAKE = 10000;

type Phase = 'closing' | 'overdue';

/** One alert per (contract, recipient, deliveryEnd, phase). */
function deliveryWindowDedupeKey(
    tenantId: string,
    contractId: string,
    userId: string,
    endYmd: string,
    phase: Phase,
): string {
    return `contract-delivery:${tenantId}:${contractId}:${userId}:${endYmd}:${phase}`;
}

export async function runContractDeliveryWindowSweep(
    options: ContractDeliveryWindowSweepOptions = {},
): Promise<ContractDeliveryWindowSweepResult> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob(
        'contract-delivery-window-sweep',
        async () => {
            const now = options.now ?? new Date();
            const withinDays = options.withinDays ?? DEFAULT_WITHIN_DAYS;
            const windowEnd = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
            const lookbackStart = new Date(
                now.getTime() - OVERDUE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
            );

            // 1 — ACTIVE contracts whose window is closing or lapsed
            // (bounded). One range covers both phases; the phase is
            // decided per row below.
            const contracts = await prisma.contract.findMany({
                where: {
                    deletedAt: null,
                    status: 'ACTIVE',
                    deliveryEnd: { gte: lookbackStart, lte: windowEnd },
                    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
                },
                select: {
                    id: true,
                    tenantId: true,
                    counterparty: true,
                    commodity: true,
                    volumeTonnes: true,
                    deliveryEnd: true,
                },
                take: SCAN_TAKE,
            });

            let notified = 0;

            if (contracts.length > 0) {
                // 2 — outstanding tonnage per contract, in ONE groupBy
                // across every tenant in the batch (the privileged
                // connection makes this safe; the rows are keyed by
                // contractId, which is already tenant-bound).
                const deliveredByContract = new Map<string, Prisma.Decimal>();
                const groups = await prisma.grainDelivery.groupBy({
                    by: ['contractId'],
                    where: {
                        deletedAt: null,
                        contractId: { in: contracts.map((c) => c.id) },
                    },
                    _sum: { tonnes: true },
                });
                for (const g of groups) {
                    deliveredByContract.set(
                        g.contractId,
                        g._sum.tonnes ?? new Prisma.Decimal(0),
                    );
                }

                // 3 — recipients: active OWNER/ADMIN per tenant (one
                // batched query).
                const tenantIds = [...new Set(contracts.map((c) => c.tenantId))];
                const memberships = await prisma.tenantMembership.findMany({
                    where: {
                        tenantId: { in: tenantIds },
                        status: 'ACTIVE',
                        role: { in: ['OWNER', 'ADMIN'] },
                    },
                    select: { tenantId: true, userId: true, tenant: { select: { slug: true } } },
                    take: 5000,
                });
                const recipientsByTenant = new Map<string, { userId: string; slug: string }[]>();
                for (const m of memberships) {
                    const list = recipientsByTenant.get(m.tenantId) ?? [];
                    list.push({ userId: m.userId, slug: m.tenant.slug });
                    recipientsByTenant.set(m.tenantId, list);
                }

                // 4 — candidate rows, dropping ones already sent for
                // this contract + phase.
                const candidates = contracts.flatMap((contract) => {
                    const end = contract.deliveryEnd!;
                    const endYmd = end.toISOString().slice(0, 10);
                    const days = daysUntil(end, now);
                    const phase: Phase = days < 0 ? 'overdue' : 'closing';

                    const delivered =
                        deliveredByContract.get(contract.id) ?? new Prisma.Decimal(0);
                    const outstanding =
                        contract.volumeTonnes != null
                            ? Prisma.Decimal.max(
                                  contract.volumeTonnes.minus(delivered),
                                  new Prisma.Decimal(0),
                              )
                            : null;

                    // Fully delivered but still flagged ACTIVE: the
                    // grain moved, so there is nothing to chase. The
                    // operator still needs to advance the status, but
                    // that is a nudge this alert should not impersonate.
                    if (outstanding != null && outstanding.isZero()) return [];

                    const what = contract.commodity
                        ? `${contract.commodity} (${contract.counterparty})`
                        : contract.counterparty;
                    const outstandingText =
                        outstanding != null
                            ? ` Остават ${outstanding.toFixed()} т за доставка.`
                            : '';

                    return (recipientsByTenant.get(contract.tenantId) ?? []).map((r) => ({
                        tenantId: contract.tenantId,
                        userId: r.userId,
                        type: 'CONTRACT_DELIVERY_DUE' as const,
                        title:
                            phase === 'overdue'
                                ? 'Просрочен срок за доставка'
                                : 'Наближаващ срок за доставка',
                        message:
                            phase === 'overdue'
                                ? `Срокът за доставка по договора за ${what} изтече на ${endYmd} (преди ${Math.abs(days)} дни).${outstandingText}`
                                : `Срокът за доставка по договора за ${what} изтича на ${endYmd} (след ${days} дни).${outstandingText}`,
                        linkUrl: `/t/${r.slug}/grain/contracts`,
                        dedupeKey: deliveryWindowDedupeKey(
                            contract.tenantId,
                            contract.id,
                            r.userId,
                            endYmd,
                            phase,
                        ),
                    }));
                });

                if (candidates.length > 0) {
                    const keys = candidates.map((c) => c.dedupeKey);
                    const existing = await prisma.notification.findMany({
                        where: { dedupeKey: { in: keys } },
                        select: { dedupeKey: true },
                        take: keys.length,
                    });
                    const seen = new Set(existing.map((e) => e.dedupeKey));
                    const fresh = candidates.filter((c) => !seen.has(c.dedupeKey));

                    if (fresh.length > 0) {
                        const res = await prisma.notification.createMany({
                            data: fresh,
                            skipDuplicates: true,
                        });
                        notified = res.count;
                        for (const row of fresh) {
                            publishNotificationEvent(row.tenantId, row.userId, {
                                id: row.dedupeKey,
                                type: row.type,
                                title: row.title,
                                message: row.message,
                                read: false,
                                linkUrl: row.linkUrl,
                                createdAt: now.toISOString(),
                            });
                        }
                    }
                }
            }

            logger.info('contract delivery window sweep completed', {
                component: 'job',
                jobName: 'contract-delivery-window-sweep',
                scope: options.tenantId ? 'tenant-scoped' : 'system-wide',
                ...(options.tenantId ? { tenantId: options.tenantId } : {}),
                flagged: contracts.length,
                notified,
            });

            const durationMs = Math.round(performance.now() - startMs);
            const result: JobRunResult = {
                jobName: 'contract-delivery-window-sweep',
                jobRunId,
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs,
                itemsScanned: contracts.length,
                itemsActioned: notified,
                itemsSkipped: contracts.length - notified,
                details: { flagged: contracts.length, notified },
            };

            return { result, flagged: contracts.length, notified };
        },
        { tenantId: options.tenantId },
    );
}
