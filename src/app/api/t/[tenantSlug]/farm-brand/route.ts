/**
 * P6.6 — save the farm's public content.
 *
 *   PUT /api/t/:slug/farm-brand   { displayName?, tagline?, about?, oblast?, crops? }
 *
 * CREATES the brand row when there is none, which is what makes the rest of
 * the public-profile surface reachable at all: before this, nothing in the
 * product could write a `FarmBrand`, so `/f/{handle}` could not serve any
 * real farm and both sibling routes refused `FARM_BRAND_NOT_FOUND` on every
 * call (#1867).
 *
 * `PUT` rather than `PATCH` despite being a partial write, because the body
 * is the desired state OF THE FIELDS IT NAMES and sending it twice leaves the
 * same result. A field left out is untouched and an explicit `null` clears
 * it — the distinction an autosaving editor needs, or saving a tagline would
 * wipe yesterday's `about`.
 *
 * Publication preconditions are NOT enforced here. A draft may be
 * incomplete; `PUT .../publication` is where the three refusals bite.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { readFarmBrandDraft, updateFarmBrand } from '@/app-layer/usecases/public-farm-profile';
import { UpdateFarmBrandSchema } from '@/app-layer/schemas/farm-brand.schemas';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { jsonResponse } from '@/lib/api-response';

export const PUT = withApiErrorHandling(
    withValidatedBody(
        UpdateFarmBrandSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            // #1197's standing rule: every social surface sits behind a
            // runtime flag, default OFF. `assertFeatureEnabled` 404s rather
            // than 403s so a dark-launched surface stays undiscoverable.
            //
            // The key is a LITERAL here rather than behind a shared helper:
            // `social-routes-flag-gated` requires one, because an operator
            // holding the flag console has to find the gate by reading the
            // route.
            await assertFeatureEnabled('social.public-profile', ctx.userId);
            const result = await updateFarmBrand(ctx, body);
            return jsonResponse(result);
        },
    ),
);

/**
 * The draft, for the editor to render.
 *
 * `200` with `null` when there is no draft rather than `404`: a farm that has
 * never opened the editor is in a normal state, and the form should show
 * itself empty instead of an error. The operations that genuinely need a
 * draft — claiming a handle, recording consent — refuse with
 * `FARM_BRAND_NOT_FOUND` on their own.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertFeatureEnabled('social.public-profile', ctx.userId);
        return jsonResponse(await readFarmBrandDraft(ctx));
    },
);
