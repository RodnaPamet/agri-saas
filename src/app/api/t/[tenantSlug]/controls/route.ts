import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listControls, listControlsPaginated, createControl, listControlsWithDeleted } from '@/app-layer/usecases/control';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateControlSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { csvEnumField, csvIdField } from '@/lib/validation/query-params';
import { ControlStatus } from '@prisma/client';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const ControlsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    // multiple:true facets — see filter-defs.ts. csvEnumField / csvIdField
    // split the comma-joined param and validate each member (400 on a bad
    // one), yielding an ARRAY the repository turns into `{ in: [...] }`.
    status: csvEnumField(z.nativeEnum(ControlStatus)),
    applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']).optional(),
    ownerUserId: csvIdField(),
    q: z.string().optional().transform(normalizeQ),
    category: csvIdField(),
    includeDeleted: z.enum(['true', 'false']).optional(),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // WP-2 — the compliance/GRC domain is gated behind CERTIFICATION.
    await assertModuleEnabled(ctx, 'CERTIFICATION');
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = ControlsQuerySchema.parse(sp);

    if (query.includeDeleted === 'true') {
        const controls = await listControlsWithDeleted(ctx);
        return jsonResponse(controls);
    }

    const filters = {
        status: query.status,
        applicability: query.applicability,
        ownerUserId: query.ownerUserId,
        q: query.q,
        category: query.category,
    };

    // If pagination params present, use paginated response
    if (query.limit !== undefined || query.cursor !== undefined) {
        const result = await listControlsPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters,
        });
        return jsonResponse(result);
    }

    // PR-5 — backfill cap. Ask for cap+1 rows; the helper slices to
    // the cap and reports `truncated: true` if the sentinel was hit.
    const controls = await listControls(ctx, filters, { take: LIST_BACKFILL_CAP + 1 });
    const result = applyBackfillCap(controls);
    // PR-6 — row-count observability.
    recordListPageRowCount({
        entity: 'controls',
        count: result.rows.length,
        truncated: result.truncated,
        tenantId: ctx.tenantId,
    });
    return jsonResponse(result);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateControlSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // WP-2 — the compliance/GRC domain is gated behind CERTIFICATION.
    await assertModuleEnabled(ctx, 'CERTIFICATION');
    const control = await createControl(ctx, body);
    return jsonResponse(control, { status: 201 });
}));
