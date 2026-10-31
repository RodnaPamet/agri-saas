/**
 * Low-Stock Monitor
 *
 * Daily cross-tenant sweep: for every Item with a `reorderLevel` set,
 * compute total on-hand (Σ of its non-deleted lots' `quantityOnHand`)
 * and, when it has dropped below the threshold, fire a LOW_STOCK
 * notification to the tenant's active OWNER/ADMIN members.
 *
 * Dedupe is one notification per EPISODE of an item being low, not one per
 * day. `Item.lowStockNotifiedAt` is the episode marker: the sweep stamps it
 * when an item drops below its level and alerts, and CLEARS it when on-hand
 * recovers to at-or-above the level, which re-arms the next drop.
 *
 * It used to carry a date bucket, so a still-low item re-alerted every
 * morning. Measured in production 2026-10-30: 9,438 LOW_STOCK rows against 44
 * of every other kind combined, growing ~66 a day — and because the phone
 * reads only the newest 50 notifications, the flood pushed every other kind
 * off the farm's notification screen. Owner ruling 2026-10-31: once per item,
 * until it is restocked and drops again.
 *
 * `dedupeKey` still carries the episode's instant rather than nothing at all,
 * because the column is `@unique`: a key stable across episodes would make
 * the SECOND episode a duplicate and silently drop it for ever.
 *
 * Copy is in the RECIPIENT's language, resolved per member from
 * `User.uiLanguage` — not the sweep's, which has no language of its own. This
 * job hardcoded English and is why the owner saw an English «Известия» screen
 * on a Bulgarian phone (#2511).
 *
 * Reads/writes use the privileged worker prisma connection (same cross-tenant
 * pattern as `risk-appetite-jobs.ts`); the Σ-on-hand is a single grouped query
 * (never per-item N+1).
 *
 * Schedule: daily at 09:00 UTC (see schedules.ts)
 *
 * @module app-layer/jobs/low-stock-monitor
 */
import prisma from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { publishFreshNotifications } from '@/app-layer/notifications/publish-fresh';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { translateFor } from '@/lib/i18n/server-messages';
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

/**
 * One alert per (item, recipient, EPISODE).
 *
 * The last segment is the instant the episode was detected, not a date bucket.
 * `Notification.dedupeKey` is `@unique`, so a key stable across episodes would
 * make an item's second drop a duplicate of its first and drop it silently —
 * for ever, since the key never changes again. The episode marker lives on
 * `Item.lowStockNotifiedAt`; this only has to be distinct per episode.
 */
function lowStockDedupeKey(
    tenantId: string,
    itemId: string,
    userId: string,
    episodeAt: Date,
): string {
    return `low-stock:${tenantId}:${itemId}:${userId}:${episodeAt.toISOString()}`;
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

            // 1 — items that declare a reorder threshold.
            const items = await prisma.item.findMany({
                where: {
                    deletedAt: null,
                    reorderLevel: { not: null },
                    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
                },
                select: {
                    id: true,
                    tenantId: true,
                    name: true,
                    reorderLevel: true,
                    lowStockNotifiedAt: true,
                },
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

                // 3 — assess every item with a threshold, and keep the episode
                // marker beside the figures so the two decisions below can be
                // read off one array.
                const assessed = items.map((i) => ({
                    itemId: i.id,
                    tenantId: i.tenantId,
                    name: i.name,
                    onHand: onHandByItem.get(i.id) ?? 0,
                    reorderLevel: toNum(i.reorderLevel),
                    announcedAt: i.lowStockNotifiedAt,
                }));

                lowItems = assessed
                    .filter((i) => i.onHand < i.reorderLevel)
                    .map(({ itemId, tenantId, name, onHand, reorderLevel }) => ({
                        itemId,
                        tenantId,
                        name,
                        onHand,
                        reorderLevel,
                    }));

                // 4 — RECOVERED items re-arm. Done before the alerting branch and
                // unconditionally, because an item that recovered is not in
                // `newlyLow` and would otherwise keep its marker for ever — the
                // next genuine drop would then be silent, which is a worse
                // failure than the flood this replaces.
                const recoveredIds = assessed
                    .filter((i) => i.onHand >= i.reorderLevel && i.announcedAt !== null)
                    .map((i) => i.itemId);
                if (recoveredIds.length > 0) {
                    await prisma.item.updateMany({
                        where: { id: { in: recoveredIds } },
                        data: { lowStockNotifiedAt: null },
                    });
                }

                // 5 — only a NEW episode alerts. An item already below its level
                // and already announced says nothing further until it recovers.
                const newlyLow = assessed.filter(
                    (i) => i.onHand < i.reorderLevel && i.announcedAt === null,
                );

                if (newlyLow.length > 0) {
                    // 6 — recipients: active OWNER/ADMIN per tenant (one batched
                    // query). `uiLanguage` rides along because the copy is in the
                    // RECIPIENT's language and this sweep has none of its own.
                    const tenantIds = [...new Set(newlyLow.map((i) => i.tenantId))];
                    const memberships = await prisma.tenantMembership.findMany({
                        where: {
                            tenantId: { in: tenantIds },
                            status: 'ACTIVE',
                            role: { in: ['OWNER', 'ADMIN'] },
                        },
                        select: {
                            tenantId: true,
                            userId: true,
                            tenant: { select: { slug: true } },
                            user: { select: { uiLanguage: true } },
                        },
                        take: 5000,
                    });
                    const recipientsByTenant = new Map<
                        string,
                        { userId: string; slug: string; uiLanguage: unknown }[]
                    >();
                    for (const m of memberships) {
                        const list = recipientsByTenant.get(m.tenantId) ?? [];
                        list.push({
                            userId: m.userId,
                            slug: m.tenant.slug,
                            uiLanguage: m.user?.uiLanguage ?? null,
                        });
                        recipientsByTenant.set(m.tenantId, list);
                    }

                    // 7 — one row per (item, recipient), copy resolved per
                    // recipient. A `for` loop rather than `flatMap`, because
                    // `translateFor` is async and a `.map` of promises would put
                    // unresolved promises in `data`.
                    const episodeAt = now;
                    const candidates: {
                        tenantId: string;
                        userId: string;
                        type: 'LOW_STOCK';
                        title: string;
                        message: string;
                        linkUrl: string;
                        dedupeKey: string;
                    }[] = [];
                    for (const item of newlyLow) {
                        for (const r of recipientsByTenant.get(item.tenantId) ?? []) {
                            const locale = resolveRecipientLocale(r.uiLanguage);
                            candidates.push({
                                tenantId: item.tenantId,
                                userId: r.userId,
                                type: 'LOW_STOCK' as const,
                                title: await translateFor(locale, 'notifications.lowStock.title'),
                                message: await translateFor(locale, 'notifications.lowStock.body', {
                                    name: item.name,
                                    onHand: String(item.onHand),
                                    reorderLevel: String(item.reorderLevel),
                                }),
                                linkUrl: `/t/${r.slug}/inventory`,
                                dedupeKey: lowStockDedupeKey(
                                    item.tenantId,
                                    item.itemId,
                                    r.userId,
                                    episodeAt,
                                ),
                            });
                        }
                    }

                    if (candidates.length > 0) {
                        // 8 — the rows and the episode markers go in ONE
                        // transaction. Split, a crash between them is either a
                        // farm alerted with no marker (so alerted again tomorrow,
                        // the defect this change removes) or a marker with no
                        // alert (so silent until the item recovers and drops
                        // again, which is worse). There is no pre-read for
                        // existing keys any more: the marker column owns dedupe
                        // now, and `skipDuplicates` covers a re-run within the
                        // same millisecond.
                        const [res] = await prisma.$transaction([
                            prisma.notification.createMany({
                                data: candidates,
                                skipDuplicates: true,
                            }),
                            prisma.item.updateMany({
                                where: { id: { in: newlyLow.map((i) => i.itemId) } },
                                data: { lowStockNotifiedAt: episodeAt },
                            }),
                        ]);
                        notified = res.count;

                        // One read for the batch, then a frame per row carrying its
                        // ROW id. A dedupeKey here becomes the client's
                        // `Last-Event-ID` and resolves to nothing, so a reconnect
                        // right after a sweep replayed nothing — and a sweep is
                        // exactly when a client has most to catch up on (#2142).
                        //
                        // After the commit, not inside it: this publishes to
                        // clients, and announcing rows a rollback discarded is
                        // the shape `afterCommit` exists to prevent.
                        await publishFreshNotifications(prisma, 'notify.low-stock', candidates.map((row) => ({
                            tenantId: row.tenantId,
                            userId: row.userId,
                            dedupeKey: row.dedupeKey,
                        })));
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
