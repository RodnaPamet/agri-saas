/**
 * Sign in with Apple — identity-token verification and nonce replay refusal
 * (P4.2).
 *
 * Apple REQUIRES Sign in with Apple from any app that offers another
 * third-party sign-in, so this is an App Store review gate rather than a
 * preference. The iOS app will offer Google and Microsoft.
 *
 * ## It is DORMANT until credentials exist, and that is checked explicitly
 *
 * `appleSignInConfigured()` tests for the values and says so in the log. It is
 * deliberately NOT left to the framework: `next-auth` will register a provider
 * with `undefined` credentials and fail at the token exchange with an opaque
 * error, which a user experiences as a broken button and an operator reads as
 * noise — rather than as "this feature is not configured". That distinction is
 * the whole reason `verifyTurnstile` tests for its secret rather than assuming
 * absence fails safely (P3.5c), and the same reasoning applies here.
 *
 * ## The audience differs by flow, and conflating them is a real attack
 *
 * An identity token minted for the iOS app carries the BUNDLE ID in `aud`; one
 * minted for the web flow carries the SERVICES ID. Accepting either on both
 * paths would let a token obtained through one be replayed at the other — so
 * the caller states which flow it is and gets exactly that audience checked.
 *
 * ## The nonce is the replay defence, and it is single-use BY INSERT
 *
 * Apple echoes a nonce into the identity token. The client sends the RAW
 * nonce; Apple's token carries its SHA-256. Checking only that they match
 * proves the token was minted for this request — it does NOT stop the same
 * token being presented twice. So each nonce is also claimed exactly once, by
 * INSERT against a unique index: the insert IS the claim, and a replay
 * violates the constraint. That is cheaper and harder to get wrong than a
 * read-then-write, which races itself under concurrency.
 */
import { createHash } from 'node:crypto';

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { env } from '@/env';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';

/** Apple's published signing keys. */
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');
/** The `iss` every Apple identity token carries. */
const APPLE_ISSUER = 'https://appleid.apple.com';

/**
 * How long a nonce stays claimed.
 *
 * Apple identity tokens are short-lived (minutes), so a nonce only has to
 * outlive the token that carries it. An hour is generous for clock skew and a
 * slow handoff, and keeps the table small enough that the sweep is trivial.
 */
export const APPLE_NONCE_TTL_MS = 60 * 60 * 1000;

/** Which flow is presenting the token — it decides the expected audience. */
export type AppleFlow = 'native' | 'web';

export interface AppleIdentity {
    /** Apple's stable per-user id (`sub`). Never an email. */
    appleUserId: string;
    /**
     * Only present when the user agreed to share it, and only on the FIRST
     * authorisation — Apple omits it afterwards. A caller must therefore treat
     * absence as "I already know this person" rather than "no email".
     */
    email: string | null;
    emailVerified: boolean;
    /** True when Apple is relaying to a private relay address. */
    isPrivateRelay: boolean;
}

export type AppleVerifyResult =
    | { ok: true; identity: AppleIdentity }
    | { ok: false; reason: 'not_configured' | 'bad_token' | 'bad_nonce' | 'nonce_replayed' };

let warnedUnconfigured = false;

/**
 * Whether Sign in with Apple is configured at all.
 *
 * Read from `env` per call rather than hoisted: an operator pasting the four
 * values into the VM's `.env` and recreating the container must not need a
 * rebuild, which is the same property the Turnstile sitekey has.
 */
export function appleSignInConfigured(flow: AppleFlow = 'native'): boolean {
    const audience = flow === 'native' ? env.APPLE_BUNDLE_ID : env.APPLE_SERVICES_ID;
    return Boolean(audience);
}

/** `createRemoteJWKSet` caches and rotates on its own; one instance per process. */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function appleKeys() {
    if (!jwks) jwks = createRemoteJWKSet(APPLE_JWKS_URL);
    return jwks;
}

/** SHA-256, hex — the transform Apple applies to a nonce before embedding it. */
export function hashNonce(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

/**
 * Claim a nonce, exactly once.
 *
 * Returns false when it has been seen before. The INSERT is the claim: a
 * unique index on `nonceHash` makes a replay a constraint violation rather
 * than something a read has to notice, so two concurrent presentations of the
 * same token cannot both pass.
 */
async function claimNonce(nonceHash: string): Promise<boolean> {
    try {
        await prisma.appleSignInNonce.create({
            data: { nonceHash, expiresAt: new Date(Date.now() + APPLE_NONCE_TTL_MS) },
        });
        return true;
    } catch (err) {
        // P2002 is the replay. Anything else is a real failure and must not be
        // read as "already used" — that would turn a database outage into a
        // silent refusal of every legitimate sign-in.
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
            return false;
        }
        throw err;
    }
}

/**
 * Verify an Apple identity token and consume its nonce.
 *
 * `rawNonce` is what the client generated and sent to Apple; the token carries
 * its SHA-256. Both halves are required: the hash match proves the token was
 * minted for THIS request, and the single-use claim stops the same token being
 * presented twice.
 */
export async function verifyAppleIdentityToken(input: {
    identityToken: string;
    rawNonce: string;
    flow: AppleFlow;
}): Promise<AppleVerifyResult> {
    const audience = input.flow === 'native' ? env.APPLE_BUNDLE_ID : env.APPLE_SERVICES_ID;
    if (!audience) {
        if (!warnedUnconfigured) {
            warnedUnconfigured = true;
            logger.warn('apple-signin.not_configured', {
                component: 'apple-signin',
                flow: input.flow,
                message:
                    'Sign in with Apple is NOT active: no audience is configured for this flow ' +
                    '(APPLE_BUNDLE_ID for native, APPLE_SERVICES_ID for web). Set the Apple ' +
                    'credentials in the environment to enable it; no deploy is required.',
            });
        }
        return { ok: false, reason: 'not_configured' };
    }

    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(input.identityToken, appleKeys(), {
            issuer: APPLE_ISSUER,
            // The audience is flow-specific on purpose — see the file docblock.
            audience,
        }));
    } catch {
        // Deliberately one reason for every verification failure: a bad
        // signature, a wrong audience, an expired token and a malformed one
        // are all "this token is not acceptable", and telling them apart would
        // help somebody probing which of the four they got wrong.
        return { ok: false, reason: 'bad_token' };
    }

    const nonceClaim = typeof payload.nonce === 'string' ? payload.nonce : null;
    if (!nonceClaim || nonceClaim !== hashNonce(input.rawNonce)) {
        return { ok: false, reason: 'bad_nonce' };
    }

    if (!(await claimNonce(nonceClaim))) {
        logger.warn('apple-signin.nonce_replayed', {
            component: 'apple-signin',
            flow: input.flow,
        });
        return { ok: false, reason: 'nonce_replayed' };
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) return { ok: false, reason: 'bad_token' };

    return {
        ok: true,
        identity: {
            appleUserId: sub,
            email: typeof payload.email === 'string' ? payload.email : null,
            // Apple sends these as strings or booleans depending on the flow.
            emailVerified: payload.email_verified === true || payload.email_verified === 'true',
            isPrivateRelay:
                payload.is_private_email === true || payload.is_private_email === 'true',
        },
    };
}

/**
 * Drop expired nonces.
 *
 * Not a correctness requirement — a stale row refuses a replay just as well as
 * a fresh one — but the table would otherwise grow one row per sign-in for
 * ever. Safe to run from a scheduled job.
 */
export async function sweepExpiredAppleNonces(now = new Date()): Promise<number> {
    const { count } = await prisma.appleSignInNonce.deleteMany({
        where: { expiresAt: { lt: now } },
    });
    return count;
}
