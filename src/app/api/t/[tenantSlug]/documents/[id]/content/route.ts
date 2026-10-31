/**
 * GET /api/t/[tenantSlug]/documents/[id]/content — the bytes, for preview.
 *
 * The AV + tenant-key gate is in `readFarmDocumentContent`, which is this
 * route's registered entry in `download-route-gate-reachability`'s
 * `USECASE_SEAMS`. That is not a style choice: `ingest.ts` justifies writing
 * bytes to disk BEFORE scanning them with "every read of those bytes goes
 * through a download route that asks `isDownloadAllowed` first", so a gate
 * missing here would retroactively invalidate the reason uploads are allowed
 * to hit disk unscanned.
 *
 * 404 once purged, which is what makes a tombstone safe to show in the list.
 */
import { Readable } from 'node:stream';

import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { readFarmDocumentContent } from '@/app-layer/usecases/farm-documents';
import { withApiErrorHandling } from '@/lib/errors/api';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const { stream, contentType, sizeBytes } = await readFarmDocumentContent(ctx, params.id);

        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
            headers: {
                'Content-Type': contentType,
                'Content-Length': String(sizeBytes),
                // `inline` because this endpoint exists for PREVIEW — the
                // phone renders a PDF or an image in place. No filename is
                // offered: `name` is encrypted on the row precisely because it
                // is routinely «Договор аренда <фамилия>.pdf», and a
                // Content-Disposition filename would put that third-party name
                // into every proxy log on the path.
                'Content-Disposition': 'inline',
                // Never a shared cache: these bytes are one farm's.
                'Cache-Control': 'private, no-store',
            },
        });
    },
);
