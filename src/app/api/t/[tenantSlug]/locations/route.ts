import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listLocations, listLocationsPaginated, createLocation } from '@/app-layer/usecases/location';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateLocationSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';

const LocationQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    status: z.string().optional(),
    q: z.string().optional().transform(normalizeQ),
    /**
     * Comma-separated `LocationKind`s, e.g. `?kind=BIN,STORAGE`. A Location is
     * a field or a storage row depending on kind, so a caller that wants one
     * (the inventory lot's storage picker wants storage) asks for it.
     */
    kind: z
        .string()
        .optional()
        .transform((v) =>
            v ? v.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean) : undefined,
        ),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = LocationQuerySchema.parse(sp);

    const hasPagination = query.limit || query.cursor;
    if (hasPagination) {
        const result = await listLocationsPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters: { status: query.status, q: query.q, kind: query.kind },
        });
        return jsonWithETag(req, result);
    }

    const locations = await listLocations(ctx, { status: query.status, q: query.q, kind: query.kind });
    return jsonWithETag(req, locations);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateLocationSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const location = await createLocation(ctx, body);
    return jsonResponse(location, { status: 201 });
}));
