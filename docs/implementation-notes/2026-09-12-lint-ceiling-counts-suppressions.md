# 2026-09-12 — the lint ceiling, and why it counts suppressions

**Branch:** `fix/874-lint-ceiling-counts-suppressions` · Refs #874 ·
Follows `2026-09-10-lint-gate-cannot-fail.md`

## What was still open

The 2026-09-10 pass promoted `react-hooks/rules-of-hooks` to `error` and left
the second lever explicitly undone:

> **`--max-warnings=0` is deliberately NOT set.** Setting it would have required
> suppressing 120 findings, which is the same defect wearing a different hat: a
> gate that passes because nothing is looked at.

That reasoning is right, and it is the reason this change is not simply
`--max-warnings=121`.

## The hole a warning ceiling does not close

`errorCount` and `warningCount` both EXCLUDE anything silenced by an inline
`eslint-disable` comment. Those findings move to `result.suppressedMessages`,
which no `--max-warnings` ceiling reads. Measured on a clean tree at
`0a109317b`, with one ESLint pass over 3,868 files:

| | count |
|---|---:|
| errors | 0 |
| warnings | 121 |
| **suppressed findings** | **1,580** |
| …of those, with no `-- reason` | 461 |
| …of those, from rules configured at severity 2 | 13 |

So 93% of this repo's lint findings already sit outside anything a warning
ceiling can see, and `@typescript-eslint/no-explicit-any` is 1,416 of the 1,580.

Under a warnings-only ceiling the cheapest way to go green is to mute. That is
not hypothetical: the channel is open at ERROR severity too. Thirteen suppressed
findings come from rules the config sets to severity 2, including two
`react-hooks/rules-of-hooks` mutes — the very rule promoted on 2026-09-10 to
stop the #872 crash class, switched off from inside the file it constrains.

## The invariant

**Converting a warning into a suppression must never reduce a number.**

Muting moves a finding from `warnings` to `suppressed`. The warning ceiling
relaxes by one and the suppression ceiling is exceeded by one, so the gate
fails. Silencing costs exactly what leaving it costs — which is what makes the
2026-09-10 objection ("a gate that passes because nothing is looked at") no
longer apply to setting a ceiling.

Demonstrated on the real tree, not argued:

```
MUTATION A — one blanket disable added to a file with existing warnings
  warnings            121 → 119     a --max-warnings gate goes GREENER
  suppressed         1580 → 1583    ceiling exceeded  → exit 1

MUTATION B — a conditional hook (the #872 shape) added and muted
  errors                0 → 0       errorCount never moves
  error-severity mutes 13 → 14      named in the failure → exit 1
    "error-severity rule muted: src/components/__ceiling_probe.tsx|react-hooks/rules-of-hooks"
```

## What the gate checks

`scripts/lint-ceiling.ts`, run as `npm run lint` (the same script the required
`Lint` context already invoked, so the mount point does not move):

1. **files linted ≥ 3,400.** Checked FIRST. Every count below is a selection,
   and an empty selection satisfies every ceiling — a lint run whose config
   stops resolving reports the cleanest numbers in the project's history. This
   separates "nothing is wrong" from "nothing was examined".
2. **errors = 0.**
3. **warnings ≤ 121.**
4. **suppressed ≤ 1,580.**
5. **suppressions with no `-- reason` ≤ 461**, so a new mute costs a written
   justification rather than a bare comment.
6. **severity-2 mutes match an exact map**, in both directions — a new one
   fails, and a removed one fails until the map is corrected, so the recorded
   list cannot quietly stop describing the tree.
7. **drift sentinels** on 3–5: a ceiling more than 25 above reality has stopped
   ratcheting, and the gap is headroom a later regression spends without going
   red. Same shape as `CURRENT_BASELINE` in the two existing ratchets.

Ceilings may be lowered freely. Raising one is a visible line in the diff, which
is the entire mechanism.

## Decisions

- **No rule severity changes.** CLAUDE.md states `@typescript-eslint/no-explicit-any`
  is intentionally `warn` because the `: any` debt makes `error` infeasible, and
  that the ratchet is the enforcement. This change adds ceilings in that same
  idiom and touches no rule.

- **This counts suppressions because the repo's own `as any` ratchet already
  does.** `tests/guardrails/no-explicit-any-ratchet.test.ts` scans text rather
  than trusting ESLint severity, and says so in its failure output: *"The cast
  still counts toward the baseline."* A lint gate that let a disable comment
  erase a finding would invert the convention it sits beside.

- **The 13 severity-2 mutes are recorded, not fixed, in this PR.** Ten are
  `no-explicit-any` in `src/lib/security/pii-middleware.ts` and
  `saml-client.ts`, where `eslint.config.mjs:116` escalates that rule to `error`
  for the security surface — so the repo's strictest scoping is currently muted
  from inside. Two are `rules-of-hooks` in `tests/e2e/fixtures.ts`, which is a
  genuine plugin false positive: Playwright's `use` fixture parameter read as
  React's `use()` hook, in a file that imports nothing from React. That one
  wants config scoping rather than a mute. Recording them makes the debt
  countable; fixing them is separate work and each has a different answer.

- **`--max-warnings` is not used at all.** It cannot express any of checks 1,
  4, 5, 6 or 7, and the flag alone is what the previous note correctly declined.

- **`lint:raw` and `lint:fix` keep the plain ESLint invocations** for the
  `--fix` workflow. `lint-staged` does not lint (it runs the secret scan only),
  so no hook changes.

## Proof

`tests/guards/lint-ceiling-has-teeth.test.ts` drives `evaluate()` with
fabricated measurements — 13 tests, each a mutation of a passing baseline, plus
a control asserting the baseline passes. Fabricated rather than measured on
purpose: a real lint pass is ~90s, and a double that cannot express the failing
input defeats the proof. A `Measurement` is a plain record, so every failure
mode is expressible, including ones absent from the tree today.

## Left undone

The 121 warnings and 1,580 suppressions themselves. This change stops the
numbers rising and forces them down as they are fixed; it does not fix them.
The five warning categories and their reasoning are unchanged from the
2026-09-10 note.
