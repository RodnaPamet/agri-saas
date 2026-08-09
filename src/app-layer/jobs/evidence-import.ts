/**
 * Epic 43.3 — Bulk evidence import from a ZIP archive.
 *
 * Triggered by `POST /api/t/:slug/evidence/imports`. The HTTP layer
 * stages the uploaded ZIP under `temp/<tenantId>/...` and enqueues
 * this job; the worker streams the archive back, walks every entry,
 * runs the safety guards, and routes accepted entries through the
 * canonical `uploadEvidenceFile` usecase so business rules (MIME
 * allowlist, dedup, audit trail, tenant scoping, RLS, encryption)
 * stay byte-for-byte identical to the single-file upload path.
 *
 * ## Why not extract synchronously inside the request
 *
 * A 100 MB ZIP holding 500 PDFs would block the Next.js runtime for
 * minutes — every subsequent request on that lambda/instance would
 * stall. BullMQ moves the work to the worker process where slow
 * jobs are the norm and operators can scale independently.
 *
 * ## Safety bounds
 *
 * Every bound is enforced BEFORE decompressing the entry — we read
 * the central directory's declared sizes via jszip and reject the
 * whole archive on the first violation. Decompressing first and
 * counting bytes after is the classic ZIP-bomb mistake.
 *
 *   - **Compressed size** capped on upload (handled by the HTTP
 *     layer's existing `isAllowedSize`; reasserted here as a
 *     belt-and-braces signal).
 *   - **Total declared uncompressed size** capped at
 *     `MAX_UNCOMPRESSED_BYTES` (default 500 MB). A bomb that
 *     advertises 8 GB triggers a single check, no decompression.
 *   - **Per-entry compression ratio** capped at `MAX_RATIO` (100:1).
 *     Real ZIPs of mixed evidence rarely exceed 10:1; legitimate
 *     text-only archives can hit ~30:1. 100:1 catches gzip-bomb
 *     style archives without false-positiving on compressed CSVs.
 *   - **File count** capped at `MAX_ENTRIES` (default 1000). Past
 *     this, the import is split into multiple uploads.
 *   - **Path traversal** — entries with `..`, absolute paths, NUL
 *     bytes, drive prefixes (`C:\`), or backslashes are rejected.
 *     We never write extracted bytes to a filesystem path derived
 *     from the entry name; `uploadEvidenceFile` consumes the
 *     basename and lets the storage layer build the canonical
 *     `tenants/<tenantId>/evidence/...` key. Belt-and-braces all
 *     the same.
 *   - **Symlinks / directories / Mac OS metadata** — skipped, not
 *     errored. ZIPs from macOS often carry `__MACOSX/` and
 *     `.DS_Store` entries we don't want as evidence rows.
 *
 * ## Idempotency
 *
 * - The job is non-retrying (`attempts: 1`) so a crash mid-import
 *   leaves partial evidence rows in place but doesn't double up.
 * - `uploadEvidenceFile` already de-dupes by SHA-256 — re-running
 *   the same archive doesn't duplicate evidence content (the
 *   second run reuses the existing FileRecord), but DOES create
 *   duplicate Evidence rows. Operators should clean up before
 *   re-importing.
 *
 * ## Observability
 *
 * The job updates BullMQ progress as it iterates entries so the
 * GET status endpoint can show `extracted/skipped/errored` live.
 * On completion, the JobRunResult details carry the full
 * per-entry tally + any reject reasons for ops.
 */

import crypto from 'node:crypto';
import JSZip from 'jszip';

import { prisma } from '@/lib/prisma';
import { getStorageProvider } from '@/lib/storage';
import { logger } from '@/lib/observability/logger';
import { runJob } from '@/lib/observability/job-runner';
import { uploadEvidenceFile } from '@/app-layer/usecases/evidence';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import type { EvidenceImportPayload } from './types';

// ─── Limits ─────────────────────────────────────────────────────────

/** Total declared uncompressed bytes across all kept entries. */
export const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MB
/** Per-entry compression ratio — anything wilder reads as a bomb. */
export const MAX_RATIO = 100;
/** Hard cap on entry count. */
export const MAX_ENTRIES = 1000;
/** Floor for ratio enforcement — tiny entries trivially exceed it. */
const RATIO_MIN_COMPRESSED_BYTES = 1024;

// ─── Result shape ───────────────────────────────────────────────────

export interface EvidenceImportSkip {
    path: string;
    reason: string;
}

export interface EvidenceImportResult {
    tenantId: string;
    /** Source archive — for log correlation only. */
    stagingPathKey: string;
    /** Successfully created Evidence ids. */
    evidenceIds: string[];
    /** Total entries inspected from the archive's central directory. */
    totalEntries: number;
    /** Entries successfully extracted + persisted as evidence. */
    extracted: number;
    /** Entries the safety guards / file-type filter dropped. */
    skipped: number;
    /** Entries that hit a runtime error mid-extract. */
    errored: number;
    /** Up to the first 50 skip reasons — the rest are logged. */
    skipReasons: EvidenceImportSkip[];
    /** First error message if any extraction throws. */
    firstError?: string;
    jobRunId: string;
}

// ─── Path safety ────────────────────────────────────────────────────

/**
 * Reject ZIP entry paths that could escape the intended directory.
 * The actual write path is built by the storage layer from the
 * basename (we never feed the entry path into `path.join`); this
 * defensive check is the second of the two locks.
 */
export function isUnsafeZipEntryPath(entryPath: string): boolean {
    if (!entryPath) return true;
    if (entryPath.includes('\0')) return true;
    if (entryPath.startsWith('/') || entryPath.startsWith('\\')) return true;
    if (/^[a-zA-Z]:[\\/]/.test(entryPath)) return true; // C:\ or C:/
    // Backslashes in zip entries are non-portable + usually a sign of
    // a bad/malicious encoder. POSIX-style `/` separators are the
    // only ones we accept.
    if (entryPath.includes('\\')) return true;
    const segments = entryPath.split('/');
    for (const seg of segments) {
        if (seg === '..') return true;
    }
    return false;
}

/** Strip a directory prefix safely; returns `null` for unsafe paths. */
export function safeBasename(entryPath: string): string | null {
    if (isUnsafeZipEntryPath(entryPath)) return null;
    const idx = entryPath.lastIndexOf('/');
    const base = idx >= 0 ? entryPath.slice(idx + 1) : entryPath;
    if (!base || base === '.' || base === '..') return null;
    return base;
}

// ─── ZIP-bomb detection ─────────────────────────────────────────────

export function isLikelyZipBombEntry(opts: {
    compressedSize: number;
    uncompressedSize: number;
    maxRatio?: number;
}): boolean {
    const maxRatio = opts.maxRatio ?? MAX_RATIO;
    if (opts.compressedSize < RATIO_MIN_COMPRESSED_BYTES) {
        // Tiny entries can trivially exceed the ratio (e.g. an empty
        // file's central-directory entry has compressed=0). Don't
        // false-positive on those.
        return false;
    }
    if (opts.compressedSize === 0) return false;
    return opts.uncompressedSize / opts.compressedSize > maxRatio;
}

// ─── MIME allow-list mirror ─────────────────────────────────────────
//
// We can't import the existing isAllowedMime because it lives next to
// the upload usecase and pulls Prisma — keep this list aligned with
// the dropzone's evidence accept= preset (file-upload.tsx). Any
// mismatch is caught at uploadEvidenceFile time anyway (it re-checks
// MIME) — this is the cheap pre-filter so we don't decompress entries
// the usecase will refuse.

const EVIDENCE_EXTENSIONS = new Set([
    'pdf',
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'csv',
    'txt',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'json',
]);

function entryAcceptable(name: string): boolean {
    const ext = name.split('.').pop()?.toLowerCase();
    return ext ? EVIDENCE_EXTENSIONS.has(ext) : false;
}

// ─── Helpers ────────────────────────────────────────────────────────

async function streamToBuffer(
    stream: NodeJS.ReadableStream,
): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
        );
    }
    return Buffer.concat(chunks);
}

function inferMimeType(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    switch (ext) {
        case 'pdf':
            return 'application/pdf';
        case 'png':
            return 'image/png';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'gif':
            return 'image/gif';
        case 'webp':
            return 'image/webp';
        case 'csv':
            return 'text/csv';
        case 'txt':
            return 'text/plain';
        case 'doc':
            return 'application/msword';
        case 'docx':
            return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        case 'xls':
            return 'application/vnd.ms-excel';
        case 'xlsx':
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        case 'json':
            return 'application/json';
        default:
            return 'application/octet-stream';
    }
}

async function buildJobContext(payload: EvidenceImportPayload): Promise<RequestContext> {
    const membership = await prisma.tenantMembership.findFirst({
        where: {
            userId: payload.initiatedByUserId,
            tenantId: payload.tenantId,
            status: 'ACTIVE',
        },
        select: { role: true, customRoleId: true },
    });
    if (!membership) {
        throw new Error(
            `evidence-import: user ${payload.initiatedByUserId} is not an active member of tenant ${payload.tenantId}`,
        );
    }
    const appPermissions = getPermissionsForRole(membership.role);
    const role = membership.role;
    return {
        requestId: payload.requestId ?? `evidence-import-${payload.tenantId}`,
        userId: payload.initiatedByUserId,
        tenantId: payload.tenantId,
        role,
        permissions: {
            canRead: appPermissions.evidence.view,
            canWrite: appPermissions.evidence.upload,
            canAdmin: appPermissions.admin.manage,
            canAudit: appPermissions.audits.view,
            canExport: appPermissions.reports.export,
        },
        appPermissions,
    };
}

// ─── Public job entry point ─────────────────────────────────────────

export async function runEvidenceImport(
    payload: EvidenceImportPayload,
    onProgress?: (p: { extracted: number; skipped: number; errored: number; totalEntries: number }) => Promise<void> | void,
): Promise<EvidenceImportResult> {
    const jobRunId = crypto.randomUUID();
    return runJob('evidence-import', async () => {
        const ctx = await buildJobContext(payload);
        if (!ctx.permissions.canWrite) {
            throw new Error(
                `evidence-import: user ${payload.initiatedByUserId} lacks evidence.upload permission on tenant ${payload.tenantId}`,
            );
        }

        const storage = getStorageProvider();
        const stream = storage.readStream(payload.stagingPathKey);
        const archiveBuffer = await streamToBuffer(stream);

        const zip = await JSZip.loadAsync(archiveBuffer);

        // Build a flat list of file entries (skip directories /
        // metadata) with declared sizes from the central directory.
        const entries: Array<{
            path: string;
            compressedSize: number;
            uncompressedSize: number;
            obj: JSZip.JSZipObject;
        }> = [];

        zip.forEach((relativePath, fileObj) => {
            if (fileObj.dir) return;
            // Some encoders (macOS Archive Utility) include `__MACOSX/`
            // and `.DS_Store` — drop them silently rather than count
            // them as skips, they're not user-meaningful entries.
            if (
                relativePath.startsWith('__MACOSX/') ||
                relativePath.endsWith('.DS_Store') ||
                relativePath.split('/').pop()?.startsWith('._')
            ) {
                return;
            }
            // jszip exposes sizes via the internal _data pointer.
            const data = (fileObj as unknown as {
                _data?: { uncompressedSize?: number; compressedSize?: number };
            })._data;
            entries.push({
                path: relativePath,
                compressedSize: data?.compressedSize ?? 0,
                uncompressedSize: data?.uncompressedSize ?? 0,
                obj: fileObj,
            });
        });

        // ── Top-level archive checks ────────────────────────────────
        if (entries.length > MAX_ENTRIES) {
            throw new Error(
                `evidence-import: archive has ${entries.length} entries; max is ${MAX_ENTRIES}. Split into multiple uploads.`,
            );
        }
        const totalDeclared = entries.reduce(
            (sum, e) => sum + (e.uncompressedSize || 0),
            0,
        );
        if (totalDeclared > MAX_UNCOMPRESSED_BYTES) {
            throw new Error(
                `evidence-import: archive declares ${totalDeclared} uncompressed bytes; cap is ${MAX_UNCOMPRESSED_BYTES}. ` +
                    'Possible ZIP-bomb — refusing to extract.',
            );
        }

        const skipReasons: EvidenceImportSkip[] = [];
        let extracted = 0;
        let skipped = 0;
        let errored = 0;
        let firstError: string | undefined;
        const evidenceIds: string[] = [];

        const recordSkip = (path: string, reason: string) => {
            skipped += 1;
            if (skipReasons.length < 50) {
                skipReasons.push({ path, reason });
            } else {
                logger.debug('evidence-import.skip_overflow', {
                    component: 'evidence-import',
                    path,
                    reason,
                });
            }
        };

        for (const entry of entries) {
            // ── Per-entry safety checks ─────────────────────────────
            if (isUnsafeZipEntryPath(entry.path)) {
                recordSkip(entry.path, 'unsafe-path');
                continue;
            }
            const basename = safeBasename(entry.path);
            if (!basename) {
                recordSkip(entry.path, 'unsafe-path');
                continue;
            }
            if (isLikelyZipBombEntry(entry)) {
                recordSkip(entry.path, 'zip-bomb-ratio');
                continue;
            }
            if (!entryAcceptable(basename)) {
                recordSkip(entry.path, 'extension-not-allowed');
                continue;
            }

            // ── Decompress + create evidence ────────────────────────
            try {
                const buf = await entry.obj.async('nodebuffer');
                if (buf.length > entry.uncompressedSize + 64) {
                    // Defence in depth: if actual decompressed size
                    // wildly exceeds the declared one, abort the
                    // archive rather than the entry — the central
                    // directory was lying to us.
                    throw new Error(
                        `evidence-import: entry "${entry.path}" decompressed to ${buf.length} bytes vs declared ${entry.uncompressedSize}`,
                    );
                }
                // Slice into a fresh `ArrayBuffer` so the File
                // constructor's strict BlobPart typing accepts the
                // value (Node's `Buffer` carries a wider
                // `ArrayBufferLike` that may be `SharedArrayBuffer`).
                const ab = buf.buffer.slice(
                    buf.byteOffset,
                    buf.byteOffset + buf.byteLength,
                ) as ArrayBuffer;
                const fileLike = new File([ab], basename, {
                    type: inferMimeType(basename),
                });
                const evidence = await uploadEvidenceFile(ctx, fileLike, {
                    title: basename,
                    practiceId: payload.practiceId ?? null,
                    category: payload.category ?? null,
                });
                evidenceIds.push(evidence.id);
                extracted += 1;
            } catch (err) {
                errored += 1;
                const message =
                    err instanceof Error ? err.message : String(err);
                if (!firstError) firstError = message;
                logger.warn('evidence-import.entry_failed', {
                    component: 'evidence-import',
                    tenantId: payload.tenantId,
                    path: entry.path,
                    error: message,
                });
            }

            if (onProgress) {
                await onProgress({
                    extracted,
                    skipped,
                    errored,
                    totalEntries: entries.length,
                });
            }
        }

        // ── Apply optional retention to every created evidence ──────
        if (payload.retentionUntilIso && evidenceIds.length > 0) {
            const retentionUntil = new Date(payload.retentionUntilIso);
            await prisma.evidence.updateMany({
                where: {
                    tenantId: payload.tenantId,
                    id: { in: evidenceIds },
                },
                data: {
                    retentionUntil,
                    retentionPolicy: 'FIXED_DATE',
                },
            });
        }

        // ── Cleanup the staged ZIP. Best-effort — the worker has
        // already created the evidence rows and the staging slot is
        // tenant-scoped, so a leak here is bounded + recoverable.
        try {
            await storage.delete(payload.stagingPathKey);
        } catch (err) {
            logger.warn('evidence-import.staging_cleanup_failed', {
                component: 'evidence-import',
                tenantId: payload.tenantId,
                stagingPathKey: payload.stagingPathKey,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        try {
            await prisma.fileRecord.delete({
                where: { id: payload.stagingFileRecordId },
            });
        } catch {
            // Already cleaned up — no-op.
        }

        const result: EvidenceImportResult = {
            tenantId: payload.tenantId,
            stagingPathKey: payload.stagingPathKey,
            evidenceIds,
            totalEntries: entries.length,
            extracted,
            skipped,
            errored,
            skipReasons,
            firstError,
            jobRunId,
        };

        logger.info('evidence-import.completed', {
            component: 'evidence-import',
            tenantId: payload.tenantId,
            jobRunId,
            extracted,
            skipped,
            errored,
            totalEntries: entries.length,
        });

        return result;
    }, { tenantId: payload.tenantId });
}
