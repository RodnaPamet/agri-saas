import { NextRequest } from 'next/server';
import { inviterLocale } from '@/lib/email/inviter-locale';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listTenantMembers } from '@/app-layer/usecases/tenant-admin';
import { createInviteToken, listPendingInvites } from '@/app-layer/usecases/tenant-invites';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { sendInviteEmail } from '@/lib/email/invite-email';

const InviteMemberSchema = z.object({
    email: z.string().email('Valid email required'),
    role: z.enum(['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'MECHANISATOR'] as const),
});

const TENANT_ROLE_LABEL: Record<string, string> = {
    OWNER: 'Owner',
    ADMIN: 'Admin',
    EDITOR: 'Editor',
    AUDITOR: 'Auditor',
    READER: 'Reader',
    MECHANISATOR: 'Mechanisator',
};

export const GET = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) => {
        const sp = req.nextUrl.searchParams;
        const view = sp.get('view');

        if (view === 'invites') {
            const invites = await listPendingInvites(ctx);
            return jsonResponse(invites);
        }

        const members = await listTenantMembers(ctx);
        return jsonResponse(members);
    }),
);

export const POST = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await req.json();
        const input = InviteMemberSchema.parse(body);
        const result = await createInviteToken(ctx, input);

        // Email the acceptance link to the recipient. This is the route the
        // "Invite member" admin UI actually calls, so the send MUST live here
        // (the sibling /admin/invites route emails too — keep them in sync).
        // Best-effort + fail-open: the invite row is already committed, so a
        // mailer failure never fails creation — `url` is the copy-paste
        // fallback and `emailSent` tells the admin whether it went out.
        const { sent } = await sendInviteEmail({
            // The INVITER's language (#722). An invitee has no `User` row, so
            // this email has no recipient locale to read and must pick a
            // proxy; the inviter's is right for the common case — a Bulgarian
            // farm inviting Bulgarian staff — and no worse than English in the
            // uncommon one.
            locale: await inviterLocale(ctx.userId),
            to: result.invite.email,
            acceptUrl: resolvePublicOrigin(req) + result.url,
            kind: 'workspace',
            spaceName: ctx.tenantSlug ?? 'your workspace',
            roleLabel: TENANT_ROLE_LABEL[input.role] ?? input.role,
            expiresAt: result.invite.expiresAt,
        });

        return jsonResponse(
            { invite: result.invite, url: result.url, emailSent: sent },
            { status: 201 },
        );
    }),
);
