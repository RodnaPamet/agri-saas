import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { getAutomationSuggestions } from '@/app-layer/usecases/automation-suggestions';

type Ctx = { params: Promise<{ tenantSlug: string }> };

/**
 * VR-9 — ranked automation-rule suggestions for the Practice-page right rail.
 * Read-only + deterministic, so it's cheap to poll; the client can revalidate
 * on demand.
 */
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const data = await getAutomationSuggestions(ctx);
    return jsonResponse(data);
});
