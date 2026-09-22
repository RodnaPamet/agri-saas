# 2026-09-22 — refresh rotation: absorb a re-presented token instead of burning the session

**Commit:** `fix(auth): absorb a re-presented refresh token instead of burning the session`

## What happened

The owner was being signed out of the iOS app roughly half an hour after every
sign-in. The native client reported `token refresh rejected, clearing tokens`
and put the app back on "Вход" — on a screen that had their data a moment
before, on a product whose whole argument is that it works in a field with no
signal. Signing back in needs `ASWebAuthenticationSession`, a browser and a
working connection, so the failure lands exactly where recovery is hardest.

Three causes were proposed from the client side: a spent/expired token (client
bug), a malformed request meaning refresh had never worked at all, or a wrong
route. **It was none of them.** Refresh worked: of 21 tokens in production, 17
had been spent successfully, and one family rotated ten times cleanly across 19
hours. What killed the session was replay detection firing on a legitimate
retry.

The rows, from `agrent_production` (UTC; the device log ran UTC+2):

| | family `aa8108de` | family `09bdd2c2` |
|---|---|---|
| legitimate rotation | 14:00:43.049 | 12:42:07.204 |
| token re-presented | 14:00:44.059 | 12:50:49.800 |
| gap | **1.02 s** | **522.6 s** |
| outcome | family + session burned | family + session burned |

Both sessions carry `revokedReason = 'security:refresh-replayed'`. The sign-out
LAGS the burn — the access token stays valid up to 15 minutes afterwards — which
is why the interval looked variable rather than like a fixed TTL.

## Design

`rotateRefreshToken` treated any token carrying `consumedAt` as theft and ran
`revokeFamily` + `revokeSessionRow`. Its own comment conceded the ambiguity —
"indistinguishable from theft, and treated identically" — for the concurrent
case. It is distinguishable, by whether the **successor** was ever used:

- a client that spent the successor demonstrably **received** it, so a later
  presentation of the parent is real theft evidence and must still burn;
- an **unspent** successor means the rotation's answer never landed, and the
  client is retrying with the only token it holds.

`NativeRefreshToken.replacedById` already pointed at the successor — it was
being written purely as an audit trail — so the check is an exact lookup rather
than a heuristic over the family.

`reissueWithinGrace` runs before the burn. When the presented token was consumed
within `REFRESH_REPLAY_GRACE_SECONDS` and its successor is still unspent,
unrevoked, unexpired and hanging off a live session, the successor is rotated
and the caller gets a working pair. Everything else falls through to the
existing burn, unchanged.

## Files

| file | role |
|---|---|
| `src/lib/auth/native/refresh-tokens.ts` | `reissueWithinGrace` + `REFRESH_REPLAY_GRACE_SECONDS`; the mint path extracted to `claimAndMint` so both routes share one atomic claim |
| `tests/integration/native-refresh-tokens.test.ts` | the contract, against a real database |
| `tests/integration/native-token-routes.test.ts` | the same contract at the HTTP boundary, including the no-enumeration-oracle property |

## Decisions

- **Two minutes, not fifteen.** An unspent successor is also the NORMAL state
  between refreshes, so the successor check alone would leave a spent token
  usable for as long as a quiet client sat on an unused one. The window is what
  bounds that. Two minutes covers a concurrent race and an immediate retry of a
  request whose response was lost; it deliberately does not cover the 522 s
  case, which is a client holding a stale COPY of a rotating credential. That
  shape is what theft detection is for, and its fix is one in-flight refresh per
  client — the wrong thing to buy with a longer window here.

- **The successor-unspent check is redundant, and the docblock says so.**
  Mutation testing found that deleting it turns no test red: a spent successor
  cannot satisfy the atomic claim's `consumedAt: null` predicate, so the path
  already fails closed. Weakening that predicate instead turns two tests red.
  The guard is kept as a cheap, explicit statement of the rule and a saved
  write — but it is not what stands between a thief and a session, and claiming
  otherwise in a comment would misdirect the next reader.

- **No interactive transaction, and no new dependency.** Closing the
  sub-millisecond concurrent window (both callers read the token as unspent,
  one wins the claim, the loser burns) needs the claim and the successor write
  to commit together, so a loser can re-read and find the successor. `src/`
  contains no `prisma.$transaction(async …)` precedent and no cuid generator to
  pre-mint an id with, and this is the credential path behind pgbouncer in
  transaction mode. That window is left open deliberately: the client prevents
  it at the right layer by holding a single in-flight refresh, and this change
  does not make it worse than the behaviour it replaces.

- **Failures stay indistinguishable.** The route returns 401 `invalid_grant`
  for every refusal — unparseable body, unknown token, revoked, expired,
  replayed. That is why the client's log could never name the cause, and it is
  preserved: the route test that pins it now spends the successor first, so its
  replay case is a genuine refusal rather than a retry the grace window
  absorbs. Without that the assertion would have passed vacuously.
