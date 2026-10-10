import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { updateMemberCertificates } from '@/app-layer/usecases/tenant-admin';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { UpdateMemberCertificatesSchema } from '@/lib/schemas';

// БАБХ farm-record — the plant-protection certificates carried by a member.
// Three-state per field (null clears, omitted leaves unchanged). Covered by
// the `/admin/members(/.*)?` rule in route-permissions.ts.

export const PUT = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; membershipId: string }>(
        'admin.members',
        async (req: NextRequest, { params }, ctx) => {
            const input = UpdateMemberCertificatesSchema.parse(await req.json());
            const result = await updateMemberCertificates(ctx, {
                membershipId: params.membershipId,
                ...input,
            });
            return jsonResponse(result);
        },
    ),
);
