# 2026-09-01 — single-rung button ladder (#776)

**Commit:** `ff22f782a` feat(ui): collapse the button size ladder to a single rung

## Design

Four sizes, one rung. `xs` / `sm` / `md` / `lg` all resolve to:

```
h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560] [&_svg]:size-[15px]
```

Adopted from the sibling compliance product, which collapsed its own ladder on
2026-07-28. Three sites carry the ladder in this codebase and all three moved:
the cva `size` map in `button-variants.ts`, and **two hand-rolled mirrors** in
`button.tsx` (the disabled-fallback and disabledTooltip branches, which do not
route through the cva). `controlSize` in `control-variants.ts` collapsed with
them.

The `size` prop is deliberately retained. Call sites still record intent, and
reversal stays a one-file edit — which is the sibling's own stated reason and
the reason this was cheap to adopt.

### What was NOT taken

The `#765` coarse-pointer floor is untouched: `pointer-coarse:min-h-11` on the
base classes, `pointer-coarse:min-w-11` on `icon`. **On a phone every button is
still 44px** — the collapse is desktop-only.
`tests/guards/button-touch-target-floor.test.ts` passed through the change
without modification, which is the evidence rather than the claim.

## Files

| file | role |
|---|---|
| `src/components/ui/button-variants.ts` | the cva `size` map — 5 entries collapsed |
| `src/components/ui/button.tsx` | both hand-rolled mirrors collapsed |
| `src/components/ui/control-variants.ts` | `controlSize` collapsed onto `CONTROL_RUNG` |
| `tests/guards/r20-pr{a,c,e,f}-*.test.ts` | four density passes retargeted / superseded |
| `tests/guards/r22-prc-icon-discipline.test.ts` | per-size icon scale superseded |
| `tests/guards/r24-prc-slim-density.test.ts` | height-parity assertion superseded |
| `tests/guardrails/b2-table-unification.test.ts` | icon square variant retargeted `h-9 w-9` → `h-7 w-7` |
| `CLAUDE.md` | records the collapse, the retained prop, and the open `<Input>` consequence |

## Decisions

- **Retarget where the property survived, supersede where it did not.** 40
  assertions failed. Where the claim still meant something under one rung
  (padding exists and is uniform; the icon variant is square and padding-free)
  it was retargeted. Where it was false *by design* — "the four sizes form a
  monotonically-increasing icon scale", "the ladder is graded" — it was deleted
  with a written note recording what it asserted and why it went. No assertion
  was loosened into a trivially-true form: four `toContain('h-7')` checks over
  four identical strings are four assertions that cannot fail independently.
- **No seventh consolidating guard, and that was tested rather than argued.** A
  candidate ratchet was drafted on the theory that the six retargeted suites
  each check a *fragment*, so a re-grade moving three sizes and leaving one
  behind would slip through. Plausible, and false here. Measured by mutation:
  re-grading only `sm` in the cva fails **5 of 6** suites; re-grading only the
  first hand-rolled mirror in `button.tsx` fails **3 of 7**. The property is
  already enforced, including on the mirrors that bypass the cva, so a seventh
  guard would add discoverability and no safety.
- **`controlSize` collapsed with the buttons, and it changes nothing on
  screen.** The lockstep between the two scales is real in source and asserted
  by R20-PR-A, so leaving it graded would have been an inconsistency. But
  `controlSize` has **zero importers** — `<Input>` declares its own `size` map
  in `input.tsx`. This is documented in the file itself so nobody reads the
  collapse as having fixed the alignment.

## The open consequence

**Buttons no longer line up with inputs.** A `<Button size="md">` is 28px; an
`<Input size="md">` is still 36px, and they share rows in real components —
`NewTaskFields`, `LeasePaymentsPanel`, `PrescriptionPanel`,
`ParcelDetailSheet`.

This repo's own comment called that alignment out as deliberate: *"heights stay
(filter-toolbar alignment with `<Input>` is locked by the R20-PR-A ratchet)"*.

The sibling product documents the identical hazard —

> Left alone, every filter toolbar in the app would pair a 28px button with a
> 36px input and read as broken; the lockstep is load-bearing, not decorative.

— and then ships it anyway, because the scale it collapsed (`controlSize`) has
no consumers there either and its `<Input>` was left at `h-9`. So the mismatch
is inherited, not introduced by a mistake here.

Closing it means collapsing `input.tsx`'s size map too, which is a separate
decision about **typing surfaces**: a 28px text field is tight, and `<Input>`
carries its own `min-h-[44px] md:min-h-9` mobile accommodation that would need
rethinking rather than deleting. Not done here, deliberately, and flagged in
`CLAUDE.md` so the next reader meets it as a known state rather than as a
regression.
