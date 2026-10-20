/**
 * `auth()` with the suspension check attached (#1652).
 *
 * ## The gap this closes
 *
 * P5.9 put `isAccountSuspended` in `getSessionOrThrow`, and CLAUDE.md describes
 * that as "the Node choke point — all three ctx resolvers call it". Both halves
 * are true and they are not the same claim as "every authenticated request".
 * **Ten route files resolved a session with `await auth()` directly**, so they
 * never reached it. The two that mattered most:
 *
 *   - the invite-acceptance pair — a suspended account could **join a second
 *     farm** and carry on there under a fresh membership;
 *   - `auth/change-password` — it could **rotate its own credential**.
 *
 * `count-the-routes-a-gate-covers` is the lesson, and the fix is a door plus a
 * denominator: `tests/guards/api-routes-resolve-sessions-through-the-gate.test.ts`
 * holds the direct-`auth()` count under `src/app/api` at zero.
 *
 * ## Two functions, because the 401 bodies are NOT uniform and must not become so
 *
 * The obvious helper is one `getAuthenticatedSession()` that throws for both
 * refusals. It is the wrong shape here: these ten routes answer an absent
 * session in four different ways — `{ error: 'Unauthorized' }`,
 * `{ error: 'unauthenticated' }`, `{ error: { code: 'UNAUTHENTICATED', … } }`,
 * and a 302 to `/login` carrying a `callbackUrl`. Those are published contracts
 * with installed clients behind them, and collapsing four into one while fixing
 * a suspension hole would be a breaking change riding along inside a security
 * fix.
 *
 * So both functions return the session UNCHANGED, including `null`, and every
 * caller keeps its own unauthenticated branch verbatim. The only thing they add
 * is the suspension verdict.
 *
 *   `authRefusingSuspended()`  throws `ACCOUNT_SUSPENDED`. For a route inside
 *                              `withApiErrorHandling`, which turns the throw
 *                              into the same 403 the ctx resolvers answer.
 *   `authWithSuspension()`     returns the verdict for the caller to act on.
 *                              For a route that must not throw — the two
 *                              `accept-redirect` handlers are bare `GET`
 *                              exports a browser navigates to, where a JSON 403
 *                              would be shown as raw JSON.
 *
 * ## What is deliberately NOT refused, and why each is a decision
 *
 * - **`/t/{slug}/security/mfa/challenge/verify`** — owner ruling. It is part of
 *   SIGN-IN, so a refusal there arrives as a failure at the MFA step and reads
 *   as "your code is wrong" rather than "your account is suspended". Better to
 *   let the challenge succeed and refuse at the first real request, which
 *   carries the sentence that explains it. It is the single entry in the
 *   guard's allowlist, with that reason.
 * - **The invite PREVIEW halves** (`GET /api/invites/{token}`,
 *   `GET /api/org/invite/{token}`) use `authWithSuspension()` and proceed. The
 *   owner's ruling was about ACCEPTANCE; a preview is a read of an invite the
 *   person was sent, is enumeration-safe already, and refusing it would hide
 *   what they are being told about rather than stop them acting on it.
 *
 * ## The invite ruling
 *
 * Owner ruling: **refuse, and the invite stays pending.** Acceptance is
 * refused, the invite remains valid for after a lift, and the inviter gets no
 * signal in this change — a notification would disclose a moderation state to a
 * third party, and is filed separately rather than decided here.
 *
 * ## The fail direction is inherited, not re-decided
 *
 * `isAccountSuspended` fails CLOSED on an unreadable Postgres and falls THROUGH
 * to Postgres on an unreadable Redis. That asymmetry is P5.9's and is argued in
 * `suspension.ts`; nothing here changes it. A request that cannot read
 * `User.suspendedAt` cannot do the work it came for either.
 */
import type { Session } from 'next-auth';

import { auth } from '@/auth';
import { codedForbidden } from '@/lib/errors/types';

import { isAccountSuspended } from './suspension';
import {
    recordSuspendedRefusal,
    type SuspendedRefusalRecord,
} from './suspended-refusal-audit';

export interface SessionWithSuspension {
    /** Exactly what `auth()` returned, `null` included. */
    session: Session | null;
    /**
     * `false` when there is no session at all — "nobody is suspended" is the
     * honest answer to asking about an absent user, and a caller's
     * unauthenticated branch runs first in every migrated route.
     */
    suspended: boolean;
}

/** `auth()`, plus whether that session's user is suspended. Never throws. */
export async function authWithSuspension(): Promise<SessionWithSuspension> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { session, suspended: false };
    return { session, suspended: await isAccountSuspended(userId) };
}

/**
 * `auth()`, refusing a suspended account with the 403 the ctx resolvers answer.
 *
 * Returns the session unchanged — `null` included — so the caller's own
 * unauthenticated branch still decides what an absent session looks like.
 *
 * The code is `ACCOUNT_SUSPENDED` and the message matches `getSessionOrThrow`
 * exactly. Two gates answering one condition in two shapes is #1645, three
 * days old at the time of writing.
 *
 * The message used to BE the token, and #1677 changed both gates to
 * 'Your account is suspended.' together — the agreement is the contract here,
 * not the particular string. `ACCOUNT_SUSPENDED` is entried in both locales,
 * so `localizeErrorPayload` replaces this before a reader sees it; the literal
 * only surfaces when localisation fails, and a token is the worst thing to
 * leave on a path that is never watched.
 */
/**
 * @param record  When given, the refusal is appended to the moderation audit
 *                chain before the throw (#1656, owner ruling: platform admins
 *                only). Best-effort — see `recordSuspendedRefusal`.
 *
 * The record is a PARAMETER rather than a second door. A
 * `authRefusingSuspendedAndRecording` sibling would put the refusal — the part
 * that actually protects the farm — in two places, and two spellings of one
 * rule is the drift that #1671 and #1667 each shipped in turn. There is one
 * `suspended` test and one throw; only the bookkeeping is optional.
 *
 * Recorded BEFORE the throw, not after: the throw leaves this function.
 */
export async function authRefusingSuspended(
    record?: SuspendedRefusalRecord,
): Promise<Session | null> {
    const { session, suspended } = await authWithSuspension();
    if (suspended) {
        // `session.user.id` is present whenever `suspended` is true —
        // `authWithSuspension` resolves suspension FROM the session's user —
        // but the type does not say so, so an absent id skips the record
        // rather than refusing differently.
        const userId = session?.user?.id;
        if (record && userId) await recordSuspendedRefusal(userId, record);
        // #1677 — see `lib/auth.ts`: the fallback was the code itself.
        throw codedForbidden('ACCOUNT_SUSPENDED', 'Your account is suspended.');
    }
    return session;
}
