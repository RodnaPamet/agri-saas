import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { updateTenantMemberRole, removeTenantMember } from '@/app-layer/usecases/tenant-admin';
import { assignCustomRole } from '@/app-layer/usecases/custom-roles';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { codedBadRequest } from '@/lib/errors/types';
import { UpdateAdminMemberSchema } from '@/lib/schemas';


export const PATCH = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; membershipId: string }>(
        'admin.members',
        async (req: NextRequest, { params }, ctx) => {
            const body = await req.json();
            const input = UpdateAdminMemberSchema.parse(body);

            let result;

            // If role change requested, update enum role
            if (input.role) {
                result = await updateTenantMemberRole(ctx, {
                    membershipId: params.membershipId,
                    role: input.role,
                });
            }

            // If customRoleId change requested (even if null = unassign)
            if (input.customRoleId !== undefined) {
                result = await assignCustomRole(
                    ctx,
                    params.membershipId,
                    input.customRoleId,
                );
            }

            if (!result) {
                // A coded throw, not a bespoke body. This returned
                // `{ error: 'No changes specified' }` — a STRING where the
                // spec declares this operation's 400 as `ErrorResponse`, so a
                // client switching on `error.code` read `undefined` (#1447).
                //
                // The prose is preserved verbatim as the message, so anything
                // rendering it shows the same text.
                throw codedBadRequest('NO_CHANGES_SPECIFIED', 'No changes specified');
            }

            return jsonResponse(result);
        },
    ),
);

/**
 * DELETE — fully remove a membership (→ REMOVED), so it leaves the
 * members list. The hard counterpart to /deactivate; used for a member
 * the admin no longer wants listed. Self-removal + last-active-OWNER/ADMIN
 * are refused in the usecase.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; membershipId: string }>(
        'admin.members',
        async (_req: NextRequest, { params }, ctx) => {
            const result = await removeTenantMember(ctx, {
                membershipId: params.membershipId,
            });
            return jsonResponse(result);
        },
    ),
);
