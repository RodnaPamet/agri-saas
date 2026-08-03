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
import { withValidatedBody } from '@/lib/validation/route';
import { AuthActionSchema } from '@/lib/schemas';
import { env } from '@/env';
import { withApiErrorHandling } from '@/lib/errors/api';
import { logger } from '@/lib/observability/logger';
import { jsonResponse } from '@/lib/api-response';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import { SIGNUP_LIMIT } from '@/lib/security/rate-limit';
import type { PrismaClient, Role } from '@prisma/client';

export const POST = withApiErrorHandling(
    withValidatedBody(AuthActionSchema, async (_req, _ctx, body) => {
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
    }),
    { rateLimit: { config: SIGNUP_LIMIT, scope: 'self-service-signup' } },
);

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

    // Slug is derived from the org name plus a base36 timestamp so two
    // orgs with the same name don't collide.
    const slug =
        String(orgName)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '') +
        '-' +
        Date.now().toString(36);

    // Hash BEFORE the transaction. bcrypt at cost 12 costs hundreds of
    // milliseconds; holding a transaction open across it pins a pooled
    // connection, and DATABASE_URL points at PgBouncer in transaction
    // mode where that is expensive.
    const passwordHash = await hashPassword(password);

    // One transaction for all four rows. Previously these were four
    // unguarded sequential writes: a failure between the user insert and
    // the membership insert left a real User with no membership —
    // stranded on /no-tenant forever, and unable to retry because the
    // email was now taken (the duplicate check above returns 409).
    //
    // createTenantWithDek cannot join a transaction (it uses the
    // singleton client), so we create the tenant row on `tx` with a
    // freshly wrapped DEK — the same approach createTenantWithOwner
    // takes in src/app-layer/usecases/tenant-lifecycle.ts. The DEK cache
    // is not primed; it unwraps on first use.
    const { generateAndWrapDek } = await import('@/lib/security/tenant-keys');
    const { wrapped } = generateAndWrapDek();

    let created!: {
        tenantId: string;
        tenantSlug: string;
        tenantName: string;
        userId: string;
        userEmail: string;
        userName: string | null;
        role: Role;
    };

    await (prisma as PrismaClient).$transaction(async (tx) => {
        // OWNER, not ADMIN. Epic 1 made OWNER strictly superior — it alone
        // carries `admin.tenant_lifecycle` and `admin.owner_management`
        // (see src/lib/permissions.ts). A self-service tenant created with
        // an ADMIN-only member would be born with ZERO owners, so nobody
        // could ever transfer ownership, rotate the tenant DEK, or delete
        // the workspace. The `tenant_membership_last_owner_guard` trigger
        // cannot catch this: it fires on UPDATE/DELETE that would drop a
        // tenant to zero owners, and is blind to one that starts there.
        const tenant = await tx.tenant.create({
            data: { name: orgName, slug, encryptedDek: wrapped },
            select: { id: true, slug: true, name: true },
        });

        const user = await tx.user.create({
            data: {
                email,
                emailHash: hashForLookup(email),
                passwordHash,
                name,
            },
            select: { id: true, email: true, name: true },
        });

        const membership = await tx.tenantMembership.create({
            data: {
                tenantId: tenant.id,
                userId: user.id,
                role: 'OWNER',
                status: 'ACTIVE',
            },
            select: { role: true },
        });

        await tx.tenantOnboarding.create({ data: { tenantId: tenant.id } });

        created = {
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            tenantName: tenant.name,
            userId: user.id,
            userEmail: user.email,
            userName: user.name,
            role: membership.role,
        };
    });

    // Audit AFTER commit so the data is durable before the hash chain
    // extends. actorType is USER, not PLATFORM_ADMIN — this is
    // self-service, and conflating the two would corrupt the audit story
    // for anyone reviewing tenant provenance.
    //
    // The `.catch` here is deliberate, not an oversight: the transaction
    // has already committed and the user now has a real workspace, so
    // failing the response over a lost audit write would strand them
    // with an unusable UI for a problem they can't fix. But the audit
    // trail is hash-chained and security-relevant — a TENANT_CREATED
    // entry that silently never lands breaks the provenance story for
    // this tenant with no operator visibility. Log it loudly instead of
    // swallowing it.
    await appendAuditEntry({
        tenantId: created.tenantId,
        userId: created.userId,
        actorType: 'USER',
        entity: 'Tenant',
        entityId: created.tenantId,
        action: 'TENANT_CREATED',
        detailsJson: {
            category: 'tenant',
            slug: created.tenantSlug,
            name: created.tenantName,
            ownerUserId: created.userId,
            source: 'self_service_registration',
        },
    }).catch((error) => {
        logger.error('register.audit_append_failed', {
            component: 'auth',
            tenantId: created.tenantId,
            userId: created.userId,
            error: error instanceof Error ? error.message : String(error),
        });
    });

    // Fire the verification email. Mailer failures are swallowed inside
    // issueEmailVerification so SMTP latency never holds up the response.
    await issueEmailVerification(email, { userId: created.userId }).catch(() => undefined);

    // ── DEPRECATED: legacy `token` cookie (see docs/auth.md → "Legacy
    //    `token` cookie — deprecated") ────────────────────────────────
    //
    // This cookie predates the NextAuth migration. Today's product
    // login flow uses the NextAuth `__Secure-authjs.session-token`
    // cookie exclusively. It is NOT unread, though: `getSession()` in
    // `src/lib/auth.ts` falls back to `cookies().get('token')` when no
    // Auth.js session is present, so this remains a live legacy
    // authentication path, not dead code. It's kept here for one more
    // release in case an external integration still relies on it. The
    // next-release PR will:
    //   1. Drop this block.
    //   2. Drop `signToken` + `verifyToken` exports from `@/lib/auth`.
    //   3. Drop the `getSession()` legacy-cookie fallback.
    //   4. Drop the cookie-clear in `src/app/api/auth/logout/route.ts`.
    //   5. Add a structural ratchet rejecting reintroduction.
    //
    // If you find a real external consumer DURING this window: open
    // an issue with the consumer details before the delete lands.
    //
    // Skip minting it at all when email verification is required: this
    // cookie is a 7-day OWNER credential, and handing one to a registrant
    // who hasn't confirmed their address yet would undercut the whole
    // point of gating sign-in on `EmailNotVerified`. Same condition the
    // response's `emailVerificationRequired` field already uses.
    const requireEmailVerification = env.AUTH_REQUIRE_EMAIL_VERIFICATION === '1';

    const response = jsonResponse({
        user: {
            id: created.userId,
            email: created.userEmail,
            name: created.userName,
            role: created.role,
        },
        // GAP-23: slug exposed alongside id/name so callers (notably
        // E2E test fixtures via `createIsolatedTenant`) can navigate
        // to `/t/<slug>/...` without having to look the slug up
        // post-registration. Slug is a public routing identifier,
        // not sensitive — it appears in every authenticated URL.
        tenant: { id: created.tenantId, name: created.tenantName, slug: created.tenantSlug },
        emailVerificationRequired: requireEmailVerification,
    });

    if (!requireEmailVerification) {
        const token = signToken({
            userId: created.userId,
            tenantId: created.tenantId,
            email: created.userEmail,
            role: created.role,
        });

        response.cookies.set('token', token, {
            httpOnly: true,
            secure: env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 60 * 60 * 24 * 7, // 7 days
            path: '/',
        });
    }

    return response;
}
