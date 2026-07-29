# 2026-07-29 — Tooltip touch-path uniformity guard

**Commit:** `<sha> test(tooltip): lock the touch path inside the primitive`
**Amended by:** `<sha> fix(ui): stop the touch tooltip cancelling the tap it rides on`

> **Read the amendment first.** This note was written for the guard-only
> PR (#455), whose closing section filed a defect it had found and
> deliberately not fixed: the tap `preventDefault()` cancels the default
> action of whatever the tooltip wraps, so on touch a `<Tooltip>` around a
> `<Link>` or an `<a href download>` did nothing but show a tooltip. That
> fix has since landed and **inverted invariant 3 below** — the primitive
> now declines Radix's close requests through `onOpenChange` instead of
> suppressing the DOM event, and `preventDefault()` on the trigger is
> forbidden rather than required. The "What this does not prove" section
> is also superseded: the behavioural half now exists at
> `tests/rendered/tooltip-touch.test.tsx`. Both sections carry the
> correction inline.

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
3. ~~**The `preventDefault()` survives**~~ — **INVERTED by the
   amendment.** As first written this invariant required
   `preventDefault()` on both `onPointerDown` and `onClick`, gated on the
   pointer class. That mechanism is what the closing section of this note
   filed as a defect, and it has since been replaced. The invariant now
   reads: **the tap toggle survives and stays transparent** — the
   `coarsePointer`-gated `onPointerDown` still toggles `touchOpen`, the
   controlled `open`/`onOpenChange` wiring still makes the toggle mean
   something, `handleTouchOpenChange` declines Radix's close requests,
   and **no `preventDefault()` appears anywhere on the trigger except the
   `onFocus` `:focus-visible` gate** (which suppresses a Radix *open*,
   not a default the wrapped element needs).
4. **All four dismissals survive** — capture-phase document
   `pointerdown`, capture-phase window `scroll`, and the timeout (each
   paired with its removal, plus the own-trigger carve-out and the
   `!touchOpen` early return), and `onEscapeKeyDown={closeTouch}` on the
   Content. `TOUCH_AUTO_DISMISS_MS` is bounded to 2–15 s; stretching it to
   ten minutes restores the #395 failure just as effectively as deleting
   the timer. (Escape was Radix's before the amendment; the close filter
   declines its DismissableLayer dismissal along with every other close,
   so the primitive owns it now.)
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
coverage** and locks only the *shape*: that the handler exists, that the
close filter is wired, that the listeners are added and removed. It does
not prove a tap opens a tooltip on a phone.

**Superseded by the amendment.** As of the fix PR the behavioural half
exists: `tests/rendered/tooltip-touch.test.tsx` installs a coarse-pointer
`matchMedia` per test and drives the branch with real pointer events —
tap opens, second tap closes, a wrapped link navigates, a wrapped
`<a href download>` keeps its default, and outside-tap / scroll / Escape
/ timeout each dismiss. `tests/rendered/tooltip.test.tsx` remains the
hover/focus half. Tooltips are now a
`tests/guards/behavioural-coverage-registry.test.ts` entry, which was
exactly the row this note said could not be added while the rendered test
was missing. A `mobile-android` Playwright tap remains optional.

## The tap `preventDefault()` killed link navigation — found here, fixed in the amendment

This section is the defect the guard-only PR filed rather than fixed. It
is kept because it is the reasoning behind the current mechanism.

The `onClick={(e) => e.preventDefault()}` on the Trigger cancels the
**default action** of whatever element the tooltip wraps. A throwaway
rendered probe (coarse-pointer `matchMedia` stub, click a `<Tooltip>`-
wrapped `<a href>`, read `defaultPrevented` off the click that reaches the
element) confirmed the asymmetry:

| pointer | `defaultPrevented` at the wrapped element |
| --- | --- |
| fine | `false` |
| coarse | `true` |

Two things were NOT affected, and were probed separately: a React `onClick`
on the child still fires (so `IconAction` / `Button` actions work), and the
Popover `triggerTooltip` path still opens.

What WAS affected is anything relying on the native default action. For a
`<Tooltip>` wrapping a link both escape routes closed at once — Next's
app-dir Link does `if (e.defaultPrevented) return;` before `linkClicked`
(`node_modules/next/dist/client/app-dir/link.js`), and the browser default
was prevented too. On a coarse pointer the affordance did nothing but show
its own tooltip.

Reach: ~17 inline sites — icon-only nav links on tests (×4), controls (×3),
risks (×2), vendors (×2), assets, `UpgradeGate`, the `SidebarNav` admin
icon, the audit-pack export `<a href>` **downloads** (×2) and the evidence
`<a>` — plus `src/components/layout/nav-item.tsx:648`, which wraps every
collapsed-sidebar nav `<Link>`.

No test caught it for the same reason nothing caught the other silent
touch regressions: the branch never executed under jsdom.

### The fix

`preventDefault()` was the wrong lever, not the wrong idea. Its job was to
make Radix's `composeEventHandlers` skip the composed close-handlers on
`onPointerDown` / `onClick`; it did that by mutating the DOM event, which
is a channel the wrapped element also reads.

The primitive already had a channel it owns outright: on a coarse pointer
it passes `open` **and** `onOpenChange` to `TooltipPrimitive.Root`, and
Radix's `useControllableState` routes every internal `setOpen` through
`onOpenChange` without touching state when the value is controlled. So
Radix's close requests already arrive as calls, not events.

`handleTouchOpenChange` honours opens (a stylus or paired mouse on a
coarse-pointer tablet still hovers, and Radix is right about those) and
declines closes. Declining rather than filtering is deliberate: the close
that must be rejected — the click completing the opening tap, which Radix
fires unconditionally from the trigger's `onClick` — is not
distinguishable by shape or timing from the ones that would be
legitimate, and it arrives after `pointerleave` and before anything the
user could have meant. Guessing a gesture window would have been fragile
in exactly the way that ships another silent regression. Instead the
effect owns dismissal outright, which it nearly did already: outside tap,
scroll and timeout were there, and Escape moved in from Radix's
DismissableLayer to complete the set.

Consequence worth stating plainly: a tap on a tooltip-wrapped link now
does BOTH — it opens the tooltip and it navigates. That is correct for
the collapsed sidebar, where the tooltip *is* the link's label, and it is
what "mobile-first" has to mean for an affordance whose only job is to go
somewhere.

## Files

| File | Role |
| --- | --- |
| `tests/guards/tooltip-touch-uniformity.test.ts` | The guard: 6 invariant suites + mutation-regression cases. |
| `docs/tooltip-and-copy-strategy.md` | Contributor doc — new "Touch devices" subsection under `<Tooltip>`; guardrail list 2 → 3. |
| `CLAUDE.md` | Epic 56 section now states the two-gestures/one-behaviour rule. |

Added by the amendment:

| File | Role |
| --- | --- |
| `src/components/ui/tooltip.tsx` | `handleTouchOpenChange` replaces the tap `preventDefault()`; Escape joins the dismissal effect. |
| `tests/rendered/tooltip-touch.test.tsx` | The behavioural half — coarse-pointer `matchMedia` per test, real pointer events. |
| `tests/guards/behavioural-coverage-registry.test.ts` | Registry row for the tooltip touch path, now that its rendered test exists. |

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
- ~~**No `behavioural-coverage-registry` entry.**~~ True only of the
  guard-only PR: that registry requires the rendered test to exist first.
  The amendment wrote the rendered test, so the row is now there.

Amendment decisions:

- **Decline every close, rather than filter the spurious one.** A
  one-shot "swallow the next close" flag was tried on paper and is
  fragile: with `disableHoverableContent` set, `pointerleave` fires
  BEFORE `click` on a touch tap, so the flag is spent on the wrong event
  and the real echo gets through. Owning dismissal outright has no
  ordering assumptions in it.
- **Escape moved into the primitive, via `onEscapeKeyDown` rather than a
  listener.** It is the one close Radix provided that the effect did not
  already duplicate, and declining every close would otherwise have
  dropped it silently on hybrid devices. The first attempt added a
  capture-phase `document` `keydown` listener and tripped
  `tests/guardrails/keyboard-shortcut-conventions.test.ts`, which reserves
  raw `keydown` listeners for `useKeyboardShortcut` (Epic 57) — correctly:
  hundreds of mounted tooltips should not each own a global listener.
  `TooltipPrimitive.Content` already forwards `onEscapeKeyDown` into its
  DismissableLayer, which runs it BEFORE `onDismiss`, so Radix's own
  document-level `useEscapeKeydown` does the work and the handler is
  focus-independent — exact parity with the pre-fix behaviour. It is
  passed unconditionally, not gated on the pointer class: `touchOpen` is
  unread on the hover path, so `closeTouch` is inert there, and a
  `coarsePointer` term inside the Portal would be a second appearance to
  keep in sync (which the guard's "one appearance" suite forbids anyway).
- **`preventDefault()` removed from `onPointerDown` too, not just
  `onClick`.** With the close filter in place it no longer serves its
  stated purpose (Radix's pointerdown close only fires when it already
  believes it is open — the closing tap, where we agree), and it
  suppressed the compat mouse events, which is how the trigger stopped
  taking focus. A `preventDefault()` that no longer does the job its
  comment claims is the next reader's trap.
- **A `next/link` stand-in in the rendered test, not the real
  component.** The real app-dir `Link` short-circuits on
  `if (!router) return` with no `AppRouterContext`, so it would never
  navigate under jsdom and the regression test would pass vacuously
  against the broken code. The stub reproduces the three lines of its
  click contract verbatim, with the source path in a comment.
