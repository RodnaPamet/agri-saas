/**
 * Epic 1, PR 2 — Platform-admin API key verification.
 *
 * Provides constant-time verification of the `X-Platform-Admin-Key`
 * request header against the `PLATFORM_ADMIN_API_KEY` environment
 * variable. Throws a `PlatformAdminError` on mismatch or when the
 * env var is unset so callers convert it to the appropriate HTTP
 * status without leaking timing information.
 *
 * This is an assertion helper — it returns `void` on success and
 * throws on failure. Callers should call it at the top of each
 * platform-admin handler before any business logic.
 */

import { env } from '@/env';
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

const HEADER = 'x-platform-admin-key';

/**
 * Thrown by `verifyPlatformApiKey` when the request cannot proceed.
 * `status` carries the HTTP status code the route handler should
 * return (503 = key not configured, 401 = wrong / missing key).
 */
export class PlatformAdminError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'PlatformAdminError';
    }
}

/**
 * Constant-time verify of the X-Platform-Admin-Key header.
 *
 * - Returns void on success (call is an assertion, not a lookup).
 * - Throws `PlatformAdminError(503, ...)` when `PLATFORM_ADMIN_API_KEY`
 *   is unset (feature disabled at the operator level).
 * - Throws `PlatformAdminError(401, 'Unauthorized')` on key mismatch or
 *   missing header. The 401 body is deliberately terse — the correct key
 *   is never echoed.
 *
 * Length-mismatch is handled before the `timingSafeEqual` call because
 * `timingSafeEqual` requires equal-length Buffers. An early return on
 * length difference would leak timing information proportional to the
 * key length, so we pad with a dummy comparison instead of returning
 * early.
 */
/** Which key authorised a request. Not a person — see the return comment. */
export type PlatformKeyGeneration = 'current' | 'previous';

export function verifyPlatformApiKey(
    req: NextRequest,
): { readonly generation: PlatformKeyGeneration } {
    if (!env.PLATFORM_ADMIN_API_KEY) {
        throw new PlatformAdminError(503, 'Platform admin API not configured');
    }

    const provided = req.headers.get(HEADER) ?? '';

    // R-4: zero-downtime rotation. Accept either the current key OR
    // the previous one (when the operator has set it during a
    // rotation window). Both checks run in constant time; we never
    // short-circuit even on the first match because timing equality
    // across keys must hold.
    const currentMatch = constantTimeKeyMatch(provided, env.PLATFORM_ADMIN_API_KEY);
    const previousMatch =
        env.PLATFORM_ADMIN_API_KEY_PREVIOUS !== undefined
            ? constantTimeKeyMatch(provided, env.PLATFORM_ADMIN_API_KEY_PREVIOUS)
            : false;

    if (!currentMatch && !previousMatch) {
        throw new PlatformAdminError(401, 'Unauthorized');
    }

    // WHICH key generation authorised this, for attribution (P5.4, #1595).
    //
    // Additive: the function returned `void` and all 17 call sites ignore the
    // result, so nothing changes for them.
    //
    // No timing change either, and that is the part worth stating: both
    // comparisons have ALREADY run by this line — deliberately, because
    // "timing equality across keys must hold" per the rotation comment above.
    // Reporting which one matched reads a boolean that exists; it does not
    // short-circuit anything.
    //
    // What this is NOT: a person. There is ONE `PLATFORM_ADMIN_API_KEY` for
    // every operator, so the most precise attribution available is a key
    // GENERATION — which still narrows a compromise window to one side of a
    // rotation, and is strictly more than a constant. Per-moderator
    // attribution needs per-moderator credentials, which is P5.8's subject.
    return { generation: currentMatch ? 'current' : 'previous' } as const;
}

/**
 * Constant-time compare provided string against expected key.
 * Returns true on match, false otherwise. Length differences are
 * handled by padding so timingSafeEqual still runs uniformly.
 */
function constantTimeKeyMatch(provided: string, expected: string): boolean {
    const a = Buffer.alloc(expected.length);
    const b = Buffer.from(expected, 'utf8');

    a.write(provided, 'utf8');

    if (provided.length !== expected.length) {
        a[0] = a[0] ^ 0xff;
    }

    return timingSafeEqual(a, b);
}

/**
 * WHO authorised a moderation decision — a key generation, or a person.
 *
 * ## It is a UNION and must stay one (#2735)
 *
 * Two doors reach the same moderation usecases and they can attribute
 * differently, which is the whole point:
 *
 * - a **script** holds the one shared `PLATFORM_ADMIN_API_KEY`, so the most
 *   that can honestly be recorded is which GENERATION authorised it. That
 *   narrows a compromise window to one side of a rotation and is no more than
 *   that.
 * - the **console** is session-gated (`requirePermission('admin.manage')` +
 *   `assertPlatformSupport`), so there is a real `ctx.userId` and the trail can
 *   name a person.
 *
 * Collapsing the two — one nullable `userId`, or a bare string slot — produces
 * a trail where "who" is ambiguous, which is WORSE than today's honest limit:
 * a reader cannot tell "a person decided this" from "somebody holding the key
 * decided this, and we lost the detail". The discriminant is what keeps those
 * two readings apart, so a future kind (SSO, a per-person key) adds an arm
 * rather than widening an existing one.
 *
 * Owner ruling 2026-11-12: per-person API KEYS were considered and rejected.
 * Making `verifyPlatformApiKey` async for a credential lookup would convert its
 * 20 bare assertion call sites into floating promises that fail OPEN —
 * measured: `tsc --strict` exits 0 on an un-awaited async assertion, and
 * `eslint.config.mjs` configures no type-aware rules, so nothing catches it.
 * The session door creates no such hazard, so the verifier stays SYNCHRONOUS.
 */
export type ModerationActor =
    | { readonly kind: 'platform-key'; readonly generation: PlatformKeyGeneration }
    | { readonly kind: 'user'; readonly userId: string };

/**
 * How a decision is attributed in a moderation record.
 *
 * Lives HERE, beside `PlatformKeyGeneration`, rather than in
 * `usecases/moderation.ts` where it was first written (#1667). Two usecases now
 * need it — `actOnNotice` and `suspendAccount` — and `moderation.ts` already
 * imports `suspendAccountOnTx` from `account-suspension.ts`, so importing it
 * back would make a cycle between the two.
 *
 * **Both arms are PREFIXED, and the prefixes must stay distinguishable.** A
 * bare `current` in an attribution column would read as a person's handle, and
 * a bare cuid would read as neither. `platform-key:` and `user:` are what make
 * the stored value self-describing to a reader who has only the column —
 * which, for a regulator reading an export, is the usual case.
 *
 * Taking the union rather than a generation is deliberately a BREAKING
 * signature change: every call site has to say which kind of actor it has, and
 * `tsc` names the ones that do not. A defaulted or optional parameter would
 * have let a new session-gated route silently record a key generation.
 */
export function moderatorRefFor(actor: ModerationActor): string {
    return actor.kind === 'user'
        ? `user:${actor.userId}`
        : `platform-key:${actor.generation}`;
}

/**
 * The `PlatformAuditLog.actorUserId` for an actor, or null when there is none.
 *
 * NULL is not a fallback here — it is the truthful answer for a key-authorised
 * action, because there is no person in scope. Accepting an actor id from a
 * request body would put a caller-supplied name in an attribution field, which
 * is worse than an absent one (the `FeatureFlag.updatedByUserId` rule).
 */
export function actorUserIdFor(actor: ModerationActor): string | null {
    return actor.kind === 'user' ? actor.userId : null;
}
