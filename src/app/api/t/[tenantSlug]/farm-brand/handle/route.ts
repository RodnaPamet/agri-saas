/**
 * P6.6 — claim the public address for a farm.
 *
 *   PUT /api/t/:slug/farm-brand/handle   { "handle": "Победа" }
 *
 * `PUT` because the body IS the desired state: sending the same address twice
 * leaves the same result, which is what makes it safe to retry on a flaky
 * rural connection — and re-submitting the address you already hold is a
 * success rather than a collision with yourself.
 *
 * Separate from the rest of the brand editor on purpose. Every other field is
 * the farm's own content and can only fail on its own validity; the handle is
 * a reservation in a namespace shared with every other tenant, so it is the
 * one field that can be refused for a reason about somebody else. Folding it
 * into a general `PUT /farm-brand` would mean one response shape carrying
 * both "your tagline is too long" and "another farm got there first, try
 * these three instead", and the second would have been the one nobody tested.
 *
 * Every gate lives in the usecase — the admin check, the shape rules, the
 * suggest-then-attempt collision flow, and the re-projection on rename.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { claimFarmBrandHandle } from '@/app-layer/usecases/public-farm-profile';
import { ClaimFarmBrandHandleSchema } from '@/app-layer/schemas/farm-brand.schemas';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const PUT = withApiErrorHandling(
    withValidatedBody(
        ClaimFarmBrandHandleSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await claimFarmBrandHandle(ctx, body.handle);
            return jsonResponse(result);
        },
    ),
);
