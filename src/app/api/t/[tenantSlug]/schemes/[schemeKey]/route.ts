import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getSchemeDetail } from '@/app-layer/usecases/certification-scheme';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * A single certification scheme, with this farm's progress against it.
 *
 * GET only. Browsing a standard's control points is not a privileged act —
 * every role may do it (`assertCanViewFrameworks`) — and the farm-specific
 * half of the payload is scoped to the caller's own tenant inside
 * `computeCoverage`. Registered in the coverage guardrail's exclusion list for
 * that reason; the WRITE surface on this root is the platform-gated POST at
 * `/schemes`.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; schemeKey: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'CERTIFICATION');
        return jsonResponse(await getSchemeDetail(ctx, params.schemeKey));
    },
);
