/**
 * POST /api/t/[tenantSlug]/processes/[id]/export-pdf
 *
 * Epic P3-PR-B — server-side PDF generation for a process map.
 * The client renders the canvas as a PNG (P3-PR-A's
 * `exportCanvasAsPng`) and posts the base64 bytes here; we wrap
 * them in a branded PDF and stream the result back.
 *
 * Body: { pngDataUrl: string }  — `data:image/png;base64,...`
 * Returns: `application/pdf` with `Content-Disposition: attachment`.
 *
 * Why server-side:
 *   - Reuses the audit-pack PDF factory (`createPdfDocument`,
 *     `addCoverPage`, `applyHeadersAndFooters`) so the artefact
 *     looks like every other compliance export.
 *   - Avoids a ~200KB client-bundle hit from adding jsPDF.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { getProcessMap } from '@/app-layer/usecases/process-map';
import { generateProcessMapPdf } from '@/app-layer/reports/pdf/processMap';
import { badRequest } from '@/lib/errors/types';

// Force Node.js runtime — pdfkit needs stream / zlib / Buffer.
export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
    pngDataUrl: z
        .string()
        .startsWith('data:image/png;base64,')
        .min('data:image/png;base64,'.length + 16),
});

function collectPdfBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}

function safeFilename(mapName: string): string {
    const stem =
        mapName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'process-map';
    return `${stem}.pdf`;
}

export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: {
            params: Promise<{ tenantSlug: string; id: string }>;
        },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const body = Body.parse(await req.json());

        // Confirm the map exists + the caller can read it. Throws
        // notFound — withApiErrorHandling maps it to 404.
        const map = await getProcessMap(ctx, params.id);

        // Decode the base64 PNG. The Zod schema guards the prefix,
        // so the slice is safe.
        const base64 = body.pngDataUrl.slice(
            'data:image/png;base64,'.length,
        );
        let pngBytes: Buffer;
        try {
            pngBytes = Buffer.from(base64, 'base64');
        } catch {
            throw badRequest('Invalid PNG payload');
        }
        if (pngBytes.length < 32) {
            throw badRequest('Invalid PNG payload');
        }

        // PDF generator owns the tenant-name lookup (same pattern
        // as riskRegister.ts) so the route layer stays a thin
        // orchestration shell — the `no-prisma-in-routes`
        // structural guardrail enforces it.
        const pdfDoc = await generateProcessMapPdf(ctx, {
            mapName: map.name,
            version: map.version,
            pngBytes,
        });
        const pdfBuffer = await collectPdfBuffer(pdfDoc);

        const filename = safeFilename(map.name);
        // NextResponse's BodyInit accepts Uint8Array but not the
        // Node Buffer subtype (the Web type doesn't carry Node's
        // extra methods). Project the buffer through Uint8Array.
        return new NextResponse(new Uint8Array(pdfBuffer), {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': String(pdfBuffer.length),
                'Cache-Control': 'no-store, max-age=0',
            },
        });
    },
);

// Avoid unused-import warning when this file is the only one
// re-exporting jsonResponse — keep the alias so future error
// paths can pivot to JSON without an extra import.
export { jsonResponse };
