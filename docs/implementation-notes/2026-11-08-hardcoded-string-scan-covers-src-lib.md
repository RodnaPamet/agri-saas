# 2026-11-08 — the hardcoded-string scan covers `src/lib` (#2858 step 3)

**Commit:** `<pending>` test(guards): the hardcoded-string scan covers src/lib

## Design

`no-hardcoded-ui-strings` scanned `src/app` + `src/components`. It now scans
`src/lib` too, with four reasoned exclusions.

```
  ROOTS   src/app · src/components · src/lib
  EXCLUDED, each with a written reason
      src/lib/openapi/      API documentation, English by convention
      src/lib/dto/          wire-format schema metadata
      src/lib/scim/         protocol field names an IdP reads
      src/lib/agriculture/weed-options.ts   Latin binomials

  jsx-text     13 → 13      (src/lib adds none — it holds almost no JSX)
  config-prop  201 → 407    a POPULATION change, measured at floor 0
```

## Why it was open, which is the part worth keeping

The guard's own docblock already recorded this gap and named its precedent —
`src/lib/celebrations.ts`, whose copy had been moved into the catalogues. That
one instance was then cleaned up and **the gap itself was left open**, so a
documented escape hatch with its only known occupant removed read as closed.

It had collected a new occupant by then: the dashboard's first-run card
rendered six hardcoded English strings straight out of
`src/lib/onboarding-steps.ts` — the first thing a new farm sees, in a product
where four in five users carry `uiLanguage: 'bg'`. Those six were fixed by
#2860; this is #2858's step 3, which is the half that stops a fourth instance.

## Decisions

- **Steps 1 and 2 of #2858 were already done, and checking first is why this
  PR is only step 3.** `FIRST_RUN_STEPS` holds `labelKey` / `hintKey` /
  `ctaKey`, `FirstRunCard` renders them through `t()`, and all six keys exist
  in both catalogues under `dashboard.firstRun`. Measured before writing
  anything.

- **The exclusions are a category, not a convenience.** Widening to all of
  `src/lib` takes the config-property count from 201 to **1,086**, and the
  overwhelming majority of that is `src/lib/openapi/` — `description:` fields
  in the OpenAPI document. Those are API documentation read by SDK authors and
  by the contract tests; the spec is English by convention, and translating it
  would make `openapi-breaking-change` compare two languages. `dto` and `scim`
  are the same axis one layer down: a translated wire-format description would
  be wrong rather than localised.

- **Latin binomials get their own entry.** `weed-options.ts` holds
  `Sorghum halepense`, `Echinochloa crus-galli`. They are identical in every
  language by international botanical convention — that is what a binomial is
  for — and a Bulgarian "translation" would either be the same string, which
  `i18n-completeness`'s untranslated check then flags, or a colloquial name
  that no longer identifies the species on a PPP label.

- **407 is a POPULATION change, not slack**, and the distinction matters
  because raising this line is otherwise forbidden. The scan now reads 54 more
  files and 206 of the hits it counts were always there and always invisible.
  Nothing in `src/app` or `src/components` changed. That is the distinction the
  coverage gate drew when `bullmq-real-api` entered its denominator: a re-floor
  after the population moved is a different act from one that admits new debt.

- **The number came from the FAILURE MESSAGE with the floor forced to 0**,
  which is what #2858 asked for and what a prior re-floor in this very file got
  wrong — it projected a figure that carried four slack and passed against a
  live 13.

- **The jsx-text half gained nothing**, measured rather than assumed:
  `src/lib` holds almost no JSX, so that count is still 13. Widening it costs
  nothing and closes the case of a display component living under `src/lib`.

## Verification

Two mutations, both caught:

- `src/lib` removed from the roots again → the "no accumulated slack" test
  fails, because the baseline no longer equals the actual.
- a new `label: 'Map your first field'` added to `src/lib/onboarding-steps.ts`
  → 407 becomes 408 and the ratchet fails. That is the property #2858 asked
  for in its own words: *"step 3 is the one that stops a fourth instance"*.
