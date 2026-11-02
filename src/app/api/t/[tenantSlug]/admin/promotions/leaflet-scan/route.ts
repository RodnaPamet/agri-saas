import { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { codedBadRequest } from '@/lib/errors/types';
import { scanPromotionLeaflet } from '@/app-layer/usecases/promotion-leaflet-scan';

type Ctx = { params: Promise<{ tenantSlug: string }> };

/**
 * «Прочети брошура» — read a supplier's leaflet and PROPOSE its offers (#2664).
 *
 * `POST multipart/form-data` with one field, `file`: the leaflet as the
 * trading company sent it, which the owner asked for explicitly.
 *
 * **It creates no promotion.** The response is a proposal; `POST
 * /admin/promotions` writes the row, and publishing is a third deliberate
 * action. A misread price or end date would otherwise be repeated to farmers
 * as fact by the assistant — a sharper version of the reason
 * `grain/costs/invoice-scan` creates no cost entry.
 *
 * ## The two gates are the console's, not a platform key
 *
 * `requirePermission('admin.manage')` is necessary and NOT sufficient, because
 * permissions resolve from Role and every tenant's admin holds it;
 * `assertPlatformSupport(ctx)` restricts this to the designated platform tenant
 * and 404s everywhere else, so an unrelated tenant's owner is not told the
 * console exists. That is its sibling routes' model verbatim — and it is why
 * this route needs no `PUBLIC_PATH` entry: it authenticates with the session
 * cookie the Edge already understands, unlike the platform-key routes whose
 * absence from that list has been this repo's recurring severed-mechanism bug.
 *
 * Multipart is handled here rather than by a generic upload endpoint because
 * this repo has none: every multipart route mints its own `FileRecord` as part
 * of an entity-specific write. `costs/invoice-scan` says the same.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);

        const contentType = req.headers.get('content-type') || '';
        if (!contentType.includes('multipart/form-data')) {
            throw codedBadRequest(
                'LEAFLET_SCAN_INPUT_MISSING',
                'Send the leaflet file as multipart/form-data in a `file` field.',
            );
        }

        const formData = await req.formData();
        const file = formData.get('file');
        // A `File` that is not a File — a client sending the field as text —
        // is treated as ABSENT rather than coerced, so the refusal names the
        // real problem instead of failing later on empty bytes.
        if (!(file instanceof File)) {
            throw codedBadRequest(
                'LEAFLET_SCAN_INPUT_MISSING',
                'Send the leaflet file as multipart/form-data in a `file` field.',
            );
        }

        const result = await scanPromotionLeaflet(ctx, { file });

        // 200, not 201: the only row created is the stored `FileRecord`, and
        // the resource a 201 would point at — the promotion — deliberately
        // does not exist yet.
        return jsonResponse(result);
    }),
);

export const runtime = 'nodejs';
// A whole PDF goes to the model, so this is the invoice scan's budget rather
// than a default: the read is one call but the upload can be megabytes.
export const maxDuration = 60;
