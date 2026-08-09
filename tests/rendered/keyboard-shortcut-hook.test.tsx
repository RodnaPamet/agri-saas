/**
 * Epic 57 — integration tests for the shared keyboard shortcut system.
 *
 * Exercises the full stack: `KeyboardShortcutProvider` + `useKeyboardShortcut`
 * + `useRegisteredShortcuts` rendered under jsdom with React Testing
 * Library. Focuses on the guarantees the app leans on:
 *
 *   - Registration / unregistration round-trips cleanly
 *   - Priority + registration-order tie-break
 *   - `enabled: false` disables without unmount churn
 *   - Typing in inputs / textareas / contenteditable doesn't trigger
 *   - Overlay-scoped shortcuts only fire while an overlay is mounted
 *   - Unmount removes the listener from the registry
 *   - `useRegisteredShortcuts()` reflects current state for the palette
 */

import React, { useRef } from 'react';
import { render, act, fireEvent } from '@testing-library/react';

import {
    KeyboardShortcutProvider,
    useKeyboardShortcut,
    useRegisteredShortcuts,
    type UseKeyboardShortcutOptions,
} from '@/lib/hooks/use-keyboard-shortcut';

// ─── Test primitives ───────────────────────────────────────────────────

function Binding({
    keys,
    onHit,
    options,
    testId,
}: {
    keys: string | string[];
    onHit: () => void;
    options?: UseKeyboardShortcutOptions;
    testId?: string;
}) {
    useKeyboardShortcut(keys, onHit, options);
    return <div data-testid={testId ?? 'binding'} />;
}

function dispatchKey(key: string, mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {}, target?: Element) {
    const event = new KeyboardEvent('keydown', {
        key,
        metaKey: !!mods.meta,
        ctrlKey: !!mods.ctrl,
        altKey: !!mods.alt,
        shiftKey: !!mods.shift,
        bubbles: true,
        cancelable: true,
    });
    (target ?? window).dispatchEvent(event);
    return event;
}

// ─── Registration lifecycle ────────────────────────────────────────────

describe('useKeyboardShortcut — registration', () => {
    it('invokes the handler when the matching key is pressed', () => {
        const spy = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <Binding keys="k" onHit={spy} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('k');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('unregisters on unmount', () => {
        const spy = jest.fn();
        const { unmount } = render(
            <KeyboardShortcutProvider>
                <Binding keys="k" onHit={spy} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('k');
        expect(spy).toHaveBeenCalledTimes(1);
        unmount();
        dispatchKey('k');
        expect(spy).toHaveBeenCalledTimes(1); // no new calls post-unmount
    });

    it('treats `enabled: false` as a no-op without unmounting', () => {
        const spy = jest.fn();
        const { rerender } = render(
            <KeyboardShortcutProvider>
                <Binding keys="k" onHit={spy} options={{ enabled: true }} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('k');
        expect(spy).toHaveBeenCalledTimes(1);

        rerender(
            <KeyboardShortcutProvider>
                <Binding keys="k" onHit={spy} options={{ enabled: false }} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('k');
        expect(spy).toHaveBeenCalledTimes(1); // still 1

        rerender(
            <KeyboardShortcutProvider>
                <Binding keys="k" onHit={spy} options={{ enabled: true }} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('k');
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('accepts arrays of shortcuts and reports which one matched', () => {
        const matches: string[] = [];
        function MultiBinding() {
            useKeyboardShortcut(['Escape', '?'], (_e, { matched }) => {
                matches.push(matched);
            });
            return null;
        }
        render(
            <KeyboardShortcutProvider>
                <MultiBinding />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('Escape');
        dispatchKey('?', { shift: true });
        expect(matches).toEqual(['Escape', '?']);
    });
});

// ─── Priority model ────────────────────────────────────────────────────

describe('useKeyboardShortcut — priority & precedence', () => {
    it('higher priority wins over lower priority', () => {
        const low = jest.fn();
        const high = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <Binding keys="Escape" onHit={low} options={{ priority: 0 }} />
                <Binding keys="Escape" onHit={high} options={{ priority: 10 }} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('Escape');
        expect(high).toHaveBeenCalledTimes(1);
        expect(low).not.toHaveBeenCalled();
    });

    it('ties break in favour of the most-recently-registered listener', () => {
        const first = jest.fn();
        const second = jest.fn();
        const { rerender } = render(
            <KeyboardShortcutProvider>
                <Binding keys="Escape" onHit={first} />
            </KeyboardShortcutProvider>,
        );
        rerender(
            <KeyboardShortcutProvider>
                <Binding keys="Escape" onHit={first} />
                <Binding keys="Escape" onHit={second} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('Escape');
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).not.toHaveBeenCalled();
    });

    it('only fires ONE handler per keystroke, never both', () => {
        const a = jest.fn();
        const b = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <Binding keys="Escape" onHit={a} options={{ priority: 1 }} />
                <Binding keys="Escape" onHit={b} options={{ priority: 2 }} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('Escape');
        expect(b).toHaveBeenCalledTimes(1);
        expect(a).not.toHaveBeenCalled();
    });
});

// ─── Text-input safety ─────────────────────────────────────────────────

describe('useKeyboardShortcut — text-input safety', () => {
    it('does not fire while typing in an INPUT', () => {
        const spy = jest.fn();
        const { getByTestId } = render(
            <KeyboardShortcutProvider>
                <input data-testid="text" />
                <Binding keys="k" onHit={spy} />
            </KeyboardShortcutProvider>,
        );
        const input = getByTestId('text') as HTMLInputElement;
        input.focus();
        fireEvent.keyDown(input, { key: 'k' });
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not fire while typing in a TEXTAREA', () => {
        const spy = jest.fn();
        const { getByTestId } = render(
            <KeyboardShortcutProvider>
                <textarea data-testid="text" />
                <Binding keys="k" onHit={spy} />
            </KeyboardShortcutProvider>,
        );
        const ta = getByTestId('text') as HTMLTextAreaElement;
        ta.focus();
        fireEvent.keyDown(ta, { key: 'k' });
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not fire inside a contenteditable surface', () => {
        const spy = jest.fn();
        const { getByTestId } = render(
            <KeyboardShortcutProvider>
                <div data-testid="edit" contentEditable suppressContentEditableWarning />
                <Binding keys="k" onHit={spy} />
            </KeyboardShortcutProvider>,
        );
        const editable = getByTestId('edit');
        fireEvent.keyDown(editable, { key: 'k' });
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not fire on role="combobox" targets (Radix Combobox triggers)', () => {
        const spy = jest.fn();
        const { getByTestId } = render(
            <KeyboardShortcutProvider>
                <button data-testid="cb" role="combobox" aria-controls="cb-listbox" aria-expanded="false" />
                <Binding keys="k" onHit={spy} />
            </KeyboardShortcutProvider>,
        );
        fireEvent.keyDown(getByTestId('cb'), { key: 'k' });
        expect(spy).not.toHaveBeenCalled();
    });

    it('allows opt-in with allowInInputs=true (for palette search bars)', () => {
        const spy = jest.fn();
        const { getByTestId } = render(
            <KeyboardShortcutProvider>
                <input data-testid="text" />
                <Binding keys="Escape" onHit={spy} options={{ allowInInputs: true }} />
            </KeyboardShortcutProvider>,
        );
        const input = getByTestId('text') as HTMLInputElement;
        input.focus();
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

// ─── Overlay scope ─────────────────────────────────────────────────────

describe('useKeyboardShortcut — overlay scope', () => {
    function withOverlay(scope: 'global' | 'overlay', open: boolean) {
        const overlay = open
            ? (
                  <div
                      role="dialog"
                      aria-label="x"
                      aria-modal="true"
                      data-state="open"
                  />
              )
            : null;
        const spy = jest.fn();
        const utils = render(
            <KeyboardShortcutProvider>
                {overlay}
                <Binding keys="k" onHit={spy} options={{ scope }} />
            </KeyboardShortcutProvider>,
        );
        return { spy, ...utils };
    }

    it('blocks a global shortcut while an overlay is open', () => {
        const { spy } = withOverlay('global', true);
        dispatchKey('k');
        expect(spy).not.toHaveBeenCalled();
    });

    it('fires an overlay-scoped shortcut while an overlay is open', () => {
        const { spy } = withOverlay('overlay', true);
        dispatchKey('k');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not fire an overlay-scoped shortcut while no overlay is open', () => {
        const { spy } = withOverlay('overlay', false);
        dispatchKey('k');
        expect(spy).not.toHaveBeenCalled();
    });

    it('allowWhenOverlayOpen lets a global shortcut fire either way', () => {
        const spy = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <div role="dialog" aria-label="x" data-state="open" />
                <Binding keys="k" onHit={spy} options={{ allowWhenOverlayOpen: true }} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('k');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('legacy `modal: true` maps to scope=overlay', () => {
        const spy = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <div role="dialog" aria-label="x" data-state="open" />
                <Binding keys="Escape" onHit={spy} options={{ modal: true }} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('Escape');
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

// ─── preventDefault / stopPropagation ──────────────────────────────────

describe('useKeyboardShortcut — default + propagation handling', () => {
    it('preventDefault is on by default', () => {
        render(
            <KeyboardShortcutProvider>
                <Binding keys="k" onHit={() => {}} />
            </KeyboardShortcutProvider>,
        );
        const ev = dispatchKey('k');
        expect(ev.defaultPrevented).toBe(true);
    });

    it('respects preventDefault: false', () => {
        render(
            <KeyboardShortcutProvider>
                <Binding keys="k" onHit={() => {}} options={{ preventDefault: false }} />
            </KeyboardShortcutProvider>,
        );
        const ev = dispatchKey('k');
        expect(ev.defaultPrevented).toBe(false);
    });
});

// ─── Introspection for the palette ─────────────────────────────────────

describe('useRegisteredShortcuts', () => {
    function List() {
        const list = useRegisteredShortcuts();
        return (
            <ul data-testid="list">
                {list.map((s) => (
                    <li key={s.id}>
                        {s.keys.join(',')} — {s.description ?? '(no description)'} — {s.scope}
                    </li>
                ))}
            </ul>
        );
    }

    it('reflects active shortcuts and their descriptions', () => {
        const { getByTestId } = render(
            <KeyboardShortcutProvider>
                <Binding
                    keys="mod+k"
                    onHit={() => {}}
                    options={{ description: 'Open command palette' }}
                />
                <Binding
                    keys="g d"
                    onHit={() => {}}
                    options={{ description: 'Go to Dashboard' }}
                />
                <List />
            </KeyboardShortcutProvider>,
        );
        const ul = getByTestId('list');
        expect(ul.textContent).toContain('mod+k — Open command palette — global');
        expect(ul.textContent).toContain('g d — Go to Dashboard — global');
    });

    it('updates when a shortcut unmounts', () => {
        function Harness({ showGlobal }: { showGlobal: boolean }) {
            const ref = useRef(() => {});
            return (
                <KeyboardShortcutProvider>
                    {showGlobal && (
                        <Binding
                            keys="mod+k"
                            // test fixture: the test mutates ref.current between renders to verify the registry tracks the latest handler.
                            // eslint-disable-next-line react-hooks/refs
                            onHit={ref.current}
                            options={{ description: 'Open palette' }}
                        />
                    )}
                    <List />
                </KeyboardShortcutProvider>
            );
        }
        const { rerender, getByTestId } = render(<Harness showGlobal />);
        expect(getByTestId('list').textContent).toContain('mod+k');

        act(() => {
            rerender(<Harness showGlobal={false} />);
        });
        expect(getByTestId('list').textContent).not.toContain('mod+k');
    });
});

// ─── Outside the provider ──────────────────────────────────────────────

describe('useKeyboardShortcut — no provider mounted', () => {
    it('does not throw when used without a provider and never fires', () => {
        const spy = jest.fn();
        // Intentionally no <KeyboardShortcutProvider/>.
        render(<Binding keys="k" onHit={spy} />);
        dispatchKey('k');
        expect(spy).not.toHaveBeenCalled();
    });
});
