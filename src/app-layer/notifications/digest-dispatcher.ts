/**
 * Digest Dispatcher — Owner-Grouped Notification Dispatch
 *
 * Takes DueItem[] from monitoring jobs, groups items by owner/tenant,
 * resolves recipient emails, builds digest templates, and enqueues
 * through the existing NotificationOutbox with deduplication.
 *
 * Architecture:
 *   Monitor → DueItem[] → DigestDispatcher → NotificationOutbox → processOutbox → Email
 *
 * Grouping rules:
 *   1. Group by tenantId first (tenant isolation)
 *   2. Within tenant, group by ownerUserId
 *   3. Items without ownerUserId go to tenant admins
 *   4. One digest email per owner per category per day
 *
 * Deduplication:
 *   Uses the existing dedupeKey pattern: {tenantId}:{type}:{email}:{digest}:{YYYY-MM-DD}
 *   Since the key includes the date, the same digest is sent at most once per day per recipient.
 *
 * @module app-layer/notifications/digest-dispatcher
 */

import { prisma } from '@/lib/prisma';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import type { Locale } from '@/lib/i18n/locales';
import { logger } from '@/lib/observability/logger';
import type { DueItem } from '../jobs/types';
import { isNotificationsEnabled } from './settings';
import {
    buildDeadlineDigestEmail,
    buildEvidenceExpiryDigestEmail,
} from './digest-templates';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Digest kinds the dispatcher can build. VENDOR_RENEWAL_DIGEST was a
 * third member until GRC teardown phase 3; its only producer,
 * `jobs/vendor-renewal-check.ts`, was deleted in phase 2, so for a
 * while the dispatcher carried a `case` arm nothing could reach and a
 * template that rendered a link to `/t/:slug/vendors`.
 */
export type DigestCategory = 'DEADLINE_DIGEST' | 'EVIDENCE_EXPIRY_DIGEST';

export interface DispatchDigestOptions {
    /** The category of digest to send */
    category: DigestCategory;
    /** DueItems from the monitoring job */
    items: DueItem[];
    /** Override current time (for testing) */
    now?: Date;
}

export interface DispatchDigestResult {
    /** Number of digest emails enqueued */
    enqueued: number;
    /** Number of digests skipped (duplicate / disabled) */
    skipped: number;
    /** Number of items that had no resolvable recipient */
    unroutable: number;
    /** Total items processed */
    totalItems: number;
    /** Number of items suppressed due to tenant notifications disabled */
    suppressed: number;
    /** Per-tenant breakdown */
    tenants: Record<string, { enqueued: number; skipped: number; suppressed?: boolean }>;
}

export interface RecipientInfo {
    userId: string;
    email: string;
    name: string;
    /**
     * The recipient's language (#694). Carried on the recipient because the
     * digest routes ONE `DueItem` to potentially SEVERAL people whose
     * `uiLanguage` differs — so the language cannot be decided when the item
     * is produced, only when it is addressed.
     */
    locale: Locale;
}

// ─── Recipient Resolution ───────────────────────────────────────────

/**
 * Resolve user IDs to email addresses.
 * Uses batch query to avoid N+1. Returns a Map for O(1) lookup.
 */
async function resolveRecipients(
    userIds: string[],
): Promise<Map<string, RecipientInfo>> {
    if (userIds.length === 0) return new Map();

    const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, name: true, uiLanguage: true },
    });

    const result = new Map<string, RecipientInfo>();
    for (const u of users) {
        if (u.email) {
            result.set(u.id, {
                userId: u.id,
                email: u.email,
                name: u.name ?? u.email.split('@')[0],
                locale: resolveRecipientLocale(u.uiLanguage),
            });
        }
    }
    return result;
}

/**
 * Resolve tenant admins as fallback recipients for unowned items.
 */
async function resolveTenantAdmins(
    tenantId: string,
): Promise<RecipientInfo[]> {
    const memberships = await prisma.tenantMembership.findMany({
        where: {
            tenantId,
            role: 'ADMIN',
            status: 'ACTIVE',
        },
        select: {
            user: {
                select: { id: true, email: true, name: true, uiLanguage: true },
            },
        },
        take: 10, // Cap to avoid spamming large admin teams
    });

    return memberships
        .filter(m => m.user.email)
        .map(m => ({
            userId: m.user.id,
            email: m.user.email,
            name: m.user.name ?? m.user.email.split('@')[0],
            locale: resolveRecipientLocale(m.user.uiLanguage),
        }));
}

/**
 * Resolve tenant slug for building links.
 */
async function resolveTenantSlug(tenantId: string): Promise<string> {
    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true },
    });
    return tenant?.slug ?? tenantId;
}

// ─── Dedupe Key Builder ─────────────────────────────────────────────

/**
 * Build a dedupe key for digest emails.
 * Format: {tenantId}:{category}:{email}:digest:{YYYY-MM-DD}
 *
 * The key is scoped to the date, so the same digest is sent at most
 * once per day per recipient per category.
 */
export function buildDigestDedupeKey(
    tenantId: string,
    category: DigestCategory,
    email: string,
    date: Date = new Date(),
): string {
    const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
    return `${tenantId}:${category}:${email}:digest:${day}`;
}

// ─── Template Selector ──────────────────────────────────────────────

async function buildDigestEmail(
    category: DigestCategory,
    recipientName: string,
    tenantSlug: string,
    items: DueItem[],
    locale: Locale,
): Promise<{ subject: string; bodyText: string; bodyHtml: string }> {
    switch (category) {
        case 'DEADLINE_DIGEST':
            return buildDeadlineDigestEmail({ recipientName, tenantSlug, items }, locale);
        case 'EVIDENCE_EXPIRY_DIGEST':
            return buildEvidenceExpiryDigestEmail({ recipientName, tenantSlug, items }, locale);
        default: {
            const _exhaustive: never = category;
            throw new Error(`Unknown digest category: ${_exhaustive}`);
        }
    }
}

// ─── Grouping ───────────────────────────────────────────────────────

interface GroupedItems {
    /** Items grouped by tenantId → ownerUserId → DueItem[] */
    byOwner: Map<string, Map<string, DueItem[]>>;
    /** Items without ownerUserId, grouped by tenantId */
    unowned: Map<string, DueItem[]>;
}

function groupItems(items: DueItem[]): GroupedItems {
    const byOwner = new Map<string, Map<string, DueItem[]>>();
    const unowned = new Map<string, DueItem[]>();

    for (const item of items) {
        if (item.ownerUserId) {
            if (!byOwner.has(item.tenantId)) {
                byOwner.set(item.tenantId, new Map());
            }
            const tenantMap = byOwner.get(item.tenantId)!;
            if (!tenantMap.has(item.ownerUserId)) {
                tenantMap.set(item.ownerUserId, []);
            }
            tenantMap.get(item.ownerUserId)!.push(item);
        } else {
            if (!unowned.has(item.tenantId)) {
                unowned.set(item.tenantId, []);
            }
            unowned.get(item.tenantId)!.push(item);
        }
    }

    return { byOwner, unowned };
}

// ─── Main Dispatch Function ─────────────────────────────────────────

/**
 * Dispatch grouped digest notifications for DueItems.
 *
 * 1. Groups items by tenant → owner
 * 2. Resolves recipient emails
 * 3. Builds digest template per recipient
 * 4. Enqueues through NotificationOutbox with deduplication
 *
 * Idempotent: safe to call multiple times per day — duplicates
 * are silently skipped via the outbox dedupeKey unique constraint.
 */
export async function dispatchDigest(
    options: DispatchDigestOptions,
): Promise<DispatchDigestResult> {
    const { category, items, now = new Date() } = options;

    if (items.length === 0) {
        return {
            enqueued: 0,
            skipped: 0,
            unroutable: 0,
            suppressed: 0,
            totalItems: 0,
            tenants: {},
        };
    }

    const { byOwner, unowned } = groupItems(items);
    let enqueued = 0;
    let skipped = 0;
    let unroutable = 0;
    let suppressed = 0;
    const tenants: Record<string, { enqueued: number; skipped: number; suppressed?: boolean }> = {};

    // Collect all unique user IDs for batch resolution
    const allUserIds = new Set<string>();
    for (const tenantMap of byOwner.values()) {
        for (const userId of tenantMap.keys()) {
            allUserIds.add(userId);
        }
    }
    const recipients = await resolveRecipients(Array.from(allUserIds));

    // Collect all unique tenant IDs
    const allTenantIds = new Set<string>();
    for (const item of items) allTenantIds.add(item.tenantId);

    // ── Tenant notification eligibility check ───────────────────────
    // Enforce the same isNotificationsEnabled rule used by enqueue.ts.
    // Disabled tenants are skipped entirely — no digest email is sent.
    const eligibleTenants = new Set<string>();
    for (const tenantId of allTenantIds) {
        const enabled = await isNotificationsEnabled(prisma, tenantId);
        if (enabled) {
            eligibleTenants.add(tenantId);
        } else {
            // Count suppressed items for this tenant
            const tenantItemCount = items.filter(i => i.tenantId === tenantId).length;
            suppressed += tenantItemCount;
            tenants[tenantId] = { enqueued: 0, skipped: 0, suppressed: true };
            logger.info('digest suppressed — notifications disabled for tenant', {
                component: 'digest-dispatcher',
                category,
                tenantId,
                itemCount: tenantItemCount,
            });
        }
    }

    // Resolve tenant slugs in batch (only eligible tenants)
    const slugs = new Map<string, string>();
    for (const tenantId of eligibleTenants) {
        slugs.set(tenantId, await resolveTenantSlug(tenantId));
    }

    // Process owned items (grouped by user)
    for (const [tenantId, tenantMap] of byOwner) {
        if (!eligibleTenants.has(tenantId)) continue; // Notifications disabled
        if (!tenants[tenantId]) tenants[tenantId] = { enqueued: 0, skipped: 0 };
        const tenantSlug = slugs.get(tenantId) ?? tenantId;

        for (const [userId, userItems] of tenantMap) {
            const recipient = recipients.get(userId);
            if (!recipient) {
                unroutable += userItems.length;
                logger.warn('digest recipient not resolvable', {
                    component: 'digest-dispatcher',
                    category,
                    tenantId,
                    userId,
                    itemCount: userItems.length,
                });
                continue;
            }

            const result = await enqueueDigest(
                tenantId, category, recipient, tenantSlug, userItems, now,
            );
            if (result) {
                enqueued++;
                tenants[tenantId].enqueued++;
            } else {
                skipped++;
                tenants[tenantId].skipped++;
            }
        }
    }

    // Process unowned items → send to tenant admins
    for (const [tenantId, unownedItems] of unowned) {
        if (!eligibleTenants.has(tenantId)) continue; // Notifications disabled
        if (!tenants[tenantId]) tenants[tenantId] = { enqueued: 0, skipped: 0 };
        const tenantSlug = slugs.get(tenantId) ?? tenantId;
        const admins = await resolveTenantAdmins(tenantId);

        if (admins.length === 0) {
            unroutable += unownedItems.length;
            logger.warn('no tenant admins for unowned items', {
                component: 'digest-dispatcher',
                category,
                tenantId,
                itemCount: unownedItems.length,
            });
            continue;
        }

        // Send unowned items to all admins
        for (const admin of admins) {
            const result = await enqueueDigest(
                tenantId, category, admin, tenantSlug, unownedItems, now,
            );
            if (result) {
                enqueued++;
                tenants[tenantId].enqueued++;
            } else {
                skipped++;
                tenants[tenantId].skipped++;
            }
        }
    }

    logger.info('digest dispatch completed', {
        component: 'digest-dispatcher',
        category,
        totalItems: items.length,
        enqueued,
        skipped,
        suppressed,
        unroutable,
    });

    return { enqueued, skipped, unroutable, suppressed, totalItems: items.length, tenants };
}

// ─── Outbox Enqueue ─────────────────────────────────────────────────

/**
 * Enqueue a single digest email into the outbox.
 * Returns the record if created, null if deduplicated or error.
 */
async function enqueueDigest(
    tenantId: string,
    category: DigestCategory,
    recipient: RecipientInfo,
    tenantSlug: string,
    items: DueItem[],
    now: Date,
): Promise<{ id: string; dedupeKey: string } | null> {
    const dedupeKey = buildDigestDedupeKey(tenantId, category, recipient.email, now);
    const { subject, bodyText, bodyHtml } = await buildDigestEmail(
        category, recipient.name, tenantSlug, items, recipient.locale,
    );

    try {
        const record = await prisma.notificationOutbox.create({
            data: {
                tenantId,
                type: category,
                toEmail: recipient.email,
                subject,
                bodyText,
                bodyHtml,
                dedupeKey,
            },
        });
        return { id: record.id, dedupeKey };
    } catch (error: unknown) {
        // P2002 = unique constraint = duplicate dedupe key → skip
        const errorCode = typeof error === 'object' && error !== null && 'code' in error
            ? (error as Record<string, unknown>).code
            : undefined;
        const errorMessage = error instanceof Error ? error.message : undefined;
        if (errorCode === 'P2002' || errorMessage?.includes('Unique constraint')) {
            logger.debug('digest skipped — duplicate', {
                component: 'digest-dispatcher',
                category,
                dedupeKey,
            });
            return null;
        }
        throw error;
    }
}
