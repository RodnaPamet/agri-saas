/**
 * Lease-Expiry Sweep (roadmap 3/3)
 *
 * Daily cross-tenant sweep: for every active parcel lease (аренда/наем) whose
 * `endDate` falls within the reminder window (default 30 days), fire a
 * LEASE_EXPIRING notification to the tenant's active OWNER/ADMIN members so the
 * contract is renewed or ended before it lapses.
 *
 * Dedupe is one notification per (lease, recipient, endDate) — the endDate
 * bucket means a lease alerts once per contract, not daily. Reads/writes use the
 * privileged worker prisma connection (cross-tenant, same pattern as
 * `reconcile-inventory-ledgers`; `low-stock-monitor` carried this
 * shape too until it was removed in 2026-11). The `[tenantId, endDate]` index on ParcelLease backs the
 * window scan.
 *
 * Schedule: daily at 07:00 UTC (see schedules.ts)
 *
 * @module app-layer/jobs/lease-expiry-sweep
 */
import prisma from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { publishFreshNotifications } from '@/app-layer/notifications/publish-fresh';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';
import { ALERT_DAYS } from '@/lib/agro/lease-expiry';
import type { JobRunResult } from './types';

export interface LeaseExpirySweepOptions {
    /** Restrict the sweep to a single tenant (default: all tenants). */
    tenantId?: string;
    /** Reminder window in days before endDate (default 30). */
    withinDays?: number;
    /** Injectable clock for deterministic tests. */
    now?: Date;
}

export interface LeaseExpirySweepResult {
    result: JobRunResult;
    expiring: number;
    notified: number;
}

// The reminder window is the shared ALERT tier (30d) — when this sweep fires,
// the Rent-table + card badges for the same lease are red by construction.
const DEFAULT_WITHIN_DAYS = ALERT_DAYS;

/** One alert per (lease, recipient, endDate) — buckets by the contract end. */
function leaseExpiryDedupeKey(tenantId: string, leaseId: string, userId: string, endYmd: string): string {
    return `lease-expiry:${tenantId}:${leaseId}:${userId}:${endYmd}`;
}

export async function runLeaseExpirySweep(
    options: LeaseExpirySweepOptions = {},
): Promise<LeaseExpirySweepResult> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob(
        'lease-expiry-sweep',
        async () => {
            const now = options.now ?? new Date();
            const withinDays = options.withinDays ?? DEFAULT_WITHIN_DAYS;
            const windowEnd = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

            // 1 — active leases ending within the window (bounded).
            const leases = await prisma.parcelLease.findMany({
                where: {
                    deletedAt: null,
                    endDate: { gte: now, lte: windowEnd },
                    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
                },
                select: {
                    id: true,
                    tenantId: true,
                    lessorName: true,
                    endDate: true,
                    // locationId drives the notification deep-link into the
                    // location-scoped Rent view.
                    parcel: { select: { name: true, locationId: true } },
                },
                take: 10000,
            });

            let notified = 0;

            if (leases.length > 0) {
                // 2 — recipients: active OWNER/ADMIN per tenant (one batched query).
                const tenantIds = [...new Set(leases.map((l) => l.tenantId))];
                const memberships = await prisma.tenantMembership.findMany({
                    where: { tenantId: { in: tenantIds }, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
                    select: {
                        tenantId: true,
                        userId: true,
                        tenant: { select: { slug: true } },
                        // The locale comes off a relation this query ALREADY
                        // walks, rather than a second lookup per recipient —
                        // the D1 N+1 the `sla-monitor` half of #2542 had to
                        // undo. `include` returns every scalar, so this costs
                        // nothing extra.
                        user: { select: { uiLanguage: true } },
                    },
                    take: 5000,
                });
                const recipientsByTenant = new Map<
                    string,
                    { userId: string; slug: string; locale: Locale }[]
                >();
                for (const m of memberships) {
                    const list = recipientsByTenant.get(m.tenantId) ?? [];
                    list.push({
                        userId: m.userId,
                        slug: m.tenant.slug,
                        // `bg` when the column is null — `resolveRecipientLocale`'s
                        // fallback, deliberately NOT `DEFAULT_LOCALE`, which is
                        // `en` and documented for UNAUTHENTICATED surfaces. A
                        // lease notification goes to a known user whose column
                        // default is `bg`.
                        locale: resolveRecipientLocale(m.user?.uiLanguage ?? null),
                    });
                    recipientsByTenant.set(m.tenantId, list);
                }

                // 3 — candidate rows, drop ones already sent for this contract.
                // A `for` loop rather than `flatMap`, because `translateFor` is
                // async and a `.map` of promises would put unresolved promises
                // in `data` — the trap the low-stock half of #2542 records.
                const candidates: {
                    tenantId: string;
                    userId: string;
                    type: 'LEASE_EXPIRING';
                    title: string;
                    message: string;
                    linkUrl: string;
                    dedupeKey: string;
                }[] = [];
                for (const lease of leases) {
                    const endYmd = lease.endDate!.toISOString().slice(0, 10);
                    const daysLeft = Math.max(
                        0,
                        Math.ceil((lease.endDate!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
                    );
                    for (const r of recipientsByTenant.get(lease.tenantId) ?? []) {
                        candidates.push({
                            tenantId: lease.tenantId,
                            userId: r.userId,
                            type: 'LEASE_EXPIRING' as const,
                            title: await translateFor(r.locale, 'notifications.leaseExpiring.title'),
                            message: await translateFor(r.locale, 'notifications.leaseExpiring.body', {
                                parcel: lease.parcel.name,
                                lessor: lease.lessorName,
                                date: endYmd,
                                // AFTER a label in the copy, never before a noun.
                                // `translateFor` is a simple interpolate with NO
                                // ICU, so a plural that needs grammatical
                                // agreement cannot be expressed — «дни: 5» is
                                // correct at any count in both languages.
                                days: String(daysLeft),
                            }),
                            // Deep-link to the Rent register — scoped to the parcel's
                            // location when it has one (the location page deep-links
                            // the same way).
                            linkUrl: `/t/${r.slug}/rent${lease.parcel.locationId ? `?locationId=${lease.parcel.locationId}` : ''}`,
                            dedupeKey: leaseExpiryDedupeKey(lease.tenantId, lease.id, r.userId, endYmd),
                        });
                    }
                }

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
                        // One read for the batch, then a frame per row carrying its
                        // ROW id. A dedupeKey here becomes the client's
                        // `Last-Event-ID` and resolves to nothing, so a reconnect
                        // right after a sweep replayed nothing — and a sweep is
                        // exactly when a client has most to catch up on (#2142).
                        await publishFreshNotifications(prisma, 'notify.lease-expiry', fresh.map((row) => ({
                            tenantId: row.tenantId,
                            userId: row.userId,
                            dedupeKey: row.dedupeKey,
                        })));
                    }
                }
            }

            logger.info('lease expiry sweep completed', {
                component: 'job',
                jobName: 'lease-expiry-sweep',
                scope: options.tenantId ? 'tenant-scoped' : 'system-wide',
                ...(options.tenantId ? { tenantId: options.tenantId } : {}),
                expiring: leases.length,
                notified,
            });

            const durationMs = Math.round(performance.now() - startMs);
            const result: JobRunResult = {
                jobName: 'lease-expiry-sweep',
                jobRunId,
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs,
                itemsScanned: leases.length,
                itemsActioned: notified,
                itemsSkipped: leases.length - notified,
                details: { expiring: leases.length, notified },
            };

            return { result, expiring: leases.length, notified };
        },
        { tenantId: options.tenantId },
    );
}
