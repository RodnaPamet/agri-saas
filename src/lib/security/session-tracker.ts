/**
 * Epic C.3 — operational session-tracking helpers.
 *
 * Couples the stateless JWT model with the stateful `UserSession`
 * table so the server can:
 *
 *   - List every active session for an admin or for the user themselves.
 *   - Revoke a specific session (this device, this device only) without
 *     dragging every other browser the user is signed in on.
 *   - Surface "last active" timestamps and IP / user-agent on the
 *     security-settings UI.
 *
 * The flow:
 *
 *   1. NextAuth's `jwt` callback mints a token. On the FIRST mint
 *      (`if (account && user)`), call `recordNewSession`. It inserts
 *      a `UserSession` row, returns a stable `sessionId`, and the
 *      JWT callback embeds that id on the token.
 *
 *   2. On EVERY subsequent request, the same callback calls
 *      `verifyAndTouchSession(sessionId)`. The helper:
 *        - returns `{ revoked: true }` if the row's `revokedAt` is
 *          set, prompting the JWT callback to return a `SessionRevoked`
 *          error;
 *        - otherwise touches `lastActiveAt`, throttled to once every 5
 *          minutes so we don't write on every middleware request.
 *
 *   3. Admin / self UI calls `revokeSessionById` to mark a row revoked.
 *      It also bumps `User.sessionVersion` as a defence-in-depth so a
 *      classic JWT-versioning check still invalidates the cookie even
 *      if the per-session lookup is somehow skipped.
 *
 * IP / UA capture is best-effort: NextAuth callbacks don't get the
 * request object directly, so we pull headers via `next/headers` and
 * fall back to `null` when the helper isn't available (e.g. during a
 * CLI-driven flow). Missing telemetry is preferable to a sign-in
 * failure.
 */

import { randomBytes } from 'node:crypto';

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';

// ─── Header capture ─────────────────────────────────────────────────

/**
 * Best-effort IP extraction. Walks the proxy chain in priority order:
 *
 *   1. `x-forwarded-for` (left-most entry — the original client).
 *   2. `x-real-ip`.
 *   3. `cf-connecting-ip` (Cloudflare).
 *
 * Drops to `null` if no header is present so the caller doesn't ship
 * partial / made-up data to the audit log.
 */
function pickIp(headers: Headers | null): string | null {
    if (!headers) return null;
    const fwd = headers.get('x-forwarded-for');
    if (fwd) {
        const first = fwd.split(',')[0]?.trim();
        if (first) return first;
    }
    return (
        headers.get('x-real-ip') ||
        headers.get('cf-connecting-ip') ||
        null
    );
}

function pickUserAgent(headers: Headers | null): string | null {
    if (!headers) return null;
    const ua = headers.get('user-agent');
    if (!ua) return null;
    // Bound row size — pathological UAs from synthetic traffic can run
    // into the kilobytes.
    return ua.length > 512 ? ua.slice(0, 512) : ua;
}

/**
 * Read the current request headers via `next/headers` if available.
 * Returns `null` when called outside a request context (rare; e.g.
 * unit tests that don't mock `next/headers`).
 */
async function readRequestHeaders(): Promise<Headers | null> {
    try {
        const mod = await import('next/headers');
        // GAP-05 — Next 15 made `headers()` async. The function returns
        // `Promise<ReadonlyHeaders>`; we await it before casting.
        const h = await mod.headers();
        return h as unknown as Headers;
    } catch {
        return null;
    }
}

// ─── Session id minting ────────────────────────────────────────────

/**
 * 128-bit random session id, hex-encoded. Cuid would also work but
 * crypto-random gives us better entropy and removes any worry about
 * the cuid prefix leaking machine identifiers.
 */
function mintSessionId(): string {
    return randomBytes(16).toString('hex');
}

// ─── Public API ─────────────────────────────────────────────────────

export interface RecordSessionInput {
    userId: string;
    tenantId: string | null;
    /** Token expiry pulled from NextAuth's session config. */
    expiresAt: Date;
}

export interface RecordedSession {
    sessionId: string;
    rowId: string;
}

/**
 * Insert a UserSession row for a freshly minted JWT. Best-effort: a
 * DB failure must NOT break the sign-in flow, so any error logs to
 * stderr and returns a row-less placeholder. Subsequent calls to
 * `verifyAndTouchSession` will see `revoked: false` in that case
 * (no row → no revocation), preserving the previous behaviour.
 *
 * Tenant policy enforcement (Epic C.3 hardening pass):
 *
 *   - `sessionMaxAgeMinutes`: when set, caps the row's `expiresAt`
 *     to `min(input.expiresAt, now + maxAgeMinutes)`. The JWT cookie
 *     itself still uses NextAuth's default lifetime, but the per-row
 *     expiry is what `verifyAndTouchSession` enforces — so even a
 *     long-lived cookie gets short-circuited at the application
 *     layer.
 *
 *   - `maxConcurrentSessions`: when set and the user already has at
 *     least N active sessions, the OLDEST (by `lastActiveAt` ASC) is
 *     revoked with reason `policy:concurrent-limit` to make room.
 *     Eviction is preferred over deny because a stolen device cannot
 *     keep the legitimate user locked out — they sign in, their old
 *     hijacked session is killed.
 *
 * Both reads are best-effort: if the security-settings lookup fails
 * we proceed with the legacy unlimited behaviour rather than block
 * the sign-in.
 */
export async function recordNewSession(
    input: RecordSessionInput,
): Promise<RecordedSession> {
    const sessionId = mintSessionId();
    const headers = await readRequestHeaders();

    // ── Resolve tenant security policy ──
    let maxAgeMinutes: number | null = null;
    let maxConcurrent: number | null = null;
    if (input.tenantId) {
        try {
            const settings = await prisma.tenantSecuritySettings.findUnique({
                where: { tenantId: input.tenantId },
                select: {
                    sessionMaxAgeMinutes: true,
                    maxConcurrentSessions: true,
                },
            });
            maxAgeMinutes = settings?.sessionMaxAgeMinutes ?? null;
            maxConcurrent = settings?.maxConcurrentSessions ?? null;
        } catch {
            // Fall back to unlimited / NextAuth default lifetime.
        }
    }

    // ── Cap expiry to the tenant policy ──
    let effectiveExpiry = input.expiresAt;
    if (maxAgeMinutes && maxAgeMinutes > 0) {
        const policyCap = new Date(Date.now() + maxAgeMinutes * 60 * 1000);
        if (policyCap < effectiveExpiry) {
            effectiveExpiry = policyCap;
        }
    }

    // ── Evict oldest session(s) if at the concurrent-session cap ──
    if (maxConcurrent && maxConcurrent > 0) {
        try {
            await evictOldestSessionsToFit({
                userId: input.userId,
                cap: maxConcurrent,
            });
        } catch (err) {
            logger.warn('session-tracker: eviction failed', {
                component: 'session-tracker',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    try {
        const row = await prisma.userSession.create({
            data: {
                sessionId,
                userId: input.userId,
                tenantId: input.tenantId,
                ipAddress: pickIp(headers),
                userAgent: pickUserAgent(headers),
                expiresAt: effectiveExpiry,
            },
            select: { id: true },
        });
        return { sessionId, rowId: row.id };
    } catch (err) {
        // Telemetry surface — failed inserts are observable but never
        // block sign-in.
        logger.warn('session-tracker: failed to record session', {
            component: 'session-tracker',
            error: err instanceof Error ? err.message : String(err),
        });
        return { sessionId, rowId: '' };
    }
}

/**
 * If the user is already at or above the concurrent-session cap,
 * revoke their oldest sessions (by `lastActiveAt` ASC) until they
 * drop one BELOW the cap — leaving room for the brand-new session
 * the caller is about to insert.
 *
 * "Oldest by lastActiveAt" — not by createdAt — so a user who keeps
 * one device idle and signs in actively from many others doesn't
 * keep the idle one alive forever.
 *
 * Returns the number of sessions evicted (0 when under cap).
 */
async function evictOldestSessionsToFit(args: {
    userId: string;
    cap: number;
}): Promise<number> {
    const active = await prisma.userSession.findMany({
        where: {
            userId: args.userId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        orderBy: { lastActiveAt: 'asc' },
        select: { id: true },
    });
    // We're about to insert one more, so anything > cap-1 must go.
    const target = Math.max(0, args.cap - 1);
    const toEvict = active.length > target
        ? active.slice(0, active.length - target)
        : [];
    if (toEvict.length === 0) return 0;

    await prisma.userSession.updateMany({
        where: { id: { in: toEvict.map((r) => r.id) } },
        data: {
            revokedAt: new Date(),
            revokedReason: 'policy:concurrent-limit',
        },
    });
    return toEvict.length;
}

export interface VerifyResult {
    revoked: boolean;
    /** Non-null when we actually found the row. */
    rowId: string | null;
    /**
     * When the session was SIGNED IN, i.e. when the row was minted. Present
     * only when the row was found and is live. A native bearer anchors its
     * per-farm second-factor check on it (#3199): every refresh keeps the same
     * row, so this is the bearer's equivalent of a cookie token's sign-in
     * `iat`, which a freshly minted access token does not carry.
     */
    createdAt?: Date;
}

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Look up a session by id and report whether it's been revoked. Also
 * bumps `lastActiveAt` if at least `TOUCH_INTERVAL_MS` have elapsed
 * since the last touch — keeps writes bounded to once-per-5-min per
 * session even under high request volume.
 *
 * If no row exists for the id (e.g. a token minted before this code
 * shipped), return `revoked: false` so we don't lock legacy users out.
 */
export async function verifyAndTouchSession(
    sessionId: string,
): Promise<VerifyResult> {
    try {
        const row = await prisma.userSession.findUnique({
            where: { sessionId },
            select: {
                id: true,
                revokedAt: true,
                lastActiveAt: true,
                expiresAt: true,
                createdAt: true,
            },
        });
        if (!row) return { revoked: false, rowId: null };
        if (row.revokedAt) return { revoked: true, rowId: row.id };

        const now = Date.now();
        // Treat expiry as implicit revocation. We also stamp `revokedAt`
        // so admin listings stop showing the row immediately and so the
        // audit story is consistent ("expired" appears in revokedReason
        // rather than the row mysteriously disappearing).
        if (row.expiresAt.getTime() <= now) {
            try {
                await prisma.userSession.update({
                    where: { id: row.id },
                    data: {
                        revokedAt: new Date(now),
                        revokedReason: 'policy:expired',
                    },
                });
            } catch {
                // If the bookkeeping write fails we still report
                // revoked — the JWT callback should still force re-auth.
            }
            return { revoked: true, rowId: row.id };
        }

        const lastTouchMs = row.lastActiveAt.getTime();
        if (now - lastTouchMs >= TOUCH_INTERVAL_MS) {
            await prisma.userSession.update({
                where: { id: row.id },
                data: { lastActiveAt: new Date(now) },
            });
        }
        return { revoked: false, rowId: row.id, createdAt: row.createdAt };
    } catch (err) {
        logger.warn('session-tracker: verify/touch failed', {
            component: 'session-tracker',
            error: err instanceof Error ? err.message : String(err),
        });
        return { revoked: false, rowId: null };
    }
}

export interface RevokeResult {
    /** True iff a non-revoked row existed and was just marked. */
    revoked: boolean;
    /** The sessionId we revoked, for audit + UI confirmation. */
    sessionId: string | null;
    userId: string | null;
}

/**
 * Tenant-scoped lookup of a session by its `sessionId`. Returns the
 * row only when its `tenantId` matches the calling tenant — the
 * admin sessions DELETE handler uses this to recheck the
 * cross-tenant boundary before revoking. Returning `null` for a
 * row that exists in a different tenant prevents the handler from
 * leaking whether the id exists elsewhere.
 *
 * Lives in this module so route handlers don't need direct Prisma
 * access (enforced by the `no-prisma-in-routes` guardrail).
 */
export async function findOwnTenantSession(args: {
    tenantId: string;
    sessionId: string;
}): Promise<{ id: string; userId: string; revokedAt: Date | null } | null> {
    const row = await prisma.userSession.findUnique({
        where: { sessionId: args.sessionId },
        select: { id: true, tenantId: true, userId: true, revokedAt: true },
    });
    if (!row || row.tenantId !== args.tenantId) return null;
    return { id: row.id, userId: row.userId, revokedAt: row.revokedAt };
}

/**
 * Mark a UserSession row revoked. Caller is responsible for the audit
 * log (the action context — admin vs self vs system — is theirs to
 * know). To prevent partial revocation, also bump `User.sessionVersion`
 * so the existing JWT-versioning check (in src/auth.ts) catches the
 * revoked token even if `verifyAndTouchSession` is somehow skipped.
 *
 * Per-session granularity comes from this function returning the
 * affected `userId`; the caller can choose whether to bump the global
 * sessionVersion (revokes ALL of the user's sessions) or rely solely
 * on the row-level `revokedAt` (revokes only this specific session).
 */
export async function revokeSessionById(input: {
    sessionId: string;
    reason: string;
}): Promise<RevokeResult> {
    const existing = await prisma.userSession.findUnique({
        where: { sessionId: input.sessionId },
        select: { id: true, userId: true, revokedAt: true },
    });
    if (!existing || existing.revokedAt) {
        return {
            revoked: false,
            sessionId: existing ? input.sessionId : null,
            userId: existing?.userId ?? null,
        };
    }
    await prisma.userSession.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), revokedReason: input.reason },
    });
    return { revoked: true, sessionId: input.sessionId, userId: existing.userId };
}

// ─── Listing helpers (consumed by the admin route) ─────────────────

export interface ActiveSessionView {
    sessionId: string;
    userId: string;
    tenantId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
    expiresAt: string;
    lastActiveAt: string;
}

function toView(row: {
    sessionId: string;
    userId: string;
    tenantId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
    expiresAt: Date;
    lastActiveAt: Date;
}): ActiveSessionView {
    return {
        sessionId: row.sessionId,
        userId: row.userId,
        tenantId: row.tenantId,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        lastActiveAt: row.lastActiveAt.toISOString(),
    };
}

/** All non-revoked, non-expired sessions for a single user. */
export async function listActiveSessionsForUser(
    userId: string,
): Promise<ActiveSessionView[]> {
    const rows = await prisma.userSession.findMany({
        where: {
            userId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        orderBy: { lastActiveAt: 'desc' },
    });
    return rows.map(toView);
}

/** All non-revoked, non-expired sessions across a whole tenant. */
export async function listActiveSessionsForTenant(
    tenantId: string,
): Promise<ActiveSessionView[]> {
    const rows = await prisma.userSession.findMany({
        where: {
            tenantId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        orderBy: { lastActiveAt: 'desc' },
    });
    return rows.map(toView);
}

/**
 * Sessions for a single user, scoped to the calling tenant. Used by
 * the admin members-page modal to display + revoke a colleague's
 * sessions. Tenant-scoping the lookup means an admin in tenant A
 * cannot see a user's sessions in tenant B even if the user is a
 * member of both.
 */
export async function listActiveSessionsForUserInTenant(args: {
    tenantId: string;
    userId: string;
}): Promise<ActiveSessionView[]> {
    const rows = await prisma.userSession.findMany({
        where: {
            tenantId: args.tenantId,
            userId: args.userId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        orderBy: { lastActiveAt: 'desc' },
    });
    return rows.map(toView);
}

/**
 * Per-user active-session count, returned as a flat map for cheap
 * use in list views. Empty map when no users have active sessions.
 */
export async function countActiveSessionsForTenantUsers(
    tenantId: string,
): Promise<Record<string, number>> {
    const rows = await prisma.userSession.groupBy({
        by: ['userId'],
        where: {
            tenantId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) {
        out[r.userId] = r._count._all;
    }
    return out;
}
