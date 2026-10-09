# 2026-10-09 — row activation survives a re-render (#1076)

**Commit:** _(this change)_

## Design

With selection enabled, a table row's single click toggles selection and the
row ACTION — almost always `router.push` to the detail page — was the
double-click, wired to `onDoubleClick` alone.

`dblclick` is the wrong event to depend on. The browser fires it only when
both clicks resolve to the same target, and dispatches it on their nearest
common ancestor when they do not. Selection itself causes a React re-render
between the two clicks, so the event can be lifted off the row and the row's
handler never runs.

Activation is now taken from the click's own count:

```
onClick     detail === 1  ->  toggle selection
onClick     detail >= 2   ->  toggle BACK, then activate   (new)
onDoubleClick              ->  activate, deduped            (kept)
```

`MouseEvent.detail` is the click count in a gesture, and the browser derives
it from button, time and position in the input pipeline rather than from the
hit-test target — so the second click still carries `detail === 2` when the
node under the cursor has been replaced. That is exactly the case `dblclick`
loses.

Both events stay wired, so activation has to be idempotent per gesture — a
per-row flag in `table-utils.ts` (`hasActivated` / `markActivated` /
`resetActivation`), with **no time in it**. A `detail === 1` click opens a
gesture and clears the flag; `dblclick` terminates one and clears it either
way, which is what lets a bare `fireEvent.doubleClick` work repeatedly.

`onDoubleClick` is not vestigial — a bare `fireEvent.doubleClick` dispatches
no clicks at all, and `tests/rendered/entity-list-page.test.tsx` does exactly
that.

**The first version of this dedupe WAS time-based — a 100 ms window on
`e.timeStamp` — and it was wrong.** Its own rendered test caught it while the
machine was loaded: under contention the `detail === 2` click and the
`dblclick` that follows arrive more than 100 ms apart, both paths fire, and
the row action runs twice. A doubled `router.push` is a doubled history entry,
and on a destructive row action it would be worse. A load-sensitive dedupe
inside a fix for a load-sensitive flake is no fix at all, and the only reason
it did not ship is that the test was run under load rather than alone.

## Evidence

From the Playwright trace of a 3-of-3 retry failure on
`data-table-platform.spec.ts:188`:

```
performing dblclick action
dblclick action done
waiting for scheduled navigations to finish
  navigations have finished        <- immediately: nothing was scheduled
```

and in the same failure the row's selection ended at **zero**, i.e. the toggle
had fired an EVEN number of times. So **both clicks reached the row's
`onClick`; only `dblclick` went missing.** That single observation is what
makes the click-count fix correct and rules out every timing remedy — there
was no slow thing to wait for.

Four earlier hypotheses were refuted on the way, three of them mine: a cold
route (zero network for the whole 15 s), a permission race (the E2E user is
OWNER), the selection toolbar shifting layout under the second click (it is
always mounted at fixed `h-9` and toggles only opacity), and `onRowClick`
being unwired (`FarmTasksClient.tsx:482` passes it unconditionally).

One trap cost a nearly-published wrong finding: all three failure snapshots
read `1 selected`, which is `lastSelectedCount` — a sticky value that exists
so the label does not flicker while the bar fades. `checkbox [checked]`
occurred zero times. The live observable disagreed with the rendered one, and
only counting a *different* observable settled it.

## Files

| file | role |
| --- | --- |
| `src/components/ui/table/table-utils.ts` | `isGestureCompletingClick`, `activateRowOnce`, `ROW_ACTIVATION_DEDUPE_MS`, `NO_ROW_ACTIVATION` — the policy, once |
| `src/components/ui/table/table.tsx` | both row renderers: `ResizableTableRow`, and the non-resizable branch inside `Table<T>` |
| `src/components/ui/table/virtual-table-body.tsx` | the virtualized row |
| `tests/rendered/data-table-row-activation.test.tsx` | six assertions; the first reproduces #1076 and fails without the fix |

## Decisions

- **Three row paths, not two.** `virtual-table-body.tsx`'s own comment names
  them — resizable, non-resizable, virtualized — and I wired two and shipped
  nothing, because the non-resizable branch is the one most list pages take.
  The rendered test caught it. A previous author hit the identical trap with
  the keyboard-activation fix and left the warning in place at that site;
  worth reading before touching row behaviour again.
- **One ref for the non-resizable branch, keyed by row id.** That branch
  builds its rows inline inside `Table<T>` and has no per-row hook to hang
  state on. Keying on the id means a shared ref cannot let one row's gesture
  suppress another's, and it keeps the honest behaviour if two different rows
  are somehow activated inside the window.
- **The ref in `VirtualRow` sits BEFORE its early `return null`.** Hook order
  must not depend on whether the row exists.
- **Toggle back on the activating click**, so selection still ends where it
  started. That is the contract `table.tsx` has documented since R13-PR14 and
  it is the half a naive fix drops.
- **The dedupe is time-free**, after a time-based first attempt failed under
  contention (above). Gesture boundaries come from the click count itself:
  `detail === 1` opens, `dblclick` closes. Nothing to tune, and nothing that
  behaves differently on a busy runner than on a quiet laptop — which is the
  property the original bug lacked.
- **Activation is `detail === 2` exactly, not `>= 2`.** A triple click's third
  click should not activate a second time.
- **`detail === 0` reads as a single click.** `element.click()` and some
  synthetic dispatches leave it at 0; treating that as a gesture would make
  every programmatic click navigate.
- **The E2E specs keep using `dblclick`.** They assert the operator's real
  gesture, and swapping them for the keyboard path would have made the suite
  green while leaving the bug in front of farmers. The product was the thing
  to fix.
