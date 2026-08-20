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
 * uses. This is the column's schema default; a migration that changes one and
 * not the other is a bug, which `tests/unit/session-lifetime.test.ts` pins.
 */
export const SESSION_MAX_AGE_MINUTES = SESSION_MAX_AGE_DAYS * 24 * 60;
