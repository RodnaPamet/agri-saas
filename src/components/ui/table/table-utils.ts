/**
 * Table-local utility functions.
 *
 * Previously imported from `Dub utils`. Inlined here so the table
 * module is self-contained and doesn't depend on the Dub shim layer.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { type MouseEvent } from "react";

/** Tailwind class merge utility. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Shallow-recursive deep equality check for plain objects. */
export function deepEqual(obj1: unknown, obj2: unknown): boolean {
  if (obj1 === obj2) return true;
  if (
    typeof obj1 !== "object" ||
    typeof obj2 !== "object" ||
    obj1 === null ||
    obj2 === null
  )
    return false;

  const a = obj1 as Record<string, unknown>;
  const b = obj2 as Record<string, unknown>;
  const keys1 = Object.keys(a);
  const keys2 = Object.keys(b);
  if (keys1.length !== keys2.length) return false;

  for (const key of keys1) {
    if (!keys2.includes(key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Returns true if the click target is an interactive child element
 * (button, input, textarea, or an open overlay/popper) — used to
 * ignore row-click handlers when the user clicks on an action
 * practice within a row.
 *
 * R13-PR15 — `<a>` was REMOVED from the banned tags so clicks on
 * the title-cell link (and any other inline `<a>` in a row) bubble
 * to the row's onClick. The title link drives navigation via
 * modifier-clicks (cmd/ctrl for new tab) and double-click on the
 * row body; plain left-clicks on it `preventDefault` so the row
 * can handle the click for selection. See
 * `src/components/ui/table-title-cell.tsx` for the link's onClick
 * contract.
 */
export function isClickOnInteractiveChild(e: MouseEvent) {
  for (
    let target = e.target as HTMLElement, i = 0;
    target && target !== e.currentTarget && i < 50;
    target = target.parentElement as HTMLElement, i++
  ) {
    if (
      ["button", "input", "textarea"].includes(
        target.tagName.toLowerCase(),
      ) ||
      target.getAttribute("role") === "dialog" ||
      target.id === "modal-backdrop" ||
      [
        "data-radix-popper-content-wrapper",
        "data-vaul-overlay",
        "data-vaul-drawer",
      ].some((attr) => target.getAttribute(attr) !== null)
    )
      return true;
  }
  return false;
}

// ── Row activation ───────────────────────────────────────────────────
//
// With selection enabled, a single click toggles selection and the row
// ACTION (usually navigate to the detail page) is the double-click. That
// was wired to `onDoubleClick` alone, and `dblclick` is the wrong event to
// depend on: the browser fires it only when both clicks resolve to the
// same target, and dispatches it on their nearest common ancestor when
// they do not. A React re-render BETWEEN the two clicks — which selection
// itself causes, since the first click toggles it — can therefore lift the
// event off the row, and the row's handler never runs.
//
// Measured on agri-saas #1076, from the Playwright trace of a 3-of-3
// retry failure:
//
//     performing dblclick action
//     dblclick action done
//     waiting for scheduled navigations to finish
//       navigations have finished        <- immediately: nothing scheduled
//
// and in the same failure the row's selection ended at ZERO, i.e. the
// toggle fired an EVEN number of times. So BOTH clicks reached the row's
// `onClick`; only `dblclick` went missing. That is the whole bug, and it
// is why reading the click's own count fixes it where any amount of
// waiting does not.
//
// `MouseEvent.detail` is the click count in a gesture, and the browser
// derives it from button, time and position in the input pipeline — not
// from the hit-test target. So the second click carries `detail === 2`
// even when the node under the cursor has been replaced, which is exactly
// the case `dblclick` loses.
//
// Both events stay wired. `onDoubleClick` remains as a second route (and
// is the only one a bare `fireEvent.doubleClick` produces), so activation
// has to be idempotent per gesture — hence the gesture flag below.

/** `detail === 2` is the second click of a gesture — the activating one. */
export function isGestureCompletingClick(e: { detail: number }): boolean {
    return e.detail === 2;
}

/**
 * Per-row gesture state. `handled` is true once this gesture has activated.
 */
export interface RowActivation {
    rowId: string;
    handled: boolean;
}

/** The initial value for an activation ref — no gesture in progress. */
export const NO_ROW_ACTIVATION: RowActivation = { rowId: '', handled: false };

/**
 * Has this row's current gesture already activated?
 *
 * Deliberately NOT time-based. The first version of this used a 100ms window
 * on `e.timeStamp`, and its own rendered test caught the flaw while the
 * machine was loaded: under contention the `detail === 2` click and the
 * `dblclick` that follows it arrive more than 100ms apart, both paths fire,
 * and the row action runs TWICE — a doubled `router.push`, and worse on a
 * destructive action. A load-sensitive dedupe inside a fix for a
 * load-sensitive flake is no fix at all.
 *
 * A gesture always opens with a `detail === 1` click, so that click is the
 * reset. `dblclick` is the terminator — it clears the flag whether or not it
 * activated, which is what lets a bare `fireEvent.doubleClick` (no clicks at
 * all) work repeatedly.
 */
export function hasActivated(ref: { current: RowActivation }, rowId: string): boolean {
    return ref.current.rowId === rowId && ref.current.handled;
}

/** Record that this row's gesture has activated. */
export function markActivated(ref: { current: RowActivation }, rowId: string): void {
    ref.current = { rowId, handled: true };
}

/** Open a new gesture for this row (a `detail === 1` click, or a dblclick ending one). */
export function resetActivation(ref: { current: RowActivation }, rowId: string): void {
    ref.current = { rowId, handled: false };
}
