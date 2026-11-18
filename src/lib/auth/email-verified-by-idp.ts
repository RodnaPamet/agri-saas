/**
 * Records that an identity provider vouched for a user's e-mail address (#3178).
 *
 * `User.emailVerified` was written by exactly one path — the e-mail code a
 * password sign-up types back — so every account created by Google or
 * Microsoft Entra carried NULL for ever. Slow mode reads an explicit NULL as
 * "never confirmed" (`isSlowModeAccount`), which made the documented rule
 * "unverified OR younger than 7 days" mean ALWAYS for those people, and the
 * documented way out — verify the address — does not exist for an account
 * with no password.
 *
 * An OAuth sign-in is that verification. `signIn` in `src/auth.ts` already
 * refuses a provider reporting `email_verified === false`, and invite
 * redemption already accepts a non-credentials provider's address as
 * IdP-verified (`emailVerifiedByIdp`); this makes the stored column agree with
 * what those two paths already believe.
 *
 * The write is guarded on NULL, so the timestamp records the FIRST
 * confirmation and repeat sign-ins never move it — the same guard
 * `register/verify` uses. It never throws: a sign-in must not fail because a
 * bookkeeping column could not be written, and the next sign-in retries.
 */
import prisma from '@/lib/prisma';
import { edgeLogger } from '@/lib/observability/edge-logger';

export async function markEmailVerifiedByIdp(userId: string): Promise<void> {
    try {
        await prisma.user.updateMany({
            where: { id: userId, emailVerified: null },
            data: { emailVerified: new Date() },
        });
    } catch (err) {
        edgeLogger.warn('email-verified-by-idp write failed', {
            component: 'auth',
            error: err instanceof Error ? err.name : 'unknown',
        });
    }
}
