/**
 * GET the bytes of a farm document, for preview (#2495, step 2).
 *
 * THIS ROUTE IS THE AV EGRESS GATE for the library. `ingestUploadedFile`
 * writes bytes before the scan resolves, and the argument that makes that
 * safe is that every read asks `isDownloadAllowed` first. The gate itself
 * lives in `downloadFarmDocument`, which is registered in `USECASE_SEAMS` in
 * `download-route-gate-reachability` — a route that streamed bytes without
 * reaching it would not just leak one file, it would retroactively remove the
 * reason uploads may hit disk unscanned.
 *
 * `inline`, because this is a preview surface rather than a download one. The
 * disposition is safe here precisely BECAUSE the gate above ran: the deleted
 * routes that motivated that guard served `inline` with no AV check at all.
 */
import { NextRequest, NextResponse } from 'next/server';

import { downloadFarmDocument } from '@/app-layer/usecases/farm-documents';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { contentDisposition } from '@/lib/http/content-disposition';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; documentId: string }>(
        'documents.view',
        async (_req: NextRequest, { params }, ctx) => {
            const result = await downloadFarmDocument(ctx, params.documentId);

            const nodeStream = result.stream;
            const webStream = new ReadableStream({
                start(controller) {
                    nodeStream.on('data', (chunk: string | Buffer) =>
                        controller.enqueue(
                            new Uint8Array(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
                        ),
                    );
                    nodeStream.on('end', () => controller.close());
                    nodeStream.on('error', (err: Error) => controller.error(err));
                },
                cancel() {
                    nodeStream.destroy();
                },
            });

            const headers: Record<string, string> = {
                'Content-Type': result.contentType,
                // The real name survives in RFC 6266 `filename*` with a
                // transliterated ASCII fallback — «Договор.pdf» must not
                // become `_______.pdf`, which is what a naive sanitiser did
                // to every Cyrillic filename until #1343.
                'Content-Disposition': contentDisposition(result.name ?? 'document', 'inline'),
                // Never cached by a shared cache: a document name and its
                // bytes are third-party personal data.
                'Cache-Control': 'private, no-store',
            };
            if (result.sizeBytes != null) headers['Content-Length'] = String(result.sizeBytes);

            return new NextResponse(webStream, { status: 200, headers });
        },
    ),
);
