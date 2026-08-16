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
import { getProviderByName, assertTenantKey } from '@/lib/storage';
import { isDownloadAllowed, getBlockedReason } from '@/lib/storage/av-scan';
import { withApiErrorHandling } from '@/lib/errors/api';
import { notFound, forbidden } from '@/lib/errors/types';
import { assertCanRead } from '@/app-layer/policies/common';
import { withDeleted } from '@/lib/soft-delete';
import type { StorageProviderType } from '@/lib/storage/types';

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
            // `status`, `scanStatus`, `deletedAt` and `storageProvider` were
            // all absent from this select, so the route could not have gated
            // even if asked to — it had no status to consult. `withDeleted`
            // for the same reason as the evidence download gate: FileRecord
            // is soft-deletable, so without it a deleted row returns NULL and
            // the caller gets a misleading "not found".
            const fr = await db.fileRecord.findFirst(withDeleted({
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
                    status: true,
                    scanStatus: true,
                    deletedAt: true,
                    storageProvider: true,
                },
            }));
            if (!fr) throw notFound('Evidence file not found');
            if (fr.deletedAt) throw notFound('Evidence file has been deleted');
            if (fr.status !== 'STORED') {
                throw notFound('Evidence file is not available for download');
            }
            // The AV gate. Derived from `isDownloadAllowed` rather than
            // restated here — CLAUDE.md is explicit that a second copy of the
            // policy beside the original is how the two drift.
            if (!isDownloadAllowed(fr.scanStatus)) {
                throw forbidden(getBlockedReason(fr.scanStatus));
            }
            return fr;
        });

        // Assert the RESOLVED key belongs to the caller's tenant — never the
        // string a caller supplied. See the note on `downloadEvidenceFile`
        // for the cross-tenant read this prevents.
        assertTenantKey(fileRecord.pathKey, ctx.tenantId);

        // Read through the provider the RECORD names. `getStorageProvider()`
        // returns the currently-configured default, which silently reads from
        // the wrong backend for any object written before a provider switch.
        const storage = getProviderByName(
            fileRecord.storageProvider as StorageProviderType,
        );
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
