/**
 * Government support schemes — the read side and the platform review queue.
 *
 * `SupportScheme` is GLOBAL (a national measure is the same fact for every
 * tenant) and deliberately NOT a `Framework`: `/schemes` is certification —
 * standards a farm is AUDITED AGAINST — while this is what a farm APPLIES FOR.
 *
 * Two audiences, two functions:
 *
 *   - `listSupportSchemes` — what a farmer sees. APPROVED only. An AI-derived
 *     row that nobody has reviewed must never be indistinguishable from an
 *     official ДФЗ announcement, and the cheapest way to guarantee that is for
 *     the tenant-facing read to be unable to return one.
 *   - `listPendingSupportSchemes` / `reviewSupportScheme` — the platform
 *     review queue, reached only through the PLATFORM_ADMIN_API_KEY routes.
 *
 * @module app-layer/usecases/support-schemes
 */
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { notFound } from '@/lib/errors/types';
import {
    deriveWindowStatus,
    type SupportSchemeWindowStatus,
} from '../schemas/support-scheme.schemas';

export interface SupportSchemeFilters {
    authority?: string;
    /** Derived window status, not the stored column — see `deriveWindowStatus`. */
    status?: SupportSchemeWindowStatus;
}

export interface SupportSchemeRow {
    id: string;
    title: string;
    summary: string | null;
    authority: string;
    measureCode: string | null;
    status: SupportSchemeWindowStatus;
    applicationOpensAt: string | null;
    applicationClosesAt: string | null;
    eligibilitySummary: string | null;
    budgetAmount: string | null;
    budgetCurrency: string | null;
    sourceUrl: string | null;
    /** 'curated' | 'official-feed' | 'ai-news' — drives the UI's provenance chip. */
    source: string;
    sourceTitle: string | null;
    confidence: number | null;
    extractedAt: string | null;
}

/** Cap — a scannable list, not an export. */
const MAX_ROWS = 200;

function toRow(
    s: {
        id: string; title: string; summary: string | null; authority: string;
        measureCode: string | null; status: string;
        applicationOpensAt: Date | null; applicationClosesAt: Date | null;
        eligibilitySummary: string | null;
        budgetAmount: unknown; budgetCurrency: string | null;
        sourceUrl: string | null; source: string; sourceTitle: string | null;
        confidence: number | null; extractedAt: Date | null;
    },
    now: Date,
): SupportSchemeRow {
    return {
        id: s.id,
        title: s.title,
        summary: s.summary,
        authority: s.authority,
        measureCode: s.measureCode,
        // Derived, not the stored column. A stored status goes stale the moment
        // a deadline passes, and nobody wants a farmer reading "open" on 1
        // October about a window that shut in September.
        status: deriveWindowStatus(s.applicationOpensAt, s.applicationClosesAt, now, s.status),
        applicationOpensAt: s.applicationOpensAt ? s.applicationOpensAt.toISOString() : null,
        applicationClosesAt: s.applicationClosesAt ? s.applicationClosesAt.toISOString() : null,
        eligibilitySummary: s.eligibilitySummary,
        budgetAmount: s.budgetAmount == null ? null : String(s.budgetAmount),
        budgetCurrency: s.budgetCurrency,
        sourceUrl: s.sourceUrl,
        source: s.source,
        sourceTitle: s.sourceTitle,
        confidence: s.confidence,
        extractedAt: s.extractedAt ? s.extractedAt.toISOString() : null,
    };
}

/**
 * The farmer-facing list. APPROVED rows only, soonest deadline first.
 *
 * No `RequestContext` gate beyond the route's own tenant resolution: this is
 * public reference data — a national measure is not one farm's business — and
 * the same reasoning `AgriEvent` and `MarketNewsItem` already use.
 */
export async function listSupportSchemes(
    filters: SupportSchemeFilters = {},
    opts: { now?: Date } = {},
): Promise<SupportSchemeRow[]> {
    const now = opts.now ?? new Date();

    const rows = await prisma.supportScheme.findMany({
        where: {
            // The single most important clause in this file. An unreviewed
            // AI extraction is a guess; a farmer acting on it can lose money.
            reviewStatus: 'APPROVED',
            ...(filters.authority ? { authority: filters.authority } : {}),
        },
        orderBy: [{ applicationClosesAt: 'asc' }, { createdAt: 'desc' }],
        take: MAX_ROWS,
    });

    const mapped = rows.map((r) => toRow(r, now));
    // Status is derived, so it cannot be a WHERE clause — filtering happens
    // after mapping. The row cap is applied before this, which is acceptable
    // for a bounded reference list and would not be for a paginated one.
    return filters.status ? mapped.filter((r) => r.status === filters.status) : mapped;
}

/** The platform review queue: everything awaiting a human decision. */
export async function listPendingSupportSchemes(
    opts: { now?: Date } = {},
): Promise<SupportSchemeRow[]> {
    const now = opts.now ?? new Date();
    const rows = await prisma.supportScheme.findMany({
        where: { reviewStatus: 'PROPOSED' },
        orderBy: [{ extractedAt: 'desc' }, { createdAt: 'desc' }],
        take: MAX_ROWS,
    });
    return rows.map((r) => toRow(r, now));
}

/**
 * Approve or reject a proposal.
 *
 * `reviewedBy` is a free-text platform-admin identifier (a requestId), not a
 * `User` FK — these routes are PLATFORM_ADMIN_API_KEY-gated and have no user
 * session, the same shape `agri-events.ts` uses.
 */
export async function reviewSupportScheme(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    reviewedBy: string,
): Promise<SupportSchemeRow> {
    const existing = await prisma.supportScheme.findUnique({ where: { id } });
    if (!existing) throw notFound('Support scheme not found');

    const updated = await prisma.supportScheme.update({
        where: { id },
        data: { reviewStatus: decision, reviewedAt: new Date(), reviewedBy },
    });

    logger.info('support-scheme reviewed', {
        component: 'support-schemes',
        supportSchemeId: id,
        decision,
        source: existing.source,
        confidence: existing.confidence,
    });

    return toRow(updated, new Date());
}
