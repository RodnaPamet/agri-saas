import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { badRequest } from '@/lib/errors/types';
import {
    uploadPromotionImage,
    removePromotionImage,
    PROMOTION_IMAGE_MAX_BYTES,
} from '@/lib/promotions/promotion-image';

/**
 * Promotion artwork upload / removal (#12).
 *
 * Same two gates as the sibling promotion routes: `admin.manage` is the
 * audited role floor, `assertPlatformSupport` is the isolation practice. This
 * one matters more than most — the bytes it accepts render in EVERY tenant's
 * offers feed, so a tenant-facing writer would be a cross-tenant content
 * injection point.
 *
 * Multipart, not JSON: the browser posts the canvas-produced webp blob
 * directly, matching the evidence-upload contract.
 *
 * Permission: platform-admin surface — see ../route.ts.
 */

/** Route params — the tenant slug plus this route's own [id] segment. */
type IdParams = { tenantSlug: string; id: string };

export const POST = withApiErrorHandling(
    requirePermission<IdParams>('admin.manage', async (req: NextRequest, { params }, ctx) => {
        assertPlatformSupport(ctx);
        const { id } = params;

        const formData = await req.formData();
        const file = formData.get('file');
        if (!file || !(file instanceof File)) {
            throw badRequest('Missing or invalid file in form data.');
        }
        // Reject on the declared size before buffering, so an oversized upload
        // is refused without being read into memory first. The real check is
        // still on the buffer — this header is client-supplied.
        if (file.size > PROMOTION_IMAGE_MAX_BYTES) {
            throw badRequest('The processed image is too large — re-select a smaller one.');
        }

        const buf = Buffer.from(await file.arrayBuffer());
        const { mediaUrl } = await uploadPromotionImage(id, buf);
        return jsonResponse({ mediaUrl }, { status: 201 });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<IdParams>('admin.manage', async (_req: NextRequest, { params }, ctx) => {
        assertPlatformSupport(ctx);
        await removePromotionImage(params.id);
        return new NextResponse(null, { status: 204 });
    }),
);
