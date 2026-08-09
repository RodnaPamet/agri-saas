/**
 * POST /api/t/[tenantSlug]/reports/season-diary?seasonId=…
 *
 * Streams the combined БАБХ "ДНЕВНИК" for a whole season — one section-set
 * per Location that had a completed operation in the season window,
 * page-break between (a single PDF). Read-only data, authorised via
 * `assertCanRead` inside the generator (same privilege model as the
 * per-location farm-record + year-on-farm routes; no `requirePermission`).
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { generateSeasonDiaryPdf } from '@/app-layer/reports/pdf/farm-record-diary';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';

/** Collect a PDFKit document into a Buffer (listeners first, then end()). */
function collectPdfBuffer(pdfDoc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
        pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
        pdfDoc.on('error', reject);
        pdfDoc.end();
    });
}

// Force Node.js runtime — PDFKit needs stream, zlib, Buffer.
export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const seasonId = req.nextUrl.searchParams.get('seasonId');
        if (!seasonId) throw badRequest('seasonId is required');

        const pdfDoc = await generateSeasonDiaryPdf(ctx, { seasonId });
        const pdfBuffer = await collectPdfBuffer(pdfDoc);
        const fileName = `dnevnik-season-${seasonId}.pdf`;

        return new Response(new Uint8Array(pdfBuffer), {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${fileName}"`,
                'Cache-Control': 'no-store',
                'Content-Length': String(pdfBuffer.length),
            },
        });
    },
);
