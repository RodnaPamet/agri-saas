# 2026-08-09 — npm audit gate with tracked per-advisory exemptions

## Design

Two advisories were published against `image-size` (`GHSA-w3rx-r6r6-pgpr`,
`GHSA-5p2g-fcmc-qvqq`) while the tree was unchanged. `main` went from green to
red on the same SHA, and because `Security` is a required check, **every PR in
the repo stopped being mergeable**.

Neither advisory has a fix. Both report `vulnerable: <= 2.0.2`,
`first_patched: none`, so there is no version to upgrade to.
`npm audit fix --force` "resolves" it by downgrading `pptxgenjs` 4.x → 1.1.5,
which breaks PPTX risk-report export — a working feature traded for a
vulnerability that is not actually reachable.

`npm audit` is all-or-nothing: it cannot say "this one advisory is accepted,
everything else still blocks". The only lever it offers is `--audit-level`, and
using it would have converted one specific accepted risk into a blanket waiver
across every package. That is the pressure this change exists to remove.

```
BEFORE                                   AFTER

npm audit --omit=dev                     node scripts/audit-gate.mjs
  --audit-level=moderate                   └─ npm audit --omit=dev
        │                                        --audit-level=moderate --json
        ▼                                   └─ subtract EXEMPTIONS (by GHSA id)
  all-or-nothing:                          └─ fail on: unexempted advisory
  one unfixable advisory                            │ expired reviewBy
  blocks every merge                                │ stale (matches nothing)
```

The gate keeps the same level and the same `--omit=dev` scope. What it adds is
subtraction by **advisory id**, not by severity.

## Decisions

**Per-advisory, not per-severity.** An exemption names a GHSA id. A *new*
advisory against `image-size` — or any other package — still fails. Lowering
`--audit-level` would have exempted every future moderate finding in the tree,
which is the opposite of what was wanted.

**Exemptions expire.** Each carries a `reviewBy` date and the gate fails once it
passes. An accepted risk that nobody re-examines is indistinguishable from one
nobody noticed; the date forces the difference. Set to ~3 months out.

**Stale exemptions fail too.** If an entry stops matching any advisory — because
upstream shipped a fix — the gate fails until it is deleted. Same "no stale
entries" convention the repo already uses for `KNOWN_N_PLUS_ONE`,
`REPO_BASELINE` and `LIST_QUERY_INDEXES`. Without it the list only ever grows.

**The premise is enforced, not asserted.** The exemption rests on one fact:
`image-size` is unreachable because `pptxgenjs` only calls it from
`addImage`/`addMedia`, and `renderPptx` builds slides from `addText` +
`addTable` alone. That fact would rot silently the day somebody adds a chart
image to the risk report. `tests/guards/report-renderer-no-images.test.ts` fails
CI if `addImage` or `addMedia` ever appears there, so the justification cannot
quietly become false. It also asserts the renderer still imports `pptxgenjs` —
otherwise the guard would pass for the wrong reason.

**The strictness ratchet was taught where the level moved.**
`security-gate-strictness.test.ts` matched `npm audit --omit=dev
--audit-level=…` in `ci.yml`. Moving the invocation into a script would have
made that assertion pass vacuously — green for a reason unrelated to what it
claims, the exact failure mode CLAUDE.md documents for skipped suites and the
jsdom viewport default. It now searches the script too, and a companion test
asserts CI actually invokes the gate.

**`nanoid` was fixed, not exempted.** It had a real fix; only advisories with no
upstream remedy are eligible. Override pinned to `^3.3.17` — inside the 3.x line,
satisfying both dependents (`stripe` `^3.2.0`, `postcss` `^3.3.16`). Deliberately
narrow: a global `brace-expansion` override previously dragged ESLint's 1.x
copies to 5.x and broke Lint.

## Files

| File | Role |
|---|---|
| `scripts/audit-gate.mjs` | New. The gate: audit, subtract tracked exemptions, fail on unexempted/expired/stale |
| `.github/workflows/ci.yml` | Security job invokes the gate instead of bare `npm audit` |
| `package.json` | `nanoid: ^3.3.17` override |
| `tests/guards/report-renderer-no-images.test.ts` | New. Enforces the exemption's premise |
| `tests/guardrails/audit-exemptions.test.ts` | New. Exemptions well-formed, bounded, future-dated; CI wired |
| `tests/guardrails/security-gate-strictness.test.ts` | Searches the gate script so it cannot pass vacuously |

## Follow-up

Review both `image-size` entries by **2026-11-09**. If `pptxgenjs` ships a
release that drops or replaces `image-size`, delete the exemptions — the gate
will fail as stale until someone does.
