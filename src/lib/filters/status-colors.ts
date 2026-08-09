/**
 * Epic 53 — cross-entity status color map.
 *
 * Every entity in Inflect carries its own status enum (practices are
 * `NOT_STARTED | IN_PROGRESS | IMPLEMENTED | NOT_APPLICABLE`, risks
 * are `OPEN | MITIGATING | CLOSED | ACCEPTED`, evidence is
 * `DRAFT | SUBMITTED | APPROVED | REJECTED | EXPIRED`, tasks add
 * `TRIAGED | BLOCKED | RESOLVED | CLOSED | CANCELED`, etc.). When a
 * filter-dropdown or badge needs to paint a status chip, we want the
 * same *family* color everywhere — a "DONE"-shaped status is always
 * green whether the entity calls it `DONE`, `IMPLEMENTED`, `APPROVED`,
 * or `RESOLVED`, and a "BLOCKED"-shaped status is always red.
 *
 * This map gives consumers (filter badges, StatusBadge tooltips, saved-
 * view preset chips) a single lookup that honours those semantics
 * without the page owning its own ad-hoc palette.
 *
 * Tokens are CSS semantic names — both themes re-theme automatically.
 * Each entry returns a pair so consumers can spread onto a `<span>` as
 * `${bg} ${text}` or use them independently on icon + background
 * combos. A third `border` variant is available for outline chips.
 */

export type StatusTone =
    | 'success'   // happy path — finished, approved, resolved
    | 'info'      // in-flight — mitigating, in-progress, submitted
    | 'attention' // pending user action — draft, not-started, open-for-review
    | 'warning'   // at-risk — expiring, overdue, awaiting-signoff
    | 'error'     // blocked or failed — rejected, blocked, canceled
    | 'neutral';  // terminal or inapplicable — closed, archived, not-applicable

export interface StatusColorClasses {
    bg: string;
    text: string;
    border: string;
    tone: StatusTone;
}

const TONE_CLASSES: Record<StatusTone, Omit<StatusColorClasses, 'tone'>> = {
    success: {
        bg: 'bg-bg-success',
        text: 'text-content-success',
        border: 'border-border-success',
    },
    info: {
        bg: 'bg-bg-info',
        text: 'text-content-info',
        border: 'border-border-info',
    },
    attention: {
        bg: 'bg-bg-attention',
        text: 'text-content-attention',
        border: 'border-border-attention',
    },
    warning: {
        bg: 'bg-bg-warning',
        text: 'text-content-warning',
        border: 'border-border-warning',
    },
    error: {
        bg: 'bg-bg-error',
        text: 'text-content-error',
        border: 'border-border-error',
    },
    neutral: {
        bg: 'bg-bg-subtle',
        text: 'text-content-muted',
        border: 'border-border-subtle',
    },
};

/**
 * Canonical status → tone mapping. Covers every status enum used by
 * the migrated filter-defs (practices, risks, evidence, policies,
 * tasks, vendors, assets) plus a few common synonyms.
 *
 * New entity? Add the enum values here before wiring its filter-defs;
 * the standardisation test asserts coverage.
 */
export const STATUS_TONE: Record<string, StatusTone> = {
    // Happy path / finished
    APPROVED: 'success',
    CLOSED_OK: 'success',
    DONE: 'success',
    IMPLEMENTED: 'success',
    MITIGATED: 'success',
    RESOLVED: 'success',

    // In-flight / active work
    IN_PROGRESS: 'info',
    IN_REVIEW: 'info',
    MITIGATING: 'info',
    SUBMITTED: 'info',
    TRIAGED: 'info',

    // Pending user action / early-stage
    DRAFT: 'attention',
    NOT_STARTED: 'attention',
    OPEN: 'attention',
    PENDING: 'attention',
    PENDING_UPLOAD: 'attention',

    // At-risk / needs attention before deadline
    EXPIRING: 'warning',
    NEEDS_REVIEW: 'warning',
    OVERDUE: 'warning',
    WARN: 'warning',

    // Blocked / failed
    BLOCKED: 'error',
    CANCELED: 'error',
    EXPIRED: 'error',
    FAILED: 'error',
    REJECTED: 'error',

    // Terminal or inapplicable
    ACCEPTED: 'neutral',
    ARCHIVED: 'neutral',
    CLOSED: 'neutral',
    NOT_APPLICABLE: 'neutral',
    REMOVED: 'neutral',
    REVOKED: 'neutral',
};

/**
 * Resolve a status value to its semantic color classes.
 *
 * Falls back to `neutral` for any unknown status rather than throwing
 * — a new status shipped behind a flag is visible in the UI, just in
 * the muted palette until its tone is added here.
 */
export function statusColors(status: string | null | undefined): StatusColorClasses {
    const tone: StatusTone = (status && STATUS_TONE[status]) || 'neutral';
    return { tone, ...TONE_CLASSES[tone] };
}

/**
 * Convenience: the full `bg text` Tailwind class string for a status
 * chip. Use when you only need the surface + text combo (most pills).
 */
export function statusChipClass(status: string | null | undefined): string {
    const { bg, text } = statusColors(status);
    return `${bg} ${text}`;
}
