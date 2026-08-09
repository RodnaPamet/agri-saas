/**
 * "Year on the farm" PDF Generator
 *
 * A celebratory season-recap report for a farm tenant:
 *   Cover → recap metrics → top-fields table → certification line →
 *   activity-story line.
 *
 * All data is pulled INSIDE this usecase (via `getSeasonRecap` + a thin
 * tenant-name lookup + the same certification derivation the ag-dashboard
 * uses). The route only buffers + ships the returned document — this
 * generator does NOT call `doc.end()` (the route's `collectPdfBuffer`
 * owns finalisation, mirroring the other PDF generators).
 */
import type { RequestContext } from '@/app-layer/types';
import { getSeasonRecap } from '@/app-layer/usecases/season-recap';
import { haToDca } from '@/lib/agro/rate-calc';
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import { addCoverPage, applyHeadersAndFooters } from '@/lib/pdf/layout';
import { renderTable, autoColumnWidths } from '@/lib/pdf/table';
import { addSectionTitle, addSummaryMetrics, addSpacer, addParagraph } from '@/lib/pdf/sections';
import type { ReportMeta, TableColumn } from '@/lib/pdf/types';
import prisma from '@/lib/prisma';

function fmtNum(n: number | null, suffix = ''): string {
    if (n == null) return '—';
    // Trim trailing zeros for a clean recap display.
    const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
    return `${s}${suffix}`;
}

export async function generateYearOnFarmPdf(
    ctx: RequestContext,
    opts?: { seasonId?: string },
): Promise<PDFKit.PDFDocument> {
    // ─── Pull data (inside the usecase) ──────────────────────────────
    const recap = await getSeasonRecap(ctx, opts?.seasonId);

    const tenant = await prisma.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { name: true },
    });
    const tenantName = tenant?.name || 'Tenant';

    // Certification readiness used to ride here, derived from the top
    // AG_SCHEME framework. The certification-scheme catalog was removed
    // with the compliance uproot, so the report carries no readiness
    // section — the remaining sections are all farm records.
    const certification = null as { schemeName: string; score: number } | null;

    // ─── Meta ─────────────────────────────────────────────────────────
    const yearLabel = recap.year != null ? String(recap.year) : 'All time';
    const meta: ReportMeta = {
        tenantName,
        reportTitle: `Year on the farm — ${tenantName} ${yearLabel}`,
        reportSubtitle: recap.seasonName ?? 'Season recap',
        generatedAt: new Date().toISOString(),
        watermark: 'NONE',
    };

    // ─── Build PDF ──────────────────────────────────────────────────
    const doc = createPdfDocument(meta);

    addCoverPage(doc, meta);
    doc.addPage();

    // Recap metrics
    addSectionTitle(doc, 'Season recap');
    addSummaryMetrics(doc, [
        // Area in decares (дка = ha × 10); yield/cost densities stay per-ha.
        //
        // Two areas, deliberately distinguished. "Cropped" is every parcel
        // under the fields that produced; "harvested" is what farmers
        // actually typed against each yield record, and it is the ONLY
        // denominator behind the t/ha figure — shared with the yield page,
        // which is what stops the same harvest reading 7.0 t/ha on screen
        // and 4.2 t/ha here.
        { label: 'Cropped area (dca)', value: fmtNum(recap.totalAreaHa == null ? null : haToDca(recap.totalAreaHa)) },
        { label: 'Harvested area (dca)', value: fmtNum(recap.harvestedAreaHa == null ? null : haToDca(recap.harvestedAreaHa)) },
        { label: 'Total yield (t, gross)', value: fmtNum(recap.totalYieldTonnes) },
        // Gross tonnages measured at different moistures are not comparable;
        // this is the same grain expressed at the 14% trade basis.
        { label: 'Yield at 14% (t)', value: fmtNum(recap.totalNetTonnesStd) },
        { label: 'Avg yield (t/ha, harvested)', value: fmtNum(recap.avgYieldTPerHa) },
        { label: 'Cost per ha', value: fmtNum(recap.costPerHa) },
    ]);
    // Say so when part of the total could not be put on the standard basis,
    // rather than printing a precise-looking number that mixes bases.
    if (recap.unadjustedTonnes > 0) {
        addSpacer(doc);
        addParagraph(
            doc,
            `Note: ${fmtNum(recap.unadjustedTonnes)} t of the harvest (${recap.yieldRecordCount - recap.recordsWithMoisture} of ${recap.yieldRecordCount} records) has no moisture reading and is counted at its measured weight, not at the 14% basis.`,
        );
    }
    addSpacer(doc);

    // Top fields table
    addSectionTitle(doc, 'Top fields');
    if (recap.topFields.length > 0) {
        const widths = autoColumnWidths([3, 1.4, 1.4, 1.4]);
        const columns: TableColumn[] = [
            { key: 'name', header: 'Field', width: widths[0] },
            { key: 'yieldTonnes', header: 'Yield (t)', width: widths[1], align: 'right' },
            { key: 'areaHa', header: 'Area (dca)', width: widths[2], align: 'right' },
            { key: 'tPerHa', header: 't/ha', width: widths[3], align: 'right' },
        ];
        const rows = recap.topFields.map((f) => ({
            name: f.name,
            yieldTonnes: fmtNum(f.yieldTonnes),
            areaHa: fmtNum(f.areaHa == null ? null : haToDca(f.areaHa)),
            tPerHa: fmtNum(f.tPerHa),
        }));
        renderTable(doc, columns, rows);
    } else {
        addParagraph(doc, 'No harvest yet recorded for this scope.');
    }
    addSpacer(doc);

    // Certification line
    addSectionTitle(doc, 'Certification');
    if (certification) {
        addParagraph(
            doc,
            `${certification.schemeName} readiness: ${certification.score}%.`,
        );
    } else {
        addParagraph(doc, 'No certification scheme tracked.');
    }
    addSpacer(doc);

    // Activity story line
    addSectionTitle(doc, 'Your story');
    const scopeLabel = recap.seasonName ? `the ${recap.seasonName} season` : 'your time on the farm';
    addParagraph(
        doc,
        recap.activityCount > 0
            ? `You logged ${recap.activityCount} field ${recap.activityCount === 1 ? 'activity' : 'activities'} across ${scopeLabel} — every one a step in the story of this farm.`
            : `No field activities logged yet for ${scopeLabel} — the story starts with your first log entry.`,
    );

    applyHeadersAndFooters(doc, meta);

    // NOTE: do NOT call doc.end() — the route's collectPdfBuffer finalises.
    return doc;
}
