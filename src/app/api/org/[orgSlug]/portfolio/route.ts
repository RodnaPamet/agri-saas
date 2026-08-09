/**
 * Epic O-3 — portfolio dashboard read API.
 *
 *   GET /api/org/[orgSlug]/portfolio?view=<name>
 *
 *   view = summary  | health   | trends      ← snapshot aggregation
 *        = controls | evidence    ← cross-tenant drill-down
 *
 * Permission model:
 *   - All views require `canViewPortfolio` (any org member with that
 *     flag — ORG_ADMIN + ORG_READER).
 *   - Drill-down views additionally require `canDrillDown`. ORG_READERs
 *     don't have auto-provisioned AUDITOR membership in the child
 *     tenants, so the drill-down would return zero rows anyway under
 *     RLS. Failing fast at 403 makes the UX deterministic.
 *
 * Read-only. Wrapped with `withApiErrorHandling` for the standard
 * x-request-id / observability / error-shape handling. No
 * `withValidatedBody` because GET routes don't carry a body.
 */
import { NextRequest, NextResponse } from 'next/server';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest, forbidden } from '@/lib/errors/types';
import {
    getPortfolioSummary,
    getPortfolioTenantHealth,
    getPortfolioTrends,
    listNonPerformingControls,
    listOverdueEvidenceAcrossOrg,
} from '@/app-layer/usecases/portfolio';

const SUPPORTED_VIEWS = [
    'summary',
    'health',
    'trends',
    'controls',
    'evidence',
] as const;
type View = (typeof SUPPORTED_VIEWS)[number];

const DRILL_DOWN_VIEWS: ReadonlySet<View> = new Set(['controls', 'evidence']);

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

export const GET = withApiErrorHandling(
    async (req: NextRequest, routeCtx: RouteContext) => {
        const ctx = await getOrgCtx((await routeCtx.params), req);

        const rawView = req.nextUrl.searchParams.get('view');
        if (!rawView) {
            throw badRequest('Missing required query parameter: view');
        }
        if (!(SUPPORTED_VIEWS as readonly string[]).includes(rawView)) {
            throw badRequest(
                `Unsupported view '${rawView}'. Supported: ${SUPPORTED_VIEWS.join(', ')}`,
            );
        }
        const view = rawView as View;

        // Drill-down views need both canViewPortfolio (covered by usecase
        // assert) AND canDrillDown (route-level fail-fast). The usecases
        // themselves only check canViewPortfolio because the cross-
        // tenant safety property is enforced by the AUDITOR-membership
        // RLS at the data plane — but failing at the route layer gives
        // ORG_READERs a clean 403 rather than an empty array.
        if (DRILL_DOWN_VIEWS.has(view) && !ctx.permissions.canDrillDown) {
            throw forbidden(
                'Drill-down access is restricted to org admins with auto-provisioned tenant access',
            );
        }

        switch (view) {
            case 'summary':
                return NextResponse.json(await getPortfolioSummary(ctx));

            case 'health':
                return NextResponse.json({
                    rows: await getPortfolioTenantHealth(ctx),
                });

            case 'trends': {
                const daysParam = req.nextUrl.searchParams.get('days');
                const days = daysParam ? Number.parseInt(daysParam, 10) : 90;
                if (!Number.isFinite(days) || days < 1) {
                    throw badRequest('Invalid days parameter; must be a positive integer');
                }
                return NextResponse.json(await getPortfolioTrends(ctx, days));
            }

            case 'controls': {
                const page = parsePagination(req);
                const result = await listNonPerformingControls(ctx, page);
                return NextResponse.json({
                    rows: result.rows,
                    nextCursor: result.nextCursor,
                });
            }

            case 'evidence': {
                const page = parsePagination(req);
                const result = await listOverdueEvidenceAcrossOrg(ctx, page);
                return NextResponse.json({
                    rows: result.rows,
                    nextCursor: result.nextCursor,
                });
            }
        }
    },
);

/**
 * Parse the cursor + limit query parameters used by the three
 * paginated drill-down views. Both are optional — omitting them
 * yields the first page at the default limit. Invalid values fall
 * back to defaults rather than throwing, matching the existing
 * "lenient on read" posture (the cursor is opaque from the client's
 * perspective; an invalid one resets to page 1).
 */
function parsePagination(req: NextRequest): {
    cursor?: string;
    limit?: number;
} {
    const cursor = req.nextUrl.searchParams.get('cursor') ?? undefined;
    const limitRaw = req.nextUrl.searchParams.get('limit');
    let limit: number | undefined;
    if (limitRaw !== null) {
        const parsed = Number.parseInt(limitRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            limit = parsed;
        }
    }
    return { ...(cursor ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) };
}
