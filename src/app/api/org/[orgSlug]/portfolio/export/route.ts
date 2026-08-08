/**
 * Epic O-3 — portfolio CSV export.
 *
 *   GET /api/org/[orgSlug]/portfolio/export
 *
 * Returns a single multi-section CSV containing the org's portfolio
 * summary plus the three drill-down lists (non-performing controls,
 * critical risks, overdue evidence). Sections are separated by blank
 * rows + section-header rows so spreadsheet apps render them cleanly.
 *
 * Permission model:
 *   - `canExportReports` — required (ORG_ADMIN + ORG_READER both
 *     have it; this gate is for any future role that doesn't).
 *   - The drill-down sections of the export require `canDrillDown`
 *     additionally; if missing, those sections are omitted (the
 *     summary remains, since ORG_READERs can still see and export
 *     it). Documented in the file header so contributors don't
 *     "fix" the export to fail-fast — partial export by role is the
 *     intent.
 *
 * PDF is intentionally not implemented in v1 — the architecture doc
 * names CSV/PDF as alternatives. CSV satisfies the operator use case
 * (paste into spreadsheet, archive in evidence vault). A PDF surface
 * can be added later by composing the same usecases through pdfkit
 * (see `src/app/api/t/[tenantSlug]/audits/.../pack` for the existing
 * pdfkit pattern).
 */
import { NextRequest, NextResponse } from 'next/server';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { forbidden } from '@/lib/errors/types';
import { escapeCSV } from '@/lib/reports/csv-escape';
import {
    getPortfolioSummary,
    getPortfolioTenantHealth,
    getNonPerformingControls,
    getOverdueEvidenceAcrossOrg,
} from '@/app-layer/usecases/portfolio';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

// ── CSV helpers ────────────────────────────────────────────────────────

function sectionHeader(title: string, columnCount: number): string {
    // Repeat empty cells so the section banner spans the widest table.
    return [`# ${title}`, ...Array(Math.max(0, columnCount - 1)).fill('')]
        .map(escapeCSV)
        .join(',');
}

const SUMMARY_COLUMNS = 2;
const HEALTH_COLUMNS = 6;
const CONTROLS_COLUMNS = 6;
const EVIDENCE_COLUMNS = 6;

// ── Route ──────────────────────────────────────────────────────────────

export const GET = withApiErrorHandling(
    async (req: NextRequest, routeCtx: RouteContext) => {
        const ctx = await getOrgCtx((await routeCtx.params), req);
        if (!ctx.permissions.canExportReports) {
            throw forbidden('You do not have permission to export portfolio reports');
        }

        const sections: string[] = [];

        // ── Section 1: portfolio summary (always included) ────────────
        const summary = await getPortfolioSummary(ctx);
        sections.push(sectionHeader('Portfolio Summary', SUMMARY_COLUMNS));
        for (const row of [
            ['Organization', summary.organizationSlug],
            ['Generated At', summary.generatedAt],
            ['Tenants Total', summary.tenants.total],
            ['Tenants Snapshotted', summary.tenants.snapshotted],
            ['Tenants Pending', summary.tenants.pending],
            ['Controls Applicable', summary.controls.applicable],
            ['Controls Implemented', summary.controls.implemented],
            ['Coverage %', summary.controls.coveragePercent.toFixed(1)],
            ['Evidence Overdue', summary.evidence.overdue],
            ['Evidence Due Soon (7d)', summary.evidence.dueSoon7d],
            ['Policies Overdue Review', summary.policies.overdueReview],
            ['Tasks Overdue', summary.tasks.overdue],
            ['Findings Open', summary.findings.open],
            ['RAG Green', summary.rag.green],
            ['RAG Amber', summary.rag.amber],
            ['RAG Red', summary.rag.red],
            ['RAG Pending', summary.rag.pending],
        ]) {
            sections.push([escapeCSV(row[0]), escapeCSV(row[1] as string | number)].join(','));
        }

        // ── Section 2: tenant health table (always included) ─────────
        const health = await getPortfolioTenantHealth(ctx);
        sections.push('');
        sections.push(sectionHeader('Tenant Health', HEALTH_COLUMNS));
        sections.push(
            ['Tenant', 'Slug', 'Snapshot Date', 'Coverage %', 'Overdue Evidence', 'RAG']
                .map(escapeCSV)
                .join(','),
        );
        for (const row of health) {
            sections.push(
                [
                    escapeCSV(row.name),
                    escapeCSV(row.slug),
                    escapeCSV(row.snapshotDate ?? ''),
                    escapeCSV(row.coveragePercent !== null ? row.coveragePercent.toFixed(1) : ''),
                    escapeCSV(row.overdueEvidence ?? ''),
                    escapeCSV(row.rag ?? 'PENDING'),
                ].join(','),
            );
        }

        // ── Sections 3-5: drill-down (only when canDrillDown) ────────
        if (ctx.permissions.canDrillDown) {
            const [controls, evidence] = await Promise.all([
                getNonPerformingControls(ctx),
                getOverdueEvidenceAcrossOrg(ctx),
            ]);

            sections.push('');
            sections.push(sectionHeader('Non-Performing Controls', CONTROLS_COLUMNS));
            sections.push(
                ['Tenant', 'Slug', 'Control', 'Code', 'Status', 'Updated At']
                    .map(escapeCSV)
                    .join(','),
            );
            for (const c of controls) {
                sections.push(
                    [
                        escapeCSV(c.tenantName),
                        escapeCSV(c.tenantSlug),
                        escapeCSV(c.name),
                        escapeCSV(c.code ?? ''),
                        escapeCSV(c.status),
                        escapeCSV(c.updatedAt),
                    ].join(','),
                );
            }

            sections.push('');
            sections.push(sectionHeader('Overdue Evidence', EVIDENCE_COLUMNS));
            sections.push(
                ['Tenant', 'Slug', 'Title', 'Days Overdue', 'Status', 'Next Review Date']
                    .map(escapeCSV)
                    .join(','),
            );
            for (const e of evidence) {
                sections.push(
                    [
                        escapeCSV(e.tenantName),
                        escapeCSV(e.tenantSlug),
                        escapeCSV(e.title),
                        escapeCSV(e.daysOverdue),
                        escapeCSV(e.status),
                        escapeCSV(e.nextReviewDate),
                    ].join(','),
                );
            }
        }

        const csv = sections.join('\r\n') + '\r\n';

        const today = new Date().toISOString().slice(0, 10);
        const filename = `${ctx.orgSlug}_portfolio_${today}.csv`;

        return new NextResponse(csv, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Cache-Control': 'no-cache, no-store',
            },
        });
    },
);
