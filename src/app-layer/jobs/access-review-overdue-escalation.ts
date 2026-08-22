/**
 * Audit Coherence S7 (2026-05-24) — access review overdue
 * ESCALATION cron.
 *
 * Epic G-4 already runs `processAccessReviewReminders` which nudges
 * the campaign reviewer when `dueAt ∈ [now-grace, now+lead]`. That
 * covers the routine cadence — the reviewer gets a daily email until
 * decisions are recorded.
 *
 * What's missing: when the campaign goes past the grace tail (more
 * than `ESCALATION_DAYS` overdue) AND still has pending decisions,
 * the tenant ADMIN/OWNERs need a separate nudge so they can
 * intervene — reassign the campaign to a different reviewer,
 * force-close it, or chase the reviewer outside the system.
 *
 * Why a second job rather than folding into G-4:
 *   - Different recipient set (tenant ADMIN/OWNERs, not the
 *     reviewer). The dedupe key is per-(tenant,type,email,campaign)
 *     so the recipient fan-out has to live in the outbox calls, not
 *     in the candidate-selection loop. Two distinct fans-out are
 *     cleaner as two distinct jobs.
 *   - Different window (past-grace only). Folding it into G-4 would
 *     muddy the "remind the reviewer" semantic.
 *   - Independent kill-switch — operators can disable escalation
 *     without losing the reviewer reminders.
 *
 * Dedupe contract:
 *   Reuses the outbox unique key
 *   `(tenantId, type, email, entityId, YYYY-MM-DD)`. Re-running on
 *   the same UTC day is idempotent — second insert trips P2002 and
 *   `enqueueEmail` returns `null`. One escalation email per admin
 *   per campaign per day until the campaign closes or the
 *   decisions land.
 */
import type { PrismaClient } from '@prisma/client';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import type { Locale } from '@/lib/i18n/locales';
import { logger } from '@/lib/observability/logger';
import { enqueueEmail } from '../notifications/enqueue';
import { daysUntilDue } from './access-review-reminder';

export const ESCALATION_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface AccessReviewOverdueEscalationOptions {
    tenantId?: string;
    /** Override the "now" anchor — test-only seam. */
    now?: Date;
    /** Override the escalation threshold (days past dueAt). Default: 7. */
    escalationDays?: number;
}

export interface AccessReviewOverdueEscalationResult {
    /** Campaigns past the escalation threshold with pending decisions. */
    scanned: number;
    /** Admin emails that successfully landed in the outbox. */
    enqueued: number;
    /** Admin emails skipped because the dedupeKey already existed
     *  for this UTC day or the tenant has notifications off. */
    skippedDuplicate: number;
    /** Campaigns skipped because every admin in the tenant had no
     *  email address. */
    skippedNoAdminEmail: number;
    /** Campaigns excluded because they had no pending decisions
     *  (closeout is pending but every reviewer slot has a verdict). */
    skippedComplete: number;
}

interface EscalationCandidate {
    id: string;
    tenantId: string;
    name: string;
    dueAt: Date;
    tenantSlug: string;
    reviewerEmail: string | null;
    reviewerName: string | null;
    pendingCount: number;
    totalCount: number;
    daysOverdue: number;
}

interface AdminRecipient {
    email: string;
    name: string | null;
    /**
     * The ADMIN's language (#694). Carried on the recipient rather than
     * resolved at the send site because `loadAdmins` is bulk-fetched once for
     * every tenant — resolving inside the per-admin loop would put a query
     * back where the D1 N+1 guardrail had it hoisted out.
     */
    locale: Locale;
}

/**
 * Bulk-load ACTIVE OWNER/ADMIN memberships for every tenant in
 * the candidate set in a single `findMany`. Returns a Map keyed by
 * tenantId so the per-candidate loop is pure in-memory work.
 *
 * Hoisted out of the candidate loop to keep the D1 N+1 guardrail
 * satisfied on multi-tenant sweeps (where a per-iteration findMany
 * would scale linearly with tenant count).
 */
async function loadAdmins(
    db: PrismaClient,
    candidates: ReadonlyArray<{ tenantId: string }>,
): Promise<Map<string, AdminRecipient[]>> {
    const out = new Map<string, AdminRecipient[]>();
    const tenantIds = Array.from(new Set(candidates.map((c) => c.tenantId)));
    if (tenantIds.length === 0) return out;

    const rows = await db.tenantMembership.findMany({
        where: {
            tenantId: { in: tenantIds },
            status: 'ACTIVE',
            role: { in: ['OWNER', 'ADMIN'] },
        },
        select: {
            tenantId: true,
            user: { select: { email: true, name: true, uiLanguage: true } },
        },
    });

    // Initialise every tenant slot so the per-candidate `get()`
    // distinguishes "queried, zero admins" from "tenantId not in
    // the candidate set" cleanly.
    for (const t of tenantIds) out.set(t, []);
    for (const r of rows) {
        const email = r.user?.email ?? null;
        if (!email) continue;
        const list = out.get(r.tenantId);
        if (list) {
            list.push({
                email,
                name: r.user?.name ?? null,
                locale: resolveRecipientLocale(r.user?.uiLanguage),
            });
        }
    }
    return out;
}

/**
 * Public seam — `executor-registry` calls this with the global
 * Prisma client; tests construct their own and call directly.
 */
export async function processAccessReviewOverdueEscalation(
    db: PrismaClient,
    options: AccessReviewOverdueEscalationOptions = {},
): Promise<AccessReviewOverdueEscalationResult> {
    const now = options.now ?? new Date();
    const escalationDays = options.escalationDays ?? ESCALATION_DAYS;
    const { tenantId } = options;
    const scope = tenantId ? 'tenant-scoped' : 'system-wide';

    logger.info('access-review escalation scan starting', {
        component: 'access-review-overdue-escalation',
        scope,
        ...(tenantId ? { tenantId } : {}),
    });

    // Past the escalation threshold means `dueAt < now - escalationDays`.
    const cutoff = new Date(now.getTime() - escalationDays * MS_PER_DAY);

    const reviews = await db.accessReview.findMany({
        where: {
            status: { in: ['OPEN', 'IN_REVIEW'] },
            deletedAt: null,
            dueAt: { not: null, lt: cutoff },
            ...(tenantId ? { tenantId } : {}),
        },
        select: {
            id: true,
            tenantId: true,
            name: true,
            dueAt: true,
            reviewer: { select: { email: true, name: true } },
            tenant: { select: { slug: true } },
            decisions: { select: { id: true, decision: true } },
        },
    });

    const candidates: EscalationCandidate[] = reviews.map((r) => {
        const totalCount = r.decisions.length;
        const pendingCount = r.decisions.filter(
            (d) => d.decision === null,
        ).length;
        const dueAt = r.dueAt as Date;
        return {
            id: r.id,
            tenantId: r.tenantId,
            name: r.name,
            dueAt,
            tenantSlug: r.tenant.slug,
            reviewerEmail: r.reviewer?.email ?? null,
            reviewerName: r.reviewer?.name ?? null,
            pendingCount,
            totalCount,
            // daysUntilDue returns negative for overdue — flip the sign
            // so the email body's `daysOverdue` reads naturally.
            daysOverdue: -daysUntilDue(dueAt, now),
        };
    });

    let enqueued = 0;
    let skippedDuplicate = 0;
    let skippedNoAdminEmail = 0;
    let skippedComplete = 0;

    // Admin lookup is bulk-fetched once for every tenant in the
    // candidate set — one `findMany` regardless of how many
    // tenants are in play. Per-row loop reads from the resulting
    // Map (no DB) so the D1 N+1 guardrail stays satisfied even on
    // a system-wide sweep across many tenants.
    const adminMap = await loadAdmins(db, candidates);

    for (const c of candidates) {
        if (c.pendingCount === 0) {
            skippedComplete++;
            continue;
        }

        const admins = adminMap.get(c.tenantId) ?? [];

        if (admins.length === 0) {
            skippedNoAdminEmail++;
            logger.warn(
                'access-review-overdue-escalation: tenant has no admin emails',
                {
                    component: 'access-review-overdue-escalation',
                    accessReviewId: c.id,
                    tenantId: c.tenantId,
                },
            );
            continue;
        }

        for (const admin of admins) {
            const enqueueResult = await enqueueEmail(db, {
                tenantId: c.tenantId,
                type: 'ACCESS_REVIEW_OVERDUE_ESCALATION',
                toEmail: admin.email,
                locale: admin.locale,
                entityId: c.id,
                payload: {
                    adminName: admin.name ?? admin.email,
                    campaignName: c.name,
                    daysOverdue: c.daysOverdue,
                    pendingDecisions: c.pendingCount,
                    totalDecisions: c.totalCount,
                    tenantSlug: c.tenantSlug,
                    accessReviewId: c.id,
                    reviewerName: c.reviewerName ?? c.reviewerEmail ?? 'the assigned reviewer',
                    reviewerEmail: c.reviewerEmail,
                },
            });

            if (enqueueResult) {
                enqueued++;
            } else {
                // null = dedupe-hit OR tenant notifications off.
                skippedDuplicate++;
            }
        }
    }

    const result: AccessReviewOverdueEscalationResult = {
        scanned: candidates.length,
        enqueued,
        skippedDuplicate,
        skippedNoAdminEmail,
        skippedComplete,
    };

    logger.info('access-review escalation scan complete', {
        component: 'access-review-overdue-escalation',
        scope,
        ...result,
        ...(tenantId ? { tenantId } : {}),
    });

    return result;
}
