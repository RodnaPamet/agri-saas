/**
 * GET /api/t/[tenantSlug]/evidence/files/[fileId]/download
 * 
 * Secure file download: tenant-scoped, role-gated.
 * - S3 provider: responds with 302 redirect to presigned URL
 * - Local provider: streams file with correct headers
 */
import { NextRequest, NextResponse } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { downloadEvidenceFile } from '@/app-layer/usecases/evidence';
import { withApiErrorHandling } from '@/lib/errors/api';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; fileId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const result = await downloadEvidenceFile(ctx, params.fileId);

    // Sanitize filename for Content-Disposition
    const safeName = result.originalName
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/"/g, "'");

    // ─── S3: redirect to presigned URL ───
    if (result.mode === 'redirect') {
        return NextResponse.redirect(result.downloadUrl, {
            status: 302,
            headers: {
                'Cache-Control': 'private, no-cache, no-store',
                'X-Content-SHA256': result.sha256,
            },
        });
    }

    // ─── Local: stream file through server ───
    const nodeStream = result.stream;
    const webStream = new ReadableStream({
        start(controller) {
            nodeStream.on('data', (chunk: string | Buffer) => controller.enqueue(new Uint8Array(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
            nodeStream.on('end', () => controller.close());
            nodeStream.on('error', (err: Error) => controller.error(err));
        },
        cancel() {
            nodeStream.destroy();
        },
    });

    return new NextResponse(webStream, {
        status: 200,
        headers: {
            'Content-Type': result.mimeType || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${safeName}"`,
            'Content-Length': String(result.sizeBytes),
            'X-Content-SHA256': result.sha256,
            'Cache-Control': 'private, no-cache',
        },
    });
});
