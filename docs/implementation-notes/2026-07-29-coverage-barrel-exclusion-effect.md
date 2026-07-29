# 2026-07-29 — the barrel coverage exclusion, made real

**Supersedes:** PR #445 (`chore(coverage): exclude pure re-export barrels
from the denominator`), whose exclusion never took effect.

## The defect

#445 added `PURE_REEXPORT_BARRELS` to `jest.config.js` and appended
`!`-prefixed negations to `sharedCollectCoverageFrom`, which both
projects then referenced as `collectCoverageFrom`.

The reasoning was right. TypeScript compiles `export { X } from './m'`
into `Object.defineProperty(exports, 'X', { get: function () { … } })`,
and istanbul counts each getter as a FUNCTION. A barrel with no logic
contributes permanently-uncovered "functions" that exist only in the
emitted JavaScript — there is nothing in the source to test.

The mechanism was wrong. **`collectCoverageFrom` is a GlobalConfig
option.** Jest reads it in exactly two places, both from the global
config:

- `jest-runner` hands `globalConfig.collectCoverageFrom` to the runtime,
  which passes it to `shouldInstrument` as the instrument-time filter;
- `@jest/reporters::_addUntestedFiles` reads
  `globalConfig.collectCoverageFrom` to decide which never-loaded files
  to add at 0%.

Written inside a `projects:` entry it is never consulted. And because
`readConfigs` normalises each `projects:` entry **standalone** — nothing
at the top level is inherited by a project — the top-level
`coveragePathIgnorePatterns: ['/node_modules/', '/.next/', '/tests/']`
was inert for the same reason, in the opposite direction.

So the effective denominator was neither of the things the config
described. It was *every file some test happened to load*, minus each
project's default `["/node_modules/"]`. Two observations from the
published artifact of run 30456542044 confirm it:

- 763 of 1009 files in the `global` threshold group sit outside
  `src/app-layer/` and `src/lib/` — the only two roots the positive
  `collectCoverageFrom` scope listed;
- `tests/helpers/db.ts`, `scripts/import-products.ts` and
  `jest.config.js` itself are all in the report, though `/tests/` was
  supposedly filtered.

## Why the old guard passed

`tests/guards/coverage-barrel-exclusion.test.ts` asserted that the
config CONTAINED a negation per barrel, and that each listed file was a
pure re-export. Both were true the whole time. It never asserted the
file had LEFT THE REPORT — shape, not outcome.

The pre-merge verification had the same hole from the other side. It was
a scoped run: one test file, one project. The barrel was absent from the
resulting summary, which was read as success. But that run never
*loaded* the barrel, and a file jest never loads is absent from the
report whether or not it is excluded. The pass was vacuous.

That failure mode is reproducible on demand. `tests/unit/observability-
foundation.test.ts` imports the observability sub-modules directly, so a
`--coverage` run over it omits `src/lib/observability/index.ts` under
the OLD config *and* the new one. Point the same run at a probe that
imports `@/lib/observability` and the old config emits the barrel at
`2/27` functions.

## The fix

`coveragePathIgnorePatterns`, set on **both** projects — the one
placement jest honours (`shouldInstrument` tests it as
`config.coveragePathIgnorePatterns`, where `config` is the project).
Both projects matter because the report is merged: the UI barrels are
loaded by `tests/rendered/**`, the app-layer ones by the node suite.

The inert project-level `collectCoverageFrom` is deleted rather than
relocated. Hoisting it to the top level would *work*, and that is the
danger: it would drop `src/components/**` + `src/app/**` from the report
entirely and force-include never-loaded files at 0%, redefining the
population every floor in `jest.thresholds.json` describes. It would
also revive `!src/**/types.ts`, which today would delete genuinely
tested code (`src/lib/errors/types.ts` alone is 26/26 functions
covered).

The top-level `coveragePathIgnorePatterns` is deleted too. `/tests/` was
deliberately NOT carried into the project-level list: making it
effective is a denominator change, not a bug fix — measured at
-0.32pp on `global` functions, because test helpers are well covered —
and it would still leave `scripts/` and `prisma/` in the report. That
belongs in its own PR with its own floor recalibration.

## The guard

Two halves, because the old one only had the first.

**Purity** (kept verbatim, including the prose-vs-code detector and its
two mutation proofs): a listed file that grows a
`const`/`function`/arrow/`class` fails CI, so the list cannot become a
place to hide untested logic.

**Effect**: a real instrumented Jest pass over
`tests/fixtures/coverage/barrel-probe.ts` — a fixture whose only job is
to `import * as … from '@/lib/observability'` — followed by three
assertions on the emitted `coverage-summary.json`:

1. a **sibling** of the barrel IS present — the run collected real
   coverage, so "absent" cannot be vacuous. This is the assertion the
   original verification was missing, and it is the one that keeps the
   guard honest if the probe ever stops loading the barrel;
2. the barrel is **absent**;
3. with the barrel patterns stripped from the child config, the barrel
   is **present** — proving the absence is caused by the exclusion, and
   that this guard fails against the pre-fix config.

The child config is the real config with the real `node` project spread
into it; only `globalSetup` / `globalTeardown` (DB bootstrap, irrelevant
to instrumentation) and `testMatch` are overridden. It deliberately
keeps the `projects: [...]` **shape**, because that shape is the bug: a
child flattened to a single project would honour a top-level
`coveragePathIgnorePatterns` that the real multi-project config ignores,
and would green-light a config that is broken in CI.

Two structural assertions back it up: every barrel must be excluded in
EVERY project, and no project may declare `collectCoverageFrom` at all.

Cost: ~5s (two child jest runs) on the `tests/guards/` CI step.

## Measured effect

Recomputed from the published artifact of main run **30456542044** by
removing the excluded files' per-file counters and re-aggregating the
threshold groups. Not a projection — the group math reproduces CI's
reported `62.65%` exactly. Excluding one file cannot change another
file's counters, so the subtraction is exact.

| group | metric | before | after | delta |
| --- | --- | --- | --- | --- |
| `global` | functions | 62.65% | **63.75%** | **+1.10pp** |
| `global` | branches | 63.24% | 63.24% | 0.00 |
| `global` | statements | 76.19% | 75.75% | −0.43pp |
| `global` | lines | 78.50% | 78.09% | −0.41pp |
| `./src/app-layer/usecases/` | functions | 77.64% | 78.41% | +0.77pp |
| `./src/lib/` | functions | 78.97% | 79.67% | +0.70pp |

`global` functions is the metric the gate currently fails on (floor 64).
The gap closes from 1.35pp to 0.25pp — it does **not** turn the gate
green on its own.

Branches do not move at all: these files have zero. Statements and lines
dip slightly because a barrel's `Object.defineProperty` calls are
trivially *executed* by any import — they were inflating those two
metrics in the same breath as they deflated functions. Both stay ~6pp
above their floors.

Nine of the sixteen sit in the `global` group. The other seven do not
move the failing number: `usecases/{audit-readiness,control,framework}`
and `lib/{audit,hooks,observability}` are claimed by path thresholds and
scored there instead, and `app-layer/notifications/index.ts` is never
loaded by any test, so it was not in the report to begin with.

## Files

| file | role |
| --- | --- |
| `jest.config.js` | `coveragePathIgnorePatterns` on both projects; inert `collectCoverageFrom` + top-level path filter removed; the global-vs-project placement rule documented where it bites |
| `tests/guards/coverage-barrel-exclusion.test.ts` | purity half kept; effect half added |
| `tests/fixtures/coverage/barrel-probe.ts` | fixture that loads a barrel so the exclusion has something to remove |
| `docs/coverage-policy.md` | "What is actually in the denominator" |

## Decisions

- **`coveragePathIgnorePatterns`, not `collectCoverageFrom`.** The only
  lever that removes a file without redefining the population the floors
  were calibrated against.
- **Patterns are anchored (`/…/index\.ts$`).** They are regexes against
  the absolute filename; unanchored, `.../table/index.ts` would match
  any longer path containing it.
- **`/node_modules/` is restated.** Setting the key REPLACES jest's
  default `["/node_modules/"]`, and the ESM transform allowlist means
  some `node_modules` files do get transformed and would otherwise be
  instrumented.
- **The list grew from 10 to 16.** Six more files are pure re-export
  barrels and were carrying 102 uncovered emit-artifact functions:
  `components/ui/charts` (48 — the single largest),
  `app-layer/libraries` (22), `lib/audit` (14), `app-layer/automation`
  (12), `components/ui/dashboard-widgets` (4), `lib/hooks` (2).
- **`components/ui/filter/index.ts` (32) and `components/ui/card-list/
  index.ts` (3) stay in.** They hold real runtime values —
  `const Filter = { Select, List }` and `Object.assign(...)`. They are
  the reason the purity rule exists; bending it for the two biggest
  remaining numbers would be the exact failure the rule prevents.
- **`icons/nucleo/index.ts` is kept in the list despite contributing 0
  uncovered functions.** It is 269 trivially-covered statements of pure
  re-export; leaving it in the denominator inflates statement coverage
  for the same structural reason the others deflate functions.
