import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { exportFarmRecordToDrive } from '@/app-layer/usecases/farm-record-drive-export';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Send ONE recorded treatment's ДНЕВНИК pages to the farm's Google Drive
 * (#2019).
 *
 * The sibling `GET` of this path returns the same document as bytes. This puts
 * it in Drive instead and answers JSON describing where it went, so the button
 * can link straight to the file.
 *
 * ## Sited next to the document, not under the integration
 *
 * `/admin/integrations/google/drive/export` with a discriminated body was the
 * alternative. This shape won on three counts: the spec entry sits in
 * `journal.paths.ts` beside the download it mirrors rather than needing a new
 * paths file; the button calls a sibling of the URL it already calls; and
 * there is no request body to declare, because the handle is a path segment.
 *
 * The handle is a path segment rather than a query parameter for the same
 * reason the download is — iOS writes the full URL including the query string
 * to the device log, unsuppressably.
 *
 * ## No body, and no gates here
 *
 * Every gate is in the usecase: admin, the `integrations.google` flag, the
 * `JOURNAL` module, and the Drive grant. They are not repeated here because a
 * gate in two places is a gate that can disagree with itself — and the usecase
 * is also what the per-location route calls.
 *
 * **Admin only**, which is the owner's ruling (2026-10-26) and also what the
 * credential already requires: `resolveGoogleConnectionToken` decrypts a
 * tenant-wide secret. So a farmer-worker who recorded the treatment can
 * download this document and cannot export it. That cost is stated on the
 * usecase.
 */
export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const result = await exportFarmRecordToDrive(ctx, {
            kind: 'treatment',
            treatmentGroupId: params.treatmentGroupId,
        });
        return jsonResponse(result);
    },
);
