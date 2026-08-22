# 2026-08-23 — Two jest projects, two TypeScript targets, two coverage truths

**Commit:** `<pending> fix(test): align jest project targets so a file instruments identically`

Root cause of the coverage-parity failure. The sharded coverage gate and the
unsharded reference run disagreed on 53 files; the reason turned out to predate
sharding entirely.

## The finding

`jest.config.js` declares two projects, each handing ts-jest a tsconfig:

```
node   -> tsconfig.json                 target ES2017
jsdom  -> tests/rendered/tsconfig.json  target ES2020
```

`?.` and `??` are ES2020. Under ES2017 ts-jest **downlevels** them into
if/ternary chains, and istanbul instruments the EMITTED JS, not the source. So
the same file gets a different coverage shape depending on which project loaded
it. Measured on `src/components/ui/file-icon-resolver.ts`:

| loaded under | statements | branches |
| --- | --- | --- |
| `node` project | 26 | 30 |
| `jsdom` project | 26 | 25 |

Then the two paths diverge:

| scenario | result |
| --- | --- |
| one process, both projects | **50 statements / 53 branches** |
| separate processes, merged | **26 / 31** |
| both projects, targets aligned | **26 / 25** |

Reproduced locally in miniature, and both numbers match the CI artifacts
exactly — 50/53 is what the unsharded reference produced, 26/31 is what the
6-shard merge produced.

## Why it produced 50

When both projects run in ONE process, jest merges two *different*
instrumentations of the same path into one map. istanbul's merge keys on source
LOCATION, so entries that do not line up are appended rather than combined —
inflating a 26-statement file to 50. Sharding splits the projects across
processes, so each shard's map stays at 26 and the location-keyed merge
preserves it.

**The consequence worth stating plainly: the unsharded "reference" was never
ground truth.** The parity check was built assuming it was the standard to
match, and it is the run that double-counts. The sharded number is the more
faithful of the two.

This also explains the bidirectionality that broke the first hypothesis — 15
files larger in the reference, 18 larger in the sharded map — because which
instrumentation lands in a merged map follows load order, not a consistent
winner.

**The divergence predates sharding.** Two unsharded runs could disagree with
each other. Sharding only made it visible.

## Files

| File | Role |
| --- | --- |
| `tsconfig.json` | target ES2017 → ES2020, aligning the two projects |
| `tests/guards/jest-project-instrumentation-parity.test.ts` | Derives each project's tsconfig from `jest.config.js` and requires one shared target |

## Decisions

- **Aligned UPWARD (ES2020), not downward.** `lib` is already `esnext`, the
  esbuild worker and seed bundles already target `node22`, and Next compiles
  with SWC rather than following tsconfig `target` — so the emit change is
  confined to ts-jest and `tsc --noEmit`. Downgrading the rendered project to
  ES2017 would have worked equally for parity, but it would move a modern
  project backwards to accommodate an old default.

- **The guard derives the tsconfig list from `jest.config.js`.** A hardcoded
  pair would not cover a third project, and adding one is exactly the moment
  this reappears.

- **The guard uses TypeScript's own config loader.** A hand-rolled JSONC
  comment-stripper was tried first and was wrong: the `include` array contains
  `"./**/*"`, whose `/*` … `*/` a block-comment regex eats, corrupting the JSON.
  `ts.getParsedCommandLineOfConfigFile` handles JSONC and `extends` correctly
  and is authoritative about what tsc actually resolves.

- **Coverage numbers will move, legitimately.** Inflated denominators collapse
  where a file was double-instrumented. The gate is in shadow mode, so nothing
  breaks; when floors are re-derived they must be read from the
  `does not meet "global" threshold` line, never the summary table — the two
  populations differ by ~4.45 points on branches, and re-flooring from the
  wrong one broke main on 2026-08-20.

## Next

Re-run the parity workflow after this lands. If sharded and unsharded now
agree, `--report-only` can come off. The comparison has still never passed.
