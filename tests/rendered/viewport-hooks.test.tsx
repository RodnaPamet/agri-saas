/**
 * Zero-coverage hooks, wave 3 (part 2): the five browser-API subscribers.
 *
 *   useReducedMotion / prefersReducedMotion  — matchMedia
 *   useResizeObserver                        — ResizeObserver
 *   useIntersectionObserver                  — IntersectionObserver
 *   useKeyboardInset                         — VisualViewport
 *   useInputFocused                          — focusin/focusout
 *
 * They all have the same shape — subscribe in an effect, tear down on
 * unmount — and none of them was imported by a test. Two properties are
 * worth the setup cost, and neither shows up as a failure in ordinary use:
 *
 *   1. **The SSR/absent-API guard.** Every one bails when its global is
 *      missing. That branch is what keeps a server render (and a jsdom
 *      environment without the polyfill) from throwing, and it is
 *      unreachable in a browser, so it never gets exercised by hand.
 *   2. **Cleanup.** A leaked observer or window listener passes every
 *      assertion you would naturally write; it only shows up later as a
 *      setState-after-unmount warning or a slow page. So the teardown is
 *      asserted directly here.
 *
 * These tests replace the inert polyfills in `tests/rendered/setup.ts` with
 * capturing fakes so the observer callbacks can actually be driven, then
 * restore the originals.
 */
import { act, render, renderHook, screen } from '@testing-library/react';
import { useReducedMotion, prefersReducedMotion } from '@/components/ui/hooks/use-reduced-motion';
import { useResizeObserver } from '@/components/ui/hooks/use-resize-observer';
import { useIntersectionObserver } from '@/components/ui/hooks/use-intersection-observer';
import { useKeyboardInset } from '@/components/ui/hooks/use-keyboard-inset';
import { useInputFocused } from '@/components/ui/hooks/use-input-focused';

type Mutable = Record<string, unknown>;
const win = window as unknown as Mutable;

/**
 * Swap a global for the duration of a test, restoring whatever was there.
 *
 * `tests/rendered/setup.ts` installs its matchMedia polyfill as
 * writable-but-NOT-configurable, so `defineProperty` throws on it — plain
 * assignment is the fallback that works for those.
 */
function setGlobal(key: string, value: unknown) {
    try {
        Object.defineProperty(window, key, { configurable: true, writable: true, value });
    } catch {
        win[key] = value;
    }
}

function withGlobal(key: string, value: unknown) {
    const had = key in win;
    const original = win[key];
    setGlobal(key, value);
    return () => {
        if (had) setGlobal(key, original);
        else {
            try {
                delete win[key];
            } catch {
                win[key] = undefined;
            }
        }
    };
}

/** A stable ref, the way a real caller's `useRef` behaves across renders. */
function elementRef(el: Element | null = document.createElement('div')) {
    return { current: el };
}

// ─── useReducedMotion ────────────────────────────────────────────────

describe('useReducedMotion', () => {
    let restore: () => void;
    afterEach(() => restore?.());

    function stubMatchMedia(initial: boolean) {
        const listeners = new Set<() => void>();
        const mq = {
            matches: initial,
            addEventListener: (_type: string, cb: () => void) => void listeners.add(cb),
            removeEventListener: (_type: string, cb: () => void) => void listeners.delete(cb),
        };
        const matchMedia = jest.fn(() => mq);
        restore = withGlobal('matchMedia', matchMedia);
        return {
            matchMedia,
            emit(next: boolean) {
                mq.matches = next;
                act(() => listeners.forEach((cb) => cb()));
            },
            listenerCount: () => listeners.size,
        };
    }

    it('resolves the preference on mount', () => {
        const mm = stubMatchMedia(true);

        const { result } = renderHook(() => useReducedMotion());

        expect(result.current).toBe(true);
        expect(mm.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    });

    it('starts false when motion is allowed', () => {
        stubMatchMedia(false);
        expect(renderHook(() => useReducedMotion()).result.current).toBe(false);
    });

    it('stays live when the OS setting flips mid-session', () => {
        const mm = stubMatchMedia(false);
        const { result } = renderHook(() => useReducedMotion());

        mm.emit(true);
        expect(result.current).toBe(true);

        mm.emit(false);
        expect(result.current).toBe(false);
    });

    it('removes its listener on unmount', () => {
        const mm = stubMatchMedia(false);
        const { unmount } = renderHook(() => useReducedMotion());
        expect(mm.listenerCount()).toBe(1);

        unmount();

        expect(mm.listenerCount()).toBe(0);
    });

    it('degrades to "motion on" when matchMedia is unavailable', () => {
        // The SSR shape: no matchMedia, so the server markup must match the
        // first client render rather than throwing.
        restore = withGlobal('matchMedia', undefined);

        expect(renderHook(() => useReducedMotion()).result.current).toBe(false);
        expect(prefersReducedMotion()).toBe(false);
    });

    it('prefersReducedMotion answers imperatively for non-React callers', () => {
        // Used by the haptics module, which has no React runtime.
        const mm = stubMatchMedia(true);
        expect(prefersReducedMotion()).toBe(true);
        expect(mm.matchMedia).toHaveBeenCalled();
    });
});

// ─── observer helpers ────────────────────────────────────────────────

/** A capturing fake for the two observer constructors. */
function observerFake() {
    const instances: Array<{
        callback: (entries: unknown[]) => void;
        options?: unknown;
        observed: Element[];
        disconnect: jest.Mock;
    }> = [];

    class Fake {
        callback: (entries: unknown[]) => void;
        options?: unknown;
        observed: Element[] = [];
        disconnect = jest.fn();
        constructor(callback: (entries: unknown[]) => void, options?: unknown) {
            this.callback = callback;
            this.options = options;
            instances.push(this);
        }
        observe(node: Element) {
            this.observed.push(node);
        }
        unobserve() {}
        takeRecords() {
            return [];
        }
    }

    return {
        ctor: Fake,
        instances,
        latest: () => instances[instances.length - 1],
        emit(entry: unknown) {
            act(() => instances[instances.length - 1].callback([entry]));
        },
    };
}

// ─── useResizeObserver ───────────────────────────────────────────────

describe('useResizeObserver', () => {
    let restore: () => void;
    afterEach(() => restore?.());

    it('reports the latest entry and observes the ref’d node', () => {
        const fake = observerFake();
        restore = withGlobal('ResizeObserver', fake.ctor);
        const node = document.createElement('div');

        const ref = elementRef(node);
        const { result } = renderHook(() => useResizeObserver(ref));
        expect(result.current).toBeUndefined(); // nothing observed yet

        fake.emit({ contentRect: { width: 640, height: 480 } });

        expect(result.current).toEqual({ contentRect: { width: 640, height: 480 } });
        expect(fake.latest().observed).toEqual([node]);
    });

    it('keeps only the most recent entry', () => {
        const fake = observerFake();
        restore = withGlobal('ResizeObserver', fake.ctor);
        const ref = elementRef();
        const { result } = renderHook(() => useResizeObserver(ref));

        fake.emit({ contentRect: { width: 100 } });
        fake.emit({ contentRect: { width: 200 } });

        expect(result.current).toEqual({ contentRect: { width: 200 } });
    });

    it('disconnects on unmount', () => {
        const fake = observerFake();
        restore = withGlobal('ResizeObserver', fake.ctor);
        const { unmount } = renderHook(() => useResizeObserver(elementRef()));

        unmount();

        expect(fake.latest().disconnect).toHaveBeenCalledTimes(1);
    });

    it('never constructs an observer for an empty ref', () => {
        const fake = observerFake();
        restore = withGlobal('ResizeObserver', fake.ctor);

        renderHook(() => useResizeObserver(elementRef(null)));

        expect(fake.instances).toHaveLength(0);
    });

    it('is inert when ResizeObserver does not exist (SSR / bare jsdom)', () => {
        restore = withGlobal('ResizeObserver', undefined);

        const { result } = renderHook(() => useResizeObserver(elementRef()));

        expect(result.current).toBeUndefined();
    });
});

// ─── useIntersectionObserver ─────────────────────────────────────────

describe('useIntersectionObserver', () => {
    let restore: () => void;
    afterEach(() => restore?.());

    const visible = { isIntersecting: true, intersectionRatio: 1 };
    const hidden = { isIntersecting: false, intersectionRatio: 0 };

    it('reports entries and forwards the observer options', () => {
        const fake = observerFake();
        restore = withGlobal('IntersectionObserver', fake.ctor);
        const node = document.createElement('div');

        const ref = elementRef(node);
        const { result } = renderHook(() =>
            useIntersectionObserver(ref, { threshold: 0.5, rootMargin: '10px' }),
        );

        expect(fake.latest().options).toEqual({ threshold: 0.5, root: null, rootMargin: '10px' });
        expect(fake.latest().observed).toEqual([node]);

        fake.emit(hidden);
        expect(result.current).toEqual(hidden);

        fake.emit(visible);
        expect(result.current).toEqual(visible);
    });

    it('applies the documented defaults', () => {
        const fake = observerFake();
        restore = withGlobal('IntersectionObserver', fake.ctor);

        renderHook(() => useIntersectionObserver(elementRef()));

        expect(fake.latest().options).toEqual({ threshold: 0, root: null, rootMargin: '0%' });
    });

    it('freezeOnceVisible latches: disconnects and stops re-observing', () => {
        // The lazy-load pattern. Once seen, the consumer keeps rendering the
        // "visible" state and the observer stops costing anything.
        const fake = observerFake();
        restore = withGlobal('IntersectionObserver', fake.ctor);

        const ref = elementRef();
        const { result } = renderHook(() => useIntersectionObserver(ref, { freezeOnceVisible: true }));
        expect(fake.instances).toHaveLength(1);

        fake.emit(visible);

        expect(result.current).toEqual(visible);
        expect(fake.instances[0].disconnect).toHaveBeenCalled();
        // The frozen effect must not build a replacement observer.
        expect(fake.instances).toHaveLength(1);
    });

    it('does NOT latch on a non-intersecting entry', () => {
        // Freezing on the first callback rather than the first *visible*
        // callback would break lazy-load for anything below the fold.
        const fake = observerFake();
        restore = withGlobal('IntersectionObserver', fake.ctor);

        const ref = elementRef();
        const { result } = renderHook(() => useIntersectionObserver(ref, { freezeOnceVisible: true }));

        fake.emit(hidden);
        expect(result.current).toEqual(hidden);

        fake.emit(visible);
        expect(result.current).toEqual(visible);
    });

    it('without freezing, keeps updating after becoming visible', () => {
        const fake = observerFake();
        restore = withGlobal('IntersectionObserver', fake.ctor);

        const ref = elementRef();
        const { result } = renderHook(() => useIntersectionObserver(ref));

        fake.emit(visible);
        fake.emit(hidden);

        expect(result.current).toEqual(hidden);
        // The CURRENT observer must still be live — that is the contract.
        //
        // Deliberately not asserting the instance count: `frozen` is
        // `entry?.isIntersecting && freezeOnceVisible`, which is `undefined`
        // before the first entry and `false` after, so the first callback
        // counts as a dependency change and rebuilds the observer once even
        // with freezing off. Harmless churn, and coercing it to a boolean
        // would remove it — but that is a behaviour change, out of scope for
        // a coverage pass. This assertion holds either way.
        expect(fake.latest().disconnect).not.toHaveBeenCalled();
    });

    it('disconnects on unmount, and skips an empty ref or a missing API', () => {
        const fake = observerFake();
        restore = withGlobal('IntersectionObserver', fake.ctor);

        const mounted = renderHook(() => useIntersectionObserver(elementRef()));
        mounted.unmount();
        expect(fake.instances[0].disconnect).toHaveBeenCalledTimes(1);

        renderHook(() => useIntersectionObserver(elementRef(null)));
        expect(fake.instances).toHaveLength(1);

        restore();
        restore = withGlobal('IntersectionObserver', undefined);
        const { result } = renderHook(() => useIntersectionObserver(elementRef()));
        expect(result.current).toBeUndefined();
    });
});

// ─── useKeyboardInset ────────────────────────────────────────────────

describe('useKeyboardInset', () => {
    const restores: Array<() => void> = [];
    afterEach(() => {
        while (restores.length) restores.pop()!();
    });

    function stubViewport({ height, offsetTop = 0, innerHeight = 800 }: {
        height: number;
        offsetTop?: number;
        innerHeight?: number;
    }) {
        const listeners: Record<string, Set<() => void>> = { resize: new Set(), scroll: new Set() };
        const vv = {
            height,
            offsetTop,
            addEventListener: (type: string, cb: () => void) => void listeners[type]?.add(cb),
            removeEventListener: (type: string, cb: () => void) => void listeners[type]?.delete(cb),
        };
        restores.push(withGlobal('visualViewport', vv));
        restores.push(withGlobal('innerHeight', innerHeight));
        return {
            vv,
            fire(type: 'resize' | 'scroll') {
                act(() => listeners[type].forEach((cb) => cb()));
            },
            count: (type: 'resize' | 'scroll') => listeners[type].size,
        };
    }

    it('reports zero inset when only browser chrome is missing', () => {
        // A 50px gap is the URL bar, not a keyboard. Reacting to it makes a
        // bottom sheet jitter on every scroll — hence the 120px threshold.
        stubViewport({ height: 750, innerHeight: 800 });

        const { result } = renderHook(() => useKeyboardInset());

        expect(result.current).toEqual({ inset: 0, height: 750 });
    });

    it('reports the keyboard height once the gap clears the threshold', () => {
        stubViewport({ height: 500, innerHeight: 800 });

        expect(renderHook(() => useKeyboardInset()).result.current).toEqual({ inset: 300, height: 500 });
    });

    it('treats exactly the threshold as chrome, not a keyboard', () => {
        // The comparison is strictly `>`, so 120 is still chrome.
        stubViewport({ height: 680, innerHeight: 800 });
        expect(renderHook(() => useKeyboardInset()).result.current.inset).toBe(0);
    });

    it('accounts for a scrolled visual viewport via offsetTop', () => {
        // covered = 800 - 500 - 40 = 260
        stubViewport({ height: 500, offsetTop: 40, innerHeight: 800 });
        expect(renderHook(() => useKeyboardInset()).result.current.inset).toBe(260);
    });

    it('rounds fractional viewport heights', () => {
        // Real devices report sub-pixel heights; a fractional `bottom` makes
        // the sheet edge blurry.
        stubViewport({ height: 499.6, innerHeight: 800 });
        const { result } = renderHook(() => useKeyboardInset());
        expect(result.current).toEqual({ inset: 300, height: 500 });
    });

    it('updates on both resize and scroll, then unsubscribes from both', () => {
        const vp = stubViewport({ height: 800, innerHeight: 800 });
        const { result, unmount } = renderHook(() => useKeyboardInset());
        expect(result.current.inset).toBe(0);

        vp.vv.height = 400;
        vp.fire('resize');
        expect(result.current).toEqual({ inset: 400, height: 400 });

        vp.vv.height = 600;
        vp.fire('scroll');
        expect(result.current).toEqual({ inset: 200, height: 600 });

        expect(vp.count('resize')).toBe(1);
        expect(vp.count('scroll')).toBe(1);
        unmount();
        expect(vp.count('resize')).toBe(0);
        expect(vp.count('scroll')).toBe(0);
    });

    it('returns zeros when VisualViewport is unsupported', () => {
        restores.push(withGlobal('visualViewport', null));

        expect(renderHook(() => useKeyboardInset()).result.current).toEqual({ inset: 0, height: 0 });
    });
});

// ─── useInputFocused ─────────────────────────────────────────────────

describe('useInputFocused', () => {
    function Probe() {
        const focused = useInputFocused();
        return <span data-focus={String(focused)}>{focused ? 'typing' : 'idle'}</span>;
    }

    const state = () => screen.getByText(/typing|idle/).textContent;

    function focus(el: HTMLElement) {
        act(() => {
            el.focus();
            el.dispatchEvent(new Event('focusin', { bubbles: true }));
        });
    }

    function blur(el: HTMLElement) {
        act(() => {
            el.blur();
            el.dispatchEvent(new Event('focusout', { bubbles: true }));
        });
    }

    function mount(markup: React.ReactNode) {
        return render(
            <div>
                <Probe />
                {markup}
            </div>,
        );
    }

    it('is idle when nothing is focused', () => {
        mount(<input aria-label="Search" />);
        expect(state()).toBe('idle');
    });

    it.each([
        ['input', <input key="i" aria-label="target" />],
        ['textarea', <textarea key="t" aria-label="target" />],
        // <select> counts because browsers absorb keystrokes for option matching.
        [
            'select',
            <select key="s" aria-label="target">
                <option>a</option>
            </select>,
        ],
        ['contenteditable', <div key="c" aria-label="target" contentEditable tabIndex={0} />],
        ['role=textbox', <div key="rt" aria-label="target" role="textbox" tabIndex={0} />],
        ['role=combobox', <div key="rc" aria-label="target" role="combobox" tabIndex={0} />],
        ['role=searchbox', <div key="rs" aria-label="target" role="searchbox" tabIndex={0} />],
    ])('detects focus in a %s', (_label, node) => {
        mount(node);

        focus(screen.getByLabelText('target'));

        expect(state()).toBe('typing');
    });

    it.each([
        ['a button', <button key="b" aria-label="target" type="button" />],
        ['a plain div', <div key="d" aria-label="target" tabIndex={0} />],
        // `contenteditable="false"` is an explicit opt-OUT and must not match,
        // even though the attribute is present.
        ['contenteditable="false"', <div key="cf" aria-label="target" contentEditable={false} tabIndex={0} />],
        ['role=button', <div key="rb" aria-label="target" role="button" tabIndex={0} />],
    ])('stays idle for %s', (_label, node) => {
        mount(node);

        focus(screen.getByLabelText('target'));

        expect(state()).toBe('idle');
    });

    it('detects a host-reported isContentEditable element', () => {
        // Lexical / Tiptap surfaces report editability through the DOM
        // property rather than the attribute; jsdom does not implement it,
        // so it is set explicitly here to reach that branch.
        mount(<div aria-label="target" tabIndex={0} />);
        const el = screen.getByLabelText('target');
        Object.defineProperty(el, 'isContentEditable', { configurable: true, value: true });

        focus(el);

        expect(state()).toBe('typing');
    });

    it('is idle when there is no activeElement at all', () => {
        // Defensive: a detached / transitioning document can report null.
        const proto = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
        Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null });
        try {
            mount(<input aria-label="target" />);
            expect(state()).toBe('idle');
        } finally {
            delete (document as unknown as Record<string, unknown>).activeElement;
            if (proto) Object.defineProperty(Document.prototype, 'activeElement', proto);
        }
    });

    it('flips back to idle on blur', () => {
        mount(<input aria-label="target" />);
        const input = screen.getByLabelText('target');

        focus(input);
        expect(state()).toBe('typing');

        blur(input);
        expect(state()).toBe('idle');
    });

    it('initialises from the already-focused element on mount', () => {
        // A returning user tab-focuses a field before our effect runs; the
        // hook must not claim "idle" until the next focusin.
        const preexisting = document.createElement('input');
        document.body.appendChild(preexisting);
        preexisting.focus();

        try {
            render(<Probe />);
            expect(state()).toBe('typing');
        } finally {
            preexisting.remove();
        }
    });

    it('removes both window listeners on unmount', () => {
        const remove = jest.spyOn(window, 'removeEventListener');
        const { unmount } = render(<Probe />);

        unmount();

        const removed = remove.mock.calls.map(([type]) => type);
        expect(removed).toEqual(expect.arrayContaining(['focusin', 'focusout']));
        remove.mockRestore();
    });
});
