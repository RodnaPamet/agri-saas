/**
 * Native-client refresh tokens — mint, rotate, and detect replay.
 *
 * THE ONE INVARIANT: a bearer credential is a CHILD of a `UserSession`.
 *
 * It is not a parallel credential with its own lifecycle. Every lever the
 * product already has — an admin clicking "revoke session" at /admin/members,
 * `sessionMaxAgeMinutes` capping `expiresAt` at insert, the
 * `maxConcurrentSessions` cap stamping `revokedAt` on the oldest row, and the
 * `User.sessionVersion` backstop that password change and reset bump — applies
 * to a token because the token has no independent existence. Revoking the
 * session is what kills it; there is no second bookkeeping path that could
 * drift out of step with the first.
 *
 * Only the SHA-256 of a token is stored. The raw value is returned once at
 * issue and is unrecoverable afterwards, mirroring `PasswordResetToken`, so a
 * database disclosure yields no usable credential.
 */
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { runWithAuditContext } from '@/lib/audit-context';

/**
 * Token issue and refresh run OUTSIDE `runInTenantContext` by construction — a
 * refresh request is unauthenticated, which is the entire point of it. The RLS
 * middleware would otherwise log `missing_tenant_context` at WARN on every
 * mint, which reads like a bug on a credential path and is precisely how a real
 * warning later gets tuned out.
 *
 * Declaring `source: 'system'` states the intent instead of inheriting the
 * ambiguity: these writes are deliberately tenant-context-free and run under
 * the `superuser_bypass` policy, the same posture `recordNewSession` uses.
 */
function asSystem<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.resolve(runWithAuditContext({ source: 'system' }, fn)) as Promise<T>;
}

/**
 * Access-token lifetime.
 *
 * The number is a revocation-window decision, not a convenience one. A bearer
 * access token is NOT re-minted per request the way a session cookie is, so the
 * `token.error` flag the jwt callback bakes in (and which middleware now
 * enforces) cannot update mid-flight. The live session check therefore happens
 * at REFRESH, and this constant is exactly how stale an access token may be:
 *
 *   worst-case revocation delay === ACCESS_TOKEN_TTL
 *
 * 15 minutes buys a bounded, statable window while keeping refresh traffic to
 * roughly four requests per hour per device. Lengthening it lengthens the
 * window a stolen phone keeps working after an admin has revoked the session —
 * that is the trade, and it should be made deliberately or not at all.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Refresh-token lifetime. Long enough that a seasonal operator who does not
 * open the app for a fortnight is not silently signed out mid-field, short
 * enough that an abandoned device stops working without an admin having to
 * notice. The session's own `expiresAt` still caps this: a refresh can never
 * outlive the session it hangs from.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Raw-token entropy. 256 bits, base64url. */
const TOKEN_BYTES = 32;

export function hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

function newRawToken(): string {
    return randomBytes(TOKEN_BYTES).toString('base64url');
}

export interface IssuedRefreshToken {
    /** Returned to the caller ONCE. Never stored, never logged. */
    raw: string;
    familyId: string;
    expiresAt: Date;
}

/**
 * Mint the first refresh token of a new family, bound to a session row.
 *
 * `userSessionRowId` is the `UserSession.id` PRIMARY KEY, not the external
 * `sessionId` claim. Passing the wrong one would create a token whose FK does
 * not resolve, i.e. an unrevocable credential — so this takes the row id and
 * the caller is responsible for having a real row.
 */
export async function issueRefreshToken(input: {
    userSessionRowId: string;
    userId: string;
    tenantId: string | null;
    /** Caps the token so it can never outlive its session. */
    sessionExpiresAt: Date;
}): Promise<IssuedRefreshToken> {
    const raw = newRawToken();
    const familyId = randomBytes(16).toString('hex');
    const expiresAt = capToSession(
        new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
        input.sessionExpiresAt,
    );

    await asSystem(() => prisma.nativeRefreshToken.create({
        data: {
            tokenHash: hashToken(raw),
            userSessionId: input.userSessionRowId,
            userId: input.userId,
            tenantId: input.tenantId,
            familyId,
            expiresAt,
        },
    }));

    return { raw, familyId, expiresAt };
}

/** A refresh can never outlive the session it hangs from. */
function capToSession(want: Date, sessionExpiresAt: Date): Date {
    return want.getTime() > sessionExpiresAt.getTime() ? sessionExpiresAt : want;
}

export type RotateResult =
    | { ok: true; raw: string; expiresAt: Date; userSessionId: string; userId: string; tenantId: string | null }
    | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'session_invalid' | 'replayed' };

/**
 * Spend a refresh token and mint its successor.
 *
 * ROTATION IS THE POINT. A refresh token is single-use: spending one marks it
 * consumed and issues a replacement in the same family. Presenting a token that
 * is ALREADY consumed is not a retry — the legitimate client would be holding
 * the successor. It means two parties hold the same credential, i.e. one of
 * them stole it, and there is no way to tell which. So the entire family is
 * revoked AND the underlying session with it, which signs the thief and the
 * victim out together. That is the correct trade: a forced re-login beats a
 * silent shared session.
 *
 * The claim is a CONDITIONAL UPDATE, not read-then-write. Two concurrent
 * refreshes of the same token race on `updateMany(... consumedAt: null)` and
 * exactly one sees `count === 1`; the loser is treated as a replay. The shape
 * mirrors the invite redemption in `tenant-invites.ts` for the same reason —
 * a check-then-act here would let a race mint two live families.
 */
export async function rotateRefreshToken(rawToken: string): Promise<RotateResult> {
    const tokenHash = hashToken(rawToken);

    const row = await prisma.nativeRefreshToken.findUnique({
        where: { tokenHash },
        select: {
            id: true, familyId: true, userSessionId: true, userId: true,
            tenantId: true, expiresAt: true, consumedAt: true, revokedAt: true,
            session: { select: { revokedAt: true, expiresAt: true } },
        },
    });

    if (!row) return { ok: false, reason: 'unknown' };

    // Replay of a spent token — theft evidence. Burn the whole lineage.
    if (row.consumedAt) {
        await revokeFamily(row.familyId, 'security:refresh-replayed');
        await revokeSessionRow(row.userSessionId, 'security:refresh-replayed');
        logger.warn('native-auth.refresh_replayed', {
            component: 'native-auth',
            familyId: row.familyId,
            userSessionId: row.userSessionId,
        });
        return { ok: false, reason: 'replayed' };
    }

    if (row.revokedAt) return { ok: false, reason: 'revoked' };
    if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

    // The session is the authority. Checked LIVE here — this is the moment the
    // revocation window closes, which is why refresh fails CLOSED while
    // per-request verification does not.
    if (
        !row.session ||
        row.session.revokedAt !== null ||
        row.session.expiresAt.getTime() <= Date.now()
    ) {
        await revokeFamily(row.familyId, 'session:invalid');
        return { ok: false, reason: 'session_invalid' };
    }

    const raw = newRawToken();
    const expiresAt = capToSession(
        new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
        row.session.expiresAt,
    );

    // ATOMIC CLAIM. Only the caller that flips consumedAt from null wins.
    const claimed = await asSystem(() => prisma.nativeRefreshToken.updateMany({
        where: { id: row.id, consumedAt: null, revokedAt: null },
        data: { consumedAt: new Date() },
    }));
    if (claimed.count !== 1) {
        // Lost the race: another request spent this exact token microseconds
        // ago. Indistinguishable from theft, and treated identically.
        await revokeFamily(row.familyId, 'security:refresh-replayed');
        await revokeSessionRow(row.userSessionId, 'security:refresh-replayed');
        return { ok: false, reason: 'replayed' };
    }

    const created = await asSystem(() => prisma.nativeRefreshToken.create({
        data: {
            tokenHash: hashToken(raw),
            userSessionId: row.userSessionId,
            userId: row.userId,
            tenantId: row.tenantId,
            familyId: row.familyId,
            expiresAt,
        },
        select: { id: true },
    }));
    await asSystem(() => prisma.nativeRefreshToken.update({
        where: { id: row.id },
        data: { replacedById: created.id },
    }));

    return {
        ok: true, raw, expiresAt,
        userSessionId: row.userSessionId, userId: row.userId, tenantId: row.tenantId,
    };
}

/** Revoke every unconsumed token in a family. */
export async function revokeFamily(familyId: string, reason: string): Promise<number> {
    const res = await asSystem(() => prisma.nativeRefreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
    }));
    return res.count;
}

/** Revoke every token hanging off a session — used when the session dies. */
export async function revokeTokensForSession(userSessionRowId: string, reason: string): Promise<number> {
    const res = await asSystem(() => prisma.nativeRefreshToken.updateMany({
        where: { userSessionId: userSessionRowId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
    }));
    return res.count;
}

async function revokeSessionRow(userSessionRowId: string, reason: string): Promise<void> {
    try {
        await asSystem(() => prisma.userSession.updateMany({
            where: { id: userSessionRowId, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: reason },
        }));
    } catch (err) {
        logger.warn('native-auth.session_revoke_failed', {
            component: 'native-auth',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
