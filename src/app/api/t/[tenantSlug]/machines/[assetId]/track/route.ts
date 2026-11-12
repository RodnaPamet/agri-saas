/**
 * One machine's track for one Europe/Sofia day — #2948 stage 3.
 *
 * SIMPLIFIED, with no raw option: owner/client agreement is that the phone
 * draws a line, and a day at 30-second intervals is ~2,900 points and ~250 KB
 * of JSON that no screen can resolve. `rawCount` and `toleranceM` come back so
 * the client can say how much was dropped rather than presenting a reduced
 * line as the whole truth.
 *
 * `date` is REQUIRED and not defaulted to today. A default would make a
 * malformed or missing parameter answer confidently about a different day than
 * the caller meant — and this endpoint's whole subject is which day.
 *
 * ## The query string carries no personal data, deliberately
 *
 * iOS writes the FULL URL including the query to the device log,
 * unsuppressably, so a path or parameter here must never carry anything about
 * a person. `assetId` is a machine and `date` is a date; the DRIVER is not
 * named in either, which is the rule #1087's rename existed to establish.
 */
import { NextRequest } from 'next/server';

import { readMachineTrack } from '@/app-layer/usecases/machines';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonWithETag } from '@/lib/http/etag';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; assetId: string }>(
        'machines.view',
        async (req: NextRequest, { params }, ctx) => {
            const payload = await readMachineTrack(
                ctx,
                params.assetId,
                req.nextUrl.searchParams.get('date'),
            );
            // A past day's track never changes, so revalidation is cheap and
            // a 304 is the common case once a driver has looked at it.
            return jsonWithETag(req, payload);
        },
    ),
);
