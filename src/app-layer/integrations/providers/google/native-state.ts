/**
 * Server-held state for the NATIVE Google consent flow — #2495 step 6.
 *
 * The web flow carries its state in an HttpOnly `google_oauth_state` cookie and
 * keeps doing so; this is a second branch, not a migration. The phone cannot
 * use the cookie: its consent runs in an EPHEMERAL `ASWebAuthenticationSession`
 * (owner ruling — the sign-in sheet is ephemeral), a different cookie jar from
 * the one URLSession put the API response's cookie in. So the callback would
 * never see it and every attempt would answer `state_invalid`.
 *
 * ## The ROW is the authorisation, and that is the load-bearing part
 *
 * The web callback re-authorises with `getTenantCtx` + `assertCanAdmin`, which
 * reads the caller's session cookie. In the native flow there IS no session at
 * the callback — the ephemeral browser carries none — so that check cannot run
 * there, and a native branch that simply skipped it would be an unauthenticated
 * endpoint that creates an integration connection from a URL.
 *
 * Instead the row records WHO was authorised when the flow started, where
 * `requirePermission('admin.manage')` had a real session to check. The callback
 * then re-checks that person is STILL an active admin of that farm before
 * writing anything: equivalent in substance to the web path's re-authorisation,
 * and the reason `userId` is on the row rather than only `tenantId`.
 *
 * ## Single-use, claimed atomically
 *
 * `claimNativeState` is a conditional `updateMany` on `consumedAt: null`, the
 * same shape `PasswordResetToken` uses. A `findFirst` then `update` would let
 * two arrivals with one state both pass — and the second arrival of an OAuth
 * state is the replay this exists to refuse.
 *
 * ## Only the HASH is stored
 *
 * The state travels in a redirect the OS may log, so it is treated as a
 * credential: SHA-256 at rest, and the raw value never leaves the response that
 * carries the authorize URL. Same reasoning `NativeAuthCode` gives for hashing
 * its codes.
 */
import { createHash, randomBytes } from 'node:crypto';

import prisma from '@/lib/prisma';

/**
 * Ten minutes — long enough to read a consent screen, short enough that a
 * state captured from a log cannot be replayed later. The cookie flow's
 * `maxAge` is the same 600 seconds, deliberately: two branches of one flow
 * should not disagree about how long a consent may take.
 */
export const NATIVE_STATE_TTL_SECONDS = 600;

/**
 * Where the callback returns control for a native consent.
 *
 * A SERVER constant, never read from a request body: a client-supplied target
 * would make the callback an open redirect gated only by an allowlist, where
 * this way the flow carries no caller-controlled value at all.
 *
 * It lives HERE rather than in the connect route because App Router modules may
 * export only the names Next permits — `app-router-module-exports` caught it
 * there, and the useful part of that catch is WHY a typecheck could not:
 * Next's generated types reject the extra export with TS2344 only AFTER a
 * build, so the guard is the only thing in CI that can see it. It also belongs
 * here on the merits: the return target is part of the state's contract, since
 * the state is bound to it.
 */
export const NATIVE_RETURN_URI = 'bg.agrent.app://integrations/google';

export function hashState(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

/** Mint a state, store its hash, and return the RAW value for the URL. */
export async function issueNativeState(input: {
    tenantId: string;
    userId: string;
    redirectUri: string;
    now?: Date;
}): Promise<string> {
    const now = input.now ?? new Date();
    // 32 bytes, like the sign-in codes. Guessing is not a strategy against it,
    // which is why this needs no attempt counter where the MFA ticket does.
    const raw = randomBytes(32).toString('base64url');
    await prisma.googleOAuthState.create({
        data: {
            stateHash: hashState(raw),
            tenantId: input.tenantId,
            userId: input.userId,
            redirectUri: input.redirectUri,
            expiresAt: new Date(now.getTime() + NATIVE_STATE_TTL_SECONDS * 1000),
        },
    });
    return raw;
}

export type NativeStateClaim =
    | { ok: true; tenantId: string; userId: string; redirectUri: string }
    /**
     * A row EXISTED and could not be claimed — consumed already, or expired.
     * Carries `redirectUri` because the caller still has to send the error
     * somewhere, and this row is the only thing that knows where.
     */
    | { ok: false; reason: 'state_expired' | 'state_invalid'; redirectUri: string }
    /**
     * NO row by that hash. The distinction from the two above is what lets the
     * callback decide which FLOW it is looking at without guessing.
     *
     * A web consent sends a state that has no row here, so this is how the
     * cookie branch is reached. A native REPLAY has a row (consumed), so it
     * does not land here and gets its app-scheme error instead of the web
     * fallback — which the phone could not read.
     *
     * The alternative discriminators are both wrong. Branching on the presence
     * of the `google_oauth_state` cookie sends a web flow whose cookie expired
     * into the native branch, and it would be redirected to an app scheme a
     * browser cannot open. Branching on a bare claim failure cannot tell a web
     * state from a native replay at all.
     */
    | { ok: false; reason: 'unknown_state' };

/**
 * Claim a state exactly once.
 *
 * `state_invalid` covers a row that was already consumed — a REPLAY — and
 * `state_expired` a row still unconsumed but past its TTL. They are separated
 * because only the second is something a legitimate person causes (they left
 * the consent screen open) and only for it is "try again" the right
 * instruction.
 *
 * Note what is NOT distinguished for the caller: a state that never existed
 * answers `unknown_state`, which the callback uses to pick a BRANCH and never
 * reports. Telling an anonymous caller "that state existed and was already
 * used" would confirm a state they guessed or captured; telling them nothing
 * about an unknown one costs nothing, because it is the web path's ordinary
 * case.
 */
export async function claimNativeState(
    rawState: string,
    opts: { now?: Date } = {},
): Promise<NativeStateClaim> {
    const now = opts.now ?? new Date();
    const stateHash = hashState(rawState);

    // ATOMIC claim. A `findFirst` then `update` would let two arrivals with one
    // state both pass the check before either wrote — and a second arrival is
    // precisely the replay this refuses.
    const claimed = await prisma.googleOAuthState.updateMany({
        where: { stateHash, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
    });

    if (claimed.count === 1) {
        const row = await prisma.googleOAuthState.findUnique({
            where: { stateHash },
            select: { tenantId: true, userId: true, redirectUri: true },
        });
        // Defensive: the claim succeeded, so the row exists. Reported as
        // unknown rather than asserted, because a null here would otherwise be
        // a crash inside a handler whose whole job is to redirect somewhere.
        if (!row) return { ok: false, reason: 'unknown_state' };
        return { ok: true, ...row };
    }

    // The claim matched nothing: no row, consumed, or expired. Read it to tell
    // those apart — after the claim, so the read cannot race the write.
    const row = await prisma.googleOAuthState.findUnique({
        where: { stateHash },
        select: { expiresAt: true, consumedAt: true, redirectUri: true },
    });
    if (!row) return { ok: false, reason: 'unknown_state' };
    return {
        ok: false,
        reason: row.consumedAt === null && row.expiresAt <= now ? 'state_expired' : 'state_invalid',
        redirectUri: row.redirectUri,
    };
}
