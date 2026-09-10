# Dependency installation policy

> Part of the dependency-governance model — see
> `docs/dependency-governance.md` for the four-pillar overview, the
> contributor lifecycle (adding / upgrading / removing a
> dependency), and the NextAuth stay-on-v4 policy. This document is
> the **install-time** layer: strict peers, `npm ci`, the
> `overrides` table, Node/npm pinning.

## Strict peer-dependency resolution

Installs are **strict**. No install path passes `--legacy-peer-deps`.
npm validates the peer-dependency graph on every `npm install` /
`npm ci`, so an incompatible package combination fails fast instead
of being silently absorbed.

`--legacy-peer-deps` used to be on every install step (`Dockerfile`,
all `.github/workflows/*`). It disabled peer validation wholesale —
which masked real incompatibilities. Removing it surfaced three
genuine conflicts left behind by the Next 14 -> 16 and React 18 ->
19 migrations; all three are now resolved (see below).

The ratchet `tests/guards/no-legacy-peer-deps.test.ts` fails CI if
the flag re-enters any install path.

## Resolved conflicts

| Conflict | Cause | Resolution |
|----------|-------|------------|
| `@visx/*@3.x` vs React 19 | visx 3.x (the latest stable line) peers `react ^16 \|\| ^17 \|\| ^18`; visx 4 — which adds React 19 — is alpha-only. The repo runs `react@19`. | `overrides` block: each `@visx/*` package's `react` / `react-dom` pinned to the root version (`$react` / `$react-dom`). visx 3.x is a set of stateless SVG renderers and runs correctly under React 19 — the override records that verified fact. |
| `eslint-config-next@16` vs `eslint@8` | The Next 16 upgrade bumped `eslint-config-next` to 16, which peers `eslint >=9`; `eslint` was left at 8 (now end-of-life). | `eslint` bumped to `^9`. The lint setup already uses flat config (`ESLINT_USE_FLAT_CONFIG=true`), so eslint 9 — where flat config is the default — is a natural fit. |
| `next-auth@4` vs `next@16` / `nodemailer@7` | `next-auth@4` peers `next ^12 \|\| ^13 \|\| ^14` and (optionally) `nodemailer ^6`. The repo runs `next@16` and `nodemailer@7`. | `overrides` block: `next-auth`'s `next` and `nodemailer` pinned to the root versions. NextAuth v4 is the supported stable line here; it operates correctly on next 16 / nodemailer 7. |
| `@typescript-eslint/eslint-plugin@8.70` vs `eslint-config-next`'s `typescript-eslint@^8.46.0` | The plugin pins its siblings at `8.70.0` EXACTLY and peers `@typescript-eslint/parser` at `^8.70.0`. `eslint-config-next` pulls the `typescript-eslint` meta-package on a range so loose (`^8.46.0`) that npm will hold whatever the lockfile already had, which strands the parser on an older line and breaks the plugin's peer. | `overrides` block: the `typescript-eslint` META entry alone, floored at the installed line. It is the single edge that lags; once the meta moves, its own exact `8.70.0` pins carry parser / typescript-estree / utils / scope-manager / type-utils with it. Five per-package entries formerly did this and were DELETED in the same change — a bare top-level override rewrites PEER edges too, so they silently re-satisfied the plugin's `^8.70.0` parser peer with 8.65.0 and hid the violation they were added to prevent. With them gone the override can no longer rewrite that peer edge, so the top level resolves honestly — but that is NOT an install-time alarm, and an earlier version of this row claimed it was. Measured on npm@11.19.0 / node 22: a forward skew (the direct plugin bumped past the meta floor) exits 0 with NO ERESOLVE — npm keeps the top-level family lockstep at the plugin's version with its `^8.70.0` parser peer genuinely satisfied, and NESTS the lagging meta's whole family under `eslint-config-next` instead. The gain is a correct top-level resolution, not a loud failure. ERESOLVE was reproduced only in the different configuration where the meta entry is ALSO deleted, which is the reason it is kept. `npm run lint` stays the check that exactly one `@typescript-eslint` plugin instance is registered. |

## The `overrides` block

`package.json` carries an `overrides` block that pins the peers
above to the real installed versions. This is deliberately
**granular** — it names exactly which peer mismatches are accepted,
and why (this document). It is the opposite of the blanket
`--legacy-peer-deps`: every *other* package's peers are still
validated strictly, so a new incompatible dependency is caught at
install time.

When a package in the table ships a release whose peer range
genuinely includes the version we run, drop its `overrides` entry —
the override is a bridge, not a destination.

## Security overrides

`overrides` also force a **patched transitive dependency** when an
advisory lands against a version pulled in by a package we don't
control. The CI `Security` job (`npm audit --omit=dev
--audit-level=moderate`) blocks merges on MODERATE+ advisories in
production deps, so an un-fixable transitive CVE would otherwise
wedge the whole pipeline.

| Override | Advisory | Why |
|----------|----------|-----|
| `uuid` → `^11.1.1` | GHSA-w5hq-g745-h8pq — missing buffer bounds check in uuid v3/v5/v6 when `buf` is provided (moderate) | `next-auth@4` declares `uuid@^8.3.2`; the whole `<11.1.1` line is vulnerable, so the only fix is forcing the patched major. `next-auth` uses the version-stable named `uuid` exports (`v4`, …), which are unchanged v8 → v11. Drop this entry if `next-auth` itself moves to a patched `uuid` range. |
| `hono` → `^4.12.27` | GHSA-hvrm-45r6-mjfj — `hono/jsx` does not isolate context per request, leaking data across requests; affects `>=4.11.8 <4.12.27` (moderate) | Arrives transitively through `@prisma/dev` (#367). `hono` currently resolves to **no** instance at all — prisma 7.9.0 dropped it — so this is a floor for if it returns, not a live rewrite. |
| `tmp` → `^0.2.7` | GHSA-7c78-jf6q-g5cm — path traversal via a type-confusion bypass of `_assertPath`; affects `>=0.2.6 <0.2.7` (high) | Transitive via `fengari` + `patch-package`. #828 pinned `^0.2.6` for the earlier traversal (GHSA-ph9p-34f9-6g65); the follow-up advisory affects 0.2.6 itself. Lockfile already resolves 0.2.7. |
| `protobufjs` → `^8.6.6` | GHSA-j3f2-48v5-ccww — DoS via an infinite loop in `.proto` parsing; affects `>=8.0.0 <=8.6.5` (moderate) | Pulled by the OpenTelemetry OTLP exporter, which sits in the production tree. #421 pinned `^8.2.0` for GHSA-jggg-4jg4-v7c6 (fixed 8.2.0); that floor was later superseded. Lockfile resolves 8.7.1. |
| `@eslint/eslintrc` → `{js-yaml: ^4.3.2}`, `cosmiconfig` → `{js-yaml: ^4.3.2}`, `@istanbuljs/load-nyc-config` → `{js-yaml: ^3.15.2}` | GHSA-2883-xcg3-v3hh — `maxTotalMergeKeys` does not limit CPU use for empty merge sources (high). TWO ranges: `>=4.0.0 <4.3.2` (patched 4.3.2) and `>=3.0.0 <3.15.2` (patched 3.15.2). | Scoped, not bare: the root devDependency is `js-yaml@^5.4.1` and `@istanbuljs` needs the 3.x line, so a bare `js-yaml` key would force a major break on one of them. The first two floors had DECAYED — `^4.3.1` and `^3.15.1` each sit inside their own advisory's range, so they excluded nothing; `@eslint/eslintrc` and `cosmiconfig` both resolved the vulnerable 4.3.1. `cosmiconfig` had no override at all and is the reason fixing only the named entry would have left half the exposure standing. All three are dev-scope, so the `--omit=dev` gate never saw them — Dependabot did, and could not fix them because they are nested transitives. |
| `picomatch` → `^4.0.7` | CVE-2026-33671 — ReDoS in pattern compilation (high); **patched at 4.0.4** | Bare, not scoped: every requester must land on the 4.x line, and the two `^2.x` requesters (`anymatch`, `micromatch`) are glob matchers whose picomatch surface is version-stable across the major. **Read the raise correctly: `^4.0.4` → `^4.0.7` is floor-decay hygiene, NOT a security fix.** This repo's own record fixes the patched version at 4.0.4 — `git show 87af96901^:.trivyignore` reads "picomatch < 4.0.4 RegEx DoS" — so the previous `^4.0.4` was already above the advisory, as is every production requester today (`@parcel/watcher` declares `^4.0.4`). What had decayed is the floor's GRIP: `lint-staged` declares `^4.0.7`, so `^4.0.4` excluded nothing it could reach and additionally ADMITTED versions lint-staged itself rejects — the lockfile resolved 4.0.5 against that `^4.0.7` edge. `npm audit` cannot see this (the resolved version is patched), which is why it sat. Measured, so the entry is not oversold: deleting this override AND every picomatch lock entry, then re-resolving with npm@11, still yields picomatch 4.0.7 `dev: false` — identical to HEAD. This override is a GUARANTEE AGAINST FUTURE DRIFT, not the only thing holding today's line. Keep it, because the exposure is real: picomatch is a PRODUCTION dependency — `npm ls picomatch --omit=dev` reaches it through `@sentry/nextjs` → `@rollup/plugin-commonjs` → `@rollup/pluginutils` / `fdir`, and through `next-intl` → `@parcel/watcher`. The hoisted copy is `dev: false`, survives `npm prune --omit=dev` (Dockerfile:85) and ships in the image Trivy scans (Dockerfile:171), where `@rollup/*` at `^4.0.2` and `fdir` at `^3 \|\| ^4` would admit a pre-patch version if resolution moved. No exemption would mute the finding if it slipped: `.trivyignore` carries nothing for this id, because 87af96901 (#647) deleted all eight entries. The id WAS exempted once, on the argument that the only vulnerable copy lived inside the bundled npm CLI — which `Dockerfile:213` deletes outright — so that entry and that argument are both gone. See `tests/guards/trivyignore-exemptions.test.ts`. |

A security override is NOT a bridge to drop on convenience — keep it
until the upstream package legitimately depends on a patched range.

**A floor is only a fix while it still excludes every vulnerable
release.** All three entries above were raised on 2026-07-25 after an
audit against the GitHub Advisory Database found their ranges had
decayed into admitting a version the recorded advisory still affects —
`hono` at `^4.12.25` against a 4.12.27 fix, `tmp` at `^0.2.6` against
an advisory affecting 0.2.6, `protobufjs` at `^8.2.0` against a fix in
8.6.6. In each case the lockfile happened to sit on a patched version,
so `npm audit` was green and nothing in the repo was wrong-looking —
which is exactly why the floor, not just the lockfile, has to be
checked when a follow-up advisory lands on a package already pinned
here.

## Structural decay — what a guard CAN decide offline

The three 2026-07-25 re-floors above were followed six weeks later by
two more (#853), which makes decay a **class**, not an accident. An
entry-by-entry fix resets the clock; it does not stop the next one.

The obvious guard is the one this repo must never build. **"This floor
has decayed" is a statement about the GitHub Advisory Database at time
T, not about the repo** — no function of `package.json` +
`package-lock.json` can decide it, so a guard claiming to compute it is
lying about its own subject. Worse, putting the query on the merge path
reproduces the exact defect `scripts/audit-exemptions.mjs` exists to
prevent: npm's bulk advisory endpoint answers `200 {}` both for "no
advisories" and for "package not recognised", so a network guard fails
**open** on registry degradation. And the advisory endpoint serves
WITHDRAWN advisories — `affects=uuid@11.1.1` returns
GHSA-qmq6-f8pr-cx5x, withdrawn as a duplicate — so a naive checker would
have flagged this table's one runtime security floor as decayed on the
day it shipped. **There is no advisory query on the merge path.**

What IS decidable offline is whether each entry still does the
structural job an override is for.
`tests/guards/overrides-structural-decay.test.ts` (analysis in
`tests/helpers/overrides-analysis.ts`) runs four checks as a pure
function of the two JSON files:

| Check | Rule | Why it is the decay shape |
|-------|------|---------------------------|
| **A — no floor without a target** | Every top-level override key must match at least one lockfile entry, or be listed as a **dormant floor** with a written reason. | `hono` / `@hono/node-server` guard packages absent from the lockfile, so they are invisible to `npm audit` AND to Dependabot. That is how both decayed twice with nothing going red. |
| **B — no override that cannot act** | For `{parent: {child: range}}`, the parent must declare `child` in one of `dependencies` / `peerDependencies` / `optionalDependencies`, and at least one copy it resolves to must not be `inBundle: true`. | `npm: {undici}` fails on both counts — npm declares no `undici` (it is a transitive of a bundled dep) and the only copy is bundled bytes npm installs as published. Twelve `@visx/*` subkeys fail on the first. |
| **C — no floor that isn't a floor** | For a literal range, fail when every requester's declared range is already a `semver.subset` of it. `$name` entries are EXEMPT. | A floor that excludes nothing anyone could install still reads as protection in review. The `$name` exemption is load-bearing: `tests/guards/overrides-no-direct-dep-conflict.test.ts` requires that form on a direct dependency after a literal range aborted an entire Dependabot run. |
| **D — no silent widening** | Fail when the override's floor sits **below** a requester's floor (RELAXATION), or excludes a version a requester **pinned exactly** (PIN-BREAK). | Both halves have live examples. RELAXATION is what the five `@typescript-eslint/*@^8.61.0` entries and `picomatch@^4.0.4` were — floors sitting below `eslint-plugin@8.70.0`'s exact sibling pins and below `lint-staged`'s own `^4.0.7`, i.e. "floors" permitting older than anything in the tree asked for. They were retired and raised in the change recorded in the `@typescript-eslint/eslint-plugin` row of the conflicts table and the `picomatch` row of the security table above, which is why the check no longer reports them. PIN-BREAK is still live on three entries: `postcss` (`next` pins 8.5.23 exactly), `deepmerge-ts` (`@prisma/config` pins 7.1.5) and `mysql2` (`prisma` pins 3.15.3). |

Check D deliberately does **not** flag an override whose floor sits
*above* a requester's caret range — `uuid@^11.1.1` over `next-auth`'s
`^8.3.2` is what a security floor IS. Measured twice on 2026-09-10, the
unrestricted reading ("flag any `!semver.subset(override, requester)`")
fires on 14 of the 39 entries in the tree the guard was written against
and on 9 of the 34 that remain after the `@typescript-eslint` /
`picomatch` change — both times on every legitimate security floor in
this document (`uuid`, `protobufjs`, `valibot`, `picomatch`) plus the
`next-auth` peer bridge. A rule that must waive a quarter to a third of
its own subject on day one teaches people to add waivers.

**Every check was red when the guard was written** — 31 findings over 39
entries. Eleven of those were a single dependency defect wearing eleven
hats — the five `@typescript-eslint` entries, reported by C **and** D
because a floor below every requester both excludes nothing and permits
something older, plus `picomatch` on D — and that fix landed
first: the guard is merged on top of it and ships against **20 findings
over 34 entries**, with all four checks still red. So it ships with an
explicit waiver list (`WAIVERS` and `DORMANT_FLOORS` in the guard), one
entry per remaining finding, each carrying a written reason and a
`review` date. It borrows both sharp rules from
`scripts/audit-exemptions.mjs`: a **stale** waiver fails the build (the
finding stopped being produced, so the waiver is now a blind spot), and
an **expired** waiver fails the build once its own author's review date
passes. The list can therefore only shrink.

**What the guard does NOT cover, stated so nobody reads it as more than
it is:** it would not have caught the 2026-07-25 or #853 re-floors
themselves, because those were advisory-relative — the ranges were
structurally sound and merely no longer excluded a version the advisory
still affected. It also does not notice a copy of an overridden package
that no override entry covers (#853's third half, and live today:
`js-yaml@5.4.1` sits at the lockfile root under no override while three
nested entries floor the other three copies). Those remain the
reviewer's job, and this document is where the reasoning goes.

**One hole in the analysis was found by #866 and closed there**, and it
is recorded because the shape recurs: `unparseableRanges` was documented
as collecting any range the guard cannot parse, and collected only the
ranges *requesters* declare. An override's OWN value was never examined,
so `"sharp": "not-a-parseable-range"` — a value npm cannot apply at all —
produced no finding from any of A/B/C/D (C and D both skip an
unparseable value) and no entry in that list either. The most broken
entry possible was the one entry nothing reported. `analyseOverrides`
now records every override value that is not a usable range, including a
`$name` reference the root package does not declare.

## Regression ceilings

The two categories above are both **floors** — force a transitive
dependency *upward* to a patched or compatible release. A ceiling is
the opposite and rarer case: upstream shipped a release that is
*broken for us*, so the pin excludes everything from that release on.

A ceiling is a liability the moment it stops being true, because it
also excludes the eventual fix. Each entry therefore records the exact
broken behaviour and what must be re-measured before the ceiling is
raised.

| Override | Defect | Why the ceiling, and how to lift it |
|----------|--------|-------------------------------------|
| `nwsapi` → `>=2.2.16 <2.2.25` | Three separate defects in the 2.2.25+ line, all under jsdom. **2.2.25**: `:focus-visible` matches nothing — its emitter requires `localName` ∈ `/input\|select\|textarea/` *and* (`contenteditable` \|\| `keyboardFocus`), and jsdom never sets `keyboardFocus`. **2.2.25**: `:open` compiles to code referencing an undefined `media`, throwing `ReferenceError`, which poisons any selector list containing it. **2.2.26+**: `matchesNative` resolves `_matches \|\| node.matches`, but `_matches` is only assigned inside `install()`, which jsdom never calls — so `node.matches` re-enters jsdom's own `Element.prototype.matches` and closes a loop. `querySelectorAll(':modal')` and `closest(':modal')` hang outright; `matches(':modal')` returns after **~2.4 s per call, with no amortisation**. | `nwsapi` is an unpinned `^2.2.16` transitive of `jsdom`, so it re-resolves on *any* dev-dependency install and rides along unnamed in every lockfile regeneration — which is how it entered #828 and caused #830 while the PR's own lock patch mentioned it zero times. The 2.2.26+ stall is reached from `@floating-ui`'s `isTopLayer()` (`element.matches(':modal')`), called by `@radix-ui/react-popper` on every reposition, so any Radix popover/select/tooltip test pays it: measured 6 of 10 tests in `tests/rendered/dashboard-grid-and-picker.test.tsx` each burning a full 30 s timeout. Nothing in this repo queries `:focus-visible` or `:focus-within` through a selector engine (the 200-odd hits are Tailwind class-name variants, which jsdom never evaluates), so the ceiling costs us nothing today. **To lift it:** confirm upstream restores a non-recursive `matchesNative` under jsdom — re-run the version matrix in #830 with a positive control (`:focus-visible` must differ between 2.2.24 and 2.2.25, or the engine swap did not take) and time `isTopLayer()`; a version is only safe if `querySelectorAll(':modal')` returns and `matches(':modal')` is sub-millisecond. |

## Deterministic installs — `npm ci`

Every install path — the `Dockerfile` and all CI workflows — runs
**`npm ci`**, never `npm install`:

| | `npm install` | `npm ci` |
|---|---|---|
| Lockfile | may be **mutated** (re-resolves semver ranges) | read-only; install fails if it drifts from `package.json` |
| Reproducibility | two runs of one commit can differ | identical tree every run |
| Corrupt lockfile | silently "repaired" | **surfaced** as a hard error |

`npm ci` is therefore both the install command AND the
lockfile-integrity check — there is no separate CI step for it. A
stale or hand-mangled `package-lock.json` fails fast in every job
instead of being papered over.

Enforced by `tests/guards/deterministic-install.test.ts`, which
fails CI if any install path reverts to `npm install`.

### A worked example — the `@next/swc-*` corruption

Adopting `npm ci` immediately surfaced a real defect that
`npm install` had been masking: a stale `optionalDependencies`
block in `package.json` pinned all nine `@next/swc-*` platform
binaries to the **Next 14** version `14.2.35` — a leftover from the
Next 14 → 16 migration, never updated. `@next/swc-*` are `next`'s
own transitive optional dependencies; a consumer project must never
pin them. The stale block conflicted with `next@16.2.6`'s own SWC
deps and corrupted the lockfile — exactly the kind of
incompatibility `npm install` absorbs silently. The fix: delete the
block — `next` resolves its own platform binaries.

`tests/guards/swc-version-coherence.test.ts` now makes the skew
unrepeatable: it fails CI if `package.json` pins any `@next/swc-*`
package directly, or if any `@next/swc-*` entry in the lockfile
carries a version other than the resolved `next` version. Re-add a
pin and the platforms desynchronise from `next` — the guard catches
it before merge.

## Node / npm

Node **22** across every environment, pinned in three places that
`deterministic-install.test.ts` keeps in agreement:

- **`.nvmrc`** (`22`) — `nvm` / `fnm` auto-select it.
- **`engines`** in `package.json` (`node >=22 <23`, `npm >=10`) —
  declares the supported runtime; npm warns on a mismatch.
- **CI / container** — `NODE_VERSION` in `ci.yml`, the literal
  `"22"` in `release.yml` / `deploy.yml` / `load-test.yml`, and the
  `node:22-alpine` base image in the `Dockerfile`.

npm ships with Node 22; no separate npm install step is required.
