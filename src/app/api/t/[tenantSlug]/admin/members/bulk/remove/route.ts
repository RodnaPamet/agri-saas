/**
 * POST /api/t/:slug/admin/members/bulk/remove
 *
 * Bulk-remove memberships (→ REMOVED) — the members table's "Remove"
 * selection action. Hard counterpart to /bulk/delete (deactivate). Guarded
 * by `admin.members`. Operates on active AND already-inactive rows, skips
 * the caller's own membership, and protects the last active OWNER/ADMIN.
 * Body: `{ membershipIds: string[] }`. Returns `{ removed, skipped }`.
 */
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { bulkRemoveTenantMember } from '@/app-layer/usecases/tenant-admin';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { BulkRemoveMembershipsSchema } from '@/lib/schemas';


export const POST = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await req.json();
        const { membershipIds } = BulkRemoveMembershipsSchema.parse(body);
        const result = await bulkRemoveTenantMember(ctx, { membershipIds });
        return jsonResponse(result);
    }),
);
