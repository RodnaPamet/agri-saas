import { KeyboardEvent, RefObject, useCallback, useRef } from "react";

/**
 * Enter-to-submit for form inputs, with the "don't hijack multiline"
 * rule baked in.
 *
 * ## Default policy (`modifier: 'auto'`)
 *
 *   - `<input>`  ─ bare Enter submits. Matches native browser behaviour;
 *                  the hook adds IME-safety + optional form-ref fallback.
 *   - `<textarea>` ─ bare Enter inserts a newline (native behaviour
 *                    PRESERVED). `Cmd/Ctrl+Enter` submits. This is the
 *                    muscle-memory contract from chat UIs / prompt
 *                    consoles and is what users expect when typing
 *                    longform fields.
 *
 * ## Shift+Enter always inserts a newline
 *
 * Users reach for Shift+Enter specifically to mean "new line, don't
 * submit", regardless of element type. The hook never submits on
 * Shift+Enter — even if `modifier: 'always'` is set — because doing so
 * would be a papercut for keyboard-heavy users.
 *
 * ## IME composition
 *
 * While an IME candidate window is open (CJK, emoji picker, dead-key
 * chains), the browser reports `event.nativeEvent.isComposing === true`.
 * Firing a submit in that state cancels the user's in-progress
 * composition — a real-world bug for Japanese / Chinese / Korean users.
 * The hook always bails on composing events.
 *
 * ## Submit target resolution
 *
 * Order of attempts:
 *   1. `onSubmit` callback (if provided) — fully bypasses form
 *      lookup; useful for controlled forms driven by `react-hook-form`,
 *      or for "quick add" inputs that aren't inside a `<form>`.
 *   2. `formRef.current.requestSubmit()` — explicit ref wins when given.
 *   3. `event.target.form?.requestSubmit()` — walks from the input back
 *      to its ancestor `<form>` via the native `.form` property.
 *
 * `.requestSubmit()` (not `.submit()`) is used so the form's `submit`
 * event fires — otherwise React-managed forms see no event and skip
 * validation / preventDefault wiring.
 *
 * ## Usage
 *
 * ```tsx
 * // Chat-style textarea: Cmd+Enter submits, Enter inserts newline.
 * const { handleKeyDown } = useEnterSubmit({ formRef });
 * <textarea ref={inputRef} onKeyDown={handleKeyDown} />
 *
 * // "Quick add" input with a custom handler (no surrounding form).
 * const { handleKeyDown } = useEnterSubmit({ onSubmit: addItem });
 * <input value={draft} onChange={...} onKeyDown={handleKeyDown} />
 *
 * // Force Cmd/Ctrl+Enter even on single-line input (e.g. dangerous
 * // actions you want to slow down slightly).
 * useEnterSubmit({ formRef, modifier: 'modifier' });
 * ```
 */

export type EnterSubmitModifierPolicy =
    /** Submit on bare Enter for `<input>`, require Cmd/Ctrl+Enter for
     *  `<textarea>`. Default — matches native + chat-app conventions. */
    | "auto"
    /** Bare Enter always submits. Only pick this if the field is
     *  single-line and you've disabled newline insertion another way. */
    | "always"
    /** Always require Cmd/Ctrl+Enter. Use for destructive submits
     *  where a reflexive Enter would be dangerous. */
    | "modifier";

export interface UseEnterSubmitOptions {
    /**
     * Explicit `<form>` ref to submit. If omitted, the hook falls back
     * to `event.target.form` (the input's ancestor form).
     */
    formRef?: RefObject<HTMLFormElement | null>;
    /**
     * Custom submit handler. When set, takes precedence over any form
     * submission — useful for "quick add" inputs outside a form, or
     * controlled forms where the caller wants a callback rather than a
     * `submit` event.
     */
    onSubmit?: (event: KeyboardEvent<HTMLElement>) => void;
    /** See {@link EnterSubmitModifierPolicy}. Defaults to `"auto"`. */
    modifier?: EnterSubmitModifierPolicy;
    /** Disable the behaviour without unmounting. Defaults to `true`. */
    enabled?: boolean;
    /**
     * Stop propagation of the Enter keydown event when a submit fires.
     * Defaults to `false`. Turn on inside modals where a parent
     * keyboard-shortcut registry might otherwise see the same Enter.
     */
    stopPropagation?: boolean;
}

export interface UseEnterSubmitResult {
    handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

function isTextarea(el: EventTarget | null): boolean {
    return (
        !!el &&
        typeof (el as HTMLElement).tagName === "string" &&
        (el as HTMLElement).tagName === "TEXTAREA"
    );
}

function hasModifier(event: KeyboardEvent<HTMLElement>): boolean {
    // Meta = Cmd on macOS; Ctrl on Windows/Linux. Accept either so
    // cross-platform users aren't fighting their muscle memory.
    return event.metaKey || event.ctrlKey;
}

export function useEnterSubmit(
    options: UseEnterSubmitOptions = {},
): UseEnterSubmitResult {
    const {
        formRef,
        onSubmit,
        modifier = "auto",
        enabled = true,
        stopPropagation = false,
    } = options;

    // Keep the latest options in a ref so the callback identity stays
    // stable — consumers can spread `handleKeyDown` into a memoised
    // child without triggering a re-render storm.
    const optsRef = useRef({
        formRef,
        onSubmit,
        modifier,
        enabled,
        stopPropagation,
    });
    // "ref-as-mailbox" — refresh the latest opts every render so the keyDown handler
    // (kept stable via useCallback below) reads through to the freshest values.
    // eslint-disable-next-line react-hooks/refs -- ref-as-mailbox: the keyDown handler is kept stable by useCallback and reads opts THROUGH this ref, so it has to be refreshed during render to see the freshest values
    optsRef.current = {
        formRef,
        onSubmit,
        modifier,
        enabled,
        stopPropagation,
    };

    const handleKeyDown = useCallback(
        (event: KeyboardEvent<HTMLElement>) => {
            const opts = optsRef.current;
            if (!opts.enabled) return;
            if (event.key !== "Enter") return;

            // IME composition guard. React forwards `isComposing` via
            // `nativeEvent`; some synthetic events lose it, so we also
            // check keyCode 229 (the "in-composition" sentinel).
            const native = event.nativeEvent as unknown as {
                isComposing?: boolean;
                keyCode?: number;
            };
            if (native.isComposing) return;
            if (native.keyCode === 229) return;

            // Shift+Enter always inserts a newline — never submit. This
            // is the universal "new line, not send" shortcut.
            if (event.shiftKey) return;

            const textarea = isTextarea(event.target);
            const modPressed = hasModifier(event);

            // Decide whether this keystroke should submit.
            let shouldSubmit = false;
            switch (opts.modifier) {
                case "always":
                    shouldSubmit = true;
                    break;
                case "modifier":
                    shouldSubmit = modPressed;
                    break;
                case "auto":
                default:
                    shouldSubmit = textarea ? modPressed : true;
                    break;
            }

            if (!shouldSubmit) return;

            event.preventDefault();
            if (opts.stopPropagation) event.stopPropagation();

            if (opts.onSubmit) {
                opts.onSubmit(event);
                return;
            }

            if (opts.formRef?.current) {
                opts.formRef.current.requestSubmit();
                return;
            }

            // Fall back to the input's native ancestor form.
            const form = (event.target as HTMLInputElement | HTMLTextAreaElement)
                .form;
            form?.requestSubmit();
        },
        [],
    );

    return { handleKeyDown };
}
