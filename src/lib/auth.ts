/**
 * Auth utilities for Agrent.
 *
 * This module bridges Auth.js v5 sessions to the existing API route
 * interface (getSession, getSessionOrThrow, requireRole, etc.).
 *
 * Role hierarchy (Chunk 1):
 *   ADMIN > EDITOR > READER
 *   AUDITOR is a special role with read-only + audit access.
 *
 * TenantMembership is now authoritative for role assignment.
 * User.role and User.tenantId are deprecated backward-compat fields.
 */
import { auth } from '@/auth';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import prisma from './prisma';
import type { Role, User } from '@prisma/client';
import { env } from '@/env';
import { unauthorized, forbidden, codedForbidden } from '@/lib/errors/types';
import { isAccountSuspended } from '@/lib/auth/suspension';

export interface JwtPayload {
    userId: string;
    tenantId: string;
    email: string;
    role: Role;
    /**
     * True while the session has authenticated but not yet cleared its second
     * factor. Carried through from the Auth.js session because `getSession`
     * narrows it away otherwise, and `getUserCtx` must refuse on it: the
     * middleware's MFA gate is scoped to `isTenantPath(pathname)`, so it does
     * NOT cover person-scoped paths like `/api/me/` or `/account/`. Until P1.6
     * adds that parity, this field is the only thing standing between a
     * half-authenticated session and a person's own data.
     *
     * Undefined on the legacy-cookie path, which predates MFA entirely — the
     * same value the middleware reads there, so the two agree.
     */
    /**
     * The person's interface language, as the session carries it (#1677).
     *
     * Carried through for the same reason `mfaPending` is: `getSession`
     * narrows the Auth.js session and would otherwise drop it, and the
     * narrowed shape is what every handler sees. The token already holds it
     * (`auth.ts` sets `token.uiLanguage` from the `User` row), so this is
     * plumbing rather than a new read — there is no extra query.
     *
     * RAW, not resolved. `auth.ts` writes `token.uiLanguage ?? DEFAULT_LOCALE`
     * and `DEFAULT_LOCALE` is `'en'` — correct for an UNAUTHENTICATED surface
     * and wrong for a known person, whose `User.uiLanguage` column defaults to
     * `'bg'`. Handing English to a Bulgarian farmer whose claim merely failed
     * to load is the #686 mistake, so resolution happens at the point of use
     * (`resolveRequestLocale`), which falls back to `bg`.
     */
    uiLanguage?: string;
    mfaPending?: boolean;
    /**
     * Tenant IDs that owe a second factor this session has not presented.
     *
     * `mfaPending` above is ONE boolean, and the sign-in path computed it
     * against the session's PRIMARY tenant — while the policy is per farm. So
     * a member of farm A (MFA off, primary) and farm B (REQUIRED) arrived with
     * "nothing owed" and read B's data without B's factor. `getTenantCtx`
     * tests this list for its own tenant instead.
     *
     * Undefined on a session minted before this existed, and on the
     * legacy-cookie path. Both fall back to `mfaPending`, which holds the
     * primary tenant exactly as it always did — an old cookie loses the
     * per-tenant precision, not the gate.
     */
    mfaPendingTenantIds?: string[];
    /**
     * True when `memberships` hit `MAX_JWT_MEMBERSHIPS`, so the list above is
     * INCOMPLETE and a missing tenant cannot be read as "nothing owed".
     */
    membershipsTruncated?: boolean;
}

// Legacy JWT secret — used only for reading old cookies during migration
const LEGACY_JWT_SECRET = env.JWT_SECRET;

/**
 * Get the current session by:
 * 1. Trying Auth.js session first
 * 2. Falling back to legacy JWT cookie for migration
 *
 * tenantId and role are resolved from TenantMembership (default membership).
 */
export async function getSession(): Promise<JwtPayload | null> {
    // 1. Try Auth.js session
    const session = await auth();
    if (session?.user) {
        return {
            userId: session.user.id,
            tenantId: session.user.tenantId ?? '',
            email: session.user.email ?? '',
            role: session.user.role ?? 'READER',
            uiLanguage: session.user.uiLanguage,
            mfaPending: session.user.mfaPending,
            mfaPendingTenantIds: session.user.mfaPendingTenantIds,
            membershipsTruncated: session.user.membershipsTruncated,
        };
    }

    // 2. Legacy fallback: check for old 'token' cookie
    if (LEGACY_JWT_SECRET) {
        try {
            const cookieStore = await cookies();
            const legacyToken = cookieStore.get('token')?.value;
            if (legacyToken) {
                const decoded = jwt.verify(legacyToken, LEGACY_JWT_SECRET) as {
                    userId: string;
                    tenantId: string;
                    email: string;
                    role: Role;
                };
                return {
                    userId: decoded.userId,
                    tenantId: decoded.tenantId,
                    email: decoded.email,
                    role: decoded.role,
                };
            }
        } catch {
            // Legacy token invalid — ignore
        }
    }

    return null;
}

/**
 * The session, or a refusal.
 *
 * ## Why the suspension check is HERE and nowhere else
 *
 * This is the one function every authenticated route reaches: all three context
 * resolvers (`getTenantCtx`, `getUserCtx`, `getLegacyCtx`) call it, and
 * `getSession` goes through `auth()` — which tries the cookie first and falls
 * back to a bearer principal — so one check covers both credential types with
 * no second, looser path to keep in sync. That is the same argument
 * `src/middleware.ts` makes for being the only reader of `token.error`.
 *
 * It cannot be in middleware, which is where "within one request" would
 * naturally live: middleware runs on the EDGE, and the Edge has neither Prisma
 * nor ioredis in this deployment. See `@/lib/auth/suspension` for that in full.
 *
 * ## Why a distinct code rather than `unauthorized()`
 *
 * `ACCOUNT_SUSPENDED` is a 403 with its own code, following the
 * `PAST_DUE_RESTRICTED` convention (#1388/#1405): a suspended person must be
 * told their account was suspended, not that they lack permission or that they
 * are signed out. Collapsing it into the 401 above would send them to a login
 * page that signs them straight back in and refuses again, with nothing naming
 * the cause.
 *
 * No English prose rides along — `no-server-authored-user-copy` holds thrown
 * sentences on a downward ratchet, and the client renders the code.
 */
export async function getSessionOrThrow(opts?: {
    /**
     * Resolve the session WITHOUT refusing a suspended account.
     *
     * Owner ruling on #1667: a terminated person may cancel the 30-day
     * erasure. `ACCOUNT_TERMINATED` sets `suspendedAt` as well as
     * `deletionRequestedAt`, so the one route they need is the one this check
     * was refusing — `DELETE /api/account/deletion` answered 403 while
     * agrent-ios's recovery screen (#282, installed) offered the button.
     *
     * **A way out must never be gated on the condition it escapes.** That is
     * P5.5a's rule for slow mode, where an unverified account throttled on the
     * route that verifies it cannot get out, and
     * `tests/guards/slow-mode-escape-is-not-throttled.test.ts` pins it. The
     * same shape, with the same remedy: one named exception and a guard
     * holding the count.
     *
     * It is narrow by construction rather than by promise. The caller still
     * needs a valid session, and `cancelAccountDeletion` touches one column on
     * the CALLER's own row. Nothing here widens what a suspended account can
     * read.
     */
    allowSuspended?: boolean;
}): Promise<JwtPayload> {
    const session = await getSession();
    if (!session) throw unauthorized();

    // Checked on every request that does not explicitly opt out, deliberately
    // unthrottled: this is the signal P5.9 exists to make immediate.
    // `isAccountSuspended` absorbs the cost in Redis and fails closed only
    // where failing closed is free — a request that cannot read this row
    // cannot do its own work either.
    if (
        !opts?.allowSuspended &&
        session.userId &&
        (await isAccountSuspended(session.userId))
    ) {
        // #1677 — the fallback was the CODE itself. `ACCOUNT_SUSPENDED` is
        // entried, so `localizeErrorPayload` replaces this before a reader
        // sees it; this string is reachable only when localisation fails,
        // which that function swallows by design. A token is the worst
        // thing to leave on the one path nobody watches.
        throw codedForbidden('ACCOUNT_SUSPENDED', 'Your account is suspended.');
    }

    return session;
}

export async function getCurrentUser(): Promise<User | null> {
    const session = await getSession();
    if (!session) return null;
    return prisma.user.findUnique({ where: { id: session.userId } });
}

// ─── RBAC helpers (Chunk 1: unified roles) ───

/**
 * Linear hierarchy for standard roles.
 * AUDITOR is sidecar — not in the linear chain.
 */
const ROLE_HIERARCHY: Record<Role, number> = {
    OWNER: 5,
    ADMIN: 4,
    EDITOR: 3,
    AUDITOR: 2,
    READER: 1,
    // Lowest privilege — a read-only operator persona (see permissions.ts).
    MECHANISATOR: 1,
};

export function hasMinRole(userRole: Role, minRole: Role): boolean {
    return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minRole];
}

// ─── Permission-based helpers ───

/**
 * Can read tenant/scope data (all roles).
 *
 * Epic 1 — OWNER is strictly superior to ADMIN per CLAUDE.md's RBAC
 * section. These five legacy helpers each include OWNER explicitly
 * because OWNER is the canonical role for every tenant created via
 * `createTenantWithOwner` (and every seed tenant after the GAP-07
 * step-6 alignment). The modern `requirePermission(<key>, ...)` path
 * via `PermissionSet` already treats OWNER correctly (see
 * `src/lib/permissions.ts::getPermissionsForRole`); these helpers
 * are the legacy path used by policies + a few admin-style routes.
 */
export function canRead(role: Role): boolean {
    // MECHANISATOR is read-only at the coarse tier so its own task data
    // loads; it's confined to the "My work" screen by the route lockdown.
    return ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'MECHANISATOR'].includes(role);
}

/** Can write/mutate data (OWNER, ADMIN, EDITOR) */
export function canWrite(role: Role): boolean {
    return ['OWNER', 'ADMIN', 'EDITOR'].includes(role);
}

/** Can perform admin operations (OWNER, ADMIN) */
export function canAdmin(role: Role): boolean {
    return role === 'OWNER' || role === 'ADMIN';
}

/** Can perform audit-specific operations (OWNER, ADMIN, AUDITOR) */
export function canAudit(role: Role): boolean {
    return ['OWNER', 'ADMIN', 'AUDITOR'].includes(role);
}

/** Can export data (OWNER, ADMIN, EDITOR, AUDITOR) */
export function canExport(role: Role): boolean {
    return ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR'].includes(role);
}

/** Can edit data — alias for canWrite for backward compat */
export function canEdit(role: Role): boolean {
    return canWrite(role);
}

export function requireRole(session: JwtPayload, minRole: Role): void {
    if (!hasMinRole(session.role, minRole)) {
        throw forbidden('Forbidden: insufficient permissions');
    }
}

// ─── Membership-based role checks ───

/**
 * Check if a user has a specific role (or higher) on a tenant.
 * Resolves from TenantMembership table.
 */
export async function hasTenantRole(
    userId: string,
    tenantId: string,
    requiredRole: Role
): Promise<boolean> {
    const membership = await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
    });
    if (!membership) return false;
    return hasMinRole(membership.role, requiredRole);
}

// ─── Legacy helpers kept for backward compatibility ───

// Same ESM/CJS interop normalisation as src/lib/auth/passwords.ts.
// Without it, Node ≥ 22 returns the namespace with bcryptjs's exports
// under `.default`, and `bcrypt.compare` is undefined.
async function loadBcrypt(): Promise<typeof import('bcryptjs')> {
    const m = await import('bcryptjs');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ns: any = m;
    return (ns.default ?? ns) as typeof import('bcryptjs');
}

export async function hashPassword(password: string): Promise<string> {
    const bcrypt = await loadBcrypt();
    return bcrypt.hash(password, 12);
}

export async function verifyPassword(
    password: string,
    hash: string
): Promise<boolean> {
    const bcrypt = await loadBcrypt();
    return bcrypt.compare(password, hash);
}

/**
 * @deprecated Legacy pre-NextAuth helper. Today's only caller is
 * the retired `src/app/api/auth/register/route.ts` (#1376), which minted the legacy
 * `token` cookie alongside the canonical NextAuth session cookie.
 *
 * The corresponding `verifyToken` has **zero consumers** in the
 * codebase, so the cookie is never validated server-side. The
 * mint/clear pair stays for one more release in case an external
 * integration depends on the cookie shape; both will be removed
 * next release together with `LEGACY_JWT_SECRET`. See
 * `docs/auth.md` → "Legacy `token` cookie — deprecated".
 */
export function signToken(payload: JwtPayload): string {
    if (!LEGACY_JWT_SECRET) {
        throw new Error('JWT_SECRET not set — legacy token signing disabled');
    }
    return jwt.sign(payload, LEGACY_JWT_SECRET, { expiresIn: '7d' });
}

/**
 * @deprecated Companion to {@link signToken}. Currently has no
 * call sites — kept exported for the deprecation window only.
 * See the `@deprecated` block on `signToken` above.
 */
export function verifyToken(token: string): JwtPayload | null {
    if (!LEGACY_JWT_SECRET) return null;
    try {
        return jwt.verify(token, LEGACY_JWT_SECRET) as JwtPayload;
    } catch {
        return null;
    }
}
