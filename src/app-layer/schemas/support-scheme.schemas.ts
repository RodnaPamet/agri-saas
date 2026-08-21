/**
 * Support-scheme value sets and write-boundary schemas.
 *
 * `authority`, `status` and `source` are plain `String` columns validated here
 * rather than Postgres enums — the same shape `AgriEvent.category` and
 * `NewsDerivedEvent.kind` use. A new issuing body or a new ingestion source is
 * then a one-line change here instead of a migration, which matters because
 * the set of bodies publishing Bulgarian agricultural support is not ours to
 * fix.
 *
 * @module app-layer/schemas/support-scheme
 */
import { z } from 'zod';
import { httpsUrl } from '@/lib/schemas/url';

/** Issuing bodies. ДФЗ = Държавен фонд „Земеделие"; МЗХ = the ministry. */
export const SUPPORT_SCHEME_AUTHORITIES = ['ДФЗ', 'МЗХ', 'EC'] as const;
export type SupportSchemeAuthority = (typeof SUPPORT_SCHEME_AUTHORITIES)[number];

/** Where a row's application window stands. */
export const SUPPORT_SCHEME_STATUSES = [
    'announced',
    'open',
    'closing-soon',
    'closed',
] as const;
export type SupportSchemeWindowStatus = (typeof SUPPORT_SCHEME_STATUSES)[number];

/**
 * How a row got here.
 *
 * The distinction is load-bearing, not bookkeeping: an official ДФЗ
 * announcement and an LLM's reading of a news article are different kinds of
 * claim, and the UI renders them differently. Official sources are PREFERRED
 * where they exist — dfz.bg and mzh.government.bg publish announcements, and a
 * feed needs no hallucination guard for its dates. AI-over-news is the
 * supplement.
 */
export const SUPPORT_SCHEME_SOURCES = ['curated', 'official-feed', 'ai-news'] as const;
export type SupportSchemeSource = (typeof SUPPORT_SCHEME_SOURCES)[number];

/** Days before closing at which a window is "closing soon". */
export const CLOSING_SOON_DAYS = 14;

/**
 * Derive the window status from the dates.
 *
 * Stored `status` is what a curated row asserts; when a window is present the
 * dates are the truth, because a stored status goes stale the moment a
 * deadline passes and nobody wants a farmer reading "open" on 1 October about
 * a window that shut in September.
 */
export function deriveWindowStatus(
    opensAt: Date | string | null | undefined,
    closesAt: Date | string | null | undefined,
    now: Date,
    stored: string = 'announced',
): SupportSchemeWindowStatus {
    const opens = opensAt ? new Date(opensAt) : null;
    const closes = closesAt ? new Date(closesAt) : null;
    if (!opens && !closes) {
        return (SUPPORT_SCHEME_STATUSES as readonly string[]).includes(stored)
            ? (stored as SupportSchemeWindowStatus)
            : 'announced';
    }
    if (closes && closes.getTime() < now.getTime()) return 'closed';
    if (opens && opens.getTime() > now.getTime()) return 'announced';
    if (closes) {
        const days = (closes.getTime() - now.getTime()) / 86_400_000;
        if (days <= CLOSING_SOON_DAYS) return 'closing-soon';
    }
    return 'open';
}

// ─── Write boundary ─────────────────────────────────────────────────

export const CreateSupportSchemeSchema = z
    .object({
        title: z.string().min(1).max(200),
        summary: z.string().max(2000).optional(),
        authority: z.enum(SUPPORT_SCHEME_AUTHORITIES),
        measureCode: z.string().max(60).optional(),
        status: z.enum(SUPPORT_SCHEME_STATUSES).optional(),
        applicationOpensAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        applicationClosesAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        eligibilitySummary: z.string().max(4000).optional(),
        budgetAmount: z.number().nonnegative().optional(),
        budgetCurrency: z.string().length(3).optional(),
        sourceUrl: httpsUrl().optional(),
        source: z.enum(SUPPORT_SCHEME_SOURCES).optional(),
    })
    .strip();

export type CreateSupportSchemeInput = z.infer<typeof CreateSupportSchemeSchema>;
