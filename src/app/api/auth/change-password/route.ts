/**
 * POST /api/auth/change-password   body: { currentPassword, newPassword }
 *
 * Authenticated password change. Requires a live session; verifies the
 * current password, validates the new one (length policy + HIBP breach
 * screening — Epic A.3 / E.4), swaps the stored hash, and revokes every
 * session for the account.
 *
 * That includes the caller's OWN session — so the response carries
 * `reauthRequired: true` and the UI redirects to sign-in. A password
 * change should never leave a stale session alive anywhere.
 *
 * Mutation rate limiting is the default API_MUTATION_LIMIT — the route
 * is authenticated and `currentPassword` must verify, so the abuse
 * surface is already small.
 */
import { z } from 'zod';

import { auth } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import {
    validatePasswordPolicy,
    describePasswordPolicyFailure,
} from '@/lib/auth/passwords';
import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';
import { changePassword } from '@/lib/auth/password-management';

const ChangePasswordSchema = z
    .object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(1),
    })
    .strip();

export const POST = withApiErrorHandling(
    withValidatedBody(ChangePasswordSchema, async (req, _ctx, body) => {
        const session = await auth();
        if (!session?.user) {
            return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
        }

        if (body.newPassword === body.currentPassword) {
            return jsonResponse(
                {
                    error:
                        'Your new password must be different from your current password.',
                },
                { status: 400 },
            );
        }

        // ── New-password policy (length floor/ceiling) ──
        const policy = validatePasswordPolicy(body.newPassword);
        if (!policy.ok) {
            return jsonResponse(
                { error: describePasswordPolicyFailure(policy.reason) },
                { status: 400 },
            );
        }

        // ── Breached-password screening (fails open on a HIBP outage) ──
        const hibp = await checkPasswordAgainstHIBP(body.newPassword);
        if (hibp.breached) {
            return jsonResponse(
                {
                    error:
                        'This password appears in known data breaches. Please choose a different password.',
                },
                { status: 400 },
            );
        }

        const requestId = req.headers.get('x-request-id') ?? undefined;
        const result = await changePassword(
            session.user.id,
            body.currentPassword,
            body.newPassword,
            { requestId },
        );
        if (!result.ok) {
            return jsonResponse(
                {
                    error:
                        result.reason === 'no_password'
                            ? 'This account signs in with a social provider and has no password to change.'
                            : 'Your current password is incorrect.',
                },
                { status: 400 },
            );
        }

        // Every session — including this one — is now revoked.
        return jsonResponse({ ok: true, reauthRequired: true });
    }),
);
