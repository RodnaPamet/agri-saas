/**
 * Epic G-4 — Access review reminder job.
 *
 * Once a day, find every campaign whose `dueAt` falls inside the
 * reminder window AND that still has at least one pending decision,
 * and enqueue an `ACCESS_REVIEW_REMINDER` email to the assigned
 * reviewer.
 *
 * Two scope modes (mirrors `policyReviewReminder`):
 *   - tenantId provided  → scan that single tenant.
 *   - tenantId omitted   → scan every tenant (system-wide nightly cron).
 *
 * Deduplication contract:
 *   The notification outbox unique key is
 *   `(tenantId, type, email, entityId, YYYY-MM-DD)`. Re-running the
 *   job within the same UTC day is idempotent — the second insert
 *   trips P2002 and `enqueueEmail` returns `null`. So a 04:00 UTC
 *   run + an operator-triggered re-run at 09:00 UTC the same day
 *   results in ONE email, not two. Crossing midnight gets a fresh
 *   reminder because the day component changes — that's the
 *   intentional "remind once a day until decided" semantic.
 *
 * Reminder window:
 *   `dueAt` ∈ [now - GRACE_DAYS, now + REMINDER_DAYS]. The grace
 *   tail keeps overdue campaigns getting nudged for a few extra
 *   days before reminders quiet down (most overdue campaigns get
 *   resolved within the grace window or are explicitly closed).
 *
 * Bypassed when:
 *   - Campaign is CLOSED or soft-deleted (excluded by query).
 *   - Tenant has notifications disabled (the email-enqueue layer
 *     short-circuits to `null`).
 *   - Reviewer email is missing (we log + skip; no exception).
 *   - Zero pending decisions (no reason to nudge).
 */
import type { PrismaClient } from '@prisma/client';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import type { Locale } from '@/lib/i18n/locales';
import { logger } from '@/lib/observability/logger';
import { enqueueEmail } from '../notifications/enqueue';

export const REMINDER_LEAD_DAYS = 7;
export const REMINDER_GRACE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface AccessReviewReminderOptions {
    tenantId?: string;
    /** Override the "now" anchor — test-only seam. */
    now?: Date;
    /** Override the lookahead window. Default: 7 days. */
    leadDays?: number;
    /** Override the grace tail for overdue. Default: 3 days. */
    graceDays?: number;
}

export interface AccessReviewReminderResult {
    /** Campaigns that fell inside the reminder window. */
    scanned: number;
    /** Reminders that successfully landed in the outbox. */
    enqueued: number;
    /** Reminders skipped because the dedupeKey already existed
     *  for this UTC day, the tenant has notifications off, or the
     *  reviewer has no email. */
    skippedDuplicate: number;
    skippedNoEmail: number;
    /** Campaigns excluded because they had no pending decisions. */
    skippedComplete: number;
}

interface CampaignSnapshot {
    id: string;
    tenantId: string;
    name: string;
    dueAt: Date;
    reviewerEmail: string | null;
    reviewerName: string | null;
    reviewerLocale: Locale;
    tenantSlug: string;
    pendingCount: number;
    totalCount: number;
}

/**
 * Returns the integer days from `now` to `dueAt`. Negative when
 * overdue. Same precision as the email body uses.
 */
export function daysUntilDue(dueAt: Date, now: Date = new Date()): number {
    const diffMs = dueAt.getTime() - now.getTime();
    return Math.round(diffMs / MS_PER_DAY);
}

/**
 * Predicate — is this campaign inside the reminder window?
 * Pure function; suitable for unit-testing the boundary math.
 */
export function isInReminderWindow(
    dueAt: Date,
    now: Date = new Date(),
    leadDays: number = REMINDER_LEAD_DAYS,
    graceDays: number = REMINDER_GRACE_DAYS,
): boolean {
    const days = daysUntilDue(dueAt, now);
    return days <= leadDays && days >= -graceDays;
}

/**
 * Scan + enqueue. Public seam — `executor-registry` calls this with
 * the global Prisma client; tests construct their own and call
 * directly.
 */
export async function processAccessReviewReminders(
    db: PrismaClient,
    options: AccessReviewReminderOptions = {},
): Promise<AccessReviewReminderResult> {
    const now = options.now ?? new Date();
    const leadDays = options.leadDays ?? REMINDER_LEAD_DAYS;
    const graceDays = options.graceDays ?? REMINDER_GRACE_DAYS;
    const { tenantId } = options;
    const scope = tenantId ? 'tenant-scoped' : 'system-wide';

    logger.info('access-review reminder scan starting', {
        component: 'access-review-reminder',
        scope,
        ...(tenantId ? { tenantId } : {}),
    });

    const upper = new Date(now.getTime() + leadDays * MS_PER_DAY);
    const lower = new Date(now.getTime() - graceDays * MS_PER_DAY);

    // Pull eligible campaigns. Status filter excludes CLOSED, the
    // dueAt-IS-NULL filter excludes campaigns without a deadline
    // (no anchor to remind against), and the deletedAt filter
    // excludes soft-deleted rows.
    const reviews = await db.accessReview.findMany({
        where: {
            status: { in: ['OPEN', 'IN_REVIEW'] },
            deletedAt: null,
            dueAt: { not: null, gte: lower, lte: upper },
            ...(tenantId ? { tenantId } : {}),
        },
        select: {
            id: true,
            tenantId: true,
            name: true,
            dueAt: true,
            // `uiLanguage`: the reminder is written in the REVIEWER's
            // language (#694). Already a nested select on this query.
            reviewer: { select: { email: true, name: true, uiLanguage: true } },
            tenant: { select: { slug: true } },
            decisions: {
                select: { id: true, decision: true },
            },
        },
    });

    const candidates: CampaignSnapshot[] = reviews
        .map((r) => {
            const totalCount = r.decisions.length;
            const pendingCount = r.decisions.filter(
                (d) => d.decision === null,
            ).length;
            return {
                id: r.id,
                tenantId: r.tenantId,
                name: r.name,
                // The query filter guarantees dueAt is non-null here,
                // but TS still sees `Date | null`.
                dueAt: r.dueAt as Date,
                reviewerEmail: r.reviewer?.email ?? null,
                reviewerName: r.reviewer?.name ?? null,
                reviewerLocale: resolveRecipientLocale(r.reviewer?.uiLanguage),
                tenantSlug: r.tenant.slug,
                pendingCount,
                totalCount,
            };
        })
        .filter((c) => isInReminderWindow(c.dueAt, now, leadDays, graceDays));

    let enqueued = 0;
    let skippedDuplicate = 0;
    let skippedNoEmail = 0;
    let skippedComplete = 0;

    for (const c of candidates) {
        if (c.pendingCount === 0) {
            // Every subject decided — no nudge needed even if the
            // due date is approaching. Closing the campaign is the
            // admin's call, not a reminder concern.
            skippedComplete++;
            continue;
        }
        if (!c.reviewerEmail) {
            skippedNoEmail++;
            logger.warn('access-review-reminder: reviewer has no email', {
                component: 'access-review-reminder',
                accessReviewId: c.id,
                tenantId: c.tenantId,
            });
            continue;
        }

        const enqueueResult = await enqueueEmail(db, {
            tenantId: c.tenantId,
            type: 'ACCESS_REVIEW_REMINDER',
            toEmail: c.reviewerEmail,
            locale: c.reviewerLocale,
            entityId: c.id,
            payload: {
                reviewerName: c.reviewerName ?? c.reviewerEmail,
                campaignName: c.name,
                daysUntilDue: daysUntilDue(c.dueAt, now),
                pendingDecisions: c.pendingCount,
                totalDecisions: c.totalCount,
                tenantSlug: c.tenantSlug,
                accessReviewId: c.id,
            },
        });

        if (enqueueResult) {
            enqueued++;
        } else {
            // null = (a) dedupe-hit OR (b) tenant notifications off.
            // Both legitimate "skipped"; we don't differentiate here
            // because the outbox is the source of truth for delivery.
            skippedDuplicate++;
        }
    }

    const result: AccessReviewReminderResult = {
        scanned: candidates.length,
        enqueued,
        skippedDuplicate,
        skippedNoEmail,
        skippedComplete,
    };

    logger.info('access-review reminder scan complete', {
        component: 'access-review-reminder',
        scope,
        ...result,
        ...(tenantId ? { tenantId } : {}),
    });

    return result;
}
