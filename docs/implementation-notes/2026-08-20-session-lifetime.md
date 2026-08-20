# 2026-08-20 — session lifetime: choosing the number nobody had chosen

**Issue:** #618

## Design

The session lifetime was 30 days. Nobody had picked 30 days — it was
NextAuth's own default, showing through in three independent places, each of
which looked deliberate in isolation:

| Site | What it was | Why it looked fine |
|---|---|---|
| `src/auth.ts` `session: { strategy: 'jwt' }` | no `maxAge` | omission reads as "no opinion", but means v4's 30-day default |
| `src/lib/auth/sso-session.ts:60` | local `SESSION_MAX_AGE_SECONDS = 30d` | a named constant with a docblock |
| `TenantSecuritySettings.sessionMaxAgeMinutes` | `Int?`, no default | null reads as "unlimited by choice" |

All three now consume one exported constant,
`src/lib/auth/session-lifetime.ts`, and the column carries a matching
`@default(20160)`.

**Fourteen days.** This is the only lever that touches the *live* session, so
it — not any storage TTL, not the sign-out purge — governs the lost-phone,
stolen-phone and shared-device cases. A lost phone is never signed out, so the
lifetime *is* the exposure window. Pulling the other way: re-authentication
needs connectivity, and an operator out of signal must not be stopped
mid-job. (Offline *work* survives regardless — the outbox queues it — but the
sync that drains it needs a live session.) Fourteen days spans a harvest push
without a re-login and halves the lost-device window. A tenant wanting tighter
lowers `sessionMaxAgeMinutes`.

## Files

| File | Role |
|---|---|
| `src/lib/auth/session-lifetime.ts` | NEW — the constant, in four units, with the reasoning |
| `src/auth.ts` | explicit `session.maxAge`; `THIRTY_DAYS_MS` → `SESSION_MAX_AGE_MS` |
| `src/lib/auth/sso-session.ts` | local constant deleted in favour of the import |
| `prisma/schema/auth.prisma` | `sessionMaxAgeMinutes Int? @default(20160)` |
| `prisma/migrations/20260820160000_session_lifetime_default/` | default + backfill of existing NULLs |
| `tests/unit/session-lifetime.test.ts` | NEW — 8 assertions, incl. a real encode→getToken round trip |

## Decisions

- **`REFRESH_TOKEN_TTL_SECONDS` is deliberately NOT changed.** It reads as a
  third 30-day site and it is not one. `capToSession()`
  (`native/refresh-tokens.ts:121`) clamps every refresh token to the session
  row's `expiresAt`, on both the issue path (`:101`) and the rotate path
  (`:189`), and rotate re-checks the session live and fails closed. So a
  refresh token issued against a 14-day session already expires in 14 days;
  the 30 is a ceiling a shorter session lowers. Aligning it would encode the
  same decision twice and let the two drift. **The trap here is believing the
  opposite** — that a 30-day refresh silently undoes a 14-day session — and
  then considering the lost-phone case handled because you edited that line.

- **`sso-session.ts` had THREE uses, not one.** `:100` feeds
  `recordNewSession`, which tenant policy caps. But `:129` (`encode`'s
  `maxAge`) and `:139` (the cookie's `maxAge`) are capped by nothing. Fixing
  only the DB-facing one would have left SSO users with a 14-day session row
  and a 30-day cookie. The mismatch is not fatal —
  `verifyAndTouchSession` reads the row, so the stale cookie is bounced rather
  than honoured — but the cookie would have outlived the credential by 16 days,
  and anyone reading "how long is a session" off the cookie would get the wrong
  answer.

- **Nullable, with a non-null default — not `NOT NULL`.** The issue asks for "a
  non-null default", which this is. Adding a `NOT NULL` *constraint* would
  reject an explicit null write from the previous image, for no behavioural
  gain: null already means "no tenant-specific cap", and that now falls back to
  the same 14 days in application code rather than to a framework default.

- **Nobody is signed out.** `recordNewSession` applies the cap at INSERT only
  (`session-tracker.ts:206`), so existing `UserSession` rows keep the
  `expiresAt` they were minted with. Only sessions created after deploy
  shorten. This is why the migration needs no inverse script.

- **The tests execute rather than grep where it matters.** The cookie
  assertions mint a real JWE with v4's `encode()` and read `exp` back through
  `getToken()`, plus a resolving-power control proving a 30-day mint is
  distinguishable from a 14-day one — otherwise the assertion would pass
  against the unfixed code if `encode` ignored `maxAge`.
