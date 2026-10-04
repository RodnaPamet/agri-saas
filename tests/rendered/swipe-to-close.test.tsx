/**
 * @jest-environment jsdom
 *
 * Drag-to-dismiss for the nav drawer (P2.5).
 *
 * Gesture code is where "it works" and "it feels right" come apart, and the
 * difference is entirely in the cases that must NOT fire: a vertical scroll
 * that happens to wander sideways, a pull against the hinge, a touch on a sheet
 * that is already closed. Those are the ones here.
 *
 * jsdom reports `offsetWidth` as 0 for everything, and the hook turns the width
 * into the dismissal threshold — so a harness that did not stub it would give
 * every gesture a sub-pixel threshold and "pass" every distance case for the
 * wrong reason. The width is stubbed to 256 (`w-64`, the real drawer).
 */
import { render, fireEvent, act } from '@testing-library/react';
import { useSwipeToClose } from '@/components/layout/use-swipe-to-close';

const WIDTH = 256;

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
    const swipe = useSwipeToClose({ enabled: open, onClose, direction: 'left' });
    return (
        <div
            data-testid="panel"
            data-dragging={swipe.dragging ? 'true' : undefined}
            data-dragx={String(swipe.dragX)}
            {...swipe.handlers}
        />
    );
}

function setup(open = true) {
    const onClose = jest.fn();
    const { getByTestId, unmount } = render(<Harness open={open} onClose={onClose} />);
    const panel = getByTestId('panel');
    Object.defineProperty(panel, 'offsetWidth', { configurable: true, value: WIDTH });
    return { panel, onClose, unmount };
}

/** A touch list jsdom accepts. */
const at = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

describe('useSwipeToClose — what dismisses', () => {
    it('a deliberate drag most of the way across closes the sheet', () => {
        const { panel, onClose } = setup();
        fireEvent.touchStart(panel, at(200, 100));
        fireEvent.touchMove(panel, at(60, 104)); // -140px, past 40% of 256
        fireEvent.touchEnd(panel);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a short flick closes even though it travelled almost nowhere', () => {
        // Distance alone would reject this, and it would feel broken: the
        // gesture was decisive, it just did not go far.
        const { panel, onClose } = setup();
        fireEvent.touchStart(panel, at(200, 100));
        fireEvent.touchMove(panel, at(160, 100)); // only -40px of 256
        fireEvent.touchEnd(panel);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('useSwipeToClose — what must NOT dismiss', () => {
    it('a slow, short drag snaps back instead of closing', async () => {
        const { panel, onClose } = setup();
        fireEvent.touchStart(panel, at(200, 100));
        fireEvent.touchMove(panel, at(180, 100)); // -20px, under 40% of 256
        // Let real time pass so this is slow rather than a flick. The hook
        // measures with performance.now() at both ends, so this is the one
        // honest way to make the velocity term fail.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 120));
        });
        fireEvent.touchEnd(panel);
        expect(onClose).not.toHaveBeenCalled();
        expect(panel.getAttribute('data-dragx')).toBe('0'); // snapped back
    });

    it('a vertical scroll never drags the panel, however far it wanders sideways', () => {
        // The drawer's nav list scrolls. Without an axis commitment, flicking
        // down it would drag the whole sheet.
        const { panel, onClose } = setup();
        fireEvent.touchStart(panel, at(200, 300));
        fireEvent.touchMove(panel, at(196, 240)); // mostly vertical -> commits
        fireEvent.touchMove(panel, at(120, 180)); // now very horizontal
        expect(panel.getAttribute('data-dragging')).toBeNull();
        expect(panel.getAttribute('data-dragx')).toBe('0');
        fireEvent.touchEnd(panel);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('pulling AGAINST the hinge does not move the sheet', () => {
        // A left-entering sheet dismisses leftward. Rightward must clamp at 0,
        // not drag the panel off its own edge.
        const { panel, onClose } = setup();
        fireEvent.touchStart(panel, at(100, 100));
        fireEvent.touchMove(panel, at(240, 102));
        expect(panel.getAttribute('data-dragx')).toBe('0');
        fireEvent.touchEnd(panel);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('ignores touches entirely while the sheet is closed', () => {
        const { panel, onClose } = setup(false);
        fireEvent.touchStart(panel, at(200, 100));
        fireEvent.touchMove(panel, at(20, 100));
        fireEvent.touchEnd(panel);
        expect(onClose).not.toHaveBeenCalled();
        expect(panel.getAttribute('data-dragx')).toBe('0');
    });

    it('a cancelled touch snaps back and closes nothing', () => {
        // iOS cancels a touch when a system gesture takes over. Treating that
        // as a release would dismiss the sheet behind the user's back.
        const { panel, onClose } = setup();
        fireEvent.touchStart(panel, at(200, 100));
        fireEvent.touchMove(panel, at(40, 100));
        expect(panel.getAttribute('data-dragging')).toBe('true');
        fireEvent.touchCancel(panel);
        expect(onClose).not.toHaveBeenCalled();
        expect(panel.getAttribute('data-dragx')).toBe('0');
    });
});

describe('useSwipeToClose — the drag itself', () => {
    it('tracks the finger and reports it is dragging, so the caller can drop the transition', () => {
        // A 300ms transition left on during a drag lags the finger by exactly
        // that and reads as jank, which is why `dragging` is exposed at all.
        const { panel } = setup();
        fireEvent.touchStart(panel, at(200, 100));
        fireEvent.touchMove(panel, at(150, 103));
        expect(panel.getAttribute('data-dragging')).toBe('true');
        expect(panel.getAttribute('data-dragx')).toBe('-50');
    });

    it('a touch inside the slop radius moves nothing', () => {
        // Otherwise a tap with a 2px tremor would visibly shift the sheet.
        const { panel } = setup();
        fireEvent.touchStart(panel, at(200, 100));
        fireEvent.touchMove(panel, at(196, 101));
        expect(panel.getAttribute('data-dragging')).toBeNull();
        expect(panel.getAttribute('data-dragx')).toBe('0');
    });
});
