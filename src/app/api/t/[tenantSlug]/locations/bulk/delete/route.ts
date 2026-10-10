/**
 * POST /api/t/:slug/locations/bulk/delete
 *
 * Bulk soft-delete locations (the locations table selection action-row).
 * Permission (ADMIN) + tenant isolation are enforced in `bulkDeleteLocation`.
 * Body: `{ locationIds: string[] }`. Returns `{ deleted: n }`.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { bulkDeleteLocation } from '@/app-layer/usecases/location';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { BulkDeleteLocationsSchema } from '@/lib/schemas';


export const POST = withApiErrorHandling(
    withValidatedBody(
        BulkDeleteLocationsSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await bulkDeleteLocation(ctx, body.locationIds);
            return jsonResponse(result);
        },
    ),
);
