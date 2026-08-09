/**
 * Epic G-4 — Stream the closeout PDF evidence artifact.
 *
 *   GET /api/t/:slug/access-reviews/:reviewId/evidence
 *
 * Resolves the campaign's `evidenceFileRecordId`, fetches the
 * underlying FileRecord (tenant-scoped), and streams the PDF back
 * with the canonical filename. 404 when the campaign has no
 * artifact yet (e.g. closeout PDF generation failed and the
 * regenerate path hasn't run).
 */
import { NextRequest } from 'next/server';
import { Readable } from 'node:stream';
import { getTenantCtx } from '@/app-layer/context';
import { runInTenantContext } from '@/lib/db-context';
import { getStorageProvider } from '@/lib/storage';
import { withApiErrorHandling } from '@/lib/errors/api';
import { notFound } from '@/lib/errors/types';
import { assertCanRead } from '@/app-layer/policies/common';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; reviewId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        assertCanRead(ctx);

        const fileRecord = await runInTenantContext(ctx, async (db) => {
            const review = await db.accessReview.findFirst({
                where: { id: params.reviewId, tenantId: ctx.tenantId },
                select: { evidenceFileRecordId: true },
            });
            if (!review) throw notFound('Access review not found');
            if (!review.evidenceFileRecordId) {
                throw notFound(
                    'No evidence artifact has been generated for this campaign yet.',
                );
            }
            const fr = await db.fileRecord.findFirst({
                where: {
                    id: review.evidenceFileRecordId,
                    tenantId: ctx.tenantId,
                },
                select: {
                    id: true,
                    pathKey: true,
                    originalName: true,
                    mimeType: true,
                    sizeBytes: true,
                },
            });
            if (!fr) throw notFound('Evidence file not found');
            return fr;
        });

        const storage = getStorageProvider();
        const stream = storage.readStream(fileRecord.pathKey);

        // Convert Node Readable → Web ReadableStream for Next.js Response.
        const webStream = Readable.toWeb(stream) as unknown as ReadableStream;

        return new Response(webStream, {
            status: 200,
            headers: {
                'Content-Type': fileRecord.mimeType,
                'Content-Disposition': `attachment; filename="${fileRecord.originalName}"`,
                'Content-Length': String(fileRecord.sizeBytes),
                'Cache-Control': 'private, no-store',
            },
        });
    },
);
