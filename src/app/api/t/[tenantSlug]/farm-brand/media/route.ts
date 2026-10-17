/**
 * P6.3 — upload an image this farm may publish on its profile.
 *
 *   POST /api/t/:slug/farm-brand/media   (multipart/form-data, field `file`)
 *   → { hash, mimeType, sizeBytes, fileRecordId }
 *
 * ## Two steps, deliberately, rather than one
 *
 * This stores bytes and answers their CONTENT HASH. It does not touch
 * `FarmBrand`. Putting the hash on the profile is the content save
 * (`PATCH /farm-brand`), which is what decides whether an image is the logo,
 * where it sits in the gallery, and whether it appears at all.
 *
 * Separating them is what makes the editor honest about the two different
 * things a person is doing. An upload that also published would mean dropping
 * a file onto the page is a publication decision, and there would be no way to
 * upload four photographs and then choose two.
 *
 * It also means an upload is idempotent in the way that matters: the same
 * bytes produce the same hash, so a retry after a dropped connection yields
 * the same answer rather than a second gallery entry.
 *
 * ## What the response hash is NOT
 *
 * Not a capability. Holding a hash does not make an image public —
 * `/api/public/media/{hash}` serves it only once a PUBLISHED projection
 * references it, and only the owning tenant can put it there. Until then this
 * file is reachable exactly like any other tenant upload: through the
 * authenticated download gate, by nobody else.
 *
 * ## `farm-media`, its own storage domain
 *
 * The usecase files these under `farm-media` rather than `general`, and that
 * is load-bearing rather than tidy. Publishing checks the domain as well as
 * the tenant, so an evidence photo or a supplier invoice cannot be published
 * by hash even though the same tenant owns it. See `STORAGE_DOMAINS`.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { uploadFarmBrandMedia } from '@/app-layer/usecases/farm-brand-media';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { jsonResponse } from '@/lib/api-response';
import { codedBadRequest } from '@/lib/errors/types';

export const runtime = 'nodejs';

export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        // #1197's standing rule: every social surface sits behind a runtime
        // flag, default OFF, and the key is a LITERAL so an operator holding
        // the flag console can find the gate by reading the route.
        //
        // `social.public-profile` and not `social.farm-media`: this is the
        // EDITOR side, which is gated with the rest of the profile editor. The
        // media flag gates the PUBLIC read surface, so the two can be turned on
        // independently — a farm can be given the upload field before anyone
        // can fetch the result, which is the order this phase ships in.
        await assertFeatureEnabled('social.public-profile', ctx.userId);

        const form = await req.formData();
        const file = form.get('file');
        // `instanceof File` rather than a truthiness check: a text field named
        // `file` would otherwise reach the usecase as a string and fail deeper
        // with a message about bytes.
        if (!(file instanceof File)) {
            throw codedBadRequest('INVALID_FILE', 'No image was attached.');
        }

        const result = await uploadFarmBrandMedia(ctx, file);
        return jsonResponse(result, { status: 201 });
    },
);
