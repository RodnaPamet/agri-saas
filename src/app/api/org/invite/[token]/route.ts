/**
 * Epic D — /api/org/invite/[token]
 *
 *   GET  — preview an invite (sign-in optional; returns preview or 410).
 *   POST — redeem an invite (must be signed in).
 *
 * Anti-enumeration: GET collapses every "not redeemable" state
 * (expired / revoked / accepted / not-found) into the same 410
 * response so callers can't distinguish.
 *
 * Rate limited: INVITE_REDEEM_LIMIT (10/min per IP), same shape as
 * the tenant-invite redemption endpoint.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authRefusingSuspended, authWithSuspension } from '@/lib/auth/session-gate';
import {
    previewOrgInviteByToken,
    redeemOrgInvite,
} from '@/app-layer/usecases/org-invites';
import { withApiErrorHandling } from '@/lib/errors/api';
import { INVITE_REDEEM_LIMIT } from '@/lib/security/rate-limit';
import {
    enforceRateLimit,
    getClientIp,
    isRateLimitBypassed,
} from '@/lib/security/rate-limit-middleware';
import { unauthorized } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

async function applyRedeemRateLimit(req: NextRequest): Promise<NextResponse | null> {
    if (isRateLimitBypassed()) return null;
    const enforcement = await enforceRateLimit(req, {
        scope: 'org-invite-redeem',
        config: INVITE_REDEEM_LIMIT,
        ip: getClientIp(req),
    });
    return enforcement.response ?? null;
}

export const GET = withApiErrorHandling(
    async (req: NextRequest, routeArgs: { params: Promise<{ token: string }> }) => {
        const limitResponse = await applyRedeemRateLimit(req);
        if (limitResponse) return limitResponse;

        const { token } = await routeArgs.params;
        // Preview — proceeds for a suspended account, for the reason given on
        // the tenant invite route next door (#1652).
        const { session } = await authWithSuspension();
        const sessionEmail = session?.user?.email ?? null;

        const preview = await previewOrgInviteByToken(token, sessionEmail);
        if (!preview) {
            return NextResponse.json(
                { error: { code: 'GONE', message: 'Invite is not valid or has expired.' } },
                { status: 410 },
            );
        }

        return jsonResponse({
            organizationName: preview.organizationName,
            organizationSlug: preview.organizationSlug,
            role: preview.role,
            expiresAt: preview.expiresAt.toISOString(),
            matchesSession: preview.matchesSession,
        });
    },
);

export const POST = withApiErrorHandling(
    async (req: NextRequest, routeArgs: { params: Promise<{ token: string }> }) => {
        const limitResponse = await applyRedeemRateLimit(req);
        if (limitResponse) return limitResponse;

        // Refused for a suspended account (owner ruling, #1652) — the
        // organisation half of the same hole.
        const session = await authRefusingSuspended();
        if (!session?.user?.id || !session.user.email) {
            throw unauthorized('You must be signed in to accept an invite.');
        }

        const { token } = await routeArgs.params;
        const result = await redeemOrgInvite({
            token,
            userId: session.user.id,
            userEmail: session.user.email,
            requestId: req.headers.get('x-request-id') ?? undefined,
        });

        return jsonResponse({
            organizationId: result.organizationId,
            slug: result.organizationSlug,
            role: result.role,
            provisioned: result.provision
                ? {
                      created: result.provision.created,
                      skipped: result.provision.skipped,
                      totalConsidered: result.provision.totalConsidered,
                  }
                : null,
        });
    },
);
