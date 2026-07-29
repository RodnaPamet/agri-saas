# 2026-07-29 — Tooltip touch-path uniformity guard

**Commit:** `<sha> test(tooltip): lock the touch path inside the primitive`

## Design

PR #449 (`fbef049c`) closed the #395 kill-switch: tooltips are on again
app-wide, and `src/components/ui/tooltip.tsx` gained a coarse-pointer
branch where a tap toggles the popup. That was the right call for a
mobile-first product — Radix deliberately gives touch users nothing, so
flipping the flag alone would have shipped tooltips that work on a desk
and stay silent in a field.

It also created a regression class the four existing tooltip guards do
not cover. `ui-canonical-tooltips`, `no-ad-hoc-tooltip-title`,
`tooltip-kill-switch-consistency` and `edit-columns-no-tooltip-wrap` all
answer "is the canonical primitive being used?" — they were written when
there was one behaviour and the only way to diverge was to not use the
primitive. Now there are two behaviours inside one component, and the
new failure mode is the touch path **leaking out of** the primitive:

  - a call site that re-implements tap-to-toggle with its own
    `matchMedia('(pointer: coarse)')`;
  - a prop that lets one caller opt out (`disableTouch`, `touchBehavior`);
  - a delegating component that intercepts the trigger's pointer events;
  - a "simplification" that drops the `preventDefault()` or one of the
    three dismissal paths.

Any of those and the same control behaves differently depending on where
it appears, which is precisely what the standing requirement forbids:
tooltips must be uniform, canonical, and must not differentiate from
each other.

The last two are worse than they look because they are **silent**. No
test in the repo fails when the coarse-pointer branch breaks:
`tests/rendered/setup.ts` stubs `window.matchMedia` to answer
`matches: false` to every query, so `useCoarsePointer()` is always false
under jsdom and the entire touch branch is dead code in every rendered
test. Playwright has `mobile-android` / `mobile-iphone` projects with
`hasTouch`, but no spec taps a tooltip. #449 itself added zero
behavioural tests for the path it introduced.

So the guard asserts the **inverse of the defect**, the pattern
established by `tests/guards/tooltip-kill-switch-consistency.test.ts`
and reused by `tests/guards/rls-coverage-skip-visibility.test.ts` (#451).
Six invariants:

1. **One owner.** `@radix-ui/react-tooltip` is imported by exactly one
   file in `src/`. Every file that imports the primitive is swept for
   pointer-class tokens; only the owner may carry them. The consumer
   list is *derived* from imports, not curated, so a new call site is
   covered the day it is written.
2. **Derived, never supplied.** `const coarsePointer = useCoarsePointer();`
   must stay exactly that — not `props.forceTouch ?? useCoarsePointer()`.
   `useCoarsePointer` stays unexported. `TooltipProps` may hold no prop
   matching `/touch|coarse|tap|mobile|gesture|pointer/i`, and stays a
   closed interface (no `extends`, no index signature) so no caller can
   inject a competing `onPointerDown` into the trigger.
3. **The `preventDefault()` survives** — on both `onPointerDown` and
   `onClick`, gated on the pointer class, alongside the controlled
   `open`/`onOpenChange` wiring that makes the toggle mean anything.
4. **All three dismissals survive** — capture-phase document
   `pointerdown`, capture-phase window `scroll`, and the timeout — each
   paired with its removal, plus the own-trigger carve-out and the
   `!touchOpen` early return. `TOUCH_AUTO_DISMISS_MS` is bounded to
   2–15 s; stretching it to ten minutes restores the #395 failure just
   as effectively as deleting the timer.
5. **One appearance.** No pointer-class token inside the
   `<TooltipPrimitive.Portal>` region, so side/align/offset/surface are
   identical. Only the gesture may differ.
6. **Delegates pass through** — `IconAction`, `TimestampTooltip`,
   `EntityPrevNextNav` and the in-file `InfoTooltip` /
   `DynamicTooltipWrapper` render `<Tooltip>`, own no pointer-class
   logic, and add no pointer handler to the trigger they hand over.

Every detector is a pure function of source text, so the mutation suite
feeds each one a known-bad input and proves it fires. A detector that
only ever sees a clean file is decorative.

## What this does not prove

It is a text scan, like every file in `tests/guards/` — see "Green is
not the same as executed" in CLAUDE.md. It contributes **zero runtime
coverage** and locks only the *shape*: that the handler exists, that it
calls `preventDefault()`, that the listeners are added and removed. It
does not prove a tap opens a tooltip on a phone.

The behavioural half is `tests/rendered/tooltip.test.tsx`, and today
that half covers hover/focus only. The honest state after this PR:
tap-to-toggle is **shape-locked but unexercised**. The missing piece is
a rendered test that drives the branch behind a coarse-pointer
`matchMedia` stub (open on tap, close on second tap, close on outside
pointerdown, close on scroll, close on timeout with fake timers) — and,
optionally, one `mobile-android` Playwright case. That is deliberately
not in this PR, which is guard-only, and it is the entry that would let
tooltips join `tests/guards/behavioural-coverage-registry.test.ts`.

## Found while writing this: the tap `preventDefault()` kills link navigation

Not fixed here — this PR is guard-only — but it needs a follow-up.

The `onClick={(e) => e.preventDefault()}` on the Trigger cancels the
**default action** of whatever element the tooltip wraps. A throwaway
rendered probe (coarse-pointer `matchMedia` stub, click a `<Tooltip>`-
wrapped `<a href>`, read `defaultPrevented` off the click that reaches the
element) confirms the asymmetry:

| pointer | `defaultPrevented` at the wrapped element |
| --- | --- |
| fine | `false` |
| coarse | `true` |

Two things are NOT affected, and were probed separately: a React `onClick`
on the child still fires (so `IconAction` / `Button` actions work), and the
Popover `triggerTooltip` path still opens.

What IS affected is anything relying on the native default action. For a
`<Tooltip>` wrapping a link both escape routes close at once — Next's
app-dir Link does `if (e.defaultPrevented) return;` before `linkClicked`
(`node_modules/next/dist/client/app-dir/link.js`), and the browser default
is prevented too. On a coarse pointer the affordance does nothing but show
its own tooltip.

Reach: ~17 inline sites — icon-only nav links on tests (×4), controls (×3),
risks (×2), vendors (×2), assets, `UpgradeGate`, the `SidebarNav` admin
icon, the audit-pack export `<a href>` **downloads** (×2) and the evidence
`<a>` — plus `src/components/layout/nav-item.tsx:648`, which wraps every
collapsed-sidebar nav `<Link>`.

No test caught it for the same reason nothing catches the other silent
touch regressions: the branch never executes under jsdom.

## Files

| File | Role |
| --- | --- |
| `tests/guards/tooltip-touch-uniformity.test.ts` | The guard: 6 invariant suites + 9 mutation-regression cases. |
| `docs/tooltip-and-copy-strategy.md` | Contributor doc — new "Touch devices" subsection under `<Tooltip>`; guardrail list 2 → 3. |
| `CLAUDE.md` | Epic 56 section now states the two-gestures/one-behaviour rule and names the coverage gap. |

## Decisions

- **Derived consumer sweep, curated delegate list.** The import-derived
  sweep is total and needs no maintenance; the delegate list is the
  curated positive check that catches a delegate quietly ceasing to
  delegate. Neither alone is enough — the sweep only proves absence, the
  list only covers files someone remembered.
- **Narrow token list, not a `matchMedia` ban.** `matchMedia` is
  legitimate all over the app (`src/app/providers.tsx` queries a
  breakpoint; `use-pull-to-refresh` and `view-transitions` legitimately
  ask about pointer class and never touch tooltips). Banning it outright
  would have produced an allowlist long enough to be meaningless. The
  banned spellings are the ones that fork tooltip behaviour by device.
- **One allowlist entry, scoped to its token.**
  `src/components/ui/table/table.tsx` consumes `<Tooltip>` and carries
  `onTouchStart={header.getResizeHandler()}` — TanStack's column-resize
  grip, on a separate `<div>`, making no pointer-class decision. It is
  excused for `React touch handler` only, so the same file gaining a
  `(pointer: coarse)` query still fails. A "no stale entries" test
  deletes the excuse when the code does.
- **`disabled` is not banned.** One call site passes it
  (`locations/[locationId]` offline-cadastre hint). It short-circuits
  the tooltip for *both* pointer classes, so it is uniform by
  construction. What the guard does instead is assert the short-circuit
  condition contains no pointer-class term — `disabled || coarsePointer`
  is the defect; `disabled` is a feature.
- **Bounded `TOUCH_AUTO_DISMISS_MS` rather than pinned.** Pinning 6000
  would fail on a legitimate 5000/8000 tuning; unbounded would allow a
  60 s "fix" for a flaky test that functionally restores #395.
- **No `behavioural-coverage-registry` entry.** That registry requires
  the rendered test to exist first — which is exactly the point being
  made above, and the reason this note names the gap instead of hiding
  it behind a green guard.
