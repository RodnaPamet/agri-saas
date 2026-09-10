# 2026-09-10 — the structural overrides-decay guard

**Commit:** `<pending> feat(deps): structural overrides-decay guard, offline and waivered`

## Design

Two decayed floors were fixed in #853, six weeks after three others were
re-floored on 2026-07-25 (`docs/dependency-policy.md`). Two occurrences of
one class in six weeks is a class. The entry-by-entry fix resets the clock;
this guard is the thing that stops the next one — for the half of the
problem that is decidable.

### The constraint that shaped everything

"This floor has decayed" is a statement about the **GitHub Advisory
Database at time T**, not about the repo. It is not a function of
`package.json` + `package-lock.json`, so a guard claiming to compute it
would be lying about its own subject. Three concrete reasons the network
version is worse than nothing on the merge path:

1. `scripts/audit-exemptions.mjs` already documents that npm's bulk
   advisory endpoint returns `200 {}` **both** for "no advisories" and for
   "package not recognised". "Found nothing" and "checked nothing" arrive as
   identical bytes, so a network guard fails **open** on registry
   degradation — the precise defect that file exists to prevent.
2. The advisory endpoint serves **withdrawn** advisories:
   `affects=uuid@11.1.1` returns GHSA-qmq6-f8pr-cx5x, withdrawn as a
   duplicate. A naive checker would have flagged this repo's one runtime
   security floor as decayed on the day it shipped.
3. A merge gate that needs the network is a merge gate that is sometimes
   not a gate.

So the guard answers a smaller, **decidable** question instead: does each
entry still do the structural job an override is for?

### The four checks

```
package.json.overrides ──┐
                         ├─► analyseOverrides()  (pure, no fs/net/clock)
package-lock.json ───────┘         │
                                   ├─ A  no floor without a target
                                   ├─ B  no override that cannot act
                                   ├─ C  no floor that isn't a floor
                                   └─ D  no silent widening
                                          │
                              Finding{check, target, detail}
                                          │
                     tests/guards/overrides-structural-decay.test.ts
                        │                       │              │
                   WAIVERS +            no-stale /        synthetic
                DORMANT_FLOORS          no-expired         fixtures
```

**A — no floor without a target.** A top-level key with no matching lockfile
entry. This is the most dangerous shape in the table, because npm audit sees
no package and Dependabot sees no dependency: the entry is invisible to
every other tool in the repo, which is how `hono` decayed twice. Such an
entry is either a defect or a deliberate **dormant floor**, and the
difference has to be written down — so A has its own list,
`DORMANT_FLOORS`, which goes stale the moment the package appears in the
lockfile (it is a live floor then, and C and D start applying).

**B — no override that cannot act.** npm scopes `{parent: {child: range}}`
to the parent's **own declared edge**. So the entry is inert if the parent
declares `child` in none of `dependencies` / `peerDependencies` /
`optionalDependencies`, or if every copy it resolves to is `inBundle: true`
(bundled bytes ship inside the parent's tarball; npm installs them as
published). Resolution uses npm's own walk-up, not a substring match.

**C — no floor that isn't a floor.** Every requester's declared range is
already a `semver.subset` of the override range, so it excludes nothing
anybody could have installed.

**D — no silent widening.** Two shapes: RELAXATION (the override's floor
sits below a requester's floor — npm may install something older than the
requester itself demands) and PIN-BREAK (the override excludes a version a
requester pinned exactly).

## Files

| File | Role |
|------|------|
| `tests/helpers/overrides-analysis.ts` | The pure analysis. No fs, no network, no clock — takes the two parsed JSON documents and returns findings, the flattened edge list, unparseable ranges, and unsupported nesting. |
| `tests/guards/overrides-structural-decay.test.ts` | The guard: live-tree verdict, the `WAIVERS` / `DORMANT_FLOORS` ledger with the stale + expiry rules, positive controls, an in-memory mutation proof over the real `package.json`, and synthetic fixtures per rule. |
| `docs/dependency-policy.md` | New "Structural decay" section (the four checks, why there is no advisory query, and what the guard explicitly does not cover); the `@visx/*` row corrected — twelve of its twenty-two subkeys are inert. |
| `tests/guards/dependency-governance-integrity.test.ts` | Registers the new guard as the sixth dependency pillar, so a guard carrying waivers cannot be silenced by deleting the guard. |

## Decisions

- **D reports two shapes, not "admits any excluded version".** The literal
  reading was implemented and measured first: it fires on **14 of the 39**
  entries — every legitimate security floor in `dependency-policy.md`,
  because forcing `uuid@^11.1.1` past `next-auth`'s `^8.3.2` *is* what a
  floor does. A rule that must waive a third of its own subject on day one
  teaches people to add waivers. RELAXATION and PIN-BREAK are the subset of
  that reading which is never what an override is for, and they still catch
  both cases the brief named: the `@typescript-eslint/*` family (below
  `eslint-plugin@8.70.0`'s exact sibling pins and its `parser: ^8.70.0`
  peer) and `postcss` (`$postcss` → `^8.5.28` against `next`'s exact
  `8.5.23`).

- **`$name` entries are exempt from C by construction, and the exemption is
  load-bearing.** `tests/guards/overrides-no-direct-dep-conflict.test.ts`
  asserts `overrides.sharp === '$sharp'` literally, after a repeated literal
  range on a direct dependency aborted an entire Dependabot run — every
  update, including security ones. A "this floor excludes nothing" complaint
  about `$sharp` would put two guards in direct contradiction. There is a
  fixture pinning the non-collision.

- **Waivers are keyed on the OVERRIDE, never on a lockfile path.** Paths
  churn on every hoist (`node_modules/typescript-eslint/node_modules/@typescript-eslint/eslint-plugin`
  appears and disappears with unrelated bumps). A ledger that went stale on
  mechanical Dependabot bumps would train people to delete entries without
  reading them, which is the failure mode the ledger exists to prevent.

- **31 findings shipped as waivers rather than as fixes.** Every check is
  red on today's tree, and a guard that arrives already-failing gets
  skipped — `.trivyignore`'s eight dead entries and the post-merge-only
  coverage job are both in this repo's history. The two dependency fixes the
  guard surfaces (raise the five `@typescript-eslint` floors and
  `picomatch`; delete the twelve dead `@visx/*` subkeys and `npm: {undici}`)
  are deliberately **not** in this diff: a guard that also moves the thing it
  measures cannot be reviewed, and the second of those touches
  `package.json` on a checkout another session shares.

- **Unparseable ranges are collected, not skipped.** Both C and D fail
  toward green on a range they cannot parse — C must prove *all* requesters
  are subsets, D must prove a specific relation. That is exactly the shape
  that rots into a tautology, so `unparseableRanges` is returned and the
  guard asserts it is empty (it is, across 2,101 lockfile entries).

- **Positive controls on every selection.** An empty selection passes every
  rule here. So the guard asserts, before trusting any verdict: the
  overrides block is non-trivial (>5 keys, >40 flattened edges); the
  lockfile scanner resolves a package that is definitely installed; the
  requester scanner finds `next`'s declared `postcss` edge; check B leaves
  `@visx/axis > react`, `@visx/tooltip > react-dom` and `next-auth > next`
  green; and at least twelve override keys are covered and **clean** rather
  than merely waived.

- **What this does not cover, said in the doc rather than left implied.** It
  would not have caught the 2026-07-25 or #853 re-floors themselves — those
  were advisory-relative, and the ranges were structurally sound. It also
  does not notice an uncovered copy of an overridden package (#853's third
  half; live today, `js-yaml@5.4.1` sits at the lockfile root under no
  override while three nested entries floor the other three copies). That
  fifth check is decidable and was measured — two findings, `js-yaml` and
  `undici` — but was left out rather than shipped shaky.
