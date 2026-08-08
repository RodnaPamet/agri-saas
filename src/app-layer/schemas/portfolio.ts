/**
 * Epic O-3 — portfolio aggregation DTOs.
 *
 * Three Zod-validated DTOs power the org-level dashboard. Each is
 * deliberately shaped for its consumer:
 *
 *   - `PortfolioSummary`     — the summary cards (org totals + RAG
 *                              breakdown + per-domain metrics).
 *   - `TenantHealthRow`      — one row per tenant in the portfolio
 *                              table; includes a drill-down URL.
 *   - `PortfolioTrend`       — time-series for the org's coverage /
 *                              risk / evidence charts. Reuses the
 *                              shape of `TrendDataPoint` from the
 *                              tenant-level `compliance-trends.ts`
 *                              so charting code can be shared.
 *
 * Pure types — no DB access, no usecase logic. Imported by the
 * repository, the usecases, the eventual API routes, and the UI.
 *
 * The Zod schemas double as runtime validators (used in tests) AND
 * as the source of truth for the inferred TypeScript types — every
 * exported type is `z.infer<typeof Schema>`, so a schema change is
 * a type-system change in lockstep.
 */
import { z } from 'zod';

// ── RAG enum (shared) ─────────────────────────────────────────────────

export const RagBadgeSchema = z.enum(['GREEN', 'AMBER', 'RED']);
export type RagBadge = z.infer<typeof RagBadgeSchema>;

// ── PortfolioSummary ─────────────────────────────────────────────────

const NonNegInt = z.number().int().nonnegative();

export const PortfolioSummarySchema = z
    .object({
        organizationId: z.string().min(1),
        organizationSlug: z.string().min(1),
        /** ISO 8601 timestamp at which this summary was computed. */
        generatedAt: z.string().min(1),

        tenants: z
            .object({
                /** Total tenants under the org (every linked Tenant row). */
                total: NonNegInt,
                /** Tenants with at least one ComplianceSnapshot in window. */
                snapshotted: NonNegInt,
                /** Tenants with NO snapshot yet — newly-created or never-run. */
                pending: NonNegInt,
            })
            .strict(),

        controls: z
            .object({
                applicable: NonNegInt,
                implemented: NonNegInt,
                /** Org-wide coverage = sum(implemented) / sum(applicable) × 100.
                 *  0 when applicable === 0 (no applicable controls anywhere). */
                coveragePercent: z.number().min(0).max(100),
            })
            .strict(),

        evidence: z
            .object({
                total: NonNegInt,
                overdue: NonNegInt,
                dueSoon7d: NonNegInt,
            })
            .strict(),

        policies: z
            .object({
                total: NonNegInt,
                overdueReview: NonNegInt,
            })
            .strict(),

        tasks: z
            .object({
                open: NonNegInt,
                overdue: NonNegInt,
            })
            .strict(),

        findings: z
            .object({
                open: NonNegInt,
            })
            .strict(),

        /** RAG distribution across the org's tenants. */
        rag: z
            .object({
                green: NonNegInt,
                amber: NonNegInt,
                red: NonNegInt,
                /** Tenants without a snapshot — uncategorisable. */
                pending: NonNegInt,
            })
            .strict(),
    })
    .strict();

export type PortfolioSummary = z.infer<typeof PortfolioSummarySchema>;

// ── TenantHealthRow ──────────────────────────────────────────────────

export const TenantHealthRowSchema = z
    .object({
        tenantId: z.string().min(1),
        slug: z.string().min(1),
        name: z.string().min(1),
        /** Path the UI navigates to when the row is clicked. The
         *  CISO's auto-provisioned AUDITOR membership in this tenant
         *  is what makes the drill-down work; this DTO just carries
         *  the URL string — no auth check happens here. */
        drillDownUrl: z.string().min(1),

        /** False when the tenant has no ComplianceSnapshot yet. The
         *  metric fields are NULL in that case so the UI can render a
         *  "snapshot pending" badge cleanly. */
        hasSnapshot: z.boolean(),

        /** ISO date (YYYY-MM-DD) of the latest snapshot — or null. */
        snapshotDate: z.string().nullable(),

        coveragePercent: z.number().min(0).max(100).nullable(),
        overdueEvidence: NonNegInt.nullable(),
        rag: RagBadgeSchema.nullable(),
    })
    .strict();

export type TenantHealthRow = z.infer<typeof TenantHealthRowSchema>;

// ── PortfolioTrend ───────────────────────────────────────────────────
//
// One data point per snapshotDate, summed across all org tenants.
// Shape matches `TrendDataPoint` from
// `src/app-layer/usecases/compliance-trends.ts` so the org dashboard
// can reuse the same chart components.

export const PortfolioTrendDataPointSchema = z
    .object({
        /** ISO date string (YYYY-MM-DD) — same shape as TrendDataPoint. */
        date: z.string().min(1),
        controlCoveragePercent: z.number().min(0).max(100),
        controlsImplemented: NonNegInt,
        controlsApplicable: NonNegInt,
        evidenceOverdue: NonNegInt,
        evidenceDueSoon7d: NonNegInt,
        evidenceCurrent: NonNegInt,
        policiesTotal: NonNegInt,
        policiesOverdueReview: NonNegInt,
        tasksOpen: NonNegInt,
        tasksOverdue: NonNegInt,
        findingsOpen: NonNegInt,
    })
    .strict();

export type PortfolioTrendDataPoint = z.infer<typeof PortfolioTrendDataPointSchema>;

export const PortfolioTrendSchema = z
    .object({
        organizationId: z.string().min(1),
        daysRequested: z.number().int().positive(),
        daysAvailable: NonNegInt,
        rangeStart: z.string().min(1),
        rangeEnd: z.string().min(1),
        /** Number of distinct tenants whose snapshots contributed to
         *  the aggregate. Useful in the UI as an "as-of N tenants"
         *  caveat when a tenant was added mid-window. */
        tenantsAggregated: NonNegInt,
        dataPoints: z.array(PortfolioTrendDataPointSchema),
    })
    .strict();

export type PortfolioTrend = z.infer<typeof PortfolioTrendSchema>;

// ── Cross-tenant drill-down rows (RLS-enforced) ──────────────────────
//
// Each row carries enough tenant attribution to render the row + a
// `drillDownUrl` that lands the user on the standard per-tenant
// detail page (where the CISO's auto-provisioned AUDITOR membership
// unlocks read access). The row IDs are tenant-scoped — the CISO
// clicks → /t/{slug}/risks/{riskId} → existing tenant routing +
// RLS take over.

const ControlStatusEnum = z.enum([
    'NOT_STARTED',
    'PLANNED',
    'IN_PROGRESS',
    'IMPLEMENTING',
    'NEEDS_REVIEW',
    // 'IMPLEMENTED' and 'NOT_APPLICABLE' are intentionally excluded from
    // this DTO — non-performing means status NOT IN those two. A row
    // appearing with one of those values would be a logic bug at the
    // query layer, and the strict enum surfaces it.
]);

export const NonPerformingControlRowSchema = z
    .object({
        controlId: z.string().min(1),
        tenantId: z.string().min(1),
        tenantSlug: z.string().min(1),
        tenantName: z.string().min(1),
        name: z.string().min(1),
        code: z.string().nullable(),
        status: ControlStatusEnum,
        /** ISO timestamp — last time the control row was updated. */
        updatedAt: z.string().min(1),
        /** /t/{slug}/controls/{controlId}. */
        drillDownUrl: z.string().min(1),
    })
    .strict();

export type NonPerformingControlRow = z.infer<typeof NonPerformingControlRowSchema>;

const ActiveRiskStatusEnum = z.enum([
    'OPEN',
    'MITIGATING',
    'ACCEPTED',
    // 'CLOSED' intentionally excluded — a closed risk shouldn't surface
    // in the org's "critical risks" view, and the strict enum catches
    // a query-side regression that lets one through.
]);

export const CriticalRiskRowSchema = z
    .object({
        riskId: z.string().min(1),
        tenantId: z.string().min(1),
        tenantSlug: z.string().min(1),
        tenantName: z.string().min(1),
        title: z.string().min(1),
        inherentScore: z.number().int().nonnegative(),
        status: ActiveRiskStatusEnum,
        updatedAt: z.string().min(1),
        /** /t/{slug}/risks/{riskId}. */
        drillDownUrl: z.string().min(1),
    })
    .strict();

export type CriticalRiskRow = z.infer<typeof CriticalRiskRowSchema>;

const OverdueEvidenceStatusEnum = z.enum([
    'DRAFT',
    'SUBMITTED',
    'REJECTED',
    // 'APPROVED' intentionally excluded — approved evidence is current,
    // not overdue, regardless of nextReviewDate.
]);

export const OverdueEvidenceRowSchema = z
    .object({
        evidenceId: z.string().min(1),
        tenantId: z.string().min(1),
        tenantSlug: z.string().min(1),
        tenantName: z.string().min(1),
        title: z.string().min(1),
        /** ISO date string for the missed review. */
        nextReviewDate: z.string().min(1),
        /** Whole-day delta: floor((now - nextReviewDate) / 1d). Always ≥ 1. */
        daysOverdue: z.number().int().positive(),
        status: OverdueEvidenceStatusEnum,
        /** /t/{slug}/evidence/{evidenceId}. */
        drillDownUrl: z.string().min(1),
    })
    .strict();

export type OverdueEvidenceRow = z.infer<typeof OverdueEvidenceRowSchema>;

// ── Drill-down pagination (cursor-based) ─────────────────────────────
//
// The dashboard summary views still consume the top-50 functions
// (`getNonPerformingControls`, `getCriticalRisksAcrossOrg`,
// `getOverdueEvidenceAcrossOrg`) — fast, bounded, ideal for a card-
// sized preview. The DEDICATED drill-down pages browse beyond that
// cap via the `list*` usecase counterparts which accept a cursor
// payload and return `nextCursor` alongside the rows.
//
// Cursor model: per-entity opaque base64-JSON. The shape is
// intentionally NOT exposed to the client — `cursor` is "whatever
// the previous response gave you in `nextCursor`". Encoded fields
// are the entity's primary + secondary sort keys plus the row id
// for tiebreaker stability across tenants.
//
// The sort order is identical to the dashboard preview's sort, so
// page 1 of the paginated view matches the first 50 rows of the
// preview byte-for-byte (modulo the optional `nextCursor`).
//
//   Controls  : (statusPriority DESC, updatedAt DESC, id ASC)
//   Risks     : (inherentScore   DESC, updatedAt DESC, id ASC)
//   Evidence  : (nextReviewDate  ASC,  id ASC)        ← daysOverdue DESC
//
// `id` ASC as the final tiebreaker is per-tenant unique by Prisma
// cuid; cuid collisions across tenants are not a concern at the
// scales the platform targets.

export const PaginatedDrillDownInputSchema = z
    .object({
        /** Opaque cursor returned in the previous response's
         *  `nextCursor`. Omit for the first page. */
        cursor: z.string().min(1).optional(),
        /** Max rows to return on this page. Defaults to 50; clamped
         *  to [1, 200]. The dashboard summary keeps its hard 50;
         *  this control is for the dedicated drill-down pages. */
        limit: z.number().int().min(1).max(200).optional(),
    })
    .strict();

export type PaginatedDrillDownInput = z.infer<typeof PaginatedDrillDownInputSchema>;

export const DEFAULT_DRILLDOWN_PAGE_LIMIT = 50;
export const MAX_DRILLDOWN_PAGE_LIMIT = 200;

export interface PaginatedDrillDownResult<TRow> {
    rows: TRow[];
    /** Encoded cursor for the next page, or null when this is the
     *  last page. Treat as opaque on the client. */
    nextCursor: string | null;
}

// ── RAG threshold helper (shared) ────────────────────────────────────
//
// Single source of truth for the RAG mapping used by the per-tenant
// row computation AND by the org-summary RAG bucket counts. Pure
// function — pulled out so tests assert the thresholds directly
// without going through the full usecase.

export interface RagInputs {
    coveragePercent: number;
    overdueEvidence: number;
}

/**
 * Map a tenant's snapshot metrics to a single RAG badge.
 *
 *   RED   — coverage < 60% OR overdueEvidence ≥ 10
 *   AMBER — coverage < 80% OR overdueEvidence ≥ 1
 *   GREEN — otherwise (coverage ≥ 80% AND no overdue evidence)
 *
 * The `criticalRisks` term went with the risk register; the coverage
 * and overdue-evidence thresholds are unchanged.
 *
 * Thresholds are deliberately conservative for v1; a future iteration
 * could pull them from `TenantSecuritySettings` per-tenant.
 */
export function computeRag(inputs: RagInputs): RagBadge {
    const { coveragePercent, overdueEvidence } = inputs;
    if (coveragePercent < 60 || overdueEvidence >= 10) {
        return 'RED';
    }
    if (coveragePercent < 80 || overdueEvidence >= 1) {
        return 'AMBER';
    }
    return 'GREEN';
}
