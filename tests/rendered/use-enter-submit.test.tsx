/**
 * Zero-coverage hooks, wave 3 (part 1): `useEnterSubmit`.
 *
 * The Epic 60 shared hook that CLAUDE.md tells contributors to reach for
 * instead of hand-rolling an Enter-submit handler — and nothing imported it
 * from a test.
 *
 * It is worth pinning because almost every rule in it is a *policy* decision
 * that reads like an accident if you meet it cold in a diff:
 *
 *   - bare Enter submits an `<input>` but inserts a newline in a `<textarea>`
 *   - Shift+Enter NEVER submits, not even under `modifier: 'always'`
 *   - an in-progress IME composition suppresses the submit entirely
 *   - `requestSubmit()`, never `submit()`, so React sees the submit event
 *
 * Each of those is one line that a well-meaning simplification can delete
 * without breaking a type or another test. The IME rule is the sharpest:
 * dropping it silently breaks every CJK user and nobody else, so it is
 * exactly the kind of regression that ships.
 */
import { useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { render, renderHook, screen, fireEvent } from '@testing-library/react';
import { useEnterSubmit, type UseEnterSubmitOptions } from '@/components/ui/hooks/use-enter-submit';

// ─── synthetic-event helper ──────────────────────────────────────────
//
// The hook reads a narrow slice of the React synthetic event, so a
// hand-built object gives precise practice over the branch inputs
// (isComposing, keyCode 229, the `.form` fallback) that are awkward to
// provoke through a real render. Two real-DOM integration tests at the
// bottom prove the same handler works against genuine React events.

interface FakeEventInit {
    key?: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    target?: unknown;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

function keyEvent(over: FakeEventInit = {}) {
    const preventDefault = jest.fn();
    const stopPropagation = jest.fn();
    const event = {
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        target: document.createElement('input'),
        nativeEvent: {},
        preventDefault,
        stopPropagation,
        ...over,
    };
    return event as unknown as ReactKeyboardEvent<HTMLElement> & {
        preventDefault: jest.Mock;
        stopPropagation: jest.Mock;
    };
}

const textareaTarget = () => document.createElement('textarea');

function setup(options: UseEnterSubmitOptions = {}) {
    const onSubmit = options.onSubmit ?? jest.fn();
    const view = renderHook((props: UseEnterSubmitOptions) => useEnterSubmit(props), {
        initialProps: { ...options, onSubmit },
    });
    return { ...view, onSubmit: onSubmit as jest.Mock };
}

describe('useEnterSubmit — default "auto" policy', () => {
    it('submits on bare Enter in an <input>', () => {
        const { result, onSubmit } = setup();
        const event = keyEvent();

        result.current.handleKeyDown(event);

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    it('does NOT submit on bare Enter in a <textarea> — the newline is preserved', () => {
        // The chat-UI contract. Submitting here would make longform fields
        // impossible to use, and it is native browser behaviour besides.
        const { result, onSubmit } = setup();
        const event = keyEvent({ target: textareaTarget() });

        result.current.handleKeyDown(event);

        expect(onSubmit).not.toHaveBeenCalled();
        // Critically, it must not preventDefault either — otherwise the
        // newline the user asked for never gets inserted.
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it.each([
        ['Cmd (metaKey)', { metaKey: true }],
        ['Ctrl (ctrlKey)', { ctrlKey: true }],
    ])('submits a <textarea> on %s + Enter', (_label, mods) => {
        const { result, onSubmit } = setup();

        result.current.handleKeyDown(keyEvent({ target: textareaTarget(), ...mods }));

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('ignores keys other than Enter', () => {
        const { result, onSubmit } = setup();

        for (const key of ['a', 'Tab', 'Escape', 'NumpadEnter', ' ']) {
            result.current.handleKeyDown(keyEvent({ key }));
        }

        expect(onSubmit).not.toHaveBeenCalled();
    });
});

describe('useEnterSubmit — Shift+Enter is inviolable', () => {
    it.each([['auto'], ['always'], ['modifier']] as const)(
        'never submits on Shift+Enter under modifier=%s',
        (modifier) => {
            const { result, onSubmit } = setup({ modifier });

            // Even with the modifier held — the Shift check runs first.
            result.current.handleKeyDown(keyEvent({ shiftKey: true, metaKey: true }));

            expect(onSubmit).not.toHaveBeenCalled();
        },
    );
});

describe('useEnterSubmit — IME composition guard', () => {
    it('bails while a composition is in progress (isComposing)', () => {
        // Submitting mid-composition cancels the candidate window and
        // eats the user's half-typed word. CJK-only bug; ships easily.
        const { result, onSubmit } = setup();
        const event = keyEvent({ nativeEvent: { isComposing: true } });

        result.current.handleKeyDown(event);

        expect(onSubmit).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('bails on the keyCode 229 sentinel when isComposing is missing', () => {
        // Some synthetic/legacy events drop `isComposing`; 229 is the
        // long-standing "in composition" marker and is the backstop.
        const { result, onSubmit } = setup();

        result.current.handleKeyDown(keyEvent({ nativeEvent: { keyCode: 229 } }));

        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('submits normally once composition has ended', () => {
        const { result, onSubmit } = setup();

        result.current.handleKeyDown(keyEvent({ nativeEvent: { isComposing: false, keyCode: 13 } }));

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });
});

describe('useEnterSubmit — modifier policies', () => {
    it('"always" submits a bare Enter even in a <textarea>', () => {
        const { result, onSubmit } = setup({ modifier: 'always' });

        result.current.handleKeyDown(keyEvent({ target: textareaTarget() }));

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('"modifier" requires Cmd/Ctrl even in a plain <input>', () => {
        const { result, onSubmit } = setup({ modifier: 'modifier' });

        result.current.handleKeyDown(keyEvent());
        expect(onSubmit).not.toHaveBeenCalled();

        result.current.handleKeyDown(keyEvent({ metaKey: true }));
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });
});

describe('useEnterSubmit — enabled + stopPropagation', () => {
    it('does nothing at all when disabled', () => {
        const { result, onSubmit } = setup({ enabled: false });
        const event = keyEvent();

        result.current.handleKeyDown(event);

        expect(onSubmit).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('re-enables without remounting (the ref-mailbox reads fresh options)', () => {
        const onSubmit = jest.fn();
        const { result, rerender } = renderHook(
            (props: UseEnterSubmitOptions) => useEnterSubmit(props),
            { initialProps: { onSubmit, enabled: false } as UseEnterSubmitOptions },
        );

        result.current.handleKeyDown(keyEvent());
        expect(onSubmit).not.toHaveBeenCalled();

        rerender({ onSubmit, enabled: true });
        result.current.handleKeyDown(keyEvent());
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('leaves propagation alone by default and stops it when asked', () => {
        // Modals opt in so a page-level shortcut registry doesn't also
        // see the Enter that just submitted the dialog.
        const quiet = setup();
        const quietEvent = keyEvent();
        quiet.result.current.handleKeyDown(quietEvent);
        expect(quietEvent.stopPropagation).not.toHaveBeenCalled();

        const loud = setup({ stopPropagation: true });
        const loudEvent = keyEvent();
        loud.result.current.handleKeyDown(loudEvent);
        expect(loudEvent.stopPropagation).toHaveBeenCalled();
    });

    it('returns a stable handleKeyDown across re-renders', () => {
        // The whole point of the ref-mailbox: `useCallback(…, [])` means a
        // memoised child never re-renders because of this hook.
        const { result, rerender } = renderHook(
            (props: UseEnterSubmitOptions) => useEnterSubmit(props),
            { initialProps: { modifier: 'auto' } as UseEnterSubmitOptions },
        );
        const first = result.current.handleKeyDown;

        rerender({ modifier: 'always', stopPropagation: true });

        expect(result.current.handleKeyDown).toBe(first);
    });
});

describe('useEnterSubmit — submit target resolution', () => {
    it('prefers onSubmit over an explicit formRef', () => {
        const requestSubmit = jest.fn();
        const formRef = { current: { requestSubmit } as unknown as HTMLFormElement };
        const { result, onSubmit } = setup({ formRef });

        result.current.handleKeyDown(keyEvent());

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(requestSubmit).not.toHaveBeenCalled();
    });

    it('prefers an explicit formRef over the input’s ancestor form', () => {
        const explicit = jest.fn();
        const ancestor = jest.fn();
        const input = document.createElement('input');
        Object.defineProperty(input, 'form', { value: { requestSubmit: ancestor } });

        const { result } = renderHook(() =>
            useEnterSubmit({
                formRef: { current: { requestSubmit: explicit } as unknown as HTMLFormElement },
            }),
        );
        result.current.handleKeyDown(keyEvent({ target: input }));

        expect(explicit).toHaveBeenCalledTimes(1);
        expect(ancestor).not.toHaveBeenCalled();
    });

    it('falls back to the ancestor form when the ref is empty', () => {
        const ancestor = jest.fn();
        const input = document.createElement('input');
        Object.defineProperty(input, 'form', { value: { requestSubmit: ancestor } });

        const { result } = renderHook(() =>
            useEnterSubmit({ formRef: { current: null } }),
        );
        result.current.handleKeyDown(keyEvent({ target: input }));

        expect(ancestor).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when there is no form anywhere (a bare quick-add input)', () => {
        const { result } = renderHook(() => useEnterSubmit());
        const event = keyEvent();

        // The `form?.` optional chain is what keeps this from throwing.
        expect(() => result.current.handleKeyDown(event)).not.toThrow();
        expect(event.preventDefault).toHaveBeenCalled();
    });
});

// ─── real-DOM integration ────────────────────────────────────────────

describe('useEnterSubmit — against real React events', () => {
    beforeAll(() => {
        // jsdom builds before v21 have no requestSubmit; the hook picks it
        // deliberately over submit() so React sees the event, so the
        // polyfill must dispatch a real (cancelable) submit.
        if (typeof HTMLFormElement.prototype.requestSubmit !== 'function') {
            HTMLFormElement.prototype.requestSubmit = function requestSubmit(this: HTMLFormElement) {
                this.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            };
        }
    });

    function ChatForm({ onSubmitted }: { onSubmitted: () => void }) {
        const formRef = useRef<HTMLFormElement>(null);
        const { handleKeyDown } = useEnterSubmit({ formRef });
        return (
            <form
                ref={formRef}
                onSubmit={(e) => {
                    e.preventDefault();
                    onSubmitted();
                }}
            >
                <input id="title" aria-label="Title" onKeyDown={handleKeyDown} />
                <textarea id="body" aria-label="Body" onKeyDown={handleKeyDown} />
            </form>
        );
    }

    it('Enter in the input fires the form’s submit event', () => {
        const onSubmitted = jest.fn();
        render(<ChatForm onSubmitted={onSubmitted} />);

        fireEvent.keyDown(screen.getByLabelText('Title'), { key: 'Enter' });

        expect(onSubmitted).toHaveBeenCalledTimes(1);
    });

    it('Enter in the textarea does not, but Cmd+Enter does', () => {
        const onSubmitted = jest.fn();
        render(<ChatForm onSubmitted={onSubmitted} />);
        const body = screen.getByLabelText('Body');

        fireEvent.keyDown(body, { key: 'Enter' });
        expect(onSubmitted).not.toHaveBeenCalled();

        fireEvent.keyDown(body, { key: 'Enter', metaKey: true });
        expect(onSubmitted).toHaveBeenCalledTimes(1);
    });
});
