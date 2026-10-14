/**
 * P6.1 — publish a farm's public profile, or withdraw it.
 *
 *   PUT /api/t/:slug/farm-brand/publication   { "published": boolean }
 *
 * `PUT` because the body IS the desired state: sending the same value twice
 * leaves the same result, which is what makes it safe for a client to retry on
 * a flaky rural connection. A `POST .../publish` pair would have been two
 * endpoints for one switch, and the withdraw half would have been the one
 * nobody tested.
 *
 * Every gate lives in the usecase — the admin check, the three publication
 * preconditions, and the stale-row cleanup on a rename.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { setFarmBrandPublication } from '@/app-layer/usecases/public-farm-profile';
import { SetFarmBrandPublicationSchema } from '@/app-layer/schemas/farm-brand.schemas';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const PUT = withApiErrorHandling(
    withValidatedBody(
        SetFarmBrandPublicationSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await setFarmBrandPublication(ctx, body.published);
            return jsonResponse(result);
        },
    ),
);
