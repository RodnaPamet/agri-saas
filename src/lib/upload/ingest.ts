/**
 * The one upload ingest pipeline.
 *
 * ── What this is, and what it deliberately is not ────────────────────
 *
 * It is NOT a generic upload ENDPOINT. A single route that any entity
 * posts to would mint a `FileRecord` with nothing attached to it, and the
 * attach would be a second request — so a dropped connection between the
 * two leaves an orphan file that is stored, scanned, billed and referenced
 * by nothing. Every multipart route in this repo mints its `FileRecord`
 * inside the same transaction as the entity write for that reason, and
 * that part is genuinely per-entity.
 *
 * What was NOT per-entity is everything BEFORE the transaction. This block
 * existed near-verbatim in three usecases and in degraded form in two more:
 *
 *     declared-MIME allowlist  →  size check  →  object key  →  buffer
 *       →  byte sniff + re-check  →  storage write  →  AV scan
 *
 * Five copies means five places to forget a step, and two of them had:
 * the staged-import routes skipped the sniff and the scan entirely. This
 * module is that block, once.
 *
 * ── The order is load-bearing ────────────────────────────────────────
 *
 * The declared MIME check runs FIRST because it is free and rejects the
 * obvious case before any bytes are read. It is not trusted: `file.type`
 * is the client's claim, so after buffering, `reconcileMimeType` reads the
 * signature and the allowlist is applied AGAIN to what the bytes actually
 * are. A `.pdf` full of HTML fails the second check even though it passed
 * the first.
 *
 * The scan runs on the buffer AFTER the write, not before. Writing an
 * infected file and recording it as INFECTED is recoverable — the download
 * gate refuses it and an operator can purge the key. Scanning first and
 * writing second means a crash between the two produces a stored object
 * with no record at all, which nothing will ever look at again.
 *
 * ── The status is returned, never defaulted ──────────────────────────
 *
 * `ingestUploadedFile` returns `scanStatus` and the caller passes it to
 * `FileRepository.markStored`. That argument used to carry a
 * `= 'SKIPPED'` default, and a default meaning "unscanned" is how two
 * upload paths came to skip the scanner without anyone deciding to. The
 * default is gone; a caller that wants to skip has to say so.
 */

import { Readable } from 'node:stream';

import { env } from '@/env';
import { badRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability';

import { scanUploadedBuffer } from '@/lib/storage/av-scan';
import { reconcileMimeType } from '@/lib/storage/mime-sniff';
// `@/lib/storage` — the same specifier every other consumer uses. This
// module deliberately does NOT live under `src/lib/storage/`: from inside
// that directory the natural import is `./index`, which resolves to a
// DIFFERENT module than `@/lib/storage` (that specifier hits the
// back-compat shim `src/lib/storage.ts`). Every existing test mocks the
// shim, so an ingest pipeline importing `./index` would quietly bypass all
// of them — which is exactly what happened on the first attempt.
import {
    buildTenantObjectKey,
    FILE_MAX_SIZE_BYTES,
    getStorageProvider,
    isAllowedMime,
    isAllowedSize,
} from '@/lib/storage';
import type { StorageDomain } from '@/lib/storage';

/** Everything the caller needs to mint its own `FileRecord`. */
export interface IngestedUpload {
    /** Storage key the bytes were written to. */
    pathKey: string;
    /** The name to display. Never trusted as a path — the key is built. */
    originalName: string;
    /** The RESOLVED type: what the bytes are, not what the client claimed. */
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    /** `'local' | 's3'` — recorded so a later read knows where to look. */
    storageProvider: string;
    bucket: string | null;
    domain: StorageDomain;
    /**
     * A TERMINAL scan outcome. Pass it to `FileRepository.markStored`; do
     * not substitute a guess.
     */
    scanStatus: 'CLEAN' | 'INFECTED' | 'SKIPPED' | 'PENDING';
    /** The buffered bytes, for a caller that needs to parse them (imports). */
    buffer: Buffer;
}

export interface IngestOptions {
    /** Storage domain — decides the key prefix. */
    domain: StorageDomain;
    /** Fallback when the upload carries no filename. */
    fallbackName: string;
    /**
     * Override the shared allowlist for a surface with its own, narrower
     * rule (an importer that takes only `.zip`, say). Returning a message
     * rejects with it; returning `null` accepts.
     *
     * A surface may narrow the shared allowlist. It may NOT widen it —
     * `isAllowedMime` still runs, and this is applied on top.
     */
    extraCheck?: (args: { mimeType: string; originalName: string }) => string | null;
    /**
     * Cap smaller than `FILE_MAX_SIZE_BYTES` for this surface, or larger
     * for a staged import that is parsed rather than served.
     */
    maxBytes?: number;
    /** Component name for the mismatch log line. */
    component: string;
}

/**
 * Validate, store and scan one uploaded file.
 *
 * Throws `badRequest` on any rejection — the caller never has to map error
 * shapes. Returns on success; the caller then writes its own rows.
 */
export async function ingestUploadedFile(
    tenantId: string,
    file: File,
    opts: IngestOptions,
): Promise<IngestedUpload> {
    const declaredMime = file.type || 'application/octet-stream';
    const originalName = file.name || opts.fallbackName;

    // Cheap rejections first — no bytes read yet.
    if (!isAllowedMime(declaredMime)) {
        throw badRequest(
            'FILE_TYPE_NOT_ALLOWED',
            `MIME type "${declaredMime}" is not allowed`,
        );
    }
    const cap = opts.maxBytes ?? FILE_MAX_SIZE_BYTES;
    if (opts.maxBytes != null ? file.size > opts.maxBytes : !isAllowedSize(file.size)) {
        throw badRequest('FILE_TOO_LARGE', `File exceeds maximum size of ${cap} bytes`);
    }
    if (file.size === 0) {
        throw badRequest('FILE_EMPTY', 'File is empty');
    }

    const storage = getStorageProvider();
    const pathKey = buildTenantObjectKey(tenantId, opts.domain, originalName);
    const buffer = Buffer.from(await file.arrayBuffer());

    // The SIGNATURE beats the claim. A file whose real content is
    // inadmissible is rejected here even though its declared type passed.
    const { resolved: mimeType, detected, corrected } = reconcileMimeType(
        declaredMime,
        buffer,
    );
    if (corrected) {
        if (!isAllowedMime(mimeType)) {
            throw badRequest(
                'FILE_TYPE_NOT_ALLOWED',
                `File content is "${mimeType}", which is not allowed`,
            );
        }
        logger.warn('upload declared a MIME type its bytes contradict', {
            component: opts.component,
            tenantId,
            declaredMime,
            detected,
        });
    }

    const extraRejection = opts.extraCheck?.({ mimeType, originalName });
    if (extraRejection) {
        throw badRequest('FILE_TYPE_NOT_ALLOWED', extraRejection);
    }

    const writeResult = await storage.write(pathKey, Readable.from(buffer), { mimeType });
    // A TERMINAL scan status before the record is treated as usable.
    const scanStatus = await scanUploadedBuffer(buffer);

    return {
        pathKey,
        originalName,
        mimeType,
        sizeBytes: writeResult.sizeBytes,
        sha256: writeResult.sha256,
        storageProvider: storage.name,
        bucket: env.S3_BUCKET || null,
        domain: opts.domain,
        scanStatus,
        buffer,
    };
}
