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

/**
 * How long a just-spent refresh token may be re-presented without being read
 * as theft. See `reissueWithinGrace` for why an unspent successor is the
 * condition that actually carries the security, and this is only its bound.
 */
export const REFRESH_REPLAY_GRACE_SECONDS = 120;

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
            replacedById: true,
            session: { select: { revokedAt: true, expiresAt: true } },
        },
    });

    if (!row) return { ok: false, reason: 'unknown' };

    // A spent token, re-presented. USUALLY theft — but a concurrent refresh and
    // a lost response both arrive in exactly this shape, so ask whether the
    // successor was ever used before burning the lineage.
    if (row.consumedAt) {
        const reissued = await reissueWithinGrace(row);
        if (reissued) return reissued;

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

    return claimAndMint(row, row.session.expiresAt);
}

/** The columns a rotation needs, shared by the normal and the grace path. */
interface ClaimableToken {
    id: string;
    familyId: string;
    userSessionId: string;
    userId: string;
    tenantId: string | null;
}

/**
 * Spend one token and mint its successor.
 *
 * Extracted so the grace path below rotates through the IDENTICAL claim — a
 * second copy of this would be a second place for the atomicity to be wrong.
 * The caller has already proved the session is live; `sessionExpiresAt` is
 * passed in rather than re-read so that proof cannot drift from this write.
 */
async function claimAndMint(row: ClaimableToken, sessionExpiresAt: Date): Promise<RotateResult> {
    const raw = newRawToken();
    const expiresAt = capToSession(
        new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
        sessionExpiresAt,
    );

    // ATOMIC CLAIM. Only the caller that flips consumedAt from null wins.
    const claimed = await asSystem(() => prisma.nativeRefreshToken.updateMany({
        where: { id: row.id, consumedAt: null, revokedAt: null },
        data: { consumedAt: new Date() },
    }));
    if (claimed.count !== 1) {
        // Lost the claim. Two callers reached this exact token at once and the
        // grace path could not absorb it — fail closed.
        await revokeFamily(row.familyId, 'security:refresh-replayed');
        await revokeSessionRow(row.userSessionId, 'security:refresh-replayed');
        logger.warn('native-auth.refresh_claim_lost', {
            component: 'native-auth',
            familyId: row.familyId,
            userSessionId: row.userSessionId,
        });
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

/**
 * A spent token re-presented in good faith — or `null` when it cannot be told
 * from theft, which is the caller's signal to burn the family.
 *
 * Rotation has a failure mode that looks EXACTLY like replay and is not: two
 * requests refresh at once, and the loser presents a token the winner spent
 * moments earlier. Measured in production 2026-09-22 — the owner's session was
 * killed by a replay arriving **1.02 seconds** after a legitimate rotation, and
 * a second one 8m43s after. Both burned the family, revoked the session, and
 * put the app back on "Вход" with the operator's data still on screen.
 *
 * `rotateRefreshToken` called that case "indistinguishable from theft". It is
 * distinguishable, by whether the SUCCESSOR was ever used:
 *
 *   - a client that spent the successor demonstrably RECEIVED it, so a later
 *     replay of its parent is real theft evidence and still burns; but
 *   - an UNSPENT successor means the rotation's answer never landed, and the
 *     client is retrying with the only token it has.
 *
 * That rule is ENFORCED by the atomic claim in `claimAndMint`, not by the
 * `consumedAt` guard below: a spent successor cannot be claimed, so this path
 * fails closed on it either way. Measured — deleting that guard turns no test
 * red, while weakening the claim's `consumedAt: null` predicate turns two red.
 * It is kept as a cheap, explicit statement of the rule and a saved write, and
 * it is deliberately NOT the thing standing between a thief and a session.
 *
 * `REFRESH_REPLAY_GRACE_SECONDS` bounds the second case, because an unspent
 * successor is also the NORMAL state between refreshes — without a window, a
 * spent token would stay usable for as long as a quiet client sat on an unused
 * one. Two minutes covers a concurrent race and an immediate retry, and
 * deliberately does NOT cover a client holding a stale COPY of a rotating
 * credential minutes later: that is the shape theft detection is for, and its
 * fix is one in-flight refresh per client, not a longer window here.
 */
async function reissueWithinGrace(row: {
    consumedAt: Date | null;
    replacedById: string | null;
    familyId: string;
    userSessionId: string;
}): Promise<RotateResult | null> {
    if (!row.consumedAt || !row.replacedById) return null;

    const ageMs = Date.now() - row.consumedAt.getTime();
    if (ageMs > REFRESH_REPLAY_GRACE_SECONDS * 1000) return null;

    const successor = await prisma.nativeRefreshToken.findUnique({
        where: { id: row.replacedById },
        select: {
            id: true, familyId: true, userSessionId: true, userId: true,
            tenantId: true, expiresAt: true, consumedAt: true, revokedAt: true,
            session: { select: { revokedAt: true, expiresAt: true } },
        },
    });

    // Every one of these is a refusal to re-issue, so each falls through to the
    // burn. A revoked successor is how an ALREADY-burnt family stays burnt:
    // `revokeFamily` stamps every row, so a second replay cannot resurrect it.
    // The `consumedAt` arm is redundant with the atomic claim by design — see
    // the docblock; it is an early return, not the gate.
    if (!successor || successor.consumedAt || successor.revokedAt) return null;
    if (successor.expiresAt.getTime() <= Date.now()) return null;
    if (!successor.session || successor.session.revokedAt !== null) return null;
    if (successor.session.expiresAt.getTime() <= Date.now()) return null;

    const result = await claimAndMint(successor, successor.session.expiresAt);
    if (result.ok) {
        logger.info('native-auth.refresh_grace_reissue', {
            component: 'native-auth',
            familyId: row.familyId,
            userSessionId: row.userSessionId,
            consumedAgeMs: ageMs,
        });
    }
    return result;
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
