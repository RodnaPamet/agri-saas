# 2026-09-10 — the structural overrides-decay guard

**Commits:** `<pending> feat(deps): structural overrides-decay guard, offline and waivered`
and `<pending> fix(deps): rebase the overrides guard onto the dependency fix,
retune its floor` — the branch merges
`fix/typescript-eslint-and-picomatch-floors` before it lands, for the reason
in "Rebased onto the dependency fix" below.

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
  entries in the pre-fix tree (re-measured after the merge: **9 of the 34**
  that remain) — every legitimate security floor in `dependency-policy.md`,
  because forcing `uuid@^11.1.1` past `next-auth`'s `^8.3.2` *is* what a
  floor does. A rule that must waive a third of its own subject on day one
  teaches people to add waivers. RELAXATION and PIN-BREAK are the subset of
  that reading which is never what an override is for, and they still catch
  both cases the brief named: the `@typescript-eslint/*` family (below
  `eslint-plugin@8.70.0`'s exact sibling pins and its `parser: ^8.70.0`
  peer — since fixed, see below) and `postcss` (`$postcss` → `^8.5.28`
  against `next`'s exact `8.5.23`, still live).

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

- **20 findings shipped as waivers rather than as fixes** (31 when the guard
  was written; 11 of them stopped being produced once the dependency fix was
  merged in — see below). Every check is still red, and a guard that arrives
  already-failing gets skipped — the eight dead `.trivyignore` entries #647
  deleted and the post-merge-only coverage job are both in this repo's
  history. The remaining dependency fix the guard surfaces — delete the
  twelve dead `@visx/*` subkeys and `npm: {undici}` — is deliberately **not**
  in this diff: a guard that also moves the thing it measures cannot be
  reviewed, and that edit touches `package.json` on a checkout another
  session shares. It is dated 2026-10-16 in `WAIVERS`.

- **Unparseable ranges are collected, not skipped.** Both C and D fail
  toward green on a range they cannot parse — C must prove *all* requesters
  are subsets, D must prove a specific relation. That is exactly the shape
  that rots into a tautology, so `unparseableRanges` is returned and the
  guard asserts it is empty (it is, across 2,097 lockfile entries).

- **Positive controls on every selection.** An empty selection passes every
  rule here. So the guard asserts, before trusting any verdict: the
  overrides block is non-trivial (>5 keys, >25 flattened edges); the
  lockfile scanner resolves a package that is definitely installed; the
  requester scanner finds `next`'s declared `postcss` edge; check B leaves
  `@visx/axis > react`, `@visx/tooltip > react-dom` and `next-auth > next`
  green; and at least twelve override keys are covered and **clean** rather
  than merely waived. The edge floor is deliberately set *below* the pending
  `@visx` deletion (which takes 46 edges to 33), because a population floor
  that the very fix this file schedules would turn red is the same trap as
  counting findings — see below.

- **What this does not cover, said in the doc rather than left implied.** It
  would not have caught the 2026-07-25 or #853 re-floors themselves — those
  were advisory-relative, and the ranges were structurally sound. It also
  does not notice an uncovered copy of an overridden package (#853's third
  half; live today, `js-yaml@5.4.1` sits at the lockfile root under no
  override while three nested entries floor the other three copies). That
  fifth check is decidable and was measured — two findings, `js-yaml` and
  `undici` — but was left out rather than shipped shaky.

## Rebased onto the dependency fix

The guard was written against a tree where five per-package
`@typescript-eslint` overrides sat at `^8.61.0` and `picomatch` at `^4.0.4`.
`fix/typescript-eslint-and-picomatch-floors` retires the five and raises
picomatch, which stops **eleven** of the 31 findings being produced — and a
stale waiver fails this build by design. So that branch is merged in here
first (merge, not rebase: the lane rule is never force-push) and the eleven
waivers are deleted rather than re-dated. Verified by running the guard, not
by reading the fix: `staleWaivers` named exactly those eleven, and reverting
the fix in `package.json` turns the guard red with exactly those eleven
findings, unwaived.

### The anti-vacuity floor is no longer a count

`expect(analysis.findings.length).toBeGreaterThan(20)` was the assertion
that the guard cannot silently start finding nothing. The merge took the
count to exactly 20, so it failed — and lowering it to 19 would have been
the wrong repair twice over:

1. **It ratchets against the fix.** Every waiver retired removes a finding,
   so the number only falls as the work goes right. It went red on a change
   that fixed six overrides entries; 19 re-arms the same trap one fix later,
   and an assertion whose failure mode is "somebody fixed something" teaches
   the reader to edit the assertion.
2. **A total cannot say WHICH check is alive.** 13 of the 20 findings are
   check B. Measured: neutering check A alone leaves the whole waiver
   bookkeeping silent — the two `DORMANT_FLOORS` entries that answer A have
   no staleness rule of their own — so a count set anywhere under 20 calls a
   dead check green.

It is replaced by four live proofs, one per check: the real `package.json`
and `package-lock.json` plus one injected defect, red on A, B, C and D. B and
C are new (a `next-auth` subkey on an edge next-auth does not declare; the
clean `nwsapi` ceiling widened until it restates jsdom's own range, with an
assertion that the *unmutated* entry is not reported). That floor does not
decay as the waiver list shrinks — it still holds when the tree is entirely
clean.

### Review dates re-argued

The twelve dead `@visx` subkeys, `npm > undici` and `@hono/node-server` move
to **2026-10-16**: each is a `package.json` deletion that cannot change
resolution, or a documentation row somebody can write today. The identical
"next dependency PR" argument dated the `@typescript-eslint` and `picomatch`
waivers 2026-10-16 and that PR landed five weeks early, so the easier change
does not get the later date. `find-my-way`, `nanoid`, `postcss`,
`deepmerge-ts` and `mysql2` keep **2026-12-11** — each needs a decision
somebody has to make first — and `hono` keeps **2027-01-16** as a periodic
re-read of a recorded advisory. The horizons are written into the guard so
the next reader inherits the argument and not just the dates.

### One defect found while proving the above

`expired()` read the live lists, so both of its fixtures depended on this
file still having entries in it — and the list is supposed to reach zero.
The day the last waiver is retired, "flags an entry whose review date has
passed" goes red with nothing wrong with the tree, and the obvious repair is
to delete the rule that makes the list shrink. `entries` is now a parameter
defaulting to the live lists; proven by emptying both lists (old fixture
fails, new synthetic one passes). The pair now also pins the
`audit-exemptions.mjs` boundary: due ON the review date, overdue the day
after.

---

## 2026-09-10 (later the same day) — #866: six selectors green while dead

The guard above was parked, not merged, because four review rounds found the
same defect class inside it — including inside the commit written to close
that class. Every control in the file fed input production never produces:
the live assertion ran on the real 20 findings, the control on a hand-made
fixture of 0 or 1. The two input sets never overlapped, so no control could
report that its selector had stopped discriminating.

Six defeats were measured on Node 22 and are now each red-then-green:

| # | Mutation | Before | After |
|---|----------|--------|-------|
| 1 | `if (findings.length > 0) return []` in `staleWaivers()` | 71/71 green | 1 failed |
| 2 | `"sharp": "not-a-parseable-range"` in `package.json`, **no guard mutation** | 45/45 green | 3 failed |
| 3 | `resolve()`'s `?? null` → `?? raw`, plus `"sharp": "$sharp-typo"` | 45/45 green | 3 failed |
| 4 | `if (findings.length > 1) return []` in `unwaived()` | 71/71 green | 1 failed |
| 5 | `return []` first in `stableDormantFloors()` (± a false `uuid` dormant floor) | 71/71 green | 1-2 failed |
| 6 | `if (1) return []` in `datedEntries()` (± a waiver back-dated to 2020) | 71/71 green | 2 failed |

### The rule the fix is built on

**A control must run the selector on the REAL tree's input with the defect
injected into it.** Not on a fixture beside it. Three of the four selectors
therefore take their list as a PARAMETER defaulting to the live list, so the
live assertion reads exactly as before while the control can pass the real 20
findings / the real lockfile / the real dated lists plus one injected defect.
The mutations above all key on INPUT SIZE, which is precisely what a
0-or-1-element fixture cannot exercise.

### Defeat 2 and 3 were a code defect, not a test defect

The helper's own "## Failing safe" docblock claimed an unparseable range is
NEVER silently dropped. `unparseableRanges` was populated only by
`requestersFor()`, for the ranges packages in the LOCKFILE declare — an
override's own value was never examined. So the most broken entry possible (a
value npm cannot apply at all) was the one entry no check reported: C and D
both `continue` on `!isParseableRange`, and the test named *every override
value resolves to a parseable range* asserted only `resolved === null`.
`collectValueDefects()` now records both shapes — a `$name` resolving to
nothing, and a value `semver.validRange` rejects — before any check reasons
about an edge, which is what makes the docblock describe the code.

### The `> 20` finding floor is not retuned, it is replaced

Re-measured on this tree: 34 override keys, 46 edges, exactly **20** findings
(A 2, B 13, C 2, D 3), 18 `WAIVERS` + 2 `DORMANT_FLOORS` accounting for all
20 with nothing stale. `> 20` was red by one on a tree with nothing wrong
with it; `> 19` would be red by one again on the next fix. There is no N that
is both a floor today and survives the work it is asking for, because the
quantity counts OPEN defects and the goal is zero.

The replacement floor is per check and it is ONE: each of A, B, C and D must
produce at least one finding on the real `package.json` + `package-lock.json`
under a single injected defect of its own shape. The injected defect is put
there by the test, so that floor holds when the tree is entirely clean. The
anti-vacuity properties the count carried are kept separately — the
population floors (>5 keys, >25 edges, >10 nested, >1000 lockfile entries),
which fall only when the overrides table itself shrinks, and *a substantial
set of overrides is covered and CLEAN*, which fails if everything ends up
waived.

### Left alone deliberately

The dated fuse is untouched. 15 of the 20 dated entries expire **2026-10-16**
— five weeks out — so CI goes red on 10-17 unless the dead `@visx` subkey and
`npm > undici` deletions land first. Every one of those entries is still
producing its finding today (the no-stale-waiver assertion proves it), so
none is stale and none was re-dated: the forcing function is the point.
