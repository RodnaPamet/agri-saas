import { NextRequest, NextResponse } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';
import { listGoogleConnections, disconnectGoogle } from '@/app-layer/integrations/providers/google';

/**
 * #2005 — Google connection collection.
 *
 * Gated by `admin.manage` (the admin/integrations root); denials audit as
 * AUTHZ_DENIED. Mirrors the SharePoint collection route.
 */

/**
 * GET — list this tenant's Google connections (no secrets).
 *
 * Deliberately NOT flag-gated, where the connect route is. A tenant that
 * connected Google before the flag was turned off still needs to see and
 * remove the connection; hiding it would leave a grant the admin cannot
 * revoke from the UI.
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        return jsonResponse(await listGoogleConnections(ctx));
    }),
);

/** DELETE ?connectionId — disconnect a Google connection. */
export const DELETE = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const connectionId = req.nextUrl.searchParams.get('connectionId');
        if (!connectionId) throw badRequest('connectionId is required');
        await disconnectGoogle(ctx, connectionId);
        return new NextResponse(null, { status: 204 });
    }),
);
