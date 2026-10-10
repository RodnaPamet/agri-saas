/**
 * Who is making this request, for rate-limiting purposes only.
 *
 * ## Why this exists
 *
 * `buildRateLimitKey`'s own docblock is emphatic:
 *
 *   > CGNAT rationale — DO NOT "simplify" the authenticated key to IP-only.
 *   > This is a mobile-first product: most users arrive over carrier
 *   > networks, where carrier-grade NAT puts *thousands* of unrelated
 *   > subscribers behind ONE public IPv4. […] every authenticated preset
 *   > MUST keep the userId.
 *
 * Measured against that: of the **346** route files wrapped in
 * `withApiErrorHandling`, **3** passed a `getUserId` resolver. The other
 * **343** keyed `<scope>:ip:<ip>:anon` — the exact shape the docblock forbids,
 * on a product whose users share carrier egress IPs. One busy farmer, or one
 * abuser, throttled every other subscriber behind the same NAT.
 *
 * Nothing was wrong with the mechanism. `getUserId` worked; it was OPT-IN, and
 * an invariant that holds only when 346 route authors each remember it is not
 * an invariant. So the resolution moved to the choke point every wrapped route
 * already passes through, and the option became an override rather than the
 * only way in.
 *
 * ## Why a token decode here is affordable
 *
 * `getToken` verifies and decrypts the NextAuth JWE. Symmetric crypto, no
 * database, no network — the same call `src/middleware.ts` already makes for
 * every request on its way in. This one duplicates that work once per
 * MUTATION, which is the minority of traffic and already bound for a database
 * write.
 *
 * ## Why not have middleware pass the id down in a header
 *
 * It would avoid the second decode, and it would be forgeable. A client
 * setting the header to someone else's id poisons their bucket; setting a
 * fresh value per request escapes the limit entirely. That is only safe if
 * middleware unconditionally overwrites the inbound value on every path, which
 * is a guarantee spread across the whole matcher rather than held in one
 * place. Decoding the credential we were actually sent cannot be spoofed.
 *
 * ## Fail SOFT, deliberately
 *
 * Any failure returns `null`, which keys the request as `anon` — the
 * pre-existing behaviour, and a tighter bucket rather than a looser one. A
 * limiter that threw would turn an unreadable cookie into a 500 on a write
 * path; a limiter that failed open would be worse. `null` is the conservative
 * answer in both directions.
 */
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { env } from '@/env';
import { isSlowModeAccount } from './slow-mode';

/**
 * Everything the limiter needs about the caller, from ONE token decode.
 *
 * Both fields come out of the same JWE. Resolving them separately would pay
 * the decode twice on every mutation for no gain, and would make it possible
 * for the two answers to disagree — the id from one decode and the account
 * state from another.
 */
export interface RequestIdentity {
    /** `token.sub`, or `null` when there isn't one we can read. */
    readonly userId: string | null;
    /**
     * Whether this caller gets the reduced mutation budget (P5.5a).
     *
     * `false` for an anonymous caller: anon is already keyed per-IP on the
     * tightest presets, and slow mode is a statement about an ACCOUNT. There
     * is no account here to make it about.
     */
    readonly slowMode: boolean;
}

/**
 * The caller's user id, or `null` when there isn't one we can read.
 *
 * `token.sub` is the field — the same one `src/middleware.ts` uses to key the
 * read tier (`apiReadRateLimit`), so both tiers bucket a given user
 * identically. Bearer tokens resolve too: `getToken` accepts an
 * `Authorization: Bearer` header, so a native client is keyed by user rather
 * than sharing one `anon` bucket per egress IP with every other phone on the
 * network.
 */
export async function resolveRequestUserId(req: NextRequest): Promise<string | null> {
    return (await resolveRequestIdentity(req)).userId;
}

/**
 * The caller's id AND slow-mode state, from one decode (P5.5a, #1596).
 *
 * `resolveRequestUserId` delegates here so there is exactly one decode and one
 * place that reads these claims. The fail-soft contract is unchanged and
 * extends to the new field: an unreadable token yields
 * `{ userId: null, slowMode: false }`.
 *
 * `slowMode: false` on failure is NOT a hole. A caller we cannot identify is
 * keyed `anon` per-IP, which is the tighter bucket the docblock above describes
 * — applying a reduced per-account budget to a shared anonymous key would
 * punish a whole CGNAT egress for one unreadable cookie, which is the exact
 * defect this module was written to remove.
 */
export async function resolveRequestIdentity(req: NextRequest): Promise<RequestIdentity> {
    try {
        const token = await getToken({ req, secret: env.AUTH_SECRET });
        const sub = token?.sub;
        const userId = typeof sub === 'string' && sub.length > 0 ? sub : null;

        // No account ⇒ no account-level state to apply.
        if (!userId) return { userId: null, slowMode: false };

        return {
            userId,
            slowMode: isSlowModeAccount({
                emailVerifiedAt: typeof token?.emailVerifiedAt === 'number'
                    ? token.emailVerifiedAt
                    : token?.emailVerifiedAt === null ? null : undefined,
                accountCreatedAt: typeof token?.accountCreatedAt === 'number'
                    ? token.accountCreatedAt
                    : undefined,
            }),
        };
    } catch {
        // See "Fail SOFT" above: anon is a tighter bucket, not a looser one.
        return { userId: null, slowMode: false };
    }
}
