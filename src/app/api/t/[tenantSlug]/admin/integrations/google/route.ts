import { NextRequest, NextResponse } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { codedBadRequest } from '@/lib/errors/types';
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
        // Unprefixed, matching FILE_REQUIRED and IDENTIFIERS_REQUIRED: the
        // generic `*_REQUIRED` codes describe the REQUEST or the caller, the
        // prefixed ones name the entity whose field is missing. A missing
        // query parameter is a property of the request, and this route raises
        // it before it knows the parameter names any Google row.
        if (!connectionId) throw codedBadRequest('CONNECTION_ID_REQUIRED', 'A connection id is required.');
        await disconnectGoogle(ctx, connectionId);
        return new NextResponse(null, { status: 204 });
    }),
);
