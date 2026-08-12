import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listCostEntries, createCostEntry } from '@/app-layer/usecases/cost-entry';
import { CreateCostEntrySchema, CostCategorySchema } from '@/app-layer/schemas/grain.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import { parseCsvIdParam, parseCsvEnumParam } from '@/lib/validation/query-params';

/**
 * Cost entries — the register behind /grain/costs (GRAIN module).
 *
 * This path used to serve the `?by=planting|field|season` cost ROLLUP.
 * That report is gone: the grain net-worth calculator already reports the
 * same ATTRIBUTED_CROP_COST figure as part of a larger answer, and two
 * endpoints over one number is what `src/lib/grain/cost-metrics.ts` exists
 * to prevent. The path is REUSED rather than left beside a new one so the
 * page and its API keep the same name — which is also the convention
 * `tests/guards/multi-select-facet-route-parity.test.ts` resolves by.
 *   GET  → list cost entries (newest incurred-date first; ?category= is a
 *          MULTI-select facet and arrives comma-joined, ?q= free-text over
 *          supplier / currency). Rows carry NO encrypted narrative
 *          (`description`) — fetch one entry for that.
 *   POST → create a cost entry.
 *
 * Auth follows the PayrollExpense precedent, which is what every grain
 * route does: module gate here, `assertCanRead`/`assertCanWrite` in the
 * usecase. NOT `requirePermission` — grain is not in the Epic C.1
 * `PRIVILEGED_ROOTS`, and adding a `ROUTE_PERMISSIONS` rule for a path
 * outside those roots fails the orphan-rule test, while adding the root
 * would pull all ~11 existing grain routes into a scope none of them
 * satisfies.
 */

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const sp = req.nextUrl.searchParams;
        const { rows, totalCount, truncated } = await listCostEntries(ctx, {
            // A multi-select facet is comma-joined into ONE param by
            // `filterStateToUrlParams`, so a bare `sp.get()` would hand
            // Prisma the literal string "PAYROLL,RENT" and throw a
            // validation error the page would render as its EMPTY state —
            // a confident claim of zero rows in response to a crash.
            categories: parseCsvEnumParam(sp.get('category'), CostCategorySchema, 'category'),
            plantingIds: parseCsvIdParam(sp.get('plantingId'), 'planting'),
            seasonIds: parseCsvIdParam(sp.get('seasonId'), 'season'),
            locationIds: parseCsvIdParam(sp.get('locationId'), 'location'),
            parcelIds: parseCsvIdParam(sp.get('parcelId'), 'parcel'),
            leaseIds: parseCsvIdParam(sp.get('leaseId'), 'lease'),
            itemIds: parseCsvIdParam(sp.get('itemId'), 'item'),
            q: sp.get('q') ?? undefined,
        });
        // Hot list read on a page farmers reload over rural LTE — a weak
        // ETag turns an unchanged cost register into a 304.
        return jsonWithETag(req, { rows, totalCount, truncated });
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateCostEntrySchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'GRAIN');
            const record = await createCostEntry(ctx, body);
            return jsonResponse(record, { status: 201 });
        },
    ),
);
