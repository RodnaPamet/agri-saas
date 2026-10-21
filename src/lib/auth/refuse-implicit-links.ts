/**
 * Refuse to link an unseen OAuth identity to whoever is already signed in.
 *
 * ## The behaviour this removes
 *
 * next-auth 4's `core/lib/callback-handler.js` resolves `user` from the
 * EXISTING session before it looks at the incoming OAuth account —
 * `user = await getUser(session.sub)` — and then, when the provider account is
 * one it has never seen:
 *
 *     } else {
 *       if (user) {
 *         await linkAccount({ ...account, userId: user.id });
 *         return { session, user, isNewUser };
 *
 * So an OAuth identity arriving while a session cookie exists is attached to
 * that session's user, and the signer-in is handed that user's session. A
 * sign-in must establish who you are, not inherit whoever the browser was
 * already carrying — and the link it writes is permanent, so the consequence
 * outlives the request.
 *
 * Our `signIn` callback does not prevent this. It pre-creates an `Account` row
 * only when the provider email matches an existing user (`emailHash`), so an
 * identity whose email matches nobody falls straight through to the branch
 * above.
 *
 * ## Why the refusal has to be CONDITIONAL
 *
 * `linkAccount` is also how a legitimate first-time OAuth signup attaches its
 * identity — same adapter method, same arguments, twenty lines further down
 * the same function:
 *
 *     user = await createUser(newUser);
 *     await linkAccount({ ...account, userId: user.id });
 *
 * A blanket refusal therefore breaks every new Google signup. The two call
 * sites are indistinguishable from the account object alone: provider,
 * providerAccountId, tokens and `userId` all look the same.
 *
 * What separates them is WHEN the user came into existence. The legitimate
 * link always follows `createUser` within the same request; the implicit one
 * targets a user who existed beforehand. So this wraps BOTH methods and lets
 * `linkAccount` through only for a user `createUser` just minted.
 *
 * The marker is deliberately in-process and short-lived. Both calls happen in
 * one request on one instance — the handler awaits them in sequence — so a
 * shared store would buy nothing and would widen the window. The TTL exists
 * only so a `createUser` whose `linkAccount` never arrives (a throw in
 * between) cannot leave a permanent allowance behind.
 *
 * ## What this does NOT change
 *
 * - A first-time OAuth signup: `createUser` then `linkAccount`, allowed.
 * - Signing in with an identity we HAVE seen: `getUserByAccount` resolves it
 *   and `linkAccount` is never called.
 * - The email-matching case our own `signIn` callback handles: it writes the
 *   `Account` row directly through Prisma, so `getUserByAccount` finds it and
 *   this never runs.
 * - Deliberate provider linking: there is no such feature in this codebase,
 *   and `allowDangerousEmailAccountLinking` is set on no provider.
 *
 * ## The refusal carries a specific code, but still no copy (#2135)
 *
 * A throw here fails the sign-in — which is the security property — and
 * next-auth redirects to `/login` with an error code in the query. Two
 * separate things have to be right for a person to learn why:
 *
 *   1. the CODE must say which failure this was. It does now: see
 *      `NEXT_AUTH_DISPATCH_NAME`. Before that it arrived as the generic
 *      `Callback`, indistinguishable from a transient OAuth failure, which
 *      also means a client cannot tell "never retry this" from "retry".
 *   2. `/login` must render it. It does not — that page reads no `?error=`
 *      at all, for any of next-auth's ten codes. Still open as #2135: it is
 *      copy on a public surface in two languages, not part of this.
 *
 * So the refusal remains silent to the person today. It is no longer
 * anonymous to a client or to the logs.
 *
 * @module lib/auth/refuse-implicit-links
 */
import type { Adapter, AdapterAccount, AdapterUser } from 'next-auth/adapters';
import { logger } from '@/lib/observability/logger';

/**
 * How long a freshly created user may be linked to.
 *
 * Generous against a slow adapter write and far below any human round-trip:
 * the two calls are consecutive `await`s in one function, so the real gap is
 * milliseconds. This is a leak-stopper, not a tuning knob.
 */
export const IMPLICIT_LINK_GRACE_MS = 10_000;

/**
 * The `error.name` next-auth dispatches on to choose the redirect.
 *
 * `next-auth/core/routes/callback.js` compares `error.name` as a STRING, not
 * with `instanceof`, and this is the name of its own error for "the account is
 * already associated with another user" — which is exactly what this refusal
 * means. Setting it sends the person to `?error=OAuthAccountNotLinked`
 * instead of `?error=Callback`, the generic bucket a transient OAuth failure
 * also lands in.
 *
 * This deliberately DISAGREES with the class name, so it looks like a mistake.
 * It is not, and the two names are doing different jobs: the class is what
 * `instanceof` and our tests match on, and this string is what next-auth
 * reads. Renaming it to agree would restore the generic redirect silently,
 * which is why `tests/guards/the-refusal-code-is-distinguishable.test.ts`
 * pins it against next-auth's own source rather than against itself.
 */
export const NEXT_AUTH_DISPATCH_NAME = 'AccountNotLinkedError';

/**
 * Thrown instead of linking.
 *
 * The reason survives into the logs via the message and via the explicit
 * `logger.warn` at the call site — not via `name`, which is spoken for.
 */
export class ImplicitAccountLinkRefused extends Error {
    constructor(provider: string) {
        super(
            `Refusing to link an unseen ${provider} identity to an existing session. ` +
                `Sign out first, then sign in with that account.`,
        );
        this.name = NEXT_AUTH_DISPATCH_NAME;
    }
}

/**
 * Wrap an adapter so `linkAccount` serves only a just-created user.
 *
 * Exported with its own clock for the test, which must be able to cross the
 * grace window without waiting ten seconds for it.
 */
export function refuseImplicitAccountLinks(
    base: Adapter,
    now: () => number = Date.now,
): Adapter {
    /** user id → the moment `createUser` returned it. */
    const justCreated = new Map<string, number>();

    const sweep = () => {
        const cutoff = now() - IMPLICIT_LINK_GRACE_MS;
        for (const [id, at] of justCreated) if (at < cutoff) justCreated.delete(id);
    };

    return {
        ...base,
        async createUser(data: AdapterUser) {
            // `base.createUser` is required by the Adapter contract, but the
            // type marks it optional; a missing one is a misconfiguration
            // rather than something to paper over.
            if (!base.createUser) throw new Error('adapter has no createUser');
            const user = (await base.createUser(data)) as AdapterUser;
            sweep();
            justCreated.set(user.id, now());
            return user;
        },
        async linkAccount(account: AdapterAccount) {
            sweep();
            // CONSUMED, not merely read: one `createUser` authorises exactly
            // one link. Leaving the marker would let a second provider account
            // ride in on the same signup within the window.
            const createdAt = justCreated.get(account.userId);
            justCreated.delete(account.userId);
            if (createdAt === undefined) {
                logger.warn('oauth link refused: implicit link to an existing session', {
                    component: 'auth',
                    provider: account.provider,
                    // Our own id. The provider's subject is NOT logged — it is
                    // an identifier for a person at that provider.
                    userId: account.userId,
                });
                throw new ImplicitAccountLinkRefused(account.provider);
            }
            if (!base.linkAccount) throw new Error('adapter has no linkAccount');
            return base.linkAccount(account);
        },
    };
}
