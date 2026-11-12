/**
 * The session lifetime, in one place.
 *
 * Before this module the number was a 30-day framework default showing
 * through in three places at once — `auth.ts`'s `recordNewSession` call, the
 * SSO cookie's max-age, and NextAuth's own untouched `session.maxAge`. Nobody
 * had chosen 30 days; it was what you get for not deciding (issue #618).
 *
 * ## Why fourteen
 *
 * This is the only lever that touches the LIVE session, so it — not any
 * storage TTL and not the sign-out purge — is what governs the lost-phone,
 * stolen-phone and shared-device cases. A phone that is lost is never signed
 * out, so the lifetime IS the exposure window.
 *
 * Against that, an operator out of signal for days must not be logged out
 * mid-job: re-authentication needs connectivity, and a field worker who cannot
 * reach an IdP from a maize field is simply stopped. Offline WORK survives
 * regardless — the outbox queues it — but the sync that drains it needs a
 * live session.
 *
 * Fourteen days spans a full harvest push without a re-login while halving the
 * window a lost device stays useful. It is deliberately a product decision, not
 * a security maximum: a tenant that wants tighter lowers
 * `TenantSecuritySettings.sessionMaxAgeMinutes`, which caps this per tenant.
 *
 * ## What this does NOT need to touch
 *
 * `REFRESH_TOKEN_TTL_SECONDS` in `native/refresh-tokens.ts` stays at 30 days on
 * purpose. It is a CEILING, not a second lifetime: `capToSession()` clamps every
 * refresh token to the session row's `expiresAt`, so shortening the session
 * shortens the refresh token with it. Lowering both would encode the same
 * decision twice and let them drift apart.
 */

/** Days a freshly-minted session stays valid, absent a tighter tenant policy. */
export const SESSION_MAX_AGE_DAYS = 14;

/** For NextAuth's `session.maxAge`, which is in seconds. */
export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60;

/** For `expiresAt` arithmetic against `Date.now()`. */
export const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

/**
 * The same number in the units `TenantSecuritySettings.sessionMaxAgeMinutes`
 * uses, kept so the four expressions of the web lifetime are pinned against
 * each other.
 *
 * **It is no longer that column's schema default** — see
 * `SESSION_IDLE_MAX_AGE_MINUTES` below, which is, and read that docblock
 * before changing either number.
 */
export const SESSION_MAX_AGE_MINUTES = SESSION_MAX_AGE_DAYS * 24 * 60;

/**
 * The schema default for `TenantSecuritySettings.sessionMaxAgeMinutes`, and
 * since #3004 it means an IDLE window rather than an absolute age.
 *
 * ## Two numbers, because they answer different questions
 *
 * The constants above are the WEB session's absolute lifetime: a cookie minted
 * now stops working in fourteen days however much it is used, which is the
 * lost-phone window that issue #618 chose deliberately.
 *
 * This one is the tenant POLICY default, and a native refresh now slides
 * `UserSession.expiresAt` to `now + sessionMaxAgeMinutes` on every successful
 * rotation. So for a native client the number is "how long the app may sit
 * unused before it signs out", and the owner's decision (2026-11-12) is that a
 * phone in regular use never signs out.
 *
 * ## Raising it does NOT lengthen a web session, and here is why
 *
 * `recordNewSession` caps a new row to `min(input.expiresAt, now + policy)`.
 * The web passes `SESSION_MAX_AGE_MS` — fourteen days — so with the policy at
 * thirty the web's own number is the one that binds and nothing about a cookie
 * changes. That is the whole reason this could be raised without touching the
 * web rule, and it is also the thing that breaks if somebody later raises
 * `SESSION_MAX_AGE_DAYS` to match: the two numbers are different ON PURPOSE.
 *
 * ## What the fixed cap was buying, and what replaces it
 *
 * An absolute age eventually ends a session a thief is keeping alive by
 * refreshing. What bounds that now is the surrounding machinery rather than
 * the clock — replay burn invalidates a reused token and takes the family and
 * the session with it, `sessionVersion` and `UserSession.revokedAt` end every
 * live session on a password change or a suspension, and
 * `maxConcurrentSessions` bounds how many can exist. That is the standard
 * trade for an idle window and it is the trade the owner chose. An absolute
 * cap on top would need a second column, so it is a separate decision.
 */
export const SESSION_IDLE_MAX_AGE_DAYS = 30;

/** The same number in the column's units. */
export const SESSION_IDLE_MAX_AGE_MINUTES = SESSION_IDLE_MAX_AGE_DAYS * 24 * 60;
