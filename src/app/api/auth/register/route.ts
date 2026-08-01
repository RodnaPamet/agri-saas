/**
 * POST /api/auth/register  body: { action: 'register', email, password, name, orgName }
 *
 * Register is the ONLY credentials flow still served by this route.
 * Login was served here historically via `action: 'login'` before the
 * NextAuth Credentials provider became production-grade; that path was
 * removed on 2026-04-22 to avoid having two concurrent login surfaces
 * with subtly different rate-limit / audit / email-verification
 * semantics. All production login now flows through NextAuth
 * `/api/auth/callback/credentials`.
 */
import prisma from '@/lib/prisma';
import { signToken } from '@/lib/auth';
import { issueEmailVerification } from '@/lib/auth/email-verification';
import { hashPassword, validatePasswordPolicy } from '@/lib/auth/passwords';
import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { withValidatedBody } from '@/lib/validation/route';
import { AuthActionSchema } from '@/lib/schemas';
import { env } from '@/env';
import { withApiErrorHandling } from '@/lib/errors/api';
import { logger } from '@/lib/observability/logger';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(withValidatedBody(AuthActionSchema, async (_req, _ctx, body) => {
    try {
        // Zod discriminated-union already rejects anything but `register`
        // — no else branches needed. Keep the try/catch as a final safety
        // net so a DB error during registration returns JSON instead of
        // bubbling as an HTML 500 page.
        return await handleRegister(body);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
        logger.error('Auth error', { component: 'auth', error: error instanceof Error ? error.message : String(error) });
        return jsonResponse({ error: error.message || 'Auth failed' }, { status: 500 });
    }
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleRegister(body: any) {
    const { email: rawEmail, password, name, orgName } = body;
    if (!rawEmail || !password || !name || !orgName) {
        return jsonResponse({ error: 'Missing required fields' }, { status: 400 });
    }

    // Enforce password policy at the set-password boundary. Login
    // does NOT re-validate (see src/lib/auth/passwords.ts) so pre-policy
    // users aren't locked out by a later rule bump.
    const policy = validatePasswordPolicy(password);
    if (!policy.ok) {
        return jsonResponse(
            {
                error:
                    policy.reason === 'too_short'
                        ? 'Password must be at least 8 characters'
                        : policy.reason === 'too_long'
                          ? 'Password is too long'
                          : 'Password is required',
            },
            { status: 400 },
        );
    }

    // Breached-password screening (Epic A.3). Fails open on network
    // errors — a HIBP outage must not brick signup. The function never
    // logs the password or its hash.
    const hibp = await checkPasswordAgainstHIBP(password);
    if (hibp.breached) {
        return jsonResponse(
            {
                error:
                    'This password appears in known data breaches. Please choose a different password.',
            },
            { status: 400 },
        );
    }

    const email = String(rawEmail).trim().toLowerCase();

    // GAP-21: identity is anchored on `emailHash` (deterministic
    // HMAC of the normalised email). Checking by hash is what the
    // unique constraint enforces, so a duplicate signup races
    // through the same gate as the DB.
    const existing = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(email) },
    });
    if (existing) {
        return jsonResponse({ error: 'Email already registered' }, { status: 409 });
    }

    // Create tenant (Epic B.2: with a wrapped per-tenant DEK primed
    // into the manager's cache — no unwrap round-trip on first use).
    const slug = String(orgName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);
    const tenant = await createTenantWithDek({
        name: orgName,
        slug,
    });

    // Create user (no role/tenantId — membership is sole authority)
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
        data: {
            email,
            emailHash: hashForLookup(email),
            passwordHash,
            name,
        },
    });

    // Create TenantMembership (sole source of role + tenant binding).
    //
    // OWNER, not ADMIN. Epic 1 made OWNER strictly superior — it alone
    // carries `admin.tenant_lifecycle` and `admin.owner_management`
    // (see src/lib/permissions.ts). A self-service tenant created with
    // an ADMIN-only member would be born with ZERO owners, so nobody
    // could ever transfer ownership, rotate the tenant DEK, or delete
    // the workspace. The `tenant_membership_last_owner_guard` trigger
    // cannot catch this: it fires on UPDATE/DELETE that would drop a
    // tenant to zero owners, and is blind to one that starts there.
    const membership = await prisma.tenantMembership.create({
        data: {
            tenantId: tenant.id,
            userId: user.id,
            role: 'OWNER',
        },
    });

    // Fire the verification email. Non-blocking in intent — the issue
    // path writes the token row in a transaction and then attempts to
    // send the email; mailer failures are swallowed inside
    // issueEmailVerification so the register response is not held up
    // by SMTP latency or outages.
    await issueEmailVerification(email, { userId: user.id }).catch(() => undefined);

    // ── DEPRECATED: legacy `token` cookie (see docs/auth.md → "Legacy
    //    `token` cookie — deprecated") ────────────────────────────────
    //
    // This cookie predates the NextAuth migration. Today's product
    // login flow uses the NextAuth `__Secure-authjs.session-token`
    // cookie exclusively; nothing in the codebase reads `token` (zero
    // consumers of `verifyToken`, no `cookies.get('token')` anywhere).
    // It's kept here for one more release in case an external
    // integration still relies on it. The next-release PR will:
    //   1. Drop this block.
    //   2. Drop `signToken` + `verifyToken` exports from `@/lib/auth`.
    //   3. Drop the cookie-clear in `src/app/api/auth/logout/route.ts`.
    //   4. Add a structural ratchet rejecting reintroduction.
    //
    // If you find a real external consumer DURING this window: open
    // an issue with the consumer details before the delete lands.
    const token = signToken({
        userId: user.id,
        tenantId: tenant.id,
        email: user.email,
        role: membership.role,
    });

    const response = jsonResponse({
        user: { id: user.id, email: user.email, name: user.name, role: membership.role },
        // GAP-23: slug exposed alongside id/name so callers (notably
        // E2E test fixtures via `createIsolatedTenant`) can navigate
        // to `/t/<slug>/...` without having to look the slug up
        // post-registration. Slug is a public routing identifier,
        // not sensitive — it appears in every authenticated URL.
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        emailVerificationRequired: env.AUTH_REQUIRE_EMAIL_VERIFICATION === '1',
    });

    response.cookies.set('token', token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7 days
        path: '/',
    });

    return response;
}
