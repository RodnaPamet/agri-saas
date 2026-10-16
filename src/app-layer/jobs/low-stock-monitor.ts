/**
 * Low-Stock Monitor
 *
 * Daily cross-tenant sweep: for every Item with a `reorderLevel` set,
 * compute total on-hand (Σ of its non-deleted lots' `quantityOnHand`)
 * and, when it has dropped below the threshold, fire a LOW_STOCK
 * notification to the tenant's active OWNER/ADMIN members.
 *
 * Dedupe is one notification per (item, recipient, day): the `dedupeKey`
 * carries the date bucket, so a still-low item re-alerts the next day but
 * never twice in one run. Reads/writes use the privileged worker prisma
 * connection (same cross-tenant pattern as `risk-appetite-jobs.ts`); the
 * Σ-on-hand is a single grouped query (never per-item N+1).
 *
 * Schedule: daily at 09:00 UTC (see schedules.ts)
 *
 * @module app-layer/jobs/low-stock-monitor
 */
import prisma from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { publishNotificationEvent } from '@/lib/notifications/notification-bus';
import { afterCommit } from '@/lib/db/after-commit';
import type { JobRunResult } from './types';

export interface LowStockMonitorOptions {
    /** Restrict the sweep to a single tenant (default: all tenants). */
    tenantId?: string;
    /** Injectable clock for deterministic tests. */
    now?: Date;
}

export interface LowStockItem {
    itemId: string;
    tenantId: string;
    name: string;
    onHand: number;
    reorderLevel: number;
}

export interface LowStockMonitorResult {
    result: JobRunResult;
    lowItems: LowStockItem[];
    notified: number;
}

function toNum(d: unknown): number {
    if (d === null || d === undefined) return 0;
    return typeof d === 'number' ? d : Number(d as { toString(): string });
}

/** One alert per (item, recipient, day) — the date bucket re-arms daily. */
function lowStockDedupeKey(tenantId: string, itemId: string, userId: string, day: string): string {
    return `low-stock:${tenantId}:${itemId}:${userId}:${day}`;
}

export async function runLowStockMonitor(
    options: LowStockMonitorOptions = {},
): Promise<LowStockMonitorResult> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob(
        'low-stock-monitor',
        async () => {
            const now = options.now ?? new Date();
            const day = now.toISOString().slice(0, 10);

            // 1 — items that declare a reorder threshold.
            const items = await prisma.item.findMany({
                where: {
                    deletedAt: null,
                    reorderLevel: { not: null },
                    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
                },
                select: { id: true, tenantId: true, name: true, reorderLevel: true },
                take: 10000,
            });

            let lowItems: LowStockItem[] = [];
            let notified = 0;

            if (items.length > 0) {
                // 2 — total on-hand per item (one grouped query, not N+1).
                const itemIds = items.map((i) => i.id);
                const sums = await prisma.inventoryLot.groupBy({
                    by: ['itemId'],
                    where: { itemId: { in: itemIds }, deletedAt: null },
                    _sum: { quantityOnHand: true },
                });
                const onHandByItem = new Map(sums.map((s) => [s.itemId, toNum(s._sum.quantityOnHand)]));

                // 3 — the items below threshold.
                lowItems = items
                    .map((i) => ({
                        itemId: i.id,
                        tenantId: i.tenantId,
                        name: i.name,
                        onHand: onHandByItem.get(i.id) ?? 0,
                        reorderLevel: toNum(i.reorderLevel),
                    }))
                    .filter((i) => i.onHand < i.reorderLevel);

                if (lowItems.length > 0) {
                    // 4 — recipients: active OWNER/ADMIN per tenant (one batched query).
                    const tenantIds = [...new Set(lowItems.map((i) => i.tenantId))];
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

                    // 5 — build candidate rows, drop ones already sent today.
                    const candidates = lowItems.flatMap((item) =>
                        (recipientsByTenant.get(item.tenantId) ?? []).map((r) => ({
                            tenantId: item.tenantId,
                            userId: r.userId,
                            type: 'LOW_STOCK' as const,
                            title: 'Low stock',
                            message: `${item.name} is low — ${item.onHand} on hand, reorder at ${item.reorderLevel}.`,
                            linkUrl: `/t/${r.slug}/inventory`,
                            dedupeKey: lowStockDedupeKey(item.tenantId, item.itemId, r.userId, day),
                        })),
                    );

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
                            const res = await prisma.notification.createMany({ data: fresh, skipDuplicates: true });
                            notified = res.count;
                            for (const row of fresh) {
                                afterCommit('notify.low-stock', () =>
                                    publishNotificationEvent(row.tenantId, row.userId, { id: row.dedupeKey }),
                                );
                            }
                        }
                    }
                }
            }

            logger.info('low stock monitor completed', {
                component: 'job',
                jobName: 'low-stock-monitor',
                scope: options.tenantId ? 'tenant-scoped' : 'system-wide',
                ...(options.tenantId ? { tenantId: options.tenantId } : {}),
                itemsWithThreshold: items.length,
                lowItems: lowItems.length,
                notified,
            });

            const durationMs = Math.round(performance.now() - startMs);
            const result: JobRunResult = {
                jobName: 'low-stock-monitor',
                jobRunId,
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs,
                itemsScanned: items.length,
                itemsActioned: notified,
                itemsSkipped: items.length - lowItems.length,
                details: { lowItems: lowItems.length, notified },
            };

            return { result, lowItems, notified };
        },
        { tenantId: options.tenantId },
    );
}
