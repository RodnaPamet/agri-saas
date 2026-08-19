# 2026-08-19 — What the phone is allowed to keep

**Commit:** `<pending> fix(swr): allowlist what the persistent cache writes to disk`

## What was wrong

The persistent SWR cache wrote **every** successful response to
`localStorage`, spilling large ones to IndexedDB. There was no filter of any
kind — `collectEntries` took each key with `data` and no `error`.

`/leases` goes through `useTenantSWR`. A lease row carries `lessorName` and
`lessorEik`: the name and identifier of the landlord a farm rents from,
generally a private individual who is **not a user of this product**. Both are
in the Epic B `ENCRYPTED_FIELDS` manifest, precisely because they are
third-party personal data. Server-side they are AES-encrypted under a
per-tenant DEK. Client-side they were plaintext JSON on an operator's phone.

Nobody decided that. Persisting them required no decision at all — only that
the Rent page use the same hook as every other list.

## The second defect, found in the same file

The bucket was namespaced by **tenant slug alone**
(`SWRPersistenceProvider`). On a shared farm device:

1. Operator A (ADMIN) opens a list. Rows land in `agrent-swr:v*:<slug>`.
2. A signs out. Operator B (READER) signs into the **same tenant**.
3. Same slug ⇒ same bucket. SWR paints A's rows from disk before any request
   leaves the device.

The part that makes this more than cosmetic: if the API then refuses B, this
codebase's convention is to render the error only when there is nothing else to
show (`isError && rows.length === 0`, see the Epic 53 notes). B *has* rows —
A's rows — so the refusal never renders and the stale data stays on screen.

No TTL closes that. Neither does a purge-on-sign-out: B may simply sign in
after A closed the tab. Only the namespace does.

## Design

**An allowlist, not a denylist.** This repo already ran the denylist
experiment implicitly and lost: the one field pair that most obviously needed
protecting was in the encryption manifest and still went to disk. No static
analysis can decide "is this response sensitive", so the only real question is
which way an omission fails:

- a forgotten **denylist** entry writes personal data to a phone;
- a forgotten **allowlist** entry costs one cold-start refetch.

The second is a real cost — avoiding exactly that refetch is why this cache
exists — and still the right one to pay. It also closes the *class*: an
endpoint nobody has written yet is safe by default.

Seeded with the four lists the cold-start work was actually built for, the same
four that got `jsonWithETag`: journal, farm-tasks, locations,
exchange-listings.

**Gated in both funnels.** `collectEntries` is the single write funnel —
`flush()` serialises one entries array and routes it to localStorage *or* the
IndexedDB spill — so gating there covers both tiers. `applyBucket` is gated too,
because a bucket already on disk would otherwise keep rehydrating disallowed
entries into memory, and the flush that would drop them is not guaranteed to run
before the render that would show them.

**The version bump is the remediation.** The allowlist stops new writes; it does
not remove what is already on real devices. The 24h TTL only fires when that
namespace is hydrated, and the IndexedDB tier has no delete path at all — so a
phone that never opens Rent again keeps its lease PII indefinitely.
`parseBucket` rejects a wrong-version bucket **wholesale**, so bumping
`SWR_CACHE_VERSION` 1 → 2 erases every existing bucket, both tiers, on the next
launch. That one constant is the only change here that removes bytes already
written.

## Files

| file | role |
|---|---|
| `src/lib/swr/persistent-cache.ts` | `PERSISTABLE_PATHS` + `isPersistableKey`; gate in both funnels; version 1 → 2 |
| `src/components/providers/SWRPersistenceProvider.tsx` | `cacheNamespace(userId, tenant)` |
| `src/app/providers.tsx` / `src/app/layout.tsx` | resolve the user id server-side and thread it down |
| `tests/rendered/swr-persist-allowlist.test.tsx` | executing — what actually reaches disk, incl. the spill branch |
| `tests/rendered/swr-cache-namespace.test.tsx` | executing — the cross-user leak, with an in-test mutation proof |
| `tests/guards/swr-persist-allowlist.test.ts` | the list stays an allowlist, and stays small |

## Decisions

- **The allowlist is capped, not floored.** `MAX_PERSISTED_ENDPOINTS = 4`.
  Growth should require someone to raise the number and say why, because
  unnoticed growth is precisely how the original defect arrived.

- **Segment-aware matching.** `path === p || path.startsWith(p + '/')`, so
  `/journal` does not also claim `/journal-exports`. A prefix test that leaks a
  neighbouring endpoint is the same bug as a denylist, in miniature.

- **`auth()` in `RootLayout` is cheap here.** That layout already awaits
  `headers()`, so it is dynamic regardless; `auth()` decodes the session cookie
  with no database round-trip, and an unauthenticated request returns null
  immediately. Deliberately **not** a `<SessionProvider>` — the comment in
  `providers.tsx` records that one was removed because it added a client-side
  `/api/auth/session` fetch on every page load.

- **The user id is a cache key, not a credential.** It grants nothing. The cost
  of getting it wrong is a cache miss; the cost of not having it is one
  operator's rows rendering for the next one.

- **Tests execute, they do not grep.** Per this repo's own rule, a guard
  asserting that `isPersistableKey` *appears* in `collectEntries` would pass
  against a version that called it and ignored the result. Every behavioural
  assertion drives the real provider and reads what landed in storage; the
  write gate is mutation-proven (removing it turns the lease assertions red),
  and the namespace test carries an in-test proof that the old tenant-only
  keying does leak.

- **The spill branch is covered on purpose.** Lists are exactly what grows past
  `LS_BYTE_BUDGET`, so a gate that only worked on the localStorage write would
  have leaked the *largest* payloads — the opposite of anyone's intent.

## Not in this PR

Retention. Field snapshots (`agri.offline.fieldop.v1.*`) still have no TTL and
`clearFieldSnapshot` still has zero callers; Cache Storage
(`agrent-v1-fielddata`, `agrent-v1-pages`) is still unbounded and holds tenant
API responses plus rendered tenant HTML. Those are a separate sweep, and the
LRU byte cap for Cache Storage should land before any age-based eviction —
a bug in `public/sw.js` is the hardest thing in this repo to roll back, because
install deliberately skips `skipWaiting`, so a broken worker waits on operator
consent.

Purge-on-sign-out is deliberately **last**, not first: against the realistic
exposure cases it covers only "device handed over after an explicit sign-out".
A lost or stolen phone is never signed out, and a shared device where the next
operator simply signs in does not wait for it either. Once the sweep exists,
the purge is `sweep({ maxAgeMs: 0 })` at the three sign-out sites.
