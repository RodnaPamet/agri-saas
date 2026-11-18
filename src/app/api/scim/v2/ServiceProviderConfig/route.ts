/**
 * SCIM 2.0 ServiceProviderConfig endpoint
 *
 * GET /api/scim/v2/ServiceProviderConfig
 *
 * This is a public endpoint (no auth required per SCIM spec).
 * Returns the capabilities of this SCIM service provider — or a 404 while
 * SCIM is turned off, because advertising capabilities of a service that
 * refuses every request would tell an IdP to keep trying.
 */
import { NextRequest } from 'next/server';
import { scimError, scimServiceProviderConfig } from '@/lib/scim/types';
import { isScimEnabled } from '@/lib/auth/tenant-sso-availability';
import { jsonResponse } from '@/lib/api-response';

export async function GET(req: NextRequest) {
    if (!(await isScimEnabled())) {
        return jsonResponse(scimError(404, 'Not found'), {
            status: 404,
            headers: { 'Content-Type': 'application/scim+json' },
        });
    }
    const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
    return jsonResponse(scimServiceProviderConfig(baseUrl), {
        headers: { 'Content-Type': 'application/scim+json' },
    });
}
