/**
 * Epic D — org invite admin API.
 *
 *   POST /api/org/[orgSlug]/invites
 *     Create or refresh an invite. ORG_ADMIN-only via canManageMembers.
 *     Body: { email, role }. Returns { invite, url }.
 *
 *   GET /api/org/[orgSlug]/invites
 *     List pending invites (non-expired, non-revoked, non-accepted).
 *     ORG_ADMIN-only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { inviterLocale } from '@/lib/email/inviter-locale';
import { z } from 'zod';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import {
    createOrgInviteToken,
    listPendingOrgInvites,
} from '@/app-layer/usecases/org-invites';
import { forbidden } from '@/lib/errors/types';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { sendInviteEmail } from '@/lib/email/invite-email';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

const ORG_ROLE_LABEL: Record<string, string> = {
    ORG_ADMIN: 'Org admin',
    ORG_READER: 'Org reader',
};

const CreateOrgInviteInput = z.object({
    email: z.string().email('Valid email required'),
    role: z.enum(['ORG_ADMIN', 'ORG_READER'] as const),
});

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateOrgInviteInput,
        async (req: NextRequest, routeCtx: RouteContext, body) => {
            const ctx = await getOrgCtx((await routeCtx.params), req);
            if (!ctx.permissions.canManageMembers) {
                throw forbidden(
                    'You do not have permission to invite members to this organization',
                );
            }
            const result = await createOrgInviteToken(ctx, {
                email: body.email,
                role: body.role,
            });

            // Email the acceptance link to the recipient. Best-effort:
            // the invite is already committed, so a mailer failure never
            // fails creation — the `url` below is the copy-paste fallback
            // and `emailSent` tells the admin whether it went out.
            const { sent } = await sendInviteEmail({
            // The INVITER's language (#722). An invitee has no `User` row, so
            // this email has no recipient locale to read and must pick a
            // proxy; the inviter's is right for the common case — a Bulgarian
            // farm inviting Bulgarian staff — and no worse than English in the
            // uncommon one.
            locale: await inviterLocale(ctx.userId),
                to: result.invite.email,
                acceptUrl: resolvePublicOrigin(req) + result.url,
                kind: 'organization',
                spaceName: ctx.orgSlug,
                roleLabel: ORG_ROLE_LABEL[body.role] ?? body.role,
                expiresAt: result.invite.expiresAt,
            });

            return NextResponse.json(
                {
                    invite: {
                        id: result.invite.id,
                        email: result.invite.email,
                        role: result.invite.role,
                        expiresAt: result.invite.expiresAt.toISOString(),
                        createdAt: result.invite.createdAt.toISOString(),
                    },
                    url: result.url,
                    emailSent: sent,
                },
                { status: 201 },
            );
        },
    ),
);

export const GET = withApiErrorHandling(
    async (req: NextRequest, routeCtx: RouteContext) => {
        const ctx = await getOrgCtx((await routeCtx.params), req);
        if (!ctx.permissions.canManageMembers) {
            throw forbidden(
                'You do not have permission to view invites for this organization',
            );
        }
        const rows = await listPendingOrgInvites(ctx);
        return NextResponse.json({
            invites: rows.map((r) => ({
                id: r.id,
                email: r.email,
                role: r.role,
                expiresAt: r.expiresAt.toISOString(),
                createdAt: r.createdAt.toISOString(),
                invitedBy: r.invitedBy
                    ? { id: r.invitedBy.id, name: r.invitedBy.name, email: r.invitedBy.email }
                    : null,
            })),
        });
    },
);
