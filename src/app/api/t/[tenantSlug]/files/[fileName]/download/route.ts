/**
 * GET /api/t/[tenantSlug]/files/[fileName]/download
 *
 * Stream a tenant FileRecord (by id) as an attachment. Tenant-scoped via
 * FileRepository.getById + assertCanRead; reads from whichever backend
 * stored the file (dual-read via storageProvider). Records a download audit
 * entry. Used by the Farm-records register (domain 'reports') and generally.
 *
 * NOTE: the dynamic segment is named `[fileName]` to match the sibling
 * `files/[fileName]/route.ts` — Next.js requires one slug name per path
 * level. The value carried here is the FileRecord id.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead } from '@/app-layer/policies/common';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { getProviderByName } from '@/lib/storage';
import { logEvent } from '@/app-layer/events/audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { notFound } from '@/lib/errors/types';
import type { StorageProviderType } from '@/lib/storage/types';

export const runtime = 'nodejs';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; fileName: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        assertCanRead(ctx);

        // `fileName` is the FileRecord id (the URL segment value).
        const fileId = params.fileName;
        const file = await runInTenantContext(ctx, (db) => FileRepository.getById(db, ctx, fileId));
        if (!file || file.status === 'DELETED') throw notFound('File not found');

        const provider = getProviderByName(file.storageProvider as StorageProviderType);
        const stream = provider.readStream(file.pathKey);
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
        const buf = Buffer.concat(chunks);

        await runInTenantContext(ctx, (db) =>
            logEvent(db, ctx, {
                action: 'FILE_DOWNLOADED',
                entityType: 'FileRecord',
                entityId: file.id,
                details: `Downloaded ${file.originalName}`,
                detailsJson: { category: 'custom', event: 'file_download', domain: file.domain },
            }),
        );

        return new NextResponse(buf as unknown as BodyInit, {
            status: 200,
            headers: {
                'Content-Type': file.mimeType || 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${file.originalName}"`,
                'Cache-Control': 'no-store',
                'Content-Length': String(buf.length),
            },
        });
    },
);
