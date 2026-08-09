import { RequestContext } from '../types';
import { EvidenceRepository, EvidenceListFilters } from '../repositories/EvidenceRepository';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { validateFile, uploadFile } from '@/lib/storage';
import { scanUploadedBuffer } from '@/lib/storage/av-scan';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { cachedListRead, bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import type { EvidenceType, ReviewCadence } from '@prisma/client';
import { z } from 'zod';
import { CreateEvidenceSchema, UpdateEvidenceSchema } from '@/lib/schemas';

export async function listEvidence(
    ctx: RequestContext,
    filters?: EvidenceListFilters,
    options: { take?: number } = {},
) {
    assertCanRead(ctx);
    return cachedListRead({
        ctx,
        entity: 'evidence',
        operation: 'list',
        // `take` participates in the cache key so a bounded SSR
        // result can't poison the unbounded API GET cache.
        params: options.take
            ? { ...(filters ?? {}), _take: options.take }
            : (filters ?? {}),
        loader: () =>
            runInTenantContext(ctx, (db) =>
                EvidenceRepository.list(db, ctx, filters, options),
            ),
    });
}

export async function listEvidencePaginated(ctx: RequestContext, params: {
    limit?: number; cursor?: string;
    // Multi-select facets travel as arrays the whole way down. The usecase
    // used to declare them `string`, which is what allowed a comma-joined
    // "FILE,LINK" to reach the repository and be cast into an enum filter.
    filters?: EvidenceListFilters;
}) {
    assertCanRead(ctx);
    return cachedListRead({
        ctx,
        entity: 'evidence',
        operation: 'listPaginated',
        params,
        loader: () =>
            runInTenantContext(ctx, (db) =>
                EvidenceRepository.listPaginated(db, ctx, params),
            ),
    });
}

export async function getEvidence(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const evidence = await EvidenceRepository.getById(db, ctx, id);
        if (!evidence) throw notFound('Evidence not found');
        // SP-3/audit — surface a SharePoint source link + last-sync time when
        // this evidence was imported from SharePoint (one mapping per evidence).
        const spMapping = await db.integrationSyncMapping.findFirst({
            where: {
                tenantId: ctx.tenantId,
                provider: 'sharepoint',
                localEntityType: 'Evidence',
                localEntityId: id,
            },
            select: { sourceUrl: true, lastSyncedAt: true, syncStatus: true },
        });
        // Only attach `sharePoint` when the evidence is SP-sourced — keeps the
        // shape unchanged for the common (non-SharePoint) case.
        if (!spMapping?.sourceUrl) return evidence;
        return {
            ...evidence,
            sharePoint: {
                sourceUrl: spMapping.sourceUrl,
                lastSyncedAt: spMapping.lastSyncedAt ? spMapping.lastSyncedAt.toISOString() : null,
                syncStatus: spMapping.syncStatus,
            },
        };
    });
}

/**
 * Sanitise an optional free-text field, preserving the three-state contract.
 *
 * `undefined` (no change) and `null` (clear) must survive untouched — coercing
 * either into `''` would turn "leave this alone" into "blank this out" on
 * every partial update.
 *
 * Evidence free text was persisted raw. Encryption is not the control here
 * (these columns are not in the manifest, because the repository searches them
 * with `contains`), and neither is render-time escaping: the row is read
 * verbatim by the PDF export, the audit-pack share link, and any SDK consumer.
 * Epic C.5 puts sanitisation at the usecase layer for exactly that reason, and
 * evidence — the table whose whole job is being handed to an auditor — was
 * missing from the eight usecases the D.2 ratchet covers.
 */
function sanitizeOptional<T extends string | null | undefined>(value: T): T {
    if (value === undefined || value === null) return value;
    return sanitizePlainText(value as string) as T;
}

export async function createEvidence(
    ctx: RequestContext,
    data: z.infer<typeof CreateEvidenceSchema> & { file?: File },
) {
    assertCanWrite(ctx);

    // File upload happens outside the tenant transaction (filesystem I/O)
    let fileName = data.fileName || null;
    let fileSize = data.fileSize || null;
    let content = data.content || null;

    if (data.type === 'FILE' && data.file) {
        try {
            validateFile(data.file as File, { maxSizeMB: 20 });
            const uploadResult = await uploadFile(data.file as File);
            fileName = uploadResult.originalName;
            fileSize = uploadResult.size;
            content = uploadResult.fileName;
        } catch (err: unknown) {
            throw badRequest('FILE_VALIDATION_ERROR', err instanceof Error ? err.message : 'File upload failed');
        }
    }

    const created = await runInTenantContext(ctx, async (db) => {
        const controlId = data.controlId || null;

        // Validate control belongs to the same tenant
        if (controlId) {
            const control = await db.control.findFirst({
                where: { id: controlId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!control) throw badRequest('INVALID_CONTROL', 'Control not found or belongs to a different tenant');
        }

        const evidence = await EvidenceRepository.create(db, ctx, {
            controlId,

            type: data.type as EvidenceType,
            title: sanitizePlainText(data.title),
            // `content` is a URL for LINK evidence and a storage key for FILE
            // evidence, but free text for TEXT evidence — and the row is read
            // verbatim downstream, so it is sanitised for all three.
            content: sanitizeOptional(content),
            fileName,
            fileSize,
            category: sanitizeOptional(data.category),
            // B8 follow-up — trim + null-coerce so empty input
            // maps to "no folder" (the UI group-by keys on null).
            folder: data.folder?.trim() ? sanitizePlainText(data.folder.trim()) : null,
            owner: sanitizeOptional(data.owner),
            ownerUserId: data.ownerUserId || null,

            reviewCycle: (data.reviewCycle || null) as ReviewCadence | null,
            nextReviewDate: data.nextReviewDate ? new Date(data.nextReviewDate) : null,
            status: 'DRAFT',
        });

        // Bridge: create ControlEvidenceLink so evidence shows in the control evidence tab
        if (controlId) {
            // ON CONFLICT DO NOTHING, not try/catch — see the note on the
            // same bridge in `uploadEvidenceFile` below. Catching a 23505 in
            // JS does not un-abort the surrounding Postgres transaction.
            const linkKind = data.type === 'LINK' ? 'LINK' : 'FILE';
            await db.controlEvidenceLink.createMany({
                data: [{
                    tenantId: ctx.tenantId,
                    controlId,
                    kind: linkKind,
                    fileId: evidence.fileRecordId || null,
                    url: data.type === 'LINK' ? (content || null) : null,
                    note: evidence.title,
                    createdByUserId: ctx.userId,
                }],
                skipDuplicates: true,
            });
        }

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Evidence',
            entityId: evidence.id,
            details: `Created evidence: ${evidence.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'created',
                after: { title: evidence.title, type: data.type },
                summary: `Created evidence: ${evidence.title}`,
            },
        });

        return evidence;
    });
    // Linking back to a control also affects the control list view
    // (`_count.evidence`); bump both entities.
    await bumpEntityCacheVersion(ctx, 'evidence');
    if (data.controlId) await bumpEntityCacheVersion(ctx, 'control');
    return created;
}

export async function updateEvidence(ctx: RequestContext, id: string, data: z.infer<typeof UpdateEvidenceSchema>) {
    assertCanWrite(ctx);

    const updated = await runInTenantContext(ctx, async (db) => {
        // Same tenant check `createEvidence` does. Re-assignment is a write
        // that crosses entities, so it gets the same gate — otherwise a
        // caller could attach their evidence to another tenant's control by
        // id, which the create path has always refused.
        if (data.controlId) {
            const control = await db.control.findFirst({
                where: { id: data.controlId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!control) throw badRequest('INVALID_CONTROL', 'Control not found or belongs to a different tenant');
        }

        const evidence = await EvidenceRepository.update(db, ctx, id, {
            title: sanitizeOptional(data.title),
            content: sanitizeOptional(data.content),
            // Three-state: undefined = no change, null = detach, id = re-assign.
            controlId: data.controlId === undefined ? undefined : (data.controlId || null),
            category: sanitizeOptional(data.category),
            // B8 follow-up — folder is editable post-create. The
            // three-state contract is preserved (undefined = no
            // change; null = clear; string = set).
            folder:
                data.folder === undefined
                    ? undefined
                    : (data.folder?.trim() ? sanitizePlainText(data.folder.trim()) : null),
            owner: sanitizeOptional(data.owner),
            ownerUserId: data.ownerUserId,

            reviewCycle: data.reviewCycle as ReviewCadence | undefined,
            nextReviewDate: data.nextReviewDate ? new Date(data.nextReviewDate) : undefined,
        });

        if (!evidence) throw notFound('Evidence not found');

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Evidence',
            entityId: id,
            details: `Evidence updated`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'updated',
                changedFields: Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined),
                after: { title: data.title, category: data.category },
                summary: 'Evidence updated',
            },
        });

        return evidence;
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return updated;
}

/**
 * Audit Coherence S3 (2026-05-22) — explicit state-machine table.
 *
 * Pre-this-PR `reviewEvidence` accepted any `action` string against
 * any current status; a `DRAFT → APPROVED` jump bypassed SUBMITTED.
 *
 * Author / submitter flow (EDITOR):
 *   DRAFT        → SUBMITTED   (ready for review)
 *   REJECTED     → SUBMITTED   (author revised; re-submit)
 *   NEEDS_REVIEW → SUBMITTED   (owner re-submits stale evidence)
 *
 * Reviewer flow (ADMIN):
 *   SUBMITTED → APPROVED
 *   SUBMITTED → REJECTED
 *
 * Out-of-band:
 *   APPROVED → NEEDS_REVIEW    (evidence-expiry cron, NOT this endpoint)
 */
const EVIDENCE_TRANSITIONS: Record<string, ReadonlySet<string>> = {
    DRAFT: new Set(['SUBMITTED']),
    REJECTED: new Set(['SUBMITTED']),
    NEEDS_REVIEW: new Set(['SUBMITTED']),
    SUBMITTED: new Set(['APPROVED', 'REJECTED']),
};

export async function reviewEvidence(ctx: RequestContext, id: string, data: { action: string; comment?: string | null }) {
    const { action, comment } = data;

    if (action === 'SUBMITTED') {
        assertCanWrite(ctx); // EDITOR
    } else if (action === 'APPROVED' || action === 'REJECTED') {
        assertCanAdmin(ctx); // ADMIN
    } else {
        throw badRequest('Invalid review action');
    }

    const result = await runInTenantContext(ctx, async (db) => {
        const evidence = await EvidenceRepository.getById(db, ctx, id);
        if (!evidence) throw notFound('Evidence not found');

        // Audit S3 — enforce the state machine BEFORE any write.
        const allowed = EVIDENCE_TRANSITIONS[evidence.status as string];
        if (!allowed || !allowed.has(action)) {
            throw badRequest(
                `Illegal evidence transition ${evidence.status} → ${action}. ` +
                    `From ${evidence.status} the only legal next states are: ` +
                    `${[...(allowed ?? [])].join(', ') || 'none'}.`,
            );
        }

        const newStatus = action as 'SUBMITTED' | 'APPROVED' | 'REJECTED';

        // An APPROVED review restarts the clock. `reviewCycle` had no reader
        // anywhere in the codebase: setting "review quarterly" scheduled
        // nothing, and once a date passed it stayed passed, so the dashboard's
        // overdue tile went red permanently. Approving is the event that means
        // "a person has looked at this", which is exactly what the interval
        // measures from.
        const nextReviewDate = newStatus === 'APPROVED'
            ? nextReviewDateAfter(evidence.reviewCycle, new Date())
            : undefined;

        await EvidenceRepository.update(db, ctx, id, {
            status: newStatus,
            // `undefined` leaves the column alone (no cadence, or not an
            // approval); a Date advances it.
            ...(nextReviewDate ? { nextReviewDate } : {}),
        });
        await EvidenceRepository.addReview(db, ctx, id, newStatus, comment);

        // Audit S3 — notification routes via `ownerUserId` only. The
        // legacy free-text `name`-based lookup retired here; rows
        // missing `ownerUserId` simply don't notify (graceful degrade).
        if (newStatus === 'APPROVED' || newStatus === 'REJECTED') {
            const ownerUser = evidence.ownerUserId
                ? await db.user.findUnique({ where: { id: evidence.ownerUserId } })
                : null;
            if (ownerUser) {
                await db.notification.create({
                    data: {
                        tenantId: ctx.tenantId,
                        userId: ownerUser.id,
                        type: newStatus === 'APPROVED' ? 'EVIDENCE_APPROVED' : 'EVIDENCE_REJECTED',
                        title: `Evidence ${newStatus.toLowerCase()}: ${evidence.title}`,
                        message: comment || `Your evidence "${evidence.title}" has been ${newStatus.toLowerCase()}.`,
                        linkUrl: `/evidence`,
                    },
                });
            }
        }

        await logEvent(db, ctx, {
            action: 'STATUS_CHANGE',
            entityType: 'Evidence',
            entityId: id,
            details: `Evidence ${action}: ${comment || ''}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Evidence',
                fromStatus: evidence.status,
                toStatus: action,
                reason: comment || undefined,
            },
        });

        return { success: true, status: newStatus };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

// ─── Soft Delete / Restore / Purge ───

import { restoreEntity, purgeEntity } from './soft-delete-operations';
import { withDeleted } from '@/lib/soft-delete';

export async function deleteEvidence(ctx: RequestContext, id: string) {
    assertCanAdmin(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const evidence = await EvidenceRepository.getById(db, ctx, id);
        if (!evidence) throw notFound('Evidence not found');

        await db.evidence.delete({ where: { id } });

        await logEvent(db, ctx, {
            action: 'SOFT_DELETE',
            entityType: 'Evidence',
            entityId: id,
            details: `Evidence soft-deleted: ${evidence.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'deleted',
                before: { title: evidence.title },
                summary: `Evidence soft-deleted: ${evidence.title}`,
            },
        });
        return { success: true };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

export async function bulkDeleteEvidence(
    ctx: RequestContext,
    evidenceIds: string[],
): Promise<{ deleted: number }> {
    assertCanAdmin(ctx);

    const result = await runInTenantContext(ctx, async (db) => {
        const rows = await db.evidence.findMany({
            where: { id: { in: evidenceIds }, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (rows.length === 0) return { deleted: 0 };

        await db.evidence.deleteMany({
            where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId },
        });

        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'Evidence',
                entityId: r.id,
                details: 'Evidence soft-deleted (bulk)',
                detailsJson: { category: 'entity_lifecycle', entityName: 'Evidence', operation: 'deleted', summary: 'SOFT_DELETE' },
            });
        }

        return { deleted: rows.length };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

export async function restoreEvidence(ctx: RequestContext, id: string) {
    const result = await restoreEntity(ctx, 'Evidence', id);
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

export async function purgeEvidence(ctx: RequestContext, id: string) {
    const result = await purgeEntity(ctx, 'Evidence', id);
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

export async function listEvidenceWithDeleted(ctx: RequestContext) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, (db) =>
        db.evidence.findMany(withDeleted({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' as const } }))
    );
}

/**
 * GET evidence metrics — ADMIN only.
 */
export async function getEvidenceMetrics(ctx: RequestContext) {
    assertCanAdmin(ctx);
    const tenantId = ctx.tenantId;

    return runInTenantContext(ctx, async (db) => {
        const [totalEvidence, fileEvidence, linkedFileEvidence, fileRecordAgg, topControls] = await Promise.all([
            db.evidence.count({ where: { tenantId, deletedAt: null } }),
            db.evidence.count({ where: { tenantId, type: 'FILE', deletedAt: null } }),
            db.evidence.count({ where: { tenantId, type: 'FILE', controlId: { not: null }, deletedAt: null } }),

            db.fileRecord.aggregate({
                where: { tenantId, status: 'STORED' },
                _sum: { sizeBytes: true },
                _count: { id: true },
            }),
            db.evidence.groupBy({
                by: ['controlId'],
                where: { tenantId, controlId: { not: null }, deletedAt: null },
                _count: { id: true },
                orderBy: { _count: { id: 'desc' } },
                take: 10,
            }),
        ]);

        const controlIds = topControls
            .map((g: { controlId: string | null }) => g.controlId)
            .filter(Boolean) as string[];
        const controlNames = controlIds.length > 0
            ? await db.control.findMany({
                where: { id: { in: controlIds } },
                select: { id: true, name: true, code: true },
            })
            : [];

        const controlLookup = new Map(controlNames.map(c => [c.id, c]));
        const totalBytesStored = fileRecordAgg._sum?.sizeBytes ?? 0;
        const storedFileCount = fileRecordAgg._count?.id ?? 0;
        const linkedRate = fileEvidence > 0 ? Math.round((linkedFileEvidence / fileEvidence) * 100) : 0;

        return {
            totalEvidence,
            fileEvidence,
            linkedFileEvidence,
            linkedRate,
            storedFileCount,
            totalBytesStored,
            totalBytesFormatted: totalBytesStored < 1048576
                ? `${(totalBytesStored / 1024).toFixed(1)} KB`
                : `${(totalBytesStored / 1048576).toFixed(1)} MB`,
            topControlsByEvidence: topControls.map((g: { controlId: string | null; _count: { id: number } }) => {
                const ctrl = g.controlId ? controlLookup.get(g.controlId) : null;
                return {
                    controlId: g.controlId,
                    controlName: ctrl ? `${ctrl.code || ''} ${ctrl.name}`.trim() : '—',
                    evidenceCount: g._count.id,
                };
            }),
        };
    });
}

// ─── File Upload / Download ───

import { FileRepository } from '../repositories/FileRepository';
import {
    getStorageProvider,
    buildTenantObjectKey,
    assertTenantKey,
    isAllowedMime,
    isAllowedSize,
    FILE_MAX_SIZE_BYTES,
} from '@/lib/storage';
import type { StorageDomain } from '@/lib/storage';
import { Readable } from 'stream';
import { env } from '@/env';
import { nextReviewDateAfter } from '@/lib/evidence/review-cadence';
import { reconcileMimeType } from '@/lib/storage/mime-sniff';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logger } from '@/lib/observability/logger';

/**
 * Upload a file and create an Evidence record of type FILE in one flow.
 * Streams to disk + computes SHA-256 + creates FileRecord + Evidence.
 * Supports SHA-256 dedup: reuses existing FileRecord if same hash+tenant.
 */
export async function uploadEvidenceFile(
    ctx: RequestContext,
    file: File,
    metadata: {
        title?: string;
        controlId?: string | null;
        /** Source task — set when uploaded from a task's Evidence tab. */
        taskId?: string | null;
        /** Source asset — set when uploaded from that entity's Evidence tab. */
        assetId?: string | null;
        category?: string | null;
        /** B8 follow-up — folder applied to the newly-created
         *  evidence row. Trimmed + null-coerced inside `create`. */
        folder?: string | null;
        owner?: string | null;         // Legacy free-text
        ownerUserId?: string | null;   // Real user FK (preferred)
        reviewCycle?: string | null;
        nextReviewDate?: string | null;
        domain?: StorageDomain;
    },
) {
    assertCanWrite(ctx);

    // Validate before writing.
    //
    // `file.type` is the CLIENT's claim — the browser's guess, or on a
    // hand-built multipart request simply a string the caller chose. Checking
    // only the claim means the allowlist gates on a value the uploader
    // controls, and since the type is persisted and replayed as the download
    // `Content-Type`, it also let the uploader choose what a future browser
    // would treat the bytes as. The claim is checked here to reject the
    // obvious cases early and cheaply, and the BYTES are checked below, once
    // we hold them.
    const declaredMime = file.type || 'application/octet-stream';
    if (!isAllowedMime(declaredMime)) {
        throw badRequest('FILE_TYPE_NOT_ALLOWED', `MIME type "${declaredMime}" is not allowed`);
    }
    if (!isAllowedSize(file.size)) {
        throw badRequest('FILE_TOO_LARGE', `File exceeds maximum size of ${FILE_MAX_SIZE_BYTES} bytes`);
    }

    const storage = getStorageProvider();
    const originalName = file.name || 'unnamed';
    const domain = metadata.domain || 'evidence';
    const pathKey = buildTenantObjectKey(ctx.tenantId, domain, originalName);

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // What the bytes actually are. A recognisable signature that contradicts
    // the claim wins, and the resolved type is re-checked against the
    // allowlist — so a file that declared `text/plain` to get past the gate is
    // stored and served as whatever it really is, and is rejected outright if
    // that is not admissible.
    const { resolved: mimeType, detected, corrected } = reconcileMimeType(declaredMime, buffer);
    if (corrected) {
        if (!isAllowedMime(mimeType)) {
            throw badRequest(
                'FILE_TYPE_NOT_ALLOWED',
                `File content is "${mimeType}", which is not allowed`,
            );
        }
        logger.warn('upload declared a MIME type its bytes contradict', {
            component: 'evidence',
            tenantId: ctx.tenantId,
            declaredMime,
            detected,
        });
    }

    const readable = Readable.from(buffer);
    const writeResult = await storage.write(pathKey, readable, { mimeType });

    // AV scan on the buffer we already hold, BEFORE the record is marked
    // stored. Resolves to a terminal status — never PENDING unless a
    // configured scanner erred under strict mode.
    const scanStatus = await scanUploadedBuffer(buffer);

    // Create FileRecord + Evidence in a transaction
    const result = await runInTenantContext(ctx, async (db) => {
        const controlId = metadata.controlId || null;
        const taskId = metadata.taskId || null;
        const assetId = metadata.assetId || null;

        // Validate control belongs to the same tenant
        if (controlId) {
            const control = await db.control.findFirst({
                where: { id: controlId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!control) throw badRequest('INVALID_CONTROL', 'Control not found or belongs to a different tenant');
        }

        // Validate task belongs to the same tenant
        if (taskId) {
            const task = await db.task.findFirst({
                where: { id: taskId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!task) throw badRequest('INVALID_TASK', 'Task not found or belongs to a different tenant');
        }

        // Validate asset belongs to the same tenant
        if (assetId) {
            const asset = await db.asset.findFirst({
                where: { id: assetId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!asset) throw badRequest('INVALID_ASSET', 'Asset not found or belongs to a different tenant');
        }

        // ─── SHA-256 Dedup ───
        const existingFile = await FileRepository.findBySha256(db, ctx.tenantId, writeResult.sha256);
        let fileRecordId: string;
        let deduplicated = false;

        if (existingFile && existingFile.status === 'STORED') {
            // Reuse existing FileRecord — delete the new file
            fileRecordId = existingFile.id;
            deduplicated = true;
            try { await storage.delete(pathKey); } catch { /* best effort */ }
        } else {
            // Create new FileRecord with cloud storage metadata
            const fileRecord = await FileRepository.createPending(db, ctx, {
                pathKey,
                originalName,
                mimeType,
                sizeBytes: writeResult.sizeBytes,
                sha256: writeResult.sha256,
                storageProvider: storage.name,
                bucket: env.S3_BUCKET || null,
                domain,
            });
            // Scan before the file is treated as usable, and persist a TERMINAL
            // status. Leaving it PENDING was a trap: nothing advances that state.
            await FileRepository.markStored(db, ctx, fileRecord.id, scanStatus);
            fileRecordId = fileRecord.id;
        }

        // Create Evidence linked to FileRecord
        const evidence = await EvidenceRepository.create(db, ctx, {
            type: 'FILE' as EvidenceType,
            // Title defaults to the uploaded filename, which is user-supplied
            // too — a file can be named anything.
            title: sanitizePlainText(metadata.title || originalName),
            // `content` is the storage key we built, not caller text; it is
            // left alone deliberately (sanitising a path key would be a way to
            // corrupt it, and buildTenantObjectKey already constrains it).
            content: pathKey,
            fileName: originalName,
            fileSize: writeResult.sizeBytes,
            fileRecordId,
            controlId,
            taskId,
            assetId,
            category: metadata.category ? sanitizePlainText(metadata.category) : undefined,
            // B8 follow-up — same null-coercion as the TEXT path.
            folder: metadata.folder?.trim() ? sanitizePlainText(metadata.folder.trim()) : null,
            owner: metadata.owner ? sanitizePlainText(metadata.owner) : undefined,
            ownerUserId: metadata.ownerUserId || null,
            reviewCycle: (metadata.reviewCycle || null) as ReviewCadence | null,
            nextReviewDate: metadata.nextReviewDate ? new Date(metadata.nextReviewDate) : null,
            status: 'DRAFT',
        });

        // Bridge: create ControlEvidenceLink so evidence shows in the control
        // evidence tab.
        //
        // This used to be a `create` inside `try { } catch { }`, with the
        // comment "duplicate link is acceptable". The catch caught the JS
        // exception; it did not undo anything. `db` here is an INTERACTIVE
        // Postgres transaction, and a unique violation (23505) aborts the
        // whole transaction at the database — every subsequent statement then
        // fails with 25P02 "current transaction is aborted". So the swallow
        // did the opposite of what it claimed: instead of tolerating a
        // duplicate link, it poisoned the transaction, and the audit write
        // immediately below it took the upload down with it. Uploading the
        // same file to a control twice — the ordinary case this catch existed
        // to permit — was exactly what broke.
        //
        // `createMany({ skipDuplicates })` compiles to ON CONFLICT DO NOTHING,
        // so the conflict is resolved inside the statement and 23505 is never
        // raised. Nothing is swallowed either: a real failure (bad FK, RLS
        // denial) still throws and still rolls the upload back, which is what
        // should happen.
        if (controlId) {
            await db.controlEvidenceLink.createMany({
                data: [{
                    tenantId: ctx.tenantId,
                    controlId,
                    kind: 'FILE',
                    fileId: fileRecordId,
                    note: evidence.title,
                    createdByUserId: ctx.userId,
                }],
                skipDuplicates: true,
            });
        }

        const eventAction = deduplicated ? 'FILE_DEDUP_REUSED' : 'EVIDENCE_FILE_UPLOADED';
        await logEvent(db, ctx, {
            action: eventAction,
            entityType: 'Evidence',
            entityId: evidence.id,
            details: `File uploaded: ${originalName}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'created',
                after: {
                    fileRecordId,
                    originalName,
                    mimeType,
                    sizeBytes: writeResult.sizeBytes,
                    sha256: writeResult.sha256,
                    deduplicated,
                    storageProvider: storage.name,
                },
                summary: `File uploaded: ${originalName}`,
            },
        });

        return {
            ...evidence,
            controlId,
            fileRecord: {
                id: fileRecordId,
                originalName,
                mimeType,
                sizeBytes: writeResult.sizeBytes,
                sha256: writeResult.sha256,
                status: 'STORED',
                deduplicated,
                storageProvider: storage.name,
            },
        };
    });
    // List-cache invalidation — same pair as createEvidence(): a new
    // Evidence row should appear in the evidence list immediately,
    // and if linked to a control the control's evidence-count is now
    // stale too. Without these bumps the list cache returns the
    // pre-upload view for up to 60s (TTL), and the e2e
    // upload-then-verify flow times out waiting for the new row.
    await bumpEntityCacheVersion(ctx, 'evidence');
    if (result.controlId) await bumpEntityCacheVersion(ctx, 'control');
    return result;
}

/**
 * Get file metadata for secure download (tenant check).
 */
export async function getEvidenceFileRecord(ctx: RequestContext, fileId: string) {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const fileRecord = await FileRepository.getById(db, ctx, fileId);
        if (!fileRecord) throw notFound('File not found');
        if (fileRecord.status === 'DELETED') throw notFound('File has been deleted');
        return fileRecord;
    });
}

/**
 * STRICT DOWNLOAD POLICY (Option A):
 * - ADMIN/EDITOR: can download any tenant file evidence.
 * - READER/AUDITOR: can download ONLY if evidence is linked to a control (controlId not null).
 * - Soft-deleted evidence blocks download for all roles.
 */
export async function downloadEvidenceFile(ctx: RequestContext, fileId: string) {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const fileRecord = await FileRepository.getById(db, ctx, fileId);
        if (!fileRecord) throw notFound('File not found');
        if (fileRecord.status !== 'STORED') throw notFound('File is not available for download');

        // Tenant isolation guard
        assertTenantKey(fileRecord.pathKey, ctx.tenantId);

        // ─── AV Scan Guard ───
        const scanMode = env.AV_SCAN_MODE || 'permissive';
        const scanStatus = fileRecord.scanStatus || 'PENDING';

        if (scanStatus === 'INFECTED') {
            throw forbidden('This file has been flagged as infected by antivirus scanning and cannot be downloaded.');
        }

        if (scanMode === 'strict' && scanStatus === 'PENDING') {
            throw forbidden('This file is pending antivirus scan and cannot be downloaded yet. Please try again later.');
        }

        // ─── Strict Policy: control-aware access ───
        const evidence = await db.evidence.findFirst({
            where: { tenantId: ctx.tenantId, fileRecordId: fileId },
            select: { id: true, controlId: true, deletedAt: true },
        });

        if (evidence?.deletedAt) {
            throw notFound('Evidence has been deleted');
        }

        if (!ctx.permissions.canWrite) {
            if (!evidence?.controlId) {
                throw forbidden('You can only download evidence that is linked to a control. Contact an admin to link this evidence.');
            }
        }

        await logEvent(db, ctx, {
            action: 'EVIDENCE_DOWNLOADED',
            entityType: 'FileRecord',
            entityId: fileId,
            details: `Evidence file downloaded: ${fileRecord.originalName}`,
            detailsJson: {
                category: 'access',
                operation: 'login',
                detail: `Evidence downloaded: ${fileRecord.originalName}`,
                targetUserId: ctx.userId,
            },
        });

        // ─── Dual-read: dispatch by record's storage provider ───
        // During migration, old files may be on 'local' while app is configured for 's3'.
        // Always read from the backend that stored the file.
        const recordProvider = (fileRecord.storageProvider || 'local') as import('@/lib/storage/types').StorageProviderType;
        const { getProviderByName } = await import('@/lib/storage/index');
        const readProvider = getProviderByName(recordProvider);

        if (readProvider.name === 's3') {
            // S3: return presigned download URL (client-side redirect)
            const downloadUrl = await readProvider.createSignedDownloadUrl(fileRecord.pathKey, {
                expiresIn: 300, // 5 minutes
                downloadFilename: fileRecord.originalName,
            });
            return {
                mode: 'redirect' as const,
                downloadUrl,
                originalName: fileRecord.originalName,
                mimeType: fileRecord.mimeType,
                sizeBytes: fileRecord.sizeBytes,
                sha256: fileRecord.sha256,
            };
        }

        // Local: stream file through the server
        return {
            mode: 'stream' as const,
            stream: readProvider.readStream(fileRecord.pathKey),
            originalName: fileRecord.originalName,
            mimeType: fileRecord.mimeType,
            sizeBytes: fileRecord.sizeBytes,
            sha256: fileRecord.sha256,
        };
    });
}
