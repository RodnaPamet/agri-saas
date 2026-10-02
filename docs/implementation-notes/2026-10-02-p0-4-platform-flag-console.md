# 2026-10-02 — P0.4 remainder: the platform flag console and the social gating guard

**Commit:** `<sha> feat(flags): platform flag console + social-route gating guard`

#1209 shipped P0.4's first three parts — the `FeatureFlag` + cohort models, the
resolver with its three precedence rules, and flags on `/api/auth/me`. It said
in terms what it left: *"NOT IN THIS CHANGE: the platform flag console from
P0.4."* This closes that, plus the fourth part the roadmap asks for — *"a NEW
guard that every social route is flag-gated."*

## Design

Two routes and one guard.

```
POST-ish surface                        gate
────────────────────────────────────────────────────────────────────────
GET  /api/admin/feature-flags           verifyPlatformApiKey  → raw table
PUT  /api/admin/feature-flags           verifyPlatformApiKey  → upsert +
                                                                invalidate
GET  /api/admin/feature-flags/cohorts   verifyPlatformApiKey  → sizes, or
                                                                one cohort
POST   …/cohorts                        verifyPlatformApiKey  → add (idem)
DELETE …/cohorts                        verifyPlatformApiKey  → remove
```

The gate is the platform key rather than a tenant permission because
`FeatureFlag` has no `tenantId`: a dark-launch rail is flipped for the whole
deployment, and `admin.manage` is held by an ADMIN of any single tenant. A
tenant admin able to launch a feature for every other tenant is the wrong
boundary and the obvious mistake here.

`FEATURE_FLAGS_FORCE_OFF` stays an environment variable and is **not** writable
through the console. An API that could clear the kill switch is an API that can
be compromised into clearing it, and the switch exists for the case where the
application is the thing going wrong.

### The reachability half, which the handler gate cannot see

Every assertion that drives a handler directly would still pass on a console
the Edge refuses before the handler runs. `middleware.ts` calls `getToken()`,
which understands only a NextAuth JWE, so an `x-platform-admin-key` request
yields null and is 401'd. That shape has shipped **six** times in this repo
(`token.error`, the `iflk_` key, SCIM, three signed webhooks), and
`src/lib/auth/guard.ts` anticipated the seventh in a comment: *"A tenth
platform-key route added later is caught by the same guard's reachability
half, so this list cannot silently go stale."* It was — the first run of
`tests/guards/public-routes-self-authenticate.test.ts` after writing these two
routes named both of them.

The opening is an EXACT entry for `/api/admin/feature-flags` plus a
`'/api/admin/feature-flags/'` prefix for its children, rather than one bare
prefix like the four sibling platform-admin entries. A bare prefix would also
open a future `/api/admin/feature-flagsomething` — the `/api/scim` vs
`/api/scimulator` hazard the same file names a few lines above. The siblings
carry that latent widening; a new entry need not inherit it.

### The guard, whose population is zero

No social routes exist yet. An empty selection is a PASS, and this repo has
shipped that defect often enough to name it, so
`tests/guards/social-routes-flag-gated.test.ts` is built for a zero population
rather than merely tolerating one:

- it **prints the denominator** on every run (`routes=0 pages=0 … of 371 API
  routes, 92 app pages`) plus an explicit "NO SOCIAL SURFACES EXIST YET" line,
  so a green tick cannot be read as "the surfaces are gated";
- it **proves the detector against synthetic sources** — a gated route and five
  mutations of it. That is the only mutation proof available before a real
  social route exists, and it earned its keep immediately (below);
- it **defends its own roots**. Every route or page path containing a `social`
  path SEGMENT must fall under a declared root, so landing a social surface at
  `api/t/[slug]/social` costs a visible line adding that root instead of a
  silent exclusion from the population.

A gate counts as `assertFeatureEnabled` / `isFeatureEnabled` with a **string
literal** key: an operator holding the console must be able to find the flag
that gates a route, and a runtime-assembled key is not findable by reading the
route.

## Files

| File | Role |
| --- | --- |
| `src/app/api/admin/feature-flags/route.ts` | GET the raw table + `forcedOff`; PUT upserts and invalidates |
| `src/app/api/admin/feature-flags/cohorts/route.ts` | Cohort membership — sizes, members, idempotent add/remove |
| `src/lib/feature-flags.ts` | `FLAG_KEY_PATTERN` + `FLAG_KEY_MAX_LENGTH` hoisted here, shared by three artefacts |
| `src/lib/auth/guard.ts` | Edge opening: exact entry + children prefix, with the widening note |
| `tests/guards/social-routes-flag-gated.test.ts` | The gating rule, built for a zero population |
| `tests/unit/admin-feature-flags-console.test.ts` | 40 executing assertions, incl. the reachability pair |
| `tests/guardrails/api-permission-coverage.test.ts` | Two platform-key exclusions with reasons |
| `tests/guards/openapi-undocumented-baseline.json` | Both paths baselined; ceiling 239 → 241 |
| `src/generated/route-inventory.json` | Regenerated: 371 entries, both new paths `live` |
| `CLAUDE.md` | New section: the three rules, the console, the gating rule |

## Decisions

- **Cohort membership is in scope, and that is the difference between wired and
  delivered.** `FeatureFlag.cohorts` is the limited-rollout half of the design;
  with no operator path to POPULATE a cohort, setting one makes the flag
  unreachable for everybody and the mechanism is inert. The sibling route sets
  cohort NAMES on a flag; this one puts people in them.
- **No `invalidateFlagCache()` on a membership change**, and the omission is
  deliberate rather than forgotten. `readFlagTable` caches the TABLE;
  `cohortsFor` is read per request by design. Copying the sibling's call here
  would throw away every flag's cached row to no effect, costing every flag
  read a database round-trip. Pinned by an executing assertion, because the
  obvious move is to copy it.
- **Membership is by `userId`, not email.** Resolving an email means a 17th
  `hashForLookup` call site, added in the week before P1.1 re-keys that
  derivation onto `LOOKUP_HMAC_KEY` — a site the migration has to find, with
  nothing pointing it there. `GET /cohorts` with no argument lists cohort SIZES
  so the console is self-describing: a flag naming a zero-member cohort reads
  as a live rollout and is off for everyone.
- **`updatedByUserId` is left NULL.** The credential is an API key, so there is
  no user in scope. Accepting an actor id from the body would put a
  caller-supplied name in an attribution field, which is worse than an absent
  one — asserted, so a later "fill in the field" change has to argue with a
  test. The real platform audit chain is P1.9 (`PlatformAuditLog`).
- **GET returns the raw table, not a resolved view.** An operator opens this
  screen to see that a flag is enabled-but-cohort-gated, which `/api/auth/me`
  deliberately collapses to one boolean per caller. `forcedOff` rides along
  because it overrides every row; a console showing `enabled: true` while every
  client sees the flag off would be worse than no console. The rows are NOT
  rewritten to false under the kill switch — that would misreport what a
  flip-back does.
- **Omitted `cohorts` is written as `[]`, never left undefined.** `undefined` in
  a Prisma `update` means "leave it alone", so omitting cohorts on a flag that
  HAS them would quietly keep the old narrowing while the operator believes
  they just opened it to everyone. `description` keeps the three-state
  contract: absent leaves it, explicit `null` clears it.
- **Baselined in OpenAPI rather than described.** All twelve non-tenant
  `/api/admin/*` paths are baselined, these two included — nine of them
  platform-key routes like this one, plus `diagnostics` on an admin session. The
  consumer here is an operator with `curl`, not a client that reads the spec.
  Raising `UNDOCUMENTED_CEILING` is the visible line that guard's own error
  message asks for.
- **`FLAG_KEY_PATTERN` moved into `@/lib/feature-flags`.** It started as a copy
  in the guard with a note explaining why the duplication was acceptable. It
  was not: the property being asserted is that the console and the gate AGREE,
  and a check owning its own copy of one side's rule cannot see them disagree.
  The console test drives the real route over a 15-key table classified by the
  shared pattern, with a meta-assertion that the table straddles the boundary —
  otherwise a pattern mutated to `/.*/ ` would leave every row agreeing with the
  broken pattern.

## What the proofs caught

Three defects, none of which a green run would have shown:

1. **An interpolated template key read as a literal.** `gateKeys` matched
   `(['"`])([^'"`]*)\1`, and `` `social.${surface}` `` contains no quote
   character — so the body matched end to end and a COMPUTED key satisfied the
   literal check this guard exists to enforce. Found by the synthetic mutation
   table, fixed by excluding `$` and `{` from the body (and `+` not `*`, so an
   empty literal is not a findable key either).
2. **A hand-rolled walk that reported a failed look as zero.** `pagesUnder`
   returned `[]` for a missing directory — the same answer it would give for a
   RENAMED root. Caught by two meta-guards (`scan-roots-resolve`,
   `file-collection-is-not-silently-empty`). The fix is structural: collect
   every `page.tsx` under `src/app` with `collectSourceFiles` (which throws on
   an unresolved root and enforces a floor) and filter by prefix, so the
   denominator is verified and a zero in the subset is a fact about the repo
   rather than about the walk.
3. **The Edge 401.** Covered above.

Four mutations of the routes were run against the console test, with the
sources md5-restored afterwards: deleting `invalidateFlagCache()` (1 red),
deleting the gate from the GET read path (5 red), defaulting `cohorts` to
`undefined` (8 red), dropping `skipDuplicates` (1 red).

## Not in this change

- **The flag console UI.** There are no platform-level admin PAGES in this
  codebase at all — every `admin/` page lives under `[tenantSlug]` — so a
  console screen means a new chrome, a new layout and a new auth model for a
  surface whose only caller today is an operator with `curl`. The API is what
  unblocks P2; a page is a separate, larger decision. Refs #1191.
- **`FLAG_EXEMPT` entries.** Account deletion and the DSA notices are legal
  duties and exempt from flags, but neither route exists yet, and an exemption
  for a path that does not exist is cover for a path that might never match it.
