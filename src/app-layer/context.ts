import { NextRequest } from 'next/server';
import { API_KEY_AUTH_ENABLED } from '@/lib/auth/api-key-availability';
import { getSessionOrThrow } from '@/lib/auth';
import { resolveTenantContext } from '@/lib/tenant-context';
import { RequestContext, OrgContext, UserContext } from './types';
import { randomUUID } from 'crypto';
import { mergeRequestContext } from '@/lib/observability/context';
import {
    assertApiKeyMayReachPath,
    extractBearerToken,
    isApiKeyToken,
    verifyApiKey,
} from '@/lib/auth/api-key-auth';
import { badRequest, forbidden, notFound, unauthorized } from '@/lib/errors/types';
import { personSurfaceOf, type PersonSurface } from '@/lib/auth/guard';
import prisma from '@/lib/prisma';
import { getOrgPermissions } from '@/lib/permissions';
import { logger } from '@/lib/observability/logger';

/**
 * Generates or extracts a request ID.
 * Future enhancement: Read from headers (x-request-id).
 */
function getRequestId(req?: NextRequest): string {
    if (req?.headers.has('x-request-id')) {
        return req.headers.get('x-request-id')!;
    }
    return randomUUID();
}

/**
 * Builds a RequestContext for tenant-level operations.
 * Requires tenantSlug from the route params.
 *
 * Custom role resolution: When the user's membership has a customRoleId,
 * appPermissions comes from the custom role's permissionsJson (parsed
 * with baseRole fallback). Otherwise, standard enum-based permissions.
 */
export async function getTenantCtx(
    params: { tenantSlug: string },
    req?: NextRequest
): Promise<RequestContext> {
    // Try API key auth first if Authorization header is present.
    // The URL's slug is passed and COMPARED — see tryApiKeyAuth.
    if (req) {
        const apiKeyCtx = await tryApiKeyAuth(req, params.tenantSlug);
        if (apiKeyCtx) {
            // The per-request scope gate. THIS is the enforcement point rather
            // than `requirePermission`, because only ~23 of the 273 tenant
            // routes use that wrapper — the rest gate on `assertCanWrite`,
            // which reads a coarse role derived from the key's scopes and so
            // grants every resource once any `:write` scope is present.
            // `getTenantCtx` is the one function all 273 reach.
            assertApiKeyMayReachPath(apiKeyCtx, new URL(req.url).pathname, req.method);
            return apiKeyCtx;
        }
    }

    const session = await getSessionOrThrow();
    const requestId = getRequestId(req);

    // This checks membership and resolves the tenant UUID & role
    const ctx = await resolveTenantContext(params, session.userId);

    // Enrich the observability context with tenant and user info
    // so that logs/traces emitted downstream automatically include them.
    mergeRequestContext({ tenantId: ctx.tenant.id, userId: session.userId });

    return {
        requestId,
        userId: session.userId,
        tenantId: ctx.tenant.id,
        tenantSlug: ctx.tenant.slug,
        role: ctx.role,
        permissions: ctx.permissions,
        appPermissions: ctx.appPermissions,
    };
}

/**
 * Builds a `UserContext` — a PERSON with no tenant.
 *
 * For surfaces that belong to a human rather than a farm: their own profile,
 * account settings, onboarding, the social graph. It sets no tenant, resolves
 * no role and derives no permissions, because none of those mean anything when
 * the subject is the caller themselves.
 *
 * ── it REFUSES three callers, and each refusal is load-bearing ──
 *
 * 1. **API keys.** A key is a tenant-scoped machine credential: it is issued
 *    for one farm, carries scopes, and has no person behind it. There is no
 *    correct `userId` to put in a `UserContext` for one, so the honest answer
 *    is a refusal rather than a context attributed to whoever created the key.
 *    Refused whether or not `API_KEY_AUTH_ENABLED` is on — with it off the key
 *    is ignored everywhere else, and silently serving the cookie's user to a
 *    request that presented a key would answer as the wrong principal.
 *
 * 2. **MFA-pending sessions.** `src/middleware.ts`'s MFA gate is wrapped in
 *    `isTenantPath(pathname)`, so it does not fire for `/api/me/`,
 *    `/api/social/`, `/account/` or `/onboarding/`. Until P1.6 adds that
 *    parity this check is the ONLY thing between a half-authenticated session
 *    and a person's own data — which is the data a stolen first factor is most
 *    useful against.
 *
 * 3. **Operator-only users.** A MECHANISATOR is a machine-operator persona
 *    confined to its "My work" screen. The middleware's lockdown keys on the
 *    tenant slug in the URL, and a person-scoped path HAS no slug — so that
 *    lockdown cannot fire here at all, and without this check the one persona
 *    deliberately confined to a single screen would reach every person-scoped
 *    surface in the product.
 *
 * ── why the operator decision reads the DATABASE and not the JWT ──
 *
 * The session's `memberships` array is capped at `MAX_JWT_MEMBERSHIPS` with a
 * `membershipsTruncated` flag. "Every entry is MECHANISATOR" over a TRUNCATED
 * list does not mean the user is operator-only — a non-operator membership may
 * sit beyond the cap — and the failure direction is locking a legitimate user
 * out of their own account. One indexed query on a low-traffic surface buys an
 * authoritative answer, so the cap is simply not in the decision.
 *
 * @see runInUserContext — executes with this context, setting `app.user_id` only
 */
export async function getUserCtx(
    req?: NextRequest,
    opts?: { surface?: PersonSurface },
): Promise<UserContext> {
    // FIRST, before any session work: a key presented here is a category error
    // and must not be answered as the cookie's user.
    if (req) {
        const bearer = extractBearerToken(req.headers.get('authorization'));
        if (bearer && isApiKeyToken(bearer)) {
            // A code rather than prose, for the reason given at the MFA refusal.
            throw forbidden('API_KEY_NOT_PERSON_SCOPED');
        }
    }

    const session = await getSessionOrThrow();
    const requestId = getRequestId(req);

    if (session.mfaPending === true) {
        // A machine-readable CODE, not prose.
        //
        // `tests/guards/no-server-authored-user-copy.test.ts` holds
        // server-authored copy on a downward ratchet: a prose message thrown
        // from `src/lib` or `src/app-layer` reaches the client verbatim —
        // `ApiClientError` preserves `message` and the iOS app renders the raw
        // envelope, English and all. A code is the half a client can translate.
        //
        // This deliberately does NOT match the middleware's tenant-path gate,
        // which returns `forbiddenJson('MFA verification required')` — a
        // different envelope (`{ error }` from the Edge) on a different path.
        // Copying its English here would add a second untranslatable string to
        // get a cosmetic match between two responses a client already has to
        // handle separately. P1.6 brings the two paths together; when it does,
        // the code is the thing worth agreeing on.
        throw forbidden('MFA_REQUIRED');
    }

    // P1.6 narrowed this from "every person-scoped surface" to the SOCIAL half.
    //
    // Owner ruling, 2026-10-02: the MECHANISATOR lockdown keeps a shared field
    // device off the FARM's data, not off the person's own identity. Refusing
    // an operator everywhere meant they could never reach `/account/security`
    // to change their own password — a lockdown that locks someone out of
    // their own credentials.
    //
    // The surface is derived from the request path with `personSurfaceOf`, the
    // SAME predicate the Edge gate uses, so the two enforcement points cannot
    // drift into disagreeing about what "social" means. An explicit
    // `opts.surface` overrides it for callers with no request (a server
    // component), and the default there is `account`: every social surface is
    // an API route and always has a request, so an unclassifiable call is an
    // account path — and the Edge already blocks operators from `/api/social/`
    // independently, which is what makes defaulting open here safe rather than
    // merely convenient.
    const surface = opts?.surface ?? (req ? personSurfaceOf(req.nextUrl.pathname) : 'account');
    if (surface === 'social' && (await isOperatorOnly(session.userId))) {
        // ALL-CAPS, which deliberately differs in CASE from the middleware's
        // `{ error: 'operator_scope' }`. Not cosmetic: the copy ratchet reads
        // `operator_scope` as two latin words and counts it as prose, while an
        // ALL-CAPS identifier is exempt as a code. The two responses are
        // different envelopes on different paths anyway — the Edge's bare
        // `{ error }` versus this handler's error payload — so a client has to
        // handle them separately regardless.
        throw forbidden('OPERATOR_SCOPE');
    }

    // userId only — there is no tenant to merge, and writing one here would put
    // a tenant on the log lines of a request that has none.
    mergeRequestContext({ userId: session.userId });

    return { requestId, userId: session.userId, email: session.email };
}

/**
 * True when the user holds at least one active membership and EVERY one of
 * them is MECHANISATOR.
 *
 * The `length > 0` half is not defensive clutter — `[].every(...)` is `true`,
 * so without it a user with NO memberships reads as operator-only. That user
 * is precisely who a person-scoped surface exists for: someone mid-onboarding
 * who has not joined a farm yet. Refusing them would break the surface for its
 * primary caller while every test with a seeded membership stayed green.
 */
async function isOperatorOnly(userId: string): Promise<boolean> {
    const memberships = await prisma.tenantMembership.findMany({
        where: { userId, status: 'ACTIVE', tenant: { deletedAt: null } },
        select: { role: true },
    });
    return memberships.length > 0 && memberships.every((m) => m.role === 'MECHANISATOR');
}

/**
 * Builds a RequestContext for legacy API routes that don't have tenantSlug in params.
 * Resolves tenant from the session JWT's tenantId field.
 *
 * This also performs a membership check that legacy routes previously skipped.
 */
export async function getLegacyCtx(req?: NextRequest): Promise<RequestContext> {
    // NO API-key auth here, deliberately. A legacy route has no `tenantSlug`
    // in its params, so there is nothing to compare the key's tenant against —
    // and an unchecked key context would silently REPLACE the session's tenant
    // and role (see tryApiKeyAuth for what that costs). If API-key auth is
    // ever enabled, a legacy route needs the session resolved FIRST so the
    // key can be checked against the session's tenant.

    const session = await getSessionOrThrow();
    const requestId = getRequestId(req);

    // Resolve tenant context from session's tenantId (verifies membership)
    const ctx = await resolveTenantContext({ tenantId: session.tenantId }, session.userId);

    // Enrich the observability context with tenant and user info
    mergeRequestContext({ tenantId: ctx.tenant.id, userId: session.userId });

    return {
        requestId,
        userId: session.userId,
        tenantId: ctx.tenant.id,
        tenantSlug: ctx.tenant.slug,
        role: ctx.role,
        permissions: ctx.permissions,
        appPermissions: ctx.appPermissions,
    };
}

// ─── Hub-and-spoke organization context (Epic O-2) ──────────────────

/**
 * Builds an `OrgContext` for organization-scoped routes
 * (`/api/org/[orgSlug]/*`).
 *
 * ## Anti-enumeration policy
 *
 * Both "this org slug doesn't exist" AND "you're authenticated but
 * not a member of this org" collapse to the SAME externally-visible
 * response: `notFound` with a generic message that does NOT echo
 * the slug. A non-member can therefore never enumerate which org
 * slugs exist by probing the API and watching for 403 vs 404.
 *
 * Mirrors `getOrgServerContext` (the page-side resolver) — same
 * collapse, same generic message — so the page tree and the API
 * tree expose identical signal to an attacker.
 *
 * Internal observability is preserved via a structured `org-ctx`
 * log line (level=warn) that distinguishes the two states with a
 * `reason` field (`org_not_found` vs `not_a_member`). Operators
 * reading the application logs see the real cause; external callers
 * only see 404.
 *
 * ## Resolution order
 *   1. Authenticate the user via the existing session helper. NOT API
 *      key — org-scoped routes are user-driven (CISO portfolio + admin
 *      operations); machine-to-machine API keys are tenant-scoped and
 *      have no place at the org layer.
 *   2. Look up the Organization row by slug.
 *   3. Look up the OrgMembership for (org, user).
 *   4. Pre-derive `permissions` via `getOrgPermissions(role)` so
 *      callers can read flags directly without an extra helper call.
 *
 * Steps 2 and 3 both throw the same `notFound` on failure. Internal
 * `logger.warn('org-ctx.access_denied', { reason })` distinguishes
 * the cause for operator diagnostics.
 *
 * Side effect: enriches the observability AsyncLocalStorage so logs
 * and traces emitted downstream automatically include `userId`.
 *
 * Failure shape (externally visible):
 *   - `unauthorized` (401) — no session
 *   - `badRequest`   (400) — missing/empty slug (caller-side bug, not
 *                            an enumeration vector — the slug is in
 *                            the URL path, so an empty value here
 *                            means the route never matched)
 *   - `notFound`     (404) — org slug doesn't exist OR user has no
 *                            membership; collapsed for anti-enumeration
 */
export async function getOrgCtx(
    params: { orgSlug: string },
    req?: NextRequest,
): Promise<OrgContext> {
    const session = await getSessionOrThrow();
    const requestId = getRequestId(req);

    const orgSlug = (params.orgSlug ?? '').trim();
    if (!orgSlug) {
        throw badRequest('Missing organization slug');
    }

    // Generic external message — same string for both "no such org"
    // and "not a member". The internal log line below carries the
    // real reason for ops diagnostics.
    const externalNotFound = () =>
        notFound('Organization not found or access not permitted');

    const org = await prisma.organization.findUnique({
        where: { slug: orgSlug },
        select: { id: true, slug: true },
    });
    if (!org) {
        logger.warn('org-ctx.access_denied', {
            component: 'org-ctx',
            reason: 'org_not_found',
            orgSlug,
            userId: session.userId,
            requestId,
        });
        throw externalNotFound();
    }

    const membership = await prisma.orgMembership.findUnique({
        where: {
            organizationId_userId: {
                organizationId: org.id,
                userId: session.userId,
            },
        },
        select: { role: true },
    });
    if (!membership) {
        logger.warn('org-ctx.access_denied', {
            component: 'org-ctx',
            reason: 'not_a_member',
            orgSlug,
            organizationId: org.id,
            userId: session.userId,
            requestId,
        });
        throw externalNotFound();
    }

    mergeRequestContext({ userId: session.userId });

    return {
        requestId,
        userId: session.userId,
        organizationId: org.id,
        orgSlug: org.slug,
        orgRole: membership.role,
        permissions: getOrgPermissions(membership.role),
    };
}

// ─── API Key Auth Helper ───

/**
 * Attempt to authenticate via API key from the Authorization header.
 * Returns a RequestContext if the bearer token is an API key and verification succeeds.
 * Returns null if the token is not an API key (allowing session auth fallback).
 * Throws unauthorized() if the token IS an API key but is invalid.
 */
async function tryApiKeyAuth(
    req: NextRequest,
    /**
     * The tenant slug from the ROUTE. Required, not optional: the context this
     * function returns REPLACES the session's, so without a comparison a
     * request to tenant A's URL executes against tenant B's data.
     */
    expectedTenantSlug: string,
): Promise<RequestContext | null> {
    // Disabled — see api-key-availability.ts. An `iflk_` bearer cannot reach
    // a handler anyway (the Edge refuses it first), so the only way in here is
    // a request carrying BOTH a valid session cookie and an API-key header.
    // That is not a machine client; it is a browser session whose context
    // would be silently swapped for the key's.
    if (!API_KEY_AUTH_ENABLED) return null;

    const authHeader = req.headers.get('authorization');
    const token = extractBearerToken(authHeader);

    // No token or not an API key format → fall through to session auth
    if (!token || !isApiKeyToken(token)) return null;

    // It IS an API key — must validate
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || null;

    const result = await verifyApiKey(token, clientIp);

    if (!result.valid) {
        throw unauthorized(`API key authentication failed: ${result.reason}`);
    }

    // The key's tenant must be the tenant in the URL.
    //
    // Without this, the returned context replaces the session's wholesale —
    // `tenantId`/`tenantSlug` become the KEY's, so `runInTenantContext` binds
    // RLS to a different tenant than the URL names and `logEvent` attributes
    // the write to the key's creator. The role is separately re-derived from
    // the key's SCOPES, so a user demoted to READER who kept an old `*` key
    // would get an ADMIN-permission context on every non-admin tenant route.
    if (result.ctx.tenantSlug !== expectedTenantSlug) {
        throw unauthorized('API key does not belong to this tenant');
    }

    // Override requestId from the header if available
    const requestId = getRequestId(req);
    result.ctx.requestId = requestId;

    // Enrich observability context
    mergeRequestContext({
        tenantId: result.ctx.tenantId,
        userId: result.ctx.userId,
    });

    return result.ctx;
}

