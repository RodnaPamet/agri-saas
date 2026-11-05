import { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { listPromotionLeads } from '@/app-layer/usecases/promotion-admin';

type IdParams = { tenantSlug: string; id: string };

/**
 * «Кой е питал» — the farms that asked about one promotion (#2727).
 *
 * `GET /api/t/{tenantSlug}/admin/promotions/{id}/leads -> { leads: [...] }`
 *
 * Two gates like the rest of the console: `admin.manage` is necessary and not
 * sufficient, because permissions resolve from Role and every tenant's OWNER
 * holds it; `assertPlatformSupport` is the isolation and answers 404 rather
 * than 403, so this does not announce itself to an unrelated farm.
 *
 * The enquiry message is encrypted under the INQUIRING farm's key, so the
 * usecase reads it per farm — see its docblock for why a privileged read alone
 * returns envelopes, and why that is two problems rather than one.
 */
export const GET = withApiErrorHandling(
    requirePermission<IdParams>('admin.manage', async (_req: NextRequest, { params }, ctx) => {
        assertPlatformSupport(ctx);
        return jsonResponse({ leads: await listPromotionLeads(ctx, params.id) });
    }),
);
