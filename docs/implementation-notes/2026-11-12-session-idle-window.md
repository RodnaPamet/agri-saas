# 2026-11-12 — a native session slides on activity

**Issue:** #3004. **Owner decision:** the phone stays signed in while it is
used (2026-11-12). **Client half:** agrent-ios#588.

## What happened

The owner's «Ортофотокарта» vanished. The session had been created 2026-10-26,
was last active 2026-11-08, and `expiresAt` was 2026-11-09 — created + 14 days,
regardless of use. The refresh was refused with 401 `invalid_grant`, and the
phone stayed in the app over its cache with every flag off.

## Design

The fix that first suggests itself — slide to `now + 30 days` on each refresh —
overrides a configured security control. `TenantSecuritySettings.sessionMaxAgeMinutes`
is why the session died at fourteen days, and a tenant that lowered it to seven
for its own reasons would silently have got thirty. It would also leave a field
called `sessionMaxAgeMinutes` that no longer bounds session age, which is worse
than not having the field.

So the tenant's own number becomes an **idle window**: on a successful native
refresh, `UserSession.expiresAt` is set to `now + sessionMaxAgeMinutes`. The
control keeps its meaning and stays per-tenant, and no new column is needed.

| | before | after |
|---|---|---|
| native, in weekly use | signs out 14 d after sign-in | never signs out |
| native, left in a drawer | signs out 14 d after sign-in | signs out 30 d after last use |
| a tenant that set 7 days | 7 d from sign-in | 7 d of inactivity |
| web | 14 d from sign-in | **unchanged** |

The web is unchanged for a reason worth stating, because it is what let the
default be raised at all: `recordNewSession` caps a new row to
`min(input.expiresAt, now + policy)`, the web passes fourteen days, and
14 < 30 — so the web's own number is the one that binds. The two constants are
deliberately different, and `session-lifetime.test.ts` asserts the web's stays
the SMALLER of the two: making them "agree" would double every web session,
the regression #618 exists for.

## Files

| file | role |
|---|---|
| `src/lib/auth/session-lifetime.ts` | adds `SESSION_IDLE_MAX_AGE_MINUTES` (43200) and records why it is not the web number |
| `src/lib/auth/native/refresh-tokens.ts` | `slideSessionExpiry`, called from `claimAndMint` after the atomic claim |
| `prisma/schema/auth.prisma` | column default 20160 → 43200, and the column's meaning |
| `prisma/migrations/20261112210000_session_idle_window/` | the default, plus a backfill scoped to rows at exactly 20160 |
| `tests/unit/session-lifetime.test.ts` | the constants, the schema default, and that the backfill is scoped |
| `tests/integration/native-refresh-tokens.test.ts` | five executing tests against a real database |

## Decisions

- **The slide runs AFTER the atomic claim, never before.** Ordering is the
  security property: a replayed token loses the claim and burns the family and
  the session, so sliding first would let a thief keep a session alive with a
  token that is about to be rejected. Mutation-proved — moving it earlier
  reddens "a REPLAYED token does not extend the session".

- **The successor token is capped to the NEW expiry.** Capping to the expiry
  the caller proved live would hand back a token expiring in an hour on a
  session now good for thirty days, and the phone would be sent to sign-in
  anyway.

- **An absent policy is the DEFAULT policy, not "no slide".** Most tenants have
  no `TenantSecuritySettings` row, so reading a missing row as "do not slide"
  would have shipped a feature inert for almost everybody while every test
  passed — the #1669 shape, where an unconfigured control cannot be told from a
  working one. NULL means unset; it does not mean unlimited and it does not
  mean fourteen days, because the fourteen came from the WEB's `input.expiresAt`
  and never from a tenant's choice.

- **The slide ASSIGNS rather than taking a maximum**, so lowering the policy
  shortens live sessions on their next refresh instead of waiting for an expiry
  weeks out. A security control has to move in both directions.

- **Best-effort.** Any failure leaves the previous expiry standing, which is
  exactly the behaviour before this existed. Failing the refresh instead would
  sign out a working phone because a policy read failed.

- **The backfill is scoped to rows holding exactly 20160**, authorised directly
  by the owner. A row still at the old default cannot be told from one nobody
  ever considered, since that was the value every row got for free; a tenant
  that chose its own number keeps it. The test asserts the `WHERE` clause, so
  an unscoped `UPDATE` — the one thing the authorisation did not cover — fails.

- **No absolute cap on top, deliberately.** A fixed max age eventually ends a
  session a thief keeps alive by refreshing. What bounds that now is the
  surrounding machinery rather than the clock: replay burn, `sessionVersion`,
  `UserSession.revokedAt` and `maxConcurrentSessions`. That is the standard
  trade for an idle window and it is the trade the owner chose. Recovering the
  lost property needs a second column, so it is a separate decision — and two
  age limits beside each other make neither legible.

- **`revokedAt: null` in the slide's `where` is DEFENSIVE and unproven.** It
  stops a session revoked between the caller's liveness check and this write
  from being resurrected with a fresh expiry. No test covers it, because
  `rotateRefreshToken` refuses a revoked session before reaching this code —
  recorded as unproven rather than claimed.
