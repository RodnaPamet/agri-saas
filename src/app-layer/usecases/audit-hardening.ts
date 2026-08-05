/**
 * Audit Readiness Hardening
 *
 * - Evidence integrity: SHA-256 hashing of file contents
 * - Immutable export artifacts: store export files, attach to packs
 * - Pack cloning for retest workflows
 * - Events: AUDIT_PACK_CLONED, RETEST_REQUESTED
 */
import { WorkItemStatus, Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import {
    assertCanManageAuditPacks, assertCanFreezePack, assertCanViewPack,
    assertCanVerifyIntegrity,
} from '../policies/audit-readiness.policies';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { getStorageProvider, buildTenantObjectKey, assertTenantKey } from '@/lib/storage';
import { FileRepository } from '../repositories/FileRepository';
import { prisma } from '@/lib/prisma';
import crypto from 'crypto';

// ─── Evidence Integrity ───

export function computeFileHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verify a stored file's SHA-256 and size against an expected hash.
 *
 * ## What this used to be
 *
 * A cross-tenant hash-and-size oracle. It took the filename RAW from the URL,
 * gated on `assertCanViewPack` — which admits OWNER, ADMIN, EDITOR, READER
 * AND AUDITOR, i.e. every role including an external auditor invited to one
 * pack — and passed the string straight to `storage.readStream` with no
 * FileRecord lookup and no `assertTenantKey`. It then returned
 * `computedHash`, `fileSize` and `matches` for whatever it found.
 *
 * Three things made that reachable rather than theoretical: Next decodes
 * `%2F` inside dynamic segments, so a caller can express a full path in the
 * `[fileName]` slot; production runs `STORAGE_PROVIDER: local` on one shared
 * volume; and `matches` turns the endpoint into an oracle you can ask
 * yes/no questions of about another tenant's bytes.
 *
 * ## What it is now
 *
 * Addressed by FileRecord **id**, not by path. The id is resolved
 * tenant-filtered, the resolved `pathKey` is asserted, and the read uses that
 * key — never anything the caller wrote. Integrity verification is also an
 * OWNER/ADMIN/AUDITOR action now: it is an audit function, and READER/EDITOR
 * had no business being able to enumerate hashes.
 */
export async function verifyFileIntegrity(
    ctx: RequestContext,
    fileId: string,
    expectedHash?: string,
): Promise<{ fileId: string; fileName: string; computedHash: string; matches: boolean | null; fileSize: number }> {
    assertCanVerifyIntegrity(ctx);

    return runInTenantContext(ctx, async (db) => {
        const fileRecord = await FileRepository.getById(db, ctx, fileId);
        if (!fileRecord) throw notFound('File not found');

        assertTenantKey(fileRecord.pathKey, ctx.tenantId);

        const storage = getStorageProvider();
        const stream = storage.readStream(fileRecord.pathKey);

        // Hash incrementally. Size is accumulated as we go rather than by
        // buffering the whole object — an integrity check must not be a way
        // to pull an arbitrarily large file into memory.
        const hash = crypto.createHash('sha256');
        let totalSize = 0;
        for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(buf);
            totalSize += buf.length;
        }
        const computedHash = hash.digest('hex');

        return {
            fileId,
            fileName: fileRecord.originalName,
            computedHash,
            matches: expectedHash ? computedHash === expectedHash : null,
            fileSize: totalSize,
        };
    });
}


// ─── Immutable Export Artifacts ───

export async function storeExportArtifact(
    ctx: RequestContext,
    packId: string,
    content: string,
    filename: string,
    mimeType: string,
): Promise<{ fileName: string; hash: string }> {
    assertCanFreezePack(ctx);

    // Verify pack is frozen
    const pack = await runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.findFirst({ where: { id: packId, tenantId: ctx.tenantId } })
    );
    if (!pack) throw notFound('Pack not found');
    if (pack.status === 'DRAFT') throw badRequest('Cannot attach exports to a DRAFT pack');

    // Create buffer and compute hash
    const buffer = Buffer.from(content, 'utf-8');
    const hash = computeFileHash(buffer);

    // Write via storage abstraction
    const storage = getStorageProvider();
    const pathKey = buildTenantObjectKey(ctx.tenantId, 'exports', filename);
    const { Readable } = await import('stream');
    await storage.write(pathKey, Readable.from(buffer), { mimeType });

    // Add as AuditPackItem
    await runInTenantContext(ctx, (tdb) =>
        tdb.auditPackItem.create({
            data: {
                tenantId: ctx.tenantId,
                auditPackId: packId,
                entityType: 'FILE',
                entityId: pathKey,
                snapshotJson: JSON.stringify({
                    originalFilename: filename,
                    storedFilename: pathKey,
                    sha256: hash,
                    size: buffer.length,
                    mimeType,
                    generatedAt: new Date().toISOString(),
                }),
                sortOrder: 900,
            },
        })
    );

    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'AUDIT_EXPORT_GENERATED',
            entityType: 'AuditPack',
            entityId: packId,
            details: JSON.stringify({ filename, hash, size: buffer.length }),
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AuditPack',
                operation: 'export_generated',
                after: { filename, hash, size: buffer.length },
                summary: `Audit export generated: ${filename}`,
            },
        })
    );

    return { fileName: pathKey, hash };
}

// ─── Pack Cloning (Retest) ───

export async function clonePackForRetest(
    ctx: RequestContext,
    sourcePackId: string,
    name?: string,
): Promise<{ id: string; name: string; status: string; tenantId: string; auditCycleId: string }> {
    assertCanManageAuditPacks(ctx);

    const sourcePack = await runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.findFirst({
            where: { id: sourcePackId, tenantId: ctx.tenantId },
            include: {
                items: { select: { entityType: true, entityId: true, sortOrder: true } },
                cycle: true,
            },
        })
    );
    if (!sourcePack) throw notFound('Source pack not found');
    if (sourcePack.status === 'DRAFT') throw badRequest('Cannot clone a DRAFT pack — freeze first');

    // Create new draft pack
    const clonedPack = await runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.create({
            data: {
                tenantId: ctx.tenantId,
                auditCycleId: sourcePack.auditCycleId,
                name: name || `Retest: ${sourcePack.name}`,
                status: 'DRAFT',
            },
        })
    );

    // Copy item selections (NOT snapshots — new snapshots will be created on freeze)
    const itemsToClone: Prisma.AuditPackItemCreateManyInput[] = sourcePack.items
        .filter((i) => i.entityType !== 'FILE' && i.entityType !== 'READINESS_REPORT')
        .map((item) => ({
            tenantId: ctx.tenantId,
            auditPackId: clonedPack.id,
            entityType: item.entityType,
            entityId: item.entityId,
            sortOrder: item.sortOrder,
            snapshotJson: '',
        }));

    // Auto-include IN_PROGRESS issues (legacy "READY_FOR_RETEST" status migrated
    // to IN_PROGRESS in the unified task model; see migration 20260310191803).
    const retestIssues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: WorkItemStatus.IN_PROGRESS,
            },
            select: { id: true },
            take: 50,
        })
    );

    const existingIssueIds = new Set(itemsToClone.filter((i) => i.entityType === 'ISSUE').map((i) => i.entityId));
    let sortOrder = Math.max(...itemsToClone.map((i) => (i.sortOrder as number) || 0), 0) + 1;

    for (const issue of retestIssues) {
        if (!existingIssueIds.has(issue.id)) {
            itemsToClone.push({
                tenantId: ctx.tenantId,
                auditPackId: clonedPack.id,
                entityType: 'ISSUE',
                entityId: issue.id,
                sortOrder: sortOrder++,
                snapshotJson: '',
            });
        }
    }

    if (itemsToClone.length > 0) {
        await runInTenantContext(ctx, (tdb) =>
            tdb.auditPackItem.createMany({ data: itemsToClone })
        );
    }

    // Log events
    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'AUDIT_PACK_CLONED',
            entityType: 'AuditPack',
            entityId: clonedPack.id,
            details: JSON.stringify({
                sourcePackId,
                itemsCopied: itemsToClone.length,
                retestIssuesAdded: retestIssues.filter(i => !existingIssueIds.has(i.id)).length,
            }),
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AuditPack',
                operation: 'cloned',
                after: {
                    sourcePackId,
                    itemsCopied: itemsToClone.length,
                    retestIssuesAdded: retestIssues.filter(i => !existingIssueIds.has(i.id)).length,
                },
                summary: `Pack cloned from ${sourcePackId}`,
            },
        })
    );

    if (retestIssues.length > 0) {
        await runInTenantContext(ctx, (tdb) =>
            logEvent(tdb, ctx, {
                action: 'RETEST_REQUESTED',
                entityType: 'AuditPack',
                entityId: clonedPack.id,
                details: JSON.stringify({ issueCount: retestIssues.length }),
                detailsJson: {
                    category: 'custom',
                    event: 'retest_requested',
                    issueCount: retestIssues.length,
                },
            })
        );
    }

    return clonedPack;
}

// ─── Auditor Pack Access ───

export async function getAuditorAssignedPacks(ctx: RequestContext): Promise<Array<{
    id: string; name: string; status: string; tenantId: string; auditCycleId: string;
    cycle: { name: string; frameworkKey: string; frameworkVersion: string } | null;
    items: Array<{ id: string; entityType: string }>;
}>> {
    if (ctx.role !== 'AUDITOR') throw forbidden('Only auditors can access this view');

    // Look up user email from userId
    const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });
    if (!user) return [];

    // Find auditor account for this user
    const auditor = await runInTenantContext(ctx, (tdb) =>
        tdb.auditorAccount.findFirst({
            where: { tenantId: ctx.tenantId, email: user.email, status: 'ACTIVE' },
        })
    );
    if (!auditor) return [];

    // Get pack IDs assigned to this auditor
    const accesses = await runInTenantContext(ctx, (tdb) =>
        tdb.auditorPackAccess.findMany({
            where: { auditorId: auditor.id },
            select: { auditPackId: true },
        })
    );

    const packIds = accesses.map((a) => a.auditPackId);
    if (packIds.length === 0) return [];

    // Fetch packs
    const packs = await runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.findMany({
            where: { id: { in: packIds }, tenantId: ctx.tenantId },
            include: {
                cycle: { select: { name: true, frameworkKey: true, frameworkVersion: true } },
                items: { select: { id: true, entityType: true } },
            },
        })
    );

    return packs;
}
