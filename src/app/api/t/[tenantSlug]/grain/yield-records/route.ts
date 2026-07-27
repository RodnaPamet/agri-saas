import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listYieldRecords, createYieldRecord } from '@/app-layer/usecases/yield-record';
import { CreateYieldRecordSchema } from '@/app-layer/schemas/grain.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import { parseCsvIdParam } from '@/lib/validation/query-params';

/**
 * Yield records — actual harvest production totals (GRAIN module).
 *   GET  → list yield records (newest harvest first; ?seasonId= / ?locationId=
 *          / ?plantingId= filters), each with a computed t/ha.
 *   POST → create a yield record.
 */

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const sp = req.nextUrl.searchParams;
        // Both facets declare `multiple: true`, so the filter layer sends
        // them comma-joined (`?seasonId=a,b`). Read as a scalar these became
        // an equality filter that matched nothing, and the page said "No
        // yield records match your filters" — indistinguishable from a farm
        // that genuinely harvested nothing those seasons.
        const { rows, totalCount, truncated } = await listYieldRecords(ctx, {
            seasonIds: parseCsvIdParam(sp.get('seasonId'), 'season'),
            locationIds: parseCsvIdParam(sp.get('locationId'), 'field'),
            plantingIds: parseCsvIdParam(sp.get('plantingId'), 'planting'),
            commodities: parseCsvIdParam(sp.get('commodity'), 'commodity'),
            // Server-side: the client filter only ever saw the loaded page,
            // so a match on row 501 was invisible and reported as "no
            // results" for a record that exists.
            q: sp.get('q') ?? undefined,
        });
        // Hot list read on a page farmers reload over rural LTE — a weak
        // ETag turns an unchanged harvest register into a 304.
        return jsonWithETag(req, { rows, totalCount, truncated });
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateYieldRecordSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'GRAIN');
            const record = await createYieldRecord(ctx, body);
            return jsonResponse(record, { status: 201 });
        },
    ),
);
