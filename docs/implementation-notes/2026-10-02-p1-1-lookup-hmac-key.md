# 2026-10-02 — P1.1: the lookup hash gets its own key, and the master KEK becomes rotatable

**Commit:** `<sha> feat(security): LOOKUP_HMAC_KEY — decouple the lookup hash from the master KEK`

CLAUDE.md carried a banner saying **do not rotate `DATA_ENCRYPTION_KEY`**. This
is the change that retires it — conditionally, which turns out to be the
important word.

## Design

`hashForLookup` HMAC'd with a key HKDF-derived from `DATA_ENCRYPTION_KEY`. The
rotation job re-encrypts `v1:` ciphertexts and re-wraps per-tenant DEKs; it
contains zero references to that path. So every `User.emailHash` was computed
under the old key and a rotation made every lookup by email miss — and a hash
has no authentication failure, so nothing errored:

- sign-in reports no such user;
- reset / verification / invite / SCIM stop matching existing accounts;
- **registration SUCCEEDS into a duplicate `User`**, because its uniqueness
  check is the same hash that now misses and the `@unique` constraint is on the
  hash.

```
          before                              after
  DATA_ENCRYPTION_KEY                 DATA_ENCRYPTION_KEY   LOOKUP_HMAC_KEY
        │                                     │                   │
   HKDF ├── 'inflect-data-encryption'    HKDF │              HKDF │ per KIND
        └── 'inflect-data-lookup-hash'        └── encryption       └── 'inflect-data-lookup-hash'
                                                                       (email, GRANDFATHERED)
  rotating the KEK moves BOTH          rotating the KEK moves only the left column
```

`LOOKUP_HMAC_KEY` **bootstraps** to the KEK's material when unset, so this
change rehashes nothing and every existing row keeps resolving. Pinning it is
what makes a rotation safe, because the pinned material then stays behind.

### The distinction that cost the most thought

**Shipping this code does not by itself make the KEK rotatable.** While the key
is bootstrapped it still tracks the KEK, so the hazard is unchanged and only
*looks* fixed — the worst possible state, because the banner would have been
retired. So `isLookupKeyPinned()` exists and `/api/readyz` reports
`capabilities.lookupKey.pinned`, and the rewritten banner tells the reader to
check the probe rather than believe the paragraph.

### Per-kind derivation, with `email` frozen

`LOOKUP_INFO` maps each identifier kind to its own HKDF info string, so a future
phone-number hash cannot collide with an email hash. `email` keeps the original
`inflect-data-lookup-hash`, and the inconsistency is load-bearing: every stored
hash was computed with it, and a tidy rename would not error — it would silently
produce the defect above. Renaming an existing kind is a REHASH, not an edit.

### Rotating the LOOKUP key is a different, harder event

A ciphertext can be tried under the previous key and the attempt tells you
whether it worked. A hash cannot, so "either key" is only expressible by
widening the QUERY. `hashForLookupCandidates` returns both,
`pii-middleware` emits `{ in: [...] }`, and `findUnique` is DOWNGRADED to
`findFirst` when it does — Prisma rejects an `in` in a unique where. Safe
because the hash column is `@unique` and the list holds at most one hash per key
generation, so at most one row can match: the guarantee `findUnique` provided.

Unique-where WRITES (`update` / `delete` / `upsert`) use the primary alone —
there is no `upsertMany` to downgrade to. `updateMany`/`deleteMany` *could* take
the widened predicate and are excluded deliberately: widening them changes which
rows a write touches, and mid-rotation the conservative behaviour is that writes
address the primary while the P1.3 sweep moves the remainder.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/encryption.ts` | `LookupKind`, `LOOKUP_INFO`, independent key resolution, `hashForLookupCandidates`, `isLookupKeyPinned` |
| `src/lib/security/pii-middleware.ts` | Candidate widening, the `findUnique` → `findFirst` downgrade, the write/read split |
| `src/env.ts` | `LOOKUP_HMAC_KEY` (default `""`) + `LOOKUP_HMAC_KEY_PREVIOUS`, with the hazard written out |
| `src/app/api/readyz/route.ts` | `capabilities.lookupKey.pinned` — reported, never gating |
| `deploy/env.prod.example` | The key plus what its absence disables |
| `tests/guardrails/deploy-env-parity.test.ts` | `FEATURE_DISABLING_DEFAULTS` entry, so the explanation is enforced |
| `tests/integration/kek-rotation-login.test.ts` | The end-to-end proof, with the defect reproduced as a control |
| `tests/unit/lookup-key-bootstrap.test.ts` | The bootstrap is byte-identical to an independently-spelled legacy derivation |
| `tests/unit/security/pii-middleware-lookup-rotation.test.ts` | Widening, the downgrade, and that writes never widen |
| `tests/unit/readyz-lookup-key-capability.test.ts` | The capability, and that it leaks only a boolean |
| `tests/unit/encryption.test.ts` | The "hash changes when key changes" test, narrowed and then INVERTED |
| `tests/guards/lookup-hash-call-sites-registered.test.ts` | The 14 direct call sites classified; the P1.3 conversion list |
| `CLAUDE.md` | The banner rewritten around the live condition |

## Decisions

- **The bootstrap is to `DATA_ENCRYPTION_KEY`'s raw MATERIAL, not its derived
  bytes.** Deriving twice could not reproduce the old hash; copying the material
  reproduces it exactly, which is why the VM step is "copy the value across" and
  not "generate a key". `tests/unit/lookup-key-bootstrap.test.ts` spells the
  pre-P1.1 derivation out independently and asserts byte equality, rather than
  comparing the implementation against itself.
- **A SHORT or EMPTY pinned value reads as ABSENT, not as an error.** A typo
  must fall back to the bootstrap; the alternative is that every lookup in the
  product starts missing. The probe uses the same predicate, so it cannot tell
  an operator the KEK is rotatable when it is not.
- **`LOOKUP_HMAC_KEY_PREVIOUS` does not fall back to
  `DATA_ENCRYPTION_KEY_PREVIOUS`.** The two rotations are independent events now;
  conflating them would make a KEK rotation silently start producing a second
  set of candidate hashes.
- **Identical primary and previous collapse to one candidate.** Otherwise an
  operator setting both to the same value pays the `findUnique` downgrade on
  every query for nothing.
- **`FEATURE_DISABLING_DEFAULTS`, not just a line in `env.prod.example`.** The
  parity guard then enforces that the key arrives WITH an explanation — the bare
  key teaches an operator nothing, and what is silently absent here is the
  recovery path from a leaked key.
- **Reported on `readyz`, never gating.** An unpinned key has been the live state
  since the product shipped; 503-ing on it would turn a latent hazard into an
  outage.

## What the proofs caught

1. **The integration test would have passed for free.** Every positive
   assertion also passes on a build where nothing was fixed, if the test simply
   never rotates the key. The negative-control block unpins the lookup key and
   proves the damage reproduces — the user becomes unfindable *and* a duplicate
   is accepted. That block is the reason to trust the other five.
2. **`typecheck` found a wrong model of the codebase.**
   `findUnique({ where: { email } })` does not compile: `email` is `@map`'d and
   is not unique in the Prisma schema. Chasing that revealed that all sixteen
   explicit call sites pass `emailHash: hashForLookup(email)` THEMSELVES — so
   the middleware's rewrite serves callers that hand it a plain address (NextAuth's
   adapter), and the previous-key widening **never reaches those sixteen**. That
   is a real limitation of the `_PREVIOUS` half, it does not affect a KEK
   rotation at all, and it is now a registry guard with a shrinking list rather
   than a sentence in a merged PR body.
3. **A flaky assertion of my own making.** The leak test grepped the probe body
   for `String(PINNED.length)` — the two characters `"45"` — which collides with
   `latencyMs`. It failed only on runs where the probe took 45ms. Replaced with
   a shape assertion; re-run three times to confirm.
4. **Two contradictory assertions two lines apart** in the registry guard, about
   whether `hashForLookupCandidates(` matches `hashForLookup\s*\(`. It does not,
   and that is the wanted behaviour — it is how a conversion shrinks the list.
   One of the two was a guess about a regex I had just written.

## Not in this change

- **Converting the sixteen explicit call sites to `hashForLookupCandidates`.**
  Needed before a LOOKUP-key rotation is readable end to end; not needed for the
  KEK rotation this unblocks. Tracked with the P1.3 rehash sweep, and the
  registry guard is the list.
- **The rehash sweep itself** (P1.3).
