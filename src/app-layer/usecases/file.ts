/**
 * File download usecase — provider-dispatched.
 * Uses the storage abstraction for all file operations.
 */
import { RequestContext } from '../types';
import { FileRepository } from '../repositories/FileRepository';
import { assertCanRead } from '../policies/common';
import { notFound } from '@/lib/errors/types';
import { getStorageProvider, assertTenantKey } from '@/lib/storage';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';

/**
 * Download a file by a caller-supplied name or storage key.
 *
 * ## The rule this function exists to enforce
 *
 * **Resolve, then read what you resolved.** The caller's string is used ONLY
 * to look up a tenant-owned FileRecord; every subsequent operation uses
 * `fileRecord.pathKey`. The previous version checked one value and read
 * another: it asked `isFileOwnedByTenant(fileName)` — which returned true if
 * ANY evidence row in the tenant had `content === fileName`, and `content` is
 * caller-supplied free text — and then passed the raw `fileName` to
 * `storage.readStream` with no `assertTenantKey` on the local branch.
 *
 * So the attack was: create an evidence record whose content is another
 * tenant's storage key, then request that key. The ownership check passed on
 * your own row and the bytes streamed from theirs. Production runs the local
 * provider on one shared volume, so "another tenant's key" is a real path.
 *
 * Both the tenant route and the legacy `/api/files/[fileName]` route land
 * here. The legacy one cannot simply be retired — `local-provider.ts` builds
 * its download URLs through it — so it inherits this stack instead.
 */
export async function downloadFile(ctx: RequestContext, fileName: string) {
    assertCanRead(ctx);
    logger.info('file download started', { component: 'file', fileName });

    return runInTenantContext(ctx, async (db) => {
        // ── Resolve ────────────────────────────────────────────────────
        // Tenant-filtered FileRecord ONLY. Evidence.content never confers
        // ownership of bytes again.
        const fileRecord = await FileRepository.findOwnedByTenant(db, ctx, fileName);
        if (!fileRecord) {
            // notFound, not forbidden: a 403 on a key you do not own is an
            // existence oracle across tenants.
            throw notFound('File not found');
        }

        // Belt and braces. The record is tenant-filtered, so this can only
        // fire if a row's pathKey disagrees with its tenantId — which would
        // be a write-side bug worth failing loudly on.
        assertTenantKey(fileRecord.pathKey, ctx.tenantId);

        if (fileRecord.status !== 'STORED') {
            throw notFound('File is not available for download');
        }

        const storage = getStorageProvider();

        if (storage.name === 's3') {
            const downloadUrl = await storage.createSignedDownloadUrl(fileRecord.pathKey, {
                expiresIn: 300,
                downloadFilename: fileRecord.originalName,
            });
            await logEvent(db, ctx, {
                action: 'READ',
                entityType: 'File',
                entityId: fileRecord.id,
                details: `Downloaded file via presigned URL: ${fileRecord.originalName}`,
                detailsJson: {
                    category: 'access',
                    operation: 'login',
                    detail: `File downloaded: ${fileRecord.originalName}`,
                },
            });
            return {
                mode: 'redirect' as const,
                downloadUrl,
                name: fileRecord.originalName,
                mimeType: fileRecord.mimeType,
            };
        }

        // ── Local provider ─────────────────────────────────────────────
        // Reads the RESOLVED pathKey. This branch previously read the raw
        // caller string, which is what made the whole thing exploitable.
        try {
            const stream = storage.readStream(fileRecord.pathKey);

            await logEvent(db, ctx, {
                action: 'READ',
                entityType: 'File',
                entityId: fileRecord.id,
                details: `Downloaded file: ${fileRecord.originalName}`,
                detailsJson: {
                    category: 'access',
                    operation: 'login',
                    detail: `File downloaded: ${fileRecord.originalName}`,
                },
            });

            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const buffer = Buffer.concat(chunks);

            return {
                mode: 'stream' as const,
                buffer,
                // The stored mimeType, not one guessed from the caller's
                // extension — the caller does not get to pick the
                // Content-Type the browser will act on.
                mimeType: fileRecord.mimeType,
                name: fileRecord.originalName,
            };
        } catch {
            throw notFound('File not found on disk');
        }
    });
}
