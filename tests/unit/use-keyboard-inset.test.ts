/**
 * @jest-environment jsdom
 *
 * useKeyboardInset — derives the soft-keyboard height from VisualViewport.
 */
import { renderHook, act } from '@testing-library/react';
import { useKeyboardInset } from '@/components/ui/hooks';

type VV = {
    height: number;
    offsetTop: number;
    addEventListener: jest.Mock;
    removeEventListener: jest.Mock;
    _fire: () => void;
};

function installVisualViewport(height: number, offsetTop = 0): VV {
    const listeners: Array<() => void> = [];
    const vv: VV = {
        height,
        offsetTop,
        addEventListener: jest.fn((_e: string, cb: () => void) => listeners.push(cb)),
        removeEventListener: jest.fn(),
        _fire: () => listeners.forEach((l) => l()),
    };
    Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: vv,
    });
    return vv;
}

describe('useKeyboardInset', () => {
    const originalInner = window.innerHeight;
    afterEach(() => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInner });
        // @ts-expect-error reset
        delete window.visualViewport;
    });

    it('reports zero inset when the visual viewport fills the layout viewport', () => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        installVisualViewport(800);
        const { result } = renderHook(() => useKeyboardInset());
        expect(result.current.inset).toBe(0);
        expect(result.current.height).toBe(800);
    });

    it('reports the keyboard height when the visual viewport shrinks', () => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        const vv = installVisualViewport(800);
        const { result } = renderHook(() => useKeyboardInset());

        // Keyboard opens → visible area shrinks to 460px (340px keyboard).
        act(() => {
            vv.height = 460;
            vv._fire();
        });
        expect(result.current.inset).toBe(340);
        expect(result.current.height).toBe(460);
    });

    // ── Focus-refined detection (the #890 fix) ──────────────────────────
    //
    // The bug: on iOS, when Safari scrolls the page to bring a focused input
    // above the keyboard, `visualViewport.offsetTop` grows and the measured
    // strip shrinks. Once it dipped under the 120px threshold the hook
    // reported inset 0 — abandoning the lift WHILE THE KEYBOARD WAS STILL
    // OPEN, so the sheet dropped back behind it.
    //
    // A pixel threshold cannot tell "small because there is no keyboard" from
    // "small because the viewport scrolled". Focus can: with an editable
    // element active a soft keyboard is up by the platform's contract.

    function focusEditable(): HTMLInputElement {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        return input;
    }

    it('keeps the lift when a focused input shrinks the measured strip below the threshold', () => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        const vv = installVisualViewport(800);
        const { result } = renderHook(() => useKeyboardInset());
        const input = focusEditable();
        act(() => {
            // A real keyboard (340px) with the viewport scrolled 260px to
            // reveal the input: 800 - 460 - 260 = 80, under the 120 threshold.
            vv.height = 460;
            vv.offsetTop = 260;
            vv._fire();
        });
        // The old implementation reported 0 here and dropped the sheet.
        expect(result.current.inset).toBe(80);
        input.remove();
    });

    it('...and the SAME geometry with nothing focused still reads as chrome', () => {
        // The discriminating control. Identical numbers, no focused input —
        // if this also reported 80 the assertion above would say nothing
        // about focus, only that 80 is returned.
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        const vv = installVisualViewport(800);
        const { result } = renderHook(() => useKeyboardInset());
        act(() => {
            vv.height = 460;
            vv.offsetTop = 260;
            vv._fire();
        });
        expect(result.current.inset).toBe(0);
    });

    it('a focused checkbox raises no keyboard, so it does not lower the bar', () => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        const vv = installVisualViewport(800);
        const { result } = renderHook(() => useKeyboardInset());
        const box = document.createElement('input');
        box.type = 'checkbox';
        document.body.appendChild(box);
        box.focus();
        act(() => {
            vv.height = 720; // 80px gap
            vv._fire();
        });
        expect(result.current.inset).toBe(0);
        box.remove();
    });

    it('ignores sub-threshold gaps (browser chrome, not a keyboard)', () => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        const vv = installVisualViewport(800);
        const { result } = renderHook(() => useKeyboardInset());
        act(() => {
            vv.height = 720; // 80px gap — below the 120px keyboard threshold
            vv._fire();
        });
        expect(result.current.inset).toBe(0);
    });
});
