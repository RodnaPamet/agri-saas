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
 * So the keyboard is detected from FOCUS — an editable element has focus —
 * and the pixel measurement is used only to size the lift, never to decide
 * whether to lift at all. Browser chrome (URL bar, toolbar) also covers the
 * bottom strip, so a small floor still filters chrome-only jitter, but it
 * can no longer veto a real keyboard.
 */
export interface KeyboardInset {
  /** Keyboard height in CSS px (0 when no keyboard). */
  inset: number;
  /** Visual-viewport height in CSS px (0 before mount). */
  height: number;
}

/**
 * Below this the covered strip is browser chrome, not a keyboard. Only
 * consulted once focus already says an editable element is active, so it
 * filters jitter rather than deciding the question.
 */
const CHROME_MAX_PX = 80;

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
      const keyboardOpen = editableHasFocus() && covered > CHROME_MAX_PX;
      setState({
        inset: keyboardOpen ? Math.round(covered) : 0,
        // Always reported. Consumers cap maxHeight with this whether or not
        // a keyboard is open, because `100vh` on iOS is the LARGE viewport
        // and overflows the visible area on its own.
        height: Math.round(vv.height),
      });
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
