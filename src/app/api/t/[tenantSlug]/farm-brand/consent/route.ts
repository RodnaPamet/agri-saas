/**
 * P6.6 — record consent to publish this farm's public profile.
 *
 *   PUT /api/t/:slug/farm-brand/consent   { "textVersion": "v1" }
 *
 * Its own route rather than a field on the content save, because consent is a
 * legal artefact and not editor state: it records that a person was shown a
 * specific text and agreed to it. The content route is autosaved, and an
 * autosave that recorded consent would be claiming somebody read something
 * they never saw.
 *
 * `PUT` because re-consenting to the same text twice leaves the same result.
 * Re-consenting to a NEW version moves the timestamp, deliberately — see the
 * usecase on why first-consent-wins would be the wrong rule.
 *
 * `setFarmBrandPublication` refuses `FARM_BRAND_CONSENT_REQUIRED` until this
 * has been called, so this is the operation that unblocks publishing.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { recordFarmBrandConsent } from '@/app-layer/usecases/public-farm-profile';
import { RecordFarmBrandConsentSchema } from '@/app-layer/schemas/farm-brand.schemas';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { jsonResponse } from '@/lib/api-response';

export const PUT = withApiErrorHandling(
    withValidatedBody(
        RecordFarmBrandConsentSchema,
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
            const result = await recordFarmBrandConsent(ctx, body);
            return jsonResponse(result);
        },
    ),
);
