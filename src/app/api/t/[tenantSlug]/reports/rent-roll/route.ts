/**
 * GET /api/t/[tenantSlug]/reports/rent-roll
 *
 * The tenant rent roll & obligations (roadmap 3/3). Default → JSON; `?format=csv`
 * → a UTF-8 (BOM'd) CSV of rent-by-lessor; `?format=pdf` → the Cyrillic PDF.
 * Read-only, authorised via `assertCanRead` inside `getRentRoll` (reports are not
 * a `requirePermission` route root).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getRentRoll } from '@/app-layer/usecases/rent-roll';
import { generateRentRollPdf } from '@/app-layer/reports/pdf/rent-roll';
import { REPORT_DAYS } from '@/lib/agro/lease-expiry';
import { requireFeature } from '@/lib/entitlements-server';
import { FEATURES } from '@/lib/entitlements';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { contentDisposition } from '@/lib/http/content-disposition';

// PDFKit needs the Node runtime (stream/zlib/Buffer).
export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ tenantSlug: string }> };

function csvCell(v: string | number | null): string {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function collectPdfBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const format = url.searchParams.get('format');
    const locationId = url.searchParams.get('locationId') ?? undefined;

    if (format === 'pdf') {
        // Plan check: PDF exports require PDF_EXPORTS (TRIAL+), matching every
        // other PDF route. A client-side gate alone would be cosmetic.
        await requireFeature(ctx.tenantId, FEATURES.PDF_EXPORTS);
        const doc = await generateRentRollPdf(ctx, { locationId });
        const buf = await collectPdfBuffer(doc);
        return new NextResponse(new Uint8Array(buf), {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': contentDisposition('rent-roll.pdf'),
            },
        });
    }

    const data = await getRentRoll(ctx, { expiringWithinDays: REPORT_DAYS, locationId });

    if (format === 'csv') {
        // One row per (lessor × unit) — the unit column is now truthful for the
        // row's own figures, and paid/outstanding settle the same unit.
        const rows = [
            ['Собственик', 'ЕИК', 'Договори', 'Площ (дка)', 'Рента/сезон', 'Единица', 'Платено', 'Оставащо'],
            ...data.byLessor.map((l) => [
                l.lessorName,
                l.lessorEik ?? '',
                l.leaseCount,
                l.leasedDca,
                l.rentTotal ?? '',
                l.rentUnit ?? '',
                l.paid,
                l.outstanding,
            ]),
        ];
        const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n');
        return new NextResponse(csv, {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': contentDisposition('rent-roll.csv'),
            },
        });
    }

    return jsonResponse(data);
});
