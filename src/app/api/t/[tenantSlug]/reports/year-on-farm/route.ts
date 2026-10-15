/**
 * POST /api/t/[tenantSlug]/reports/year-on-farm
 *
 * Generates the "Year on the farm" season-recap PDF and returns it as
 * `application/pdf`. Read-only data (authorised via `assertCanRead`
 * inside `getSeasonRecap`), matching the reports/pdf/generate privilege
 * model (usecase-layer policy, not `requirePermission`).
 *
 * Optional body `{ seasonId?: string }` scopes to a specific season;
 * omitted → most recent season, else all-time.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { generateYearOnFarmPdf } from '@/app-layer/reports/pdf/year-on-farm';
import { getSeasonRecap } from '@/app-layer/usecases/season-recap';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { contentDisposition } from '@/lib/http/content-disposition';
import { collectPdfBuffer } from '@/app-layer/reports/pdf/collect-buffer';

const BodySchema = z.object({
    seasonId: z.string().optional(),
}).strip();

// Force Node.js runtime — PDFKit needs stream, zlib, Buffer.
export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    // Body is optional — a bare POST recaps the most recent season.
    let seasonId: string | undefined;
    const raw = await req.text();
    if (raw.trim().length > 0) {
        seasonId = BodySchema.parse(JSON.parse(raw)).seasonId;
    }

    // Resolve the recap once for the filename year; the generator pulls
    // its own copy of the data internally (data lives inside the usecase).
    const recap = await getSeasonRecap(ctx, seasonId);
    const yearLabel = recap.year != null ? String(recap.year) : 'all-time';
    const fileName = `year-on-farm-${yearLabel}.pdf`;

    const pdfDoc = await generateYearOnFarmPdf(ctx, { seasonId });
    const pdfBuffer = await collectPdfBuffer(pdfDoc);

    return new Response(new Uint8Array(pdfBuffer), {
        status: 200,
        headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': contentDisposition(fileName),
            'Cache-Control': 'no-store',
            'Content-Length': String(pdfBuffer.length),
        },
    });
});
