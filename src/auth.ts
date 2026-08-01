/**
 * Auth.js (NextAuth v4) configuration — single consolidated module.
 *
 * GAP-04 — migrated from `next-auth@5.0.0-beta.30` (where the auth
 * config was split into edge-safe `auth.config.ts` + node-only
 * `auth.ts`) to `next-auth@4.24.14` (stable). v4 doesn't need the
 * edge/node split because the middleware uses `getToken()` directly
 * rather than the v5 `auth()` async wrapper.
 *
 * Exports:
 *   - `authOptions` — the canonical config consumed by every server-
 *     side helper that needs the session (`getServerSession(authOptions)`)
 *     and by the catch-all route handler.
 *   - `auth` — back-compat alias for `() => getServerSession(authOptions)`
 *     so the migration doesn't churn the 15 server-component import
 *     sites in a single PR. The alias has the same return shape as
 *     v5's `auth()` (Session | null) but is sync-callable from server
 *     contexts. New code should call `getServerSession(authOptions)`
 *     directly.
 *
 * Architecture preserved from the v5-beta era:
 *   - JWT session strategy (no Session table writes).
 *   - PrismaAdapter for the Account-linking + User row lifecycle.
 *   - Three callbacks: signIn (account linking + invite redemption),
 *     jwt (MFA + session-tracking + token refresh + sessionVersion),
 *     session (selective field exposure to client).
 *   - Module augmentation in `next-auth` (Session.user) and
 *     `next-auth/jwt` (custom token fields) — eliminates the 8
 *     `as any` casts the v5-beta type drift required.
 */

import type { NextAuthOptions, Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import { getServerSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
// GAP-04 — v5 renamed `azure-ad` → `microsoft-entra-id` to track
// Microsoft's product rename. v4 still ships under the original name.
// Same provider, same OAuth endpoints, same scopes.
import AzureAD from 'next-auth/providers/azure-ad';
import { PrismaAdapter } from '@next-auth/prisma-adapter';
import prisma from '@/lib/prisma';
import { env } from '@/env';
import { authenticateWithPassword } from '@/lib/auth/credentials';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { isTokenExpired, refreshAccessToken } from '@/lib/auth/refresh';
import type { Role } from '@prisma/client';
import { edgeLogger } from '@/lib/observability/edge-logger';
import { hashForLookup } from '@/lib/security/encryption';
import { redeemPendingInvites } from '@/lib/auth/invite-redemption';

// ─── Type augmentation ──────────────────────────────────────────────
//
// GAP-04 — the v5-beta type instability that drove 8 `as any` casts
// across auth.ts/auth.config.ts/middleware.ts is resolved here by
// declaring both Session.user AND the JWT shape so middleware +
// server-component reads are typed end-to-end.

/**
 * Hard cap on how many membership entries are embedded in the JWT.
 *
 * A user in very many tenants/orgs would otherwise grow the session
 * cookie without bound — the JWT is a fixed-size credential, not a
 * data store. 50 is far above any realistic human workspace count, so
 * this is a safety valve rather than an everyday limit.
 *
 * When the real membership count exceeds this, the JWT carries the
 * first `MAX_JWT_MEMBERSHIPS` entries and `membershipsTruncated` /
 * `orgMembershipsTruncated` is set. The Edge middleware then defers a
 * slug-miss to the authoritative server-side gate (`TenantLayout` /
 * `getTenantCtx`, both DB-backed) instead of treating it as a
 * definitive cross-tenant denial. UI surfaces that need the COMPLETE
 * list (the `/tenants` picker) do their own server-side DB lookup.
 */
export const MAX_JWT_MEMBERSHIPS = 50;

/** One entry per active membership the user holds. */
export interface MembershipEntry {
    slug: string;
    role: Role;
    tenantId: string;
}

/**
 * One entry per active OrgMembership the user holds. Mirrors
 * `MembershipEntry` for the hub-and-spoke organization layer.
 * Threaded through the JWT so middleware can gate `/org/:slug/*`
 * routes against the user's org memberships in O(1) per request
 * with no DB hit — same pattern as the tenant access gate.
 */
export interface OrgMembershipEntry {
    slug: string;
    role: 'ORG_ADMIN' | 'ORG_READER';
    organizationId: string;
}

declare module 'next-auth' {
    interface Session {
        user: {
            id: string;
            email: string;
            name?: string | null;
            image?: string | null;
            tenantId?: string | null;
            role: Role;
            mfaPending?: boolean;
            /** T00 — persisted UI language preference ('en' | 'bg'). */
            uiLanguage: string;
            /** R-1: all active memberships, for the tenant picker and middleware gate. */
            memberships?: MembershipEntry[];
            /** Org-layer memberships, for the org-route middleware gate. */
            orgMemberships?: OrgMembershipEntry[];
        };
    }
}

declare module 'next-auth/jwt' {
    interface JWT {
        userId?: string;
        sessionVersion?: number;
        sessionVersionCheckedAt?: number;
        tenantId?: string | null;
        tenantSlug?: string | null;
        role?: Role;
        /** T00 — persisted UI language preference ('en' | 'bg'). */
        uiLanguage?: string;
        mfaPending?: boolean;
        mfaFailClosed?: boolean;
        /** Active tenant memberships, capped at MAX_JWT_MEMBERSHIPS. */
        memberships?: MembershipEntry[];
        /** Active org memberships, capped at MAX_JWT_MEMBERSHIPS. */
        orgMemberships?: OrgMembershipEntry[];
        /** True when `memberships` is a capped subset of the real set. */
        membershipsTruncated?: boolean;
        /** True when `orgMemberships` is a capped subset of the real set. */
        orgMembershipsTruncated?: boolean;
        /** Provider name when the user signed in via OAuth. */
        provider?: string;
        /** EI-1/EI-3 — telemetry flag: the groups claim overflowed (>200 groups)
         *  and was resolved via a Microsoft Graph `/me/memberOf` fetch instead.
         *  The resolved group list itself is consumed in-callback by EI-3's role
         *  sync and is deliberately NOT persisted on the token — an unbounded
         *  array of group GUIDs would bloat the JWT cookie (worst for the very
         *  overage population this flag marks) with no downstream reader. */
        aadGroupsOverage?: boolean;
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        /** Operational session row id (Epic C.3). */
        userSessionId?: string;
        /** Soft-error flag — surfaces `RefreshTokenError` / `SessionRevoked` / `MfaDependencyFailure`. */
        error?: string;
    }
}

/**
 * Load the user's tenant + org membership claims into the JWT from the
 * database.
 *
 * Runs at sign-in AND on an explicit `useSession().update()`
 * (trigger === 'update'). The Edge tenant-access gate authorizes slugs
 * straight from these claims with NO DB hit, so a membership the user
 * gains AFTER sign-in — a freshly-created tenant, an accepted invite,
 * org auto-provisioning — is invisible to the gate until these claims
 * are refreshed. Without the update-trigger refresh the only way to
 * pick up a new membership is a full re-login. This is the single
 * source of truth for those claims; the sign-in path and the
 * update-trigger path both call it so they can never drift.
 *
 * `fallbackUserId` is consulted only when the email→User lookup misses
 * (a defensive sign-in edge case before the adapter commits the row);
 * on an update the user always exists so the lookup succeeds.
 */
async function applyMembershipClaims(
    token: JWT,
    fallbackUserId?: string,
): Promise<void> {
    const dbUser = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(token.email!) },
        include: {
            tenantMemberships: {
                // Exclude soft-deleted (org-removed) tenants so they
                // never enter the JWT fast-path / tenant switcher.
                where: { status: 'ACTIVE', tenant: { deletedAt: null } },
                orderBy: { createdAt: 'asc' },
                include: { tenant: { select: { slug: true, id: true } } },
            },
            orgMemberships: {
                orderBy: { createdAt: 'asc' },
                include: { organization: { select: { slug: true, id: true } } },
            },
        },
    });

    if (dbUser) {
        token.userId = dbUser.id;
        token.sessionVersion = dbUser.sessionVersion;
        // T00 — persisted UI language preference. The `include` query
        // returns every scalar column, so `uiLanguage` is present.
        token.uiLanguage = dbUser.uiLanguage ?? DEFAULT_LOCALE;

        // Active tenant memberships, capped at MAX_JWT_MEMBERSHIPS so the
        // cookie stays bounded; `membershipsTruncated` flags the rare
        // over-cap case for the middleware gate.
        token.memberships = dbUser.tenantMemberships
            .slice(0, MAX_JWT_MEMBERSHIPS)
            .map((m) => ({
                slug: m.tenant.slug,
                role: m.role,
                tenantId: m.tenantId,
            }));
        token.membershipsTruncated =
            dbUser.tenantMemberships.length > MAX_JWT_MEMBERSHIPS;

        // Same pattern (and cap) for the org layer so the middleware can
        // gate `/org/:slug/*` with no DB hit.
        token.orgMemberships = dbUser.orgMemberships
            .slice(0, MAX_JWT_MEMBERSHIPS)
            .map((m) => ({
                slug: m.organization.slug,
                role: m.role,
                organizationId: m.organizationId,
            }));
        token.orgMembershipsTruncated =
            dbUser.orgMemberships.length > MAX_JWT_MEMBERSHIPS;

        // Backward-compat: keep tenantId/tenantSlug/role as the "primary"
        // membership (oldest by createdAt).
        const primary = token.memberships[0];
        if (primary) {
            token.tenantId = primary.tenantId;
            token.tenantSlug = primary.slug;
            token.role = primary.role;
        } else {
            token.tenantId = null;
            token.tenantSlug = null;
            token.role = 'READER';
        }
    } else {
        token.userId = fallbackUserId ?? token.userId;
        token.role = 'READER';
        token.uiLanguage = token.uiLanguage ?? DEFAULT_LOCALE;
        token.sessionVersion = 0;
        token.memberships = [];
        token.orgMemberships = [];
        token.membershipsTruncated = false;
        token.orgMembershipsTruncated = false;
    }
}

// ─── Providers ──────────────────────────────────────────────────────
//
// Edge-safe providers (Google, MicrosoftEntraID) used to live in a
// separate `auth.config.ts` because v5's middleware-side `auth()`
// wrapper bundled the full config into the Edge runtime. v4's
// middleware uses `getToken()` directly, which only verifies the JWT
// cookie — providers are never bundled into the Edge bundle. So the
// split is no longer required.

const providers: NextAuthOptions['providers'] = [
    Google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        authorization: {
            params: {
                access_type: 'offline',
                prompt: 'consent',
                scope: 'openid email profile',
            },
        },
    }),
    AzureAD({
        // Pin the provider id to `microsoft-entra-id`. The v4 package
        // `next-auth/providers/azure-ad` defaults its id to `azure-ad`,
        // but the rest of the app keys off `microsoft-entra-id` — the
        // login button (`signIn('microsoft-entra-id')`), the
        // token-refresh switch in `src/lib/auth/refresh.ts`, and the
        // security-event method union. Without this override the
        // Microsoft button hits an unregistered provider and the
        // refresh path never matches. Callback URL is therefore
        // `/api/auth/callback/microsoft-entra-id`.
        id: 'microsoft-entra-id',
        name: 'Microsoft',
        clientId: env.MICROSOFT_CLIENT_ID,
        clientSecret: env.MICROSOFT_CLIENT_SECRET,
        tenantId: env.MICROSOFT_TENANT_ID,
        authorization: {
            params: {
                // EI-1 — `GroupMember.Read.All` lets the >200-group overage path
                // call Graph `/me/memberOf` with the issued access token. The
                // `groups` ID-token claim itself is governed by the tenant's App
                // Registration Token Configuration (set by the tenant admin),
                // not by this scope.
                scope: 'openid email profile offline_access https://graph.microsoft.com/GroupMember.Read.All',
            },
        },
    }),
    // Credentials — production-grade email+password auth.
    //
    // The hardened path lives in `src/lib/auth/credentials.ts`
    // (account-enumeration-safe, timing-equalised, email-verification-
    // gate-ready, silent-rehash-on-verify). The provider is always
    // registered; whether the login UI shows the email/password *form*
    // is a separate decision made in `src/app/login/page.tsx` based on
    // `getProviders()`.
    Credentials({
        id: 'credentials',
        name: 'Email and password',
        credentials: {
            email: { label: 'Email', type: 'email' },
            password: { label: 'Password', type: 'password' },
        },
        async authorize(credentials) {
            const result = await authenticateWithPassword({
                email: (credentials?.email as string | undefined) ?? '',
                password: (credentials?.password as string | undefined) ?? '',
            });
            // NextAuth surfaces any non-null return as a successful sign-in
            // and dispatches the `signIn` + `jwt` callbacks. Returning null
            // collapses every failure reason into the same client-facing
            // `CredentialsSignin` error — the account-enumeration-safe shape.
            if (!result.ok) {
                // ONE reason is surfaced: the only one the user can act
                // on. It is reachable only AFTER the password verified
                // (credentials.ts:300 → :320), so it tells an attacker
                // nothing they did not already know, and the login page
                // can point the user at the resend-verification form
                // instead of claiming their password is wrong.
                //
                // Everything else — unknown email, wrong password, rate
                // limited — stays collapsed into NextAuth's generic
                // CredentialsSignin, which is the account-enumeration-safe
                // shape. Do not add reasons here without re-reading that
                // argument.
                if (result.reason === 'email_not_verified') {
                    throw new Error('EmailNotVerified');
                }
                return null;
            }
            return {
                id: result.userId,
                email: result.email,
                name: result.name,
            };
        },
    }),
];

// ─── Invite-redemption helpers ──────────────────────────────────────
//
// Sign-in alone grants AUTHENTICATION; tenant membership is created
// ONLY via redemption of a token-bound invite (Epic 1, GAP-01 closure).
//
// The redemption itself lives in `@/lib/auth/invite-redemption`
// (`redeemPendingInvites`) and runs from the `jwt` callback, NOT here in
// `signIn`. Reason: a first-time OAuth user's `signIn` `user.id` is the
// identity-provider subject, not our `User.id` (the adapter creates the
// row only after `signIn` returns) — redeeming there wrote a membership
// against a non-existent `User` FK and stranded the invitee on
// `/no-tenant`. `redeemPendingInvites` resolves the persisted id by email
// from the jwt callback, which fires after the row exists.

async function readInviteTokenFromCookies(): Promise<{
    tenantToken: string | null;
    orgToken: string | null;
}> {
    try {
        // GAP-05 — Next 15 made `cookies()` async (Promise<ReadonlyCookies>).
        const { cookies } = await import('next/headers');
        const cookieStore = await cookies();
        return {
            tenantToken: cookieStore.get('inflect_invite_token')?.value ?? null,
            orgToken: cookieStore.get('inflect_org_invite_token')?.value ?? null,
        };
    } catch {
        return { tenantToken: null, orgToken: null };
    }
}

// ─── NextAuthOptions ────────────────────────────────────────────────

export const authOptions: NextAuthOptions = {
    adapter: PrismaAdapter(prisma) as NextAuthOptions['adapter'],
    providers,
    pages: {
        signIn: '/login',
        error: '/login',
    },
    session: { strategy: 'jwt' },
    secret: env.AUTH_SECRET,
    callbacks: {
        /**
         * signIn — runs on EVERY sign-in attempt. One responsibility:
         *
         *   Account linking: if the OAuth email matches a User row
         *   created by a different provider, link the new OAuth
         *   `Account` to the existing User rather than creating a
         *   duplicate.
         *
         * Invite redemption is DELIBERATELY not done here — a first-time
         * OAuth user's `user.id` in this callback is the identity-provider
         * subject, not our `User.id` (the adapter persists the row only
         * after `signIn` returns). It runs in the `jwt` callback via
         * `redeemPendingInvites`, which resolves the real id by email.
         *
         * Sign-in alone grants AUTHENTICATION, not tenant or org
         * membership. There is NO auto-join behaviour — see
         * `tests/guardrails/no-auto-join.test.ts`.
         */
        async signIn({ user, account, profile }) {
            if (!account) return true;

            // R-3: defensive email-verified check for OAuth.
            if (
                account.provider !== 'credentials' &&
                profile &&
                'email_verified' in profile &&
                profile.email_verified === false
            ) {
                edgeLogger.warn('signIn rejected: provider reported email_verified=false', {
                    component: 'auth',
                    provider: account.provider,
                    email: user.email ?? undefined,
                });
                return false;
            }

            // 1. Account linking for OAuth (not credentials).
            if (account.provider !== 'credentials' && user.email) {
                const existingUser = await prisma.user.findUnique({
                    where: { emailHash: hashForLookup(user.email) },
                });

                if (existingUser && user.id !== existingUser.id) {
                    const existingAccount = await prisma.account.findUnique({
                        where: {
                            provider_providerAccountId: {
                                provider: account.provider,
                                providerAccountId: account.providerAccountId,
                            },
                        },
                    });

                    if (!existingAccount) {
                        await prisma.account.create({
                            data: {
                                userId: existingUser.id,
                                type: account.type,
                                provider: account.provider,
                                providerAccountId: account.providerAccountId,
                                refresh_token: (account.refresh_token as string) ?? null,
                                access_token: (account.access_token as string) ?? null,
                                expires_at: (account.expires_at as number) ?? null,
                                token_type: (account.token_type as string) ?? null,
                                scope: (account.scope as string) ?? null,
                                id_token: (account.id_token as string) ?? null,
                                session_state: (account.session_state as string) ?? null,
                            },
                        });
                    }
                    // Invite redemption is NOT done here — a first-time
                    // OAuth user's `user.id` is the provider subject, not
                    // our User.id. It runs in the jwt callback below, which
                    // fires after the adapter has persisted the row.
                    return true;
                }
            }

            return true;
        },

        /**
         * jwt — enrich the token with custom fields, handle OAuth
         * token refresh, and gate MFA + sessionVersion + Epic C.3
         * session tracking.
         */
        async jwt({ token, user, account, profile, trigger }) {
            // Initial sign in.
            if (account && user) {
                // Redeem any pending invite BEFORE reading membership
                // claims, using the PERSISTED User.id resolved by email.
                // The adapter has created the row by now, so a first-time
                // OAuth invitee (whose signIn `user.id` was the provider
                // subject, not our User.id) gets their membership — and
                // applyMembershipClaims below reflects it in the token on
                // this same sign-in, so they land straight in the tenant.
                const inviteEmail = token.email ?? user.email ?? null;
                if (inviteEmail) {
                    const inviteTokens = await readInviteTokenFromCookies();
                    await redeemPendingInvites({
                        userEmail: inviteEmail,
                        tenantToken: inviteTokens.tenantToken,
                        orgToken: inviteTokens.orgToken,
                    });
                }

                await applyMembershipClaims(token, user.id);

                if (account.provider !== 'credentials') {
                    token.provider = account.provider;
                    token.accessToken = (account.access_token as string) ?? undefined;
                    token.refreshToken = (account.refresh_token as string) ?? undefined;
                    token.expiresAt = (account.expires_at as number) ?? undefined;
                }

                // ── EI-1 — extract AAD security-group membership from the ID
                //    token so the Epic EI-2 mapper has the raw group list. The
                //    `groups` claim is omitted for users in > ~200 groups
                //    (Entra sets `_claim_names.groups` instead) — fall back to
                //    a Graph `/me/memberOf` fetch in that overage case. A Graph
                //    failure resolves to [] and never blocks sign-in.
                if (account.provider === 'microsoft-entra-id') {
                    const { resolveEntraGroupClaims } = await import(
                        '@/lib/auth/entra-group-claims'
                    );
                    const { groups, overage } = await resolveEntraGroupClaims({
                        profile,
                        accessToken: account.access_token as string | undefined,
                    });
                    // The resolved `groups` are consumed in-callback by EI-3's
                    // role sync (below) — NOT persisted on the token: an
                    // unbounded array of group GUIDs would bloat the JWT cookie
                    // for the overage population with no downstream reader. Only
                    // the bounded overage flag rides along.
                    token.aadGroupsOverage = overage;

                    // ── EI-3 — sync the active-tenant membership role from the
                    //    tenant's group → role mappings, and enforce the group
                    //    gate. Scoped to the primary tenant (the session's
                    //    active tenant). A failure here must never block
                    //    sign-in, so it's best-effort.
                    if (token.tenantId && token.userId) {
                        try {
                            const { syncEntraMembershipRole, applyEntraSyncToToken } =
                                await import('@/lib/auth/entra-group-sync');
                            const activeTenantId = token.tenantId;
                            const result = await syncEntraMembershipRole({
                                userId: token.userId,
                                tenantId: activeTenantId,
                                aadGroups: groups,
                            });
                            applyEntraSyncToToken(token, activeTenantId, result);
                        } catch (err) {
                            edgeLogger.error('Entra group role-sync failed', {
                                component: 'entra',
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                    }
                }

                // ── MFA enforcement ──
                token.mfaPending = false;
                const activeTenantId = token.tenantId ?? null;
                if (activeTenantId) {
                    try {
                        const secSettings = await prisma.tenantSecuritySettings.findUnique({
                            where: { tenantId: activeTenantId },
                        });
                        const policy = secSettings?.mfaPolicy ?? 'DISABLED';
                        const failClosed = secSettings?.mfaFailClosed ?? false;
                        token.mfaFailClosed = failClosed;

                        if (policy === 'REQUIRED' || policy === 'OPTIONAL') {
                            const enrollment = await prisma.userMfaEnrollment.findUnique({
                                where: {
                                    userId_tenantId_type: {
                                        userId: token.userId!,
                                        tenantId: activeTenantId,
                                        type: 'TOTP',
                                    },
                                },
                            });

                            if (policy === 'REQUIRED') {
                                token.mfaPending = true;
                            } else if (policy === 'OPTIONAL' && enrollment?.isVerified) {
                                token.mfaPending = true;
                            }
                        }
                    } catch {
                        if (token.mfaFailClosed) {
                            token.mfaPending = true;
                            token.error = 'MfaDependencyFailure';
                        }
                    }
                }

                // ── Epic C.3 — record operational session row ──
                try {
                    const { recordNewSession } = await import(
                        '@/lib/security/session-tracker'
                    );
                    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
                    const recorded = await recordNewSession({
                        userId: token.userId!,
                        tenantId: token.tenantId ?? null,
                        expiresAt: new Date(Date.now() + THIRTY_DAYS_MS),
                    });
                    token.userSessionId = recorded.sessionId;
                } catch {
                    // Already swallowed in the helper.
                }

                return token;
            }

            // ── Subsequent requests ──

            // Explicit client-side session refresh (`useSession().update()`).
            // Re-reads the membership claims so a tenant the user gained
            // after sign-in — e.g. one they just created (OWNER) or were
            // invited / auto-provisioned into — becomes visible to the Edge
            // gate immediately, with no full re-login. Falls through to the
            // session-revocation + OAuth-refresh checks below.
            if (trigger === 'update' && token.email) {
                await applyMembershipClaims(token);
            }

            // Epic C.3 — verify session row still exists + isn't revoked.
            if (typeof token.userSessionId === 'string' && token.userSessionId) {
                try {
                    const { verifyAndTouchSession } = await import(
                        '@/lib/security/session-tracker'
                    );
                    const result = await verifyAndTouchSession(
                        token.userSessionId,
                    );
                    if (result.revoked) {
                        return { ...token, error: 'SessionRevoked' };
                    }
                } catch {
                    // Helper already logs; fail-open on telemetry-side
                    // failures so a transient DB blip doesn't sign every
                    // user out.
                }
            }

            // OAuth token refresh.
            if (
                token.provider &&
                token.expiresAt &&
                token.refreshToken &&
                isTokenExpired(token.expiresAt)
            ) {
                try {
                    const refreshed = await refreshAccessToken(
                        token.provider,
                        token.refreshToken,
                    );

                    token.accessToken = refreshed.accessToken;
                    token.expiresAt = refreshed.expiresAt;
                    if (refreshed.refreshToken) {
                        token.refreshToken = refreshed.refreshToken;
                    }
                    delete token.error;

                    await prisma.account.updateMany({
                        where: {
                            userId: token.userId!,
                            provider: token.provider,
                        },
                        data: {
                            access_token: refreshed.accessToken,
                            expires_at: refreshed.expiresAt,
                            ...(refreshed.refreshToken
                                ? { refresh_token: refreshed.refreshToken }
                                : {}),
                        },
                    });
                } catch {
                    edgeLogger.error('Token refresh failed, forcing reauth', { component: 'auth' });
                    token.error = 'RefreshTokenError';
                }
            }

            // MFA challenge completion check.
            if (token.mfaPending === true && token.userId && token.tenantId) {
                try {
                    const enrollment = await prisma.userMfaEnrollment.findUnique({
                        where: {
                            userId_tenantId_type: {
                                userId: token.userId,
                                tenantId: token.tenantId,
                                type: 'TOTP',
                            },
                        },
                        select: { lastChallengeAt: true, isVerified: true },
                    });

                    if (enrollment?.lastChallengeAt) {
                        const tokenIat = (token.iat as number | undefined) ?? 0;
                        const challengeTime = Math.floor(enrollment.lastChallengeAt.getTime() / 1000);
                        if (challengeTime >= tokenIat) {
                            token.mfaPending = false;
                        }
                    }
                } catch {
                    if (token.mfaFailClosed) {
                        token.error = 'MfaDependencyFailure';
                    } else {
                        token.mfaPending = false;
                    }
                }
            }

            // Throttled sessionVersion check (5-minute interval).
            if (typeof token.sessionVersion === 'number' && token.userId) {
                const SESSION_CHECK_INTERVAL = 300; // seconds
                const now = Math.floor(Date.now() / 1000);
                const lastChecked = token.sessionVersionCheckedAt ?? 0;
                if (now - lastChecked >= SESSION_CHECK_INTERVAL) {
                    try {
                        const currentUser = await prisma.user.findUnique({
                            where: { id: token.userId },
                            select: { sessionVersion: true },
                        });
                        if (currentUser && currentUser.sessionVersion > token.sessionVersion) {
                            return { ...token, error: 'SessionRevoked' };
                        }
                        token.sessionVersionCheckedAt = now;
                    } catch {
                        // Fail open on telemetry-side failures.
                    }
                }
            }

            return token;
        },

        /**
         * session — expose ONLY safe fields to the client.
         * NEVER include accessToken or refreshToken.
         */
        async session({ session, token }) {
            if (token) {
                session.user.id = token.userId ?? token.sub!;
                session.user.tenantId = token.tenantId ?? null;
                session.user.role = token.role ?? 'READER';
                session.user.uiLanguage = token.uiLanguage ?? DEFAULT_LOCALE;
                session.user.mfaPending = token.mfaPending ?? false;
                session.user.memberships = token.memberships ?? [];
                session.user.orgMemberships = token.orgMemberships ?? [];
            }
            return session;
        },
    },
};

// ─── Server-side session helper ─────────────────────────────────────
//
// Back-compat alias for v5's `auth()` so the 15+ server-component
// import sites don't all need to update in this PR. The name + return
// shape match v5: `Session | null`. Internally it calls v4's
// `getServerSession(authOptions)`.
//
// New code should call `getServerSession(authOptions)` directly to
// make the dependency explicit at each call site.

export async function auth(): Promise<Session | null> {
    return getServerSession(authOptions);
}

// Re-export `getServerSession` for ergonomics.
export { getServerSession };

// ─── Server-side signOut shim ───────────────────────────────────────
//
// v5 exported a server-side `signOut()` from the NextAuth() return.
// v4 does not — sign-out is a client-side `next-auth/react` flow OR a
// direct DELETE of the session cookie. The two server components that
// call `signOut()` (no-tenant page, tenant-picker page) use it to log
// the user out before showing a "you don't have access" UI. We
// preserve that behavior by providing a thin server-side helper that
// redirects to the canonical NextAuth signout page.
//
// Returns a redirect Response that the page should `return`.
export async function signOut(options?: {
    redirectTo?: string;
}): Promise<void> {
    const { redirect } = await import('next/navigation');
    const target = options?.redirectTo ?? '/login';
    // NextAuth's signout endpoint clears the cookie and then redirects
    // to `callbackUrl`. Hitting it from a server component this way
    // matches the v5 behavior — the user lands at `target` with no
    // active session. `redirect()` throws and never returns.
    redirect(`/api/auth/signout?callbackUrl=${encodeURIComponent(target)}`);
}
