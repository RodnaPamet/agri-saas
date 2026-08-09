/**
 * Elevation PR-1 — shared status → StatusBadge variant mappings.
 *
 * Until this PR each detail page redeclared its own STATUS_VARIANT
 * literal:
 *   risks/[riskId]/page.tsx::STATUS_VARIANT
 *   practices/[practiceId]/page.tsx (inline ternaries)
 *   tasks/[taskId]/page.tsx (inline)
 *   policies/[policyId]/page.tsx::STATUS_BADGE
 *   etc.
 * Result: the same domain enum mapped to subtly different badge tones
 * across pages. Consolidating into one file ensures every consumer
 * (MetaStrip, list-row badge, dashboard distribution) reads the same
 * vocabulary.
 *
 * The mappings live in the app-layer (not src/lib) because they're
 * domain semantics — what a "Risk OPEN" or "Policy DRAFT" means
 * visually is a product-design decision, not a UI primitive.
 */

import type { StatusBadgeVariant } from '@/components/ui/status-badge';

// ─── Risk status ─────────────────────────────────────────────────────

export const RISK_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    OPEN: 'warning',
    MITIGATING: 'info',
    // Audit Coherence S1 — practices in place, residual score
    // computed, awaiting explicit acceptance call. Distinct from
    // MITIGATING (work in progress) and ACCEPTED (signed off).
    MITIGATED: 'success',
    ACCEPTED: 'neutral',
    CLOSED: 'success',
};

// ─── Risk score band ─────────────────────────────────────────────────

export interface RiskScoreBand {
    label: string;
    variant: StatusBadgeVariant;
}

/**
 * Map a numeric risk score (0-25 likelihood × impact) to a labelled
 * band. Mirrors the `score-0-25` scale in `@/lib/design/status-tone`.
 */
export function getRiskScoreBand(score: number): RiskScoreBand {
    if (score <= 5) return { label: 'Low', variant: 'success' };
    if (score <= 12) return { label: 'Medium', variant: 'warning' };
    if (score <= 18) return { label: 'High', variant: 'warning' };
    return { label: 'Critical', variant: 'error' };
}

// ─── Practice status ──────────────────────────────────────────────────

export const CONTROL_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    NOT_STARTED: 'neutral',
    IN_PROGRESS: 'info',
    IMPLEMENTED: 'success',
    NEEDS_REVIEW: 'warning',
};

export const CONTROL_APPLICABILITY_VARIANT: Record<string, StatusBadgeVariant> = {
    APPLICABLE: 'info',
    NOT_APPLICABLE: 'neutral',
    EXCLUDED: 'neutral',
};

// ─── Task / WorkItem status ──────────────────────────────────────────

export const TASK_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    OPEN: 'neutral',
    TRIAGED: 'info',
    IN_PROGRESS: 'info',
    BLOCKED: 'error',
    PENDING_REVIEW: 'warning',
    RESOLVED: 'success',
    CLOSED: 'neutral',
    CANCELED: 'neutral',
};

export const TASK_SEVERITY_VARIANT: Record<string, StatusBadgeVariant> = {
    INFO: 'neutral',
    LOW: 'info',
    MEDIUM: 'warning',
    HIGH: 'warning',
    CRITICAL: 'error',
};

// ─── Policy status / approval ────────────────────────────────────────

export const POLICY_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    IN_REVIEW: 'info',
    PUBLISHED: 'success',
    ARCHIVED: 'warning',
};

export const POLICY_APPROVAL_VARIANT: Record<string, StatusBadgeVariant> = {
    PENDING: 'info',
    APPROVED: 'success',
    REJECTED: 'error',
};

// ─── Vendor status / criticality ─────────────────────────────────────

export const VENDOR_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    ACTIVE: 'success',
    ONBOARDING: 'info',
    OFFBOARDING: 'warning',
    OFFBOARDED: 'neutral',
};

export const VENDOR_CRITICALITY_VARIANT: Record<string, StatusBadgeVariant> = {
    LOW: 'neutral',
    MEDIUM: 'warning',
    HIGH: 'error',
    CRITICAL: 'error',
};

// Vendor assessment lifecycle (separate from vendor status).
export const VENDOR_ASSESSMENT_VARIANT: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    IN_REVIEW: 'warning',
    APPROVED: 'success',
    REJECTED: 'error',
};
