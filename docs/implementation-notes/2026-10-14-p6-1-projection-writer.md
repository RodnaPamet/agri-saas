# P6.1 PR 2 — the field allowlist, the projection writer, and one route

Second half of P6.1 (#1810). The tables shipped in **v12.26.0**, a release
ahead of this, as the phase requires.

## "Exhaustive allowlist" means compile-time

`BRAND_FIELD_DECISIONS: Record<keyof FarmBrand, FieldDecision>` demands a key
for every column on the model, so adding one to the schema is a `tsc` error
until somebody decides whether it is published.

A list of published field names would not have that property: it would compile
unchanged after a new column appeared, and the column would be private *by
omission* — the safe direction, but silently, and the next reader could not
tell a considered omission from a forgotten one.

`published` entries need no reason (the projection's schema documents each
column). `private` entries each carry one, because a bare `'private'` is
indistinguishable from an oversight. A test requires those reasons to be at
least one clause long.

This is the **second** line of defence. The projection has no PII columns at
all, so even a writer ignoring the allowlist could not leak ЕГН, ЕИК or the
address — there is nowhere for the value to land.

## One transaction for the projection, two for the publication switch

`projectFarmBrand` reads `FarmBrand` under the tenant's RLS session and writes
`PublicFarmProfile`, which has no policies, so **no bypass is needed** and both
the projection row and the `projectedHandle` bookkeeping commit together.

That atomicity is the point. P6.10 requires "unpublish → 404 within 60s", and
if the two writes could commit separately a crash between them leaves either a
public page nobody can find to remove, or a page that silently stops being
refreshed.

`setFarmBrandPublication` deliberately uses **two** transactions: it sets the
flag, then calls the reconciler. Making them atomic would hold a transaction
across the projection write for no benefit — the reconciler is idempotent and
derives everything from the flag, so a crash between them leaves the flag set
and the projection stale, which the next call corrects. The reverse order would
be worse: a published row whose brand says it is private.

`runWithoutRls({ reason: 'public-projection-read' })` is **not** used here.
That reason is for the public read path (P6.5), where there is no principal at
all; borrowing a read reason for a write would make an audit of its call sites
misleading.

## Publishing is fail-closed on three preconditions

A handle, a display name, and a recorded consent.

The first two are structural — `/f/[handle]` has no other key, and the
projection's `displayName` is NOT NULL. The third is a choice: P6.6 ships the
consent sheet, and refusing without `consentedAt` now means P6.6 cannot forget
to wire it. Publish-now-enforce-later would put identifiable information about
real farms online with no record that anyone agreed.

**Withdrawal never fails on any of them.** A farm must always be able to take
its page down, including one whose brand record has since become incomplete.

## `indexable` has no source, and that is PR 1's miss

The projection carries it because P6.5 ships robots and a sitemap over
indexable profiles only. Nothing on `FarmBrand` feeds it — PR 1 added the
column without a source.

Rather than invent one here, every projected row stays `indexable: false`, so
P6.5's sitemap is correctly empty instead of opting farms in by default. The
control belongs to P6.6 (#1815) with the rest of the editor's per-field
toggles, because "publish my page" and "let search engines index it" are
different decisions and indexing is the one that is hard to take back.

The upsert omits `indexable` on **both** branches, so a routine republish
cannot de-index a farm that has opted in. There is a test for that
specifically — `update: { ...payload }` with `indexable` in the payload would
reset it, and nothing else would notice.

## A route, because an unreachable usecase is a liability

#1793 recorded what happens otherwise: a complete, tested, audited usecase with
zero callers, whose refusal codes sat undocumented because there was no
operation to attach them to. Shipping that pattern again knowingly would have
been worse than the extra work.

`PUT /api/t/{tenantSlug}/farm-brand/publication` takes `{ published: boolean }`
— `PUT` because the body **is** the desired state, so a retry on a flaky rural
connection is safe. `published` has **no default**: a client that omits it is
refused rather than publishing a farm by accident.

Two guards had opinions and both were right:

- **`api-key-scope-families`** required the new `farm-brand` family to be
  classified. Recorded in `DELIBERATELY_EXCLUDED` — its first entry. An API
  key answers "may this machine client do routine work on my behalf", and
  publishing is not routine: it is a one-off decision with a consent record
  attached, and the consent is the owner's. Behaviour is unchanged (already
  fail-closed); the entry records that the refusal is a decision.
- **`regression-scanner`** forbids `throw new Error(` under
  `src/app-layer/usecases/`, correctly — a usecase's throws are user-facing
  refusals and must carry codes. `projectionPayload`'s three throws are the
  opposite: invariant violations meaning the caller skipped a precondition,
  which no client can act on. That moved the function to
  `src/app-layer/projections/`, which is its better home anyway — the decision
  table and the function honouring it now sit together.

## Mutation proofs

Writer (12 integration cases), each mutation caught by exactly one:

| mutation | effect |
|---|---|
| no stale-row removal on rename | orphan at the old address |
| `indexable` included in the upsert update | a republish de-indexes an opted-in farm |
| `projectedHandle` not cleared on withdrawal | a later republish reports a phantom removal |
| consent precondition dropped | publishes with no recorded consent |
| `assertCanWrite` instead of `assertCanAdmin` | an EDITOR can publish |

Route (7 unit cases): hardcoding `true` (1 case), inverting the flag (2), and
giving the schema a `default(true)` (1).
