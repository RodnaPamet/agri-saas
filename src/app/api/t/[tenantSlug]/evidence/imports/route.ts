/**
 * POST /api/t/[tenantSlug]/evidence/imports — Epic 43.3
 *
 * Stages an uploaded ZIP archive in tenant-scoped storage and
 * enqueues the `evidence-import` BullMQ job to extract its contents
 * into individual evidence rows.
 *
 * Why HTTP doesn't extract synchronously: ZIP archives can hold
 * hundreds of files and decompressing them inside the request would
 * stall the runtime for minutes. The handler's contract is just
 * "accept + stage + enqueue"; the worker does the actual work.
 *
 * Tenant scoping + permission gating: same as the single-file
 * upload route. We require the request's resolved context (already
 * tenant-checked by `getTenantCtx`) plus `evidence.upload`. The
 * worker re-asserts the same permission when building its own
 * RequestContext, so a permission revocation between accept-time
 * and run-time still bounces the import.
 */

import { NextRequest } from 'next/server';
import { Readable } from 'node:stream';

import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import { scanUploadedBuffer } from '@/lib/storage/av-scan';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { env } from '@/env';
import { enqueue } from '@/app-layer/jobs/queue';
import { logger } from '@/lib/observability/logger';

// Cap on staged ZIP size — large enough for a real evidence pack,
// small enough to refuse pathological uploads at the boundary
// (worker's safety guards still re-check after extraction begins).
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024; // 100 MB

const ALLOWED_ARCHIVE_MIMES = new Set([
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream', // some browsers flag .zip this way
]);

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        if (!ctx.appPermissions.evidence.upload) {
            return jsonResponse(
                { error: 'evidence.upload permission required' },
                { status: 403 },
            );
        }

        const formData = await req.formData();
        const file = formData.get('file');
        if (!file || !(file instanceof File)) {
            return jsonResponse(
                { error: 'Missing or invalid file in form data' },
                { status: 400 },
            );
        }

        // Cheap up-front guards — sized + extension + MIME. Each one
        // gives the operator a clearer 4xx than waiting for the
        // worker to bounce the archive.
        if (file.size === 0) {
            return jsonResponse(
                { error: 'Archive is empty' },
                { status: 400 },
            );
        }
        if (file.size > MAX_ARCHIVE_BYTES) {
            return jsonResponse(
                {
                    error: `Archive exceeds the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB cap`,
                },
                { status: 413 },
            );
        }
        const lowerName = (file.name || '').toLowerCase();
        if (!lowerName.endsWith('.zip')) {
            return jsonResponse(
                { error: 'Only .zip archives are accepted' },
                { status: 415 },
            );
        }
        if (file.type && !ALLOWED_ARCHIVE_MIMES.has(file.type.toLowerCase())) {
            return jsonResponse(
                { error: `Archive MIME "${file.type}" is not accepted` },
                { status: 415 },
            );
        }

        // ── Stage to storage ───────────────────────────────────────
        const storage = getStorageProvider();
        const originalName = file.name || 'bundle.zip';
        const pathKey = buildTenantObjectKey(
            ctx.tenantId,
            'temp',
            `evidence-import-${Date.now()}-${originalName}`,
        );
        const buffer = Buffer.from(await file.arrayBuffer());
        const writeResult = await storage.write(
            pathKey,
            Readable.from(buffer),
            { mimeType: file.type || 'application/zip' },
        );

        // A REAL verdict, not the absent argument this used to pass.
        //
        // `markStored`'s `scanStatus` carried a `= 'SKIPPED'` default and
        // this call omitted it, so a 100 MB archive of arbitrary uploaded
        // files was recorded as stored AND downloadable
        // (`isDownloadAllowed('SKIPPED')` is true in every AV mode) without
        // a byte of it reaching the scanner. The archive is the single most
        // attractive thing on this surface to smuggle something into,
        // because every file inside it is extracted and kept.
        //
        // The bytes are already buffered (the size cap is enforced on them),
        // so this adds no I/O the request was not already doing.
        const scanStatus = await scanUploadedBuffer(buffer);

        // Track the staging upload as a FileRecord so cleanup +
        // observability stay consistent with every other ingest path.
        const fileRecord = await runInTenantContext(ctx, async (db) => {
            const fr = await FileRepository.createPending(db, ctx, {
                pathKey,
                originalName,
                mimeType: file.type || 'application/zip',
                sizeBytes: writeResult.sizeBytes,
                sha256: writeResult.sha256,
                storageProvider: storage.name,
                bucket: env.S3_BUCKET || null,
                domain: 'temp',
            });
            await FileRepository.markStored(db, ctx, fr.id, scanStatus);
            return fr;
        });

        // ── Optional metadata applies to every extracted file ──────
        const retentionUntil =
            (formData.get('retentionUntil') as string | null) || null;
        const category = (formData.get('category') as string | null) || null;

        // ── Enqueue the worker ─────────────────────────────────────
        const job = await enqueue('evidence-import', {
            tenantId: ctx.tenantId,
            initiatedByUserId: ctx.userId,
            stagingPathKey: pathKey,
            stagingFileRecordId: fileRecord.id,
            retentionUntilIso: retentionUntil,
            category,
            requestId: ctx.requestId,
        });

        logger.info('evidence-import.enqueued', {
            component: 'evidence-import-route',
            tenantId: ctx.tenantId,
            stagingPathKey: pathKey,
            jobId: job.id,
            sizeBytes: writeResult.sizeBytes,
        });

        return jsonResponse(
            {
                jobId: job.id,
                stagingFileRecordId: fileRecord.id,
                sizeBytes: writeResult.sizeBytes,
                status: 'queued',
            },
            { status: 202 },
        );
    },
);
