import { RequestContext } from '../types';
import { assertCanWrite } from '../policies/common';
import { badRequest, notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { detectFormat } from '@/lib/spatial/parse';
import { assertUploadWithinSize } from '@/lib/spatial/limits';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import { scanUploadedBuffer } from '@/lib/storage/av-scan';
import { FileRepository } from '../repositories/FileRepository';
import { enqueue } from '@/app-layer/jobs/queue';
import { logger } from '@/lib/observability/logger';
import { env } from '@/env';
import { Readable } from 'node:stream';

export interface SpatialImportInput {
    filename: string;
    buffer: Buffer;
    mimeType?: string;
    /**
     * Default crop stamped on every imported parcel (#7). Optional — the
     * import UI allows "mixed / set later", which submits nothing.
     */
    cropType?: string | null;
}

export interface SpatialImportStageResult {
    /** BullMQ job id — poll `GET .../spatial-import/:jobId` for progress. */
    jobId: string;
    /** FileRecord of the staged upload (becomes Location.spatialFileId on success). */
    fileRecordId: string;
    /** Detected spatial format ('shapefile' | 'kml' | 'geojson'). */
    format: 'shapefile' | 'kml' | 'geojson';
}

/**
 * Stage a parcel-boundary upload and enqueue the off-thread import job.
 *
 * Abuse hardening (Epic harden-security #2): parsing a shapefile/KML/
 * GeoJSON is attacker-influenced CPU (vertex-count-scaled PostGIS +
 * `shpjs` decompression). We refuse to run it on the request thread.
 * This usecase is the cheap, synchronous boundary:
 *   1. authorize (write),
 *   2. detect format + enforce the per-format byte cap (caller — the
 *      route — surfaces the precise 413/415; this re-asserts as the
 *      single source of truth so a non-HTTP caller is bounded too),
 *   3. verify the target Location exists (tenant-scoped) BEFORE spending
 *      a storage write on it,
 *   4. stage the original bytes + record a FileRecord, carrying a REAL
 *      scan verdict (see below),
 *   5. enqueue the `spatial-import` job, which parses + validates +
 *      persists off-thread.
 *
 * Returns immediately with the job id; the route answers 202. The actual
 * parcel replacement happens in `runLocationSpatialImport`.
 */
export async function stageLocationSpatialImport(
    ctx: RequestContext,
    locationId: string,
    file: SpatialImportInput,
): Promise<SpatialImportStageResult> {
    assertCanWrite(ctx);

    // 1 — format detection + per-format byte cap. detectFormat returns
    //     null for an unsupported type (the route already 415s on
    //     extension, so this is a belt-and-braces 400); the size cap
    //     throws SpatialLimitError(413), which the route maps to a 413.
    const format = detectFormat(file.filename, file.mimeType);
    if (!format) {
        throw badRequest(
            'Unsupported file type. Upload a shapefile (.zip), KML (.kml/.kmz), or GeoJSON (.geojson/.json).',
        );
    }
    assertUploadWithinSize(format, file.buffer.length);

    // 2 — verify the target location exists before staging bytes for it.
    await runInTenantContext(ctx, async (db) => {
        const location = await db.location.findFirst({
            where: { id: locationId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!location) throw notFound('Location not found');
    });

    // 3 — stage the original upload through the storage abstraction.
    const storage = getStorageProvider();
    const mimeType = file.mimeType || 'application/octet-stream';
    const pathKey = buildTenantObjectKey(ctx.tenantId, 'spatial', file.filename);
    const writeResult = await storage.write(pathKey, Readable.from(file.buffer), { mimeType });

    // A REAL verdict, not the absent argument this used to pass.
    //
    // `markStored`'s `scanStatus` carried a `= 'SKIPPED'` default, and this
    // call omitted it — so a staged shapefile was recorded as stored AND
    // downloadable (`isDownloadAllowed('SKIPPED')` is true in every AV mode)
    // without a byte of it ever reaching the scanner. The docblock above
    // claimed ClamAV scanned it asynchronously and that the status was
    // PENDING; both were false, and no async scan worker exists.
    //
    // Scanning here is close to free: the bytes are already buffered in
    // memory (the size cap above is enforced on `file.buffer.length`), so
    // this adds no I/O the request was not already doing.
    const scanStatus = await scanUploadedBuffer(file.buffer);

    // 4 — record the FileRecord (becomes the Location's canonical spatial
    //     file on success; the job stamps it onto Location.spatialFileId).
    const fileRecord = await runInTenantContext(ctx, async (db) => {
        const fr = await FileRepository.createPending(db, ctx, {
            pathKey,
            originalName: file.filename,
            mimeType,
            sizeBytes: writeResult.sizeBytes,
            sha256: writeResult.sha256,
            storageProvider: storage.name,
            bucket: env.S3_BUCKET || null,
            domain: 'spatial',
        });
        await FileRepository.markStored(db, ctx, fr.id, scanStatus);
        return fr;
    });

    // 5 — enqueue the off-thread parse + validate + persist job.
    const job = await enqueue('spatial-import', {
        tenantId: ctx.tenantId,
        initiatedByUserId: ctx.userId,
        locationId,
        stagingPathKey: pathKey,
        stagingFileRecordId: fileRecord.id,
        filename: file.filename,
        mimeType: file.mimeType,
        cropType: file.cropType ?? undefined,
        requestId: ctx.requestId,
    });

    logger.info('spatial-import.enqueued', {
        component: 'spatial-import-stage',
        tenantId: ctx.tenantId,
        locationId,
        jobId: job.id,
        format,
        sizeBytes: writeResult.sizeBytes,
    });

    return { jobId: String(job.id), fileRecordId: fileRecord.id, format };
}
