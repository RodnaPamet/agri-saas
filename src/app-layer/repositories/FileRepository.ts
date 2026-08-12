import { PrismaTx } from '@/lib/db-context';
import { env } from '@/env';
import { RequestContext } from '../types';

export class FileRepository {
    static async createPending(
        db: PrismaTx,
        ctx: RequestContext,
        data: {
            pathKey: string;
            originalName: string;
            mimeType: string;
            sizeBytes: number;
            sha256: string;
            storageProvider?: string;
            bucket?: string | null;
            domain?: string;
        },
    ) {
        return db.fileRecord.create({
            data: {
                tenantId: ctx.tenantId,
                pathKey: data.pathKey,
                originalName: data.originalName,
                mimeType: data.mimeType,
                sizeBytes: data.sizeBytes,
                sha256: data.sha256,
                status: 'PENDING',
                uploadedByUserId: ctx.userId,
                storageProvider: data.storageProvider || env.STORAGE_PROVIDER,
                bucket: data.bucket || null,
                domain: data.domain || 'general',
            },
        });
    }

    /**
     * Mark a file stored, and record the outcome of its AV scan.
     *
     * `scanStatus` used to be hardcoded to PENDING here, and NOTHING in the
     * codebase ever advanced it — grep for markScanClean / markScanInfected
     * outside this file returned zero. Combined with `AV_SCAN_MODE` defaulting
     * to "strict" and the download gate 403-ing every PENDING file, that made
     * a dead-man switch: any deployment that did not override the env var
     * blocked every evidence download, permanently. Production escaped only
     * because the compose file hardcodes `disabled` — i.e. by turning
     * scanning off entirely.
     *
     * The caller now passes the real outcome. See `scanUploadedBuffer`.
     *
     * `scanStatus` is REQUIRED, and used to default to `'SKIPPED'`. That
     * default was the second version of the same bug: it reads as a
     * harmless fallback, but `isDownloadAllowed('SKIPPED')` is true in
     * every AV mode, so it silently marked a file both unscanned AND
     * downloadable. Two upload paths — the evidence ZIP import and the
     * spatial import — took it without anyone choosing to, and neither
     * mentioned scanning in its diff. A caller that genuinely wants to skip
     * must now say `'SKIPPED'` out loud, in a diff a reviewer can see.
     */
    static async markStored(
        db: PrismaTx,
        _ctx: RequestContext,
        id: string,
        scanStatus: 'CLEAN' | 'INFECTED' | 'SKIPPED' | 'PENDING',
    ) {
        return db.fileRecord.update({
            where: { id },
            data: { status: 'STORED', storedAt: new Date(), scanStatus },
        });
    }

    static async markFailed(db: PrismaTx, _ctx: RequestContext, id: string) {
        return db.fileRecord.update({
            where: { id },
            data: { status: 'FAILED' },
        });
    }

    static async markDeleted(db: PrismaTx, _ctx: RequestContext, id: string) {
        return db.fileRecord.update({
            where: { id },
            data: { status: 'DELETED' },
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.fileRecord.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
    }

    static async getByIdForTenant(db: PrismaTx, tenantId: string, id: string) {
        return db.fileRecord.findFirst({
            where: { id, tenantId },
        });
    }

    static async listByTenant(
        db: PrismaTx,
        ctx: RequestContext,
        options?: { status?: string; domain?: string; originalNamePrefix?: string; take?: number },
    ) {
        const where: Record<string, unknown> = { tenantId: ctx.tenantId };
        if (options?.status) where.status = options.status;
        if (options?.domain) where.domain = options.domain;
        if (options?.originalNamePrefix) where.originalName = { startsWith: options.originalNamePrefix };
        return db.fileRecord.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: options?.take ?? 200,
        });
    }

    /**
     * Find a STORED FileRecord with the same SHA-256 hash for a tenant (dedup).
     */
    static async findBySha256(db: PrismaTx, tenantId: string, sha256: string) {
        return db.fileRecord.findFirst({
            where: { tenantId, sha256, status: 'STORED' },
        });
    }

    /**
     * Find old PENDING FileRecords for cleanup.
     */
    static async findPendingOlderThan(db: PrismaTx, tenantId: string, olderThan: Date) {
        return db.fileRecord.findMany({
            where: {
                tenantId,
                status: 'PENDING',
                createdAt: { lt: olderThan },
            },
        });
    }

    // ─── AV Scan Lifecycle ───

    static async updateScanStatus(
        db: PrismaTx,
        id: string,
        scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'SKIPPED',
        scanDetails?: string,
    ) {
        return db.fileRecord.update({
            where: { id },
            data: {
                scanStatus,
                ...(scanDetails ? { scanDetails } : {}),
                updatedAt: new Date(),
            },
        });
    }

    static async markScanClean(db: PrismaTx, id: string) {
        return FileRepository.updateScanStatus(db, id, 'CLEAN');
    }

    static async markScanInfected(db: PrismaTx, id: string, details?: string) {
        return FileRepository.updateScanStatus(db, id, 'INFECTED', details);
    }

    static async findPendingScan(db: PrismaTx, tenantId?: string) {
        const where: Record<string, unknown> = { scanStatus: 'PENDING', status: 'STORED' };
        if (tenantId) where.tenantId = tenantId;
        return db.fileRecord.findMany({
            where,
            orderBy: { createdAt: 'asc' },
            take: 100,
        });
    }

    /**
     * Look up a FileRecord by storage key, SCOPED TO A TENANT.
     *
     * The tenantId parameter is required rather than optional: this used to be
     * a bare `where: { pathKey }`, which would return another tenant's record
     * to any caller that guessed a key. Making the scope a required argument
     * means a future caller cannot omit it by accident.
     */
    static async getByPathKey(db: PrismaTx, pathKey: string, tenantId: string) {
        return db.fileRecord.findFirst({
            where: { pathKey, tenantId },
        });
    }

    /**
     * Resolve a caller-supplied name to a FileRecord THIS TENANT owns, or null.
     *
     * Replaces `isFileOwnedByTenant`, which was a cross-tenant read primitive:
     * it returned true when `Evidence.content === fileName`, and `content` is
     * caller-supplied free text (evidence.ts sets it from `data.content` and
     * only overwrites it for type==='FILE' WITH a file). So a user could
     * create an evidence record whose content was another tenant's storage
     * key, pass the ownership check, and have `downloadFile` stream the bytes
     * — the local branch read the raw name with no `assertTenantKey` at all.
     *
     * Ownership is now derived from ONE place, the tenant-filtered FileRecord,
     * and the RECORD is returned rather than a boolean. That matters: the
     * caller must read `fileRecord.pathKey`, never the string the caller
     * supplied. A boolean invites exactly the pattern that caused this bug —
     * check one value, then use another.
     */
    static async findOwnedByTenant(
        db: PrismaTx,
        ctx: RequestContext,
        fileName: string,
    ): Promise<{ id: string; pathKey: string; originalName: string; mimeType: string; status: string; scanStatus: string | null } | null> {
        return db.fileRecord.findFirst({
            where: {
                tenantId: ctx.tenantId,
                // originalName is kept for the legacy flow, which addressed
                // files by display name. It is still tenant-scoped, and the
                // pathKey it resolves to is asserted by the caller.
                OR: [{ pathKey: fileName }, { originalName: fileName }],
            },
            select: {
                id: true, pathKey: true, originalName: true,
                mimeType: true, status: true, scanStatus: true,
            },
        });
    }
}
