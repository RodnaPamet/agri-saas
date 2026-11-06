import { NextRequest, NextResponse } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { contentDisposition } from '@/lib/http/content-disposition';
import { downloadPromotionSource } from '@/app-layer/usecases/promotion-admin';

type IdParams = { tenantSlug: string; id: string };

/**
 * Open the supplier leaflet a promotion was read from (#2750).
 *
 * `GET /api/t/{tenantSlug}/admin/promotions/{id}/source -> the bytes`
 *
 * It exists so a reviewer can answer *where did this text come from?* The
 * leaflet was already stored, scanned and given a `FileRecord` by
 * `leaflet-scan`, and then orphaned from the row it produced —
 * `Promotion.sourceFileId` is the link and this is the only way to follow it.
 *
 * Two gates like the rest of the console: `admin.manage` is necessary and not
 * sufficient, because permissions resolve from Role and every tenant's OWNER
 * holds it; `assertPlatformSupport` is the isolation and answers 404 rather
 * than 403, so this does not announce itself to an unrelated farm.
 *
 * ## The AV gate is in the USECASE, not here
 *
 * `downloadPromotionSource` asks `isDownloadAllowed` and is registered in
 * `USECASE_SEAMS` in `download-route-gate-reachability`. That placement is the
 * convention and it is load-bearing: `ingestUploadedFile` writes bytes before
 * the scan resolves, so a byte-serving route that did not reach the gate would
 * not merely leak one file — it would retroactively remove the reason uploads
 * are allowed to hit disk unscanned.
 *
 * `inline`, because this is a preview surface: the reviewer is comparing the
 * leaflet against the form beside it, not filing it. The disposition is safe
 * here precisely BECAUSE the gate ran.
 */
export const GET = withApiErrorHandling(
    requirePermission<IdParams>('admin.manage', async (_req: NextRequest, { params }, ctx) => {
        assertPlatformSupport(ctx);
        const result = await downloadPromotionSource(ctx, params.id);

        const nodeStream = result.stream;
        const webStream = new ReadableStream({
            start(controller) {
                nodeStream.on('data', (chunk: Buffer) => controller.enqueue(chunk));
                nodeStream.on('end', () => controller.close());
                nodeStream.on('error', (err: Error) => controller.error(err));
            },
            cancel() {
                nodeStream.destroy();
            },
        });

        const headers: Record<string, string> = {
            'Content-Type': result.contentType,
            // A leaflet is a supplier's internal source document, so it must
            // never land in a shared cache. `no-store` and not `private`.
            //
            // `web-platform-identifiers` pins this header's spelling, and it
            // pinned MINE first: the comment here used to spell out the mangled
            // form that a project-wide rename once produced across 39 headers,
            // and the guard reported this file as an offender. It does not strip
            // comments, so naming the banned token in prose IS the violation —
            // correctly, since the cheapest rule that cannot be argued with is
            // "this string never appears". See #776's rename for the history.
            'Cache-Control': 'no-store',
            'Content-Disposition': contentDisposition(result.name, 'inline'),
        };
        if (result.sizeBytes != null) headers['Content-Length'] = String(result.sizeBytes);

        return new NextResponse(webStream, { status: 200, headers });
    }),
);
