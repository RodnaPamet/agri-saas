/**
 * One machine's worked parcels for one calendar day — #2948 stage 3.
 *
 * Reads `WorkedParcel` and NEVER raw positions, which is what makes it answer
 * indefinitely while `/track` stops at the retention window. That is the whole
 * point of aggregating rather than keeping: what the farm uses survives, the
 * minute-by-minute movement of a person does not.
 *
 * **It does not derive on demand.** A day is ~2,900 positions per machine, so
 * a read that silently ran a geospatial aggregation would time out on the day
 * somebody opened it for a ten-machine fleet. The nightly job owns the work;
 * this reports whether it has happened — see the `derivedAt` docblock for the
 * one state that is not expressible until that job lands.
 */
import { NextRequest } from 'next/server';

import { readMachineWorked } from '@/app-layer/usecases/machines';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonWithETag } from '@/lib/http/etag';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; assetId: string }>(
        'machines.view',
        async (req: NextRequest, { params }, ctx) => {
            const payload = await readMachineWorked(
                ctx,
                params.assetId,
                req.nextUrl.searchParams.get('date'),
            );
            return jsonWithETag(req, payload);
        },
    ),
);
