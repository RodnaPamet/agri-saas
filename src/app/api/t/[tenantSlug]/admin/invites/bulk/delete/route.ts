/**
 * POST /api/t/:slug/admin/invites/bulk/delete
 *
 * Bulk-revoke pending invitations (the invites table's selection action-row
 * "Revoke selected"). Guarded by `admin.members`; tenant-scoped + idempotent
 * in the usecase. Body: `{ inviteIds: string[] }`. Returns `{ revoked: n }`.
 */
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { bulkRevokeInvite } from '@/app-layer/usecases/tenant-invites';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { BulkRevokeInvitesSchema } from '@/lib/schemas';


export const POST = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await req.json();
        const { inviteIds } = BulkRevokeInvitesSchema.parse(body);
        const result = await bulkRevokeInvite(ctx, { inviteIds });
        return jsonResponse(result);
    }),
);
