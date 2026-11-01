import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getCostSummary } from '@/app-layer/usecases/cost-summary';
import { CostCategorySchema } from '@/app-layer/schemas/grain.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';
import { parseCsvEnumParam, parseDateRangeParam } from '@/lib/validation/query-params';

/**
 * Exact cost aggregates behind the «Разходи» graphs (#500).
 *
 * `GET` with the SAME facets as the list next door — `?category=` comma-joined,
 * `?incurredOn=` as one `YYYY-MM-DD|YYYY-MM-DD` token. Deliberately the same
 * spelling rather than `?from=&to=`: the page holds one filter state and sends
 * it to both endpoints, so two conventions would mean two parsers and the
 * chance of a graph and a list disagreeing about the window they describe.
 *
 * Answers three groupings in ONE response — per type, per month, and per type
 * per month — because the third is what an unfolded type row needs, and making
 * that a second request would put a round trip behind a disclosure triangle.
 *
 * Totals are **integer minor units** grouped **by currency**, never blended:
 * there is no FX table in this repo, and `CostEntry.currency` says so. The
 * client picks which currency to draw and can say what it left out.
 *
 * Auth mirrors the list exactly — module gate here, `assertCanRead` in the
 * usecase, not `requirePermission` (grain is outside the Epic C.1
 * `PRIVILEGED_ROOTS`, and a `ROUTE_PERMISSIONS` rule outside those roots fails
 * the orphan-rule test).
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');

        const sp = req.nextUrl.searchParams;
        const window = parseDateRangeParam(sp.get('incurredOn'), 'incurredOn');

        const summary = await getCostSummary(ctx, {
            // Comma-joined by `filterStateToUrlParams`, so a bare `sp.get()`
            // would hand Postgres the literal "PAYROLL,RENT" — the same trap
            // the list route documents, and here it would surface as an empty
            // graph rather than an error.
            categories: parseCsvEnumParam(sp.get('category'), CostCategorySchema, 'category'),
            from: window?.from,
            to: window?.to,
        });

        // ETag, like the other hot list reads: the graphs are re-fetched on
        // every filter change and the payload is small but not free.
        return jsonWithETag(req, summary);
    },
);
