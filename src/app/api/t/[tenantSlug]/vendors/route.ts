import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listVendors, listVendorsPaginated, createVendor } from '@/app-layer/usecases/vendor';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateVendorSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { csvEnumField, csvIdField } from '@/lib/validation/query-params';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const VendorQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    // multiple:true facets — split + validate each member, yield an ARRAY.
    status: csvEnumField(z.enum(['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'OFFBOARDED'])),
    criticality: csvEnumField(z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])),
    riskRating: csvIdField(),
    reviewDue: z.enum(['overdue', 'next30d']).optional(),
    q: z.string().optional().transform(normalizeQ),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // WP-2 — the compliance/GRC domain is gated behind CERTIFICATION.
    await assertModuleEnabled(ctx, 'CERTIFICATION');
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = VendorQuerySchema.parse(sp);

    const hasPagination = query.limit || query.cursor;
    if (hasPagination) {
        const result = await listVendorsPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters: {
                status: query.status,
                criticality: query.criticality,
                riskRating: query.riskRating,
                reviewDue: query.reviewDue,
                q: query.q,
            },
        });
        return jsonResponse(result);
    }

    // PR-5 — backfill cap.
    const vendors = await listVendors(
        ctx,
        {
            status: query.status,
            criticality: query.criticality,
            riskRating: query.riskRating,
            reviewDue: query.reviewDue,
            q: query.q,
        },
        { take: LIST_BACKFILL_CAP + 1 },
    );
    const result = applyBackfillCap(vendors);
    // PR-6 — row-count observability.
    recordListPageRowCount({
        entity: 'vendors',
        count: result.rows.length,
        truncated: result.truncated,
        tenantId: ctx.tenantId,
    });
    return jsonResponse(result);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateVendorSchema, async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // WP-2 — the compliance/GRC domain is gated behind CERTIFICATION.
    await assertModuleEnabled(ctx, 'CERTIFICATION');
    const vendor = await createVendor(ctx, body);
    return jsonResponse(vendor, { status: 201 });
}));
