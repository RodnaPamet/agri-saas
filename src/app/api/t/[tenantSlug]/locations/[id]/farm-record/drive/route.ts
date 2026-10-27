import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { exportFarmRecordToDrive } from '@/app-layer/usecases/farm-record-drive-export';
import { FarmRecordDriveExportSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Send a block's БАБХ ДНЕВНИК for a period to the farm's Google Drive (#2019).
 *
 * The sibling `POST` of this path returns the same document as bytes, or files
 * it in the location's Farm-records register with `{ save: true }`. This is the
 * third destination, and it answers JSON describing where the file landed.
 *
 * ## Why not a `destination` on the sibling
 *
 * That route's `save` flag is already a media-type switch — `application/pdf`
 * bytes or `application/json` — and a third value would make one endpoint
 * answer three shapes decided by a body field. The existing switch is
 * documented as a trap in its own schema; adding to it compounds that rather
 * than following it.
 *
 * ## Gates
 *
 * All in the usecase: admin, the `integrations.google` flag, the `JOURNAL`
 * module, and the Drive grant, refused before any PDF is rendered. Not
 * repeated here — a gate in two places is a gate that can disagree with
 * itself, and the treatment-scoped route calls the same usecase.
 *
 * Unlike its sibling, this is **admin only** (the owner's ruling, 2026-10-26,
 * matching the credential the export needs). A writer can produce the document
 * and not export it.
 */
export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const body = FarmRecordDriveExportSchema.parse(await req.json());

        const result = await exportFarmRecordToDrive(ctx, {
            kind: 'location',
            locationId: params.id,
            from: body.from,
            to: body.to,
        });
        return jsonResponse(result);
    },
);
