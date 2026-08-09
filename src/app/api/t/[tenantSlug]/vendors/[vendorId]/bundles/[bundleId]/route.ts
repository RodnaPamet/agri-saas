import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getEvidenceBundle, addBundleItem, removeBundleItem, freezeBundle } from '@/app-layer/usecases/vendor-audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

const AddItemSchema = z.object({
    entityType: z.enum(['VENDOR_DOCUMENT', 'ASSESSMENT', 'EVIDENCE', 'PRACTICE']),
    entityId: z.string().min(1),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; vendorId: string; bundleId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    return jsonResponse(await getEvidenceBundle(ctx, params.bundleId));
});

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; vendorId: string; bundleId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    if (url.searchParams.get('action') === 'freeze') {
        return jsonResponse(await freezeBundle(ctx, params.bundleId));
    }
    const raw = await req.json();
    const body = AddItemSchema.parse(raw);
    return jsonResponse(await addBundleItem(ctx, params.bundleId, body), { status: 201 });
});

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; vendorId: string; bundleId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const itemId = url.searchParams.get('itemId');
    if (!itemId) return jsonResponse({ error: 'itemId required' }, { status: 400 });
    return jsonResponse(await removeBundleItem(ctx, params.bundleId, itemId));
});
