import { useEffect, useState } from "react";

/**
 * Tracks the on-screen (virtual) keyboard via the VisualViewport API.
 *
 * When a soft keyboard opens on a phone, the *layout* viewport doesn't
 * change but the *visual* viewport shrinks from the bottom. A
 * `position: fixed; bottom: 0` element (a bottom drawer / sheet) stays
 * anchored to the layout-viewport bottom — i.e. BEHIND the keyboard — so
 * its pinned footer (Save/Cancel) disappears. This hook reports:
 *
 *   - `inset`  — the keyboard height in CSS px (0 when closed). Lift a
 *     bottom-anchored surface by this much (`bottom: inset`) to sit it on
 *     top of the keyboard.
 *   - `height` — the current visual-viewport height in CSS px (0 before
 *     mount). Cap the surface's `maxHeight` to this so its header stays
 *     on-screen too. Reported ALWAYS, keyboard or not — see below.
 *
 * SSR-safe (returns zeros until mounted).
 *
 * ── WHY THIS IS NOT A PIXEL THRESHOLD ALONE ────────────────────────────
 *
 * The previous version decided a keyboard was open purely by measuring the
 * covered strip and comparing it to 120px:
 *
 *     const covered = window.innerHeight - vv.height - vv.offsetTop;
 *     const inset = covered > 120 ? Math.round(covered) : 0;
 *
 * On iOS that self-cancels exactly when it is needed. When Safari scrolls
 * the page to bring a focused input above the keyboard, `vv.offsetTop`
 * grows; the subtraction shrinks `covered`; and once it dips under the
 * threshold the hook reports inset 0 — abandoning the lift WHILE THE
 * KEYBOARD IS STILL OPEN. The sheet drops back behind it. A threshold
 * cannot tell "the strip is small because there is no keyboard" from "the
 * strip is small because the viewport scrolled", and those need opposite
 * answers.
 *
 * So FOCUS lowers the bar rather than replacing the measurement. With an
 * editable element focused a soft keyboard is up by the platform's own
 * contract, and `covered` is the real obscured height whatever its size —
 * so only a jitter floor applies. With nothing focused the original
 * chrome-versus-keyboard threshold is used unchanged.
 *
 * That ordering matters: it is backward-compatible by construction, so the
 * hook's existing tests still pin the no-focus behaviour, and the change is
 * confined to the case the old code got wrong.
 */
export interface KeyboardInset {
  /** Keyboard height in CSS px (0 when no keyboard). */
  inset: number;
  /** Visual-viewport height in CSS px (0 before mount). */
  height: number;
}

/**
 * With NOTHING focused, a covered strip this big is taken to be a keyboard.
 * Unchanged from the original implementation, deliberately: with no focus
 * signal this is the only evidence available, and the existing tests pin the
 * boundary (an 80px gap must read as chrome).
 */
const KEYBOARD_MIN_PX = 120;

/**
 * With an editable element FOCUSED, a soft keyboard is up by the platform's
 * own contract, so `covered` is the real obscured height and the only job of
 * this floor is to filter sub-pixel jitter.
 */
const CHROME_MAX_PX = 40;

/** Input types that raise no soft keyboard. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function editableHasFocus(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type);
  return false;
}

export function useKeyboardInset(): KeyboardInset {
  const [state, setState] = useState<KeyboardInset>({ inset: 0, height: 0 });

  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;

    const update = () => {
      // The gap between the visual viewport's bottom edge and the layout
      // viewport's bottom edge, in layout coordinates. Clamped: iOS can
      // report a transiently negative value mid-animation, and a negative
      // `bottom` would push the sheet off the bottom of the screen.
      const covered = Math.max(
        0,
        window.innerHeight - vv.height - vv.offsetTop,
      );
      // Focus REFINES the measurement, it does not replace it. With nothing
      // focused this is exactly the original heuristic, so the behaviour is
      // backward-compatible by construction — which is why this hook's
      // existing tests still hold. Focus only lowers the bar, for the case
      // the old code got wrong: a real keyboard whose measured strip has
      // been shrunk by a grown `offsetTop`.
      const keyboardOpen = editableHasFocus()
        ? covered > CHROME_MAX_PX
        : covered > KEYBOARD_MIN_PX;
      const next = {
        inset: keyboardOpen ? Math.round(covered) : 0,
        // Always reported. Consumers cap maxHeight with this whether or not
        // a keyboard is open, because `100vh` on iOS is the LARGE viewport
        // and overflows the visible area on its own.
        height: Math.round(vv.height),
      };
      // BAIL OUT WHEN NOTHING CHANGED. Returning the PREVIOUS object makes
      // React skip the re-render; returning a fresh object with identical
      // fields does not, because the bail-out is reference equality.
      //
      // This listens on `focusin`/`focusout` at the window, so EVERY Tab
      // keypress fires two updates. Without this guard each one re-rendered
      // every consumer — Modal and Popover, i.e. the open dialog — and
      // Radix's focus trap restores focus on re-render, which fires
      // `focusin` again. Tabbing between fields in a dialog could therefore
      // drive an unbounded render loop and lock the page.
      setState((prev) =>
        prev.inset === next.inset && prev.height === next.height ? prev : next,
      );
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    // Focus drives the keyboard decision, so it has to drive the recompute
    // too — the viewport fires no event when focus moves between two inputs
    // without the keyboard closing.
    window.addEventListener("focusin", update);
    window.addEventListener("focusout", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("focusin", update);
      window.removeEventListener("focusout", update);
    };
  }, []);

  return state;
}
