/**
 * Epic 62 — `useCelebration` hook.
 *
 * The real `canvas-confetti` mounts a `<canvas>` and uses
 * `requestAnimationFrame`; under jsdom we don't actually want pixels
 * — we want to assert that the hook resolves the right preset
 * choreography and respects sessionStorage dedupe.
 *
 * The test injects a stub via `__setConfettiForTest` so each preset's
 * call signature can be inspected without running the real library
 * loader. Sonner's `toast.success` is mocked at module level so
 * message assertions stay decoupled from the global Toaster mount.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { act, render } from '@testing-library/react';

const toastSuccessMock = jest.fn();
jest.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccessMock(...args),
    },
}));

import {
    useCelebration,
    __setConfettiForTest,
} from '@/components/ui/hooks/use-celebration';
import {
    celebrationDedupeKey,
    clearCelebrated,
} from '@/lib/celebrations';

// ─── Test harness ───────────────────────────────────────────────────

interface HarnessProps {
    onReady: (api: ReturnType<typeof useCelebration>) => void;
}

function Harness({ onReady }: HarnessProps) {
    const api = useCelebration();
    React.useEffect(() => {
        onReady(api);
    }, [api, onReady]);
    return null;
}

interface ConfettiCall {
    options: import('canvas-confetti').Options | undefined;
}

function makeConfettiStub() {
    const calls: ConfettiCall[] = [];
    const stub: (opts?: import('canvas-confetti').Options) => Promise<null> = (
        opts,
    ) => {
        calls.push({ options: opts });
        return Promise.resolve(null);
    };
    return { stub, calls };
}

async function flush(ms = 0) {
    // The hook fires confetti after `loadConfetti()` resolves and
    // setTimeout-staggered presets need timers to advance. Use real
    // timers + microtask flushes — fake timers + dynamic-import
    // promise chains are awkward to coordinate.
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

describe('useCelebration — milestone-key path', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        toastSuccessMock.mockClear();
    });

    it('fires the preset registered for the milestone (fireworks → 3 bursts)', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);

        let api!: ReturnType<typeof useCelebration>;
        render(<Harness onReady={(a) => (api = a)} />);
        await act(async () => {
            api.celebrate('framework-100');
        });
        // Fireworks runs three setTimeout-staggered bursts at 0/250/500ms.
        await flush(700);
        expect(calls.length).toBe(3);
        expect(calls.every((c) => c.options?.disableForReducedMotion)).toBe(
            true,
        );
    });

    it('writes the milestone toast title + description to sonner', async () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);

        let api!: ReturnType<typeof useCelebration>;
        render(<Harness onReady={(a) => (api = a)} />);
        await act(async () => {
            api.celebrate('framework-100');
        });
        await flush(0);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        const [title, opts] = toastSuccessMock.mock.calls[0] as [
            string,
            { description?: string },
        ];
        expect(title).toContain('100% framework coverage');
        expect(opts?.description).toContain('Every applicable practice');
    });

    it('dedupe — second call within the same session is a no-op', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);

        let api!: ReturnType<typeof useCelebration>;
        render(<Harness onReady={(a) => (api = a)} />);
        await act(async () => {
            api.celebrate('first-practice-mapped');
        });
        await flush(0);
        const firstCount = calls.length;
        const firstToast = toastSuccessMock.mock.calls.length;

        // Second invocation — dedupe must short-circuit BOTH the
        // toast AND the confetti.
        await act(async () => {
            api.celebrate('first-practice-mapped');
        });
        await flush(0);
        expect(calls.length).toBe(firstCount);
        expect(toastSuccessMock.mock.calls.length).toBe(firstToast);

        // Sanity: the dedupe entry exists in sessionStorage.
        expect(
            window.sessionStorage.getItem(
                celebrationDedupeKey('first-practice-mapped'),
            ),
        ).not.toBeNull();
    });

    it('clearing the dedupe entry lets the milestone fire again', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);

        let api!: ReturnType<typeof useCelebration>;
        render(<Harness onReady={(a) => (api = a)} />);
        await act(async () => {
            api.celebrate('first-practice-mapped');
        });
        await flush(0);
        const firstCount = calls.length;

        clearCelebrated('first-practice-mapped');

        await act(async () => {
            api.celebrate('first-practice-mapped');
        });
        await flush(0);
        expect(calls.length).toBeGreaterThan(firstCount);
    });

    it('hasCelebrated is exposed and reflects sessionStorage', async () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);

        let api!: ReturnType<typeof useCelebration>;
        render(<Harness onReady={(a) => (api = a)} />);
        expect(api.hasCelebrated('framework-100')).toBe(false);
        await act(async () => {
            api.celebrate('framework-100');
        });
        await flush(0);
        expect(api.hasCelebrated('framework-100')).toBe(true);
    });
});

describe('useCelebration — ad-hoc path', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        toastSuccessMock.mockClear();
    });

    it('burst preset emits a single confetti call', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);

        let api!: ReturnType<typeof useCelebration>;
        render(<Harness onReady={(a) => (api = a)} />);
        await act(async () => {
            api.celebrate({ preset: 'burst' });
        });
        await flush(0);
        expect(calls.length).toBe(1);
        expect(calls[0].options?.particleCount).toBeGreaterThan(0);
    });

    it('rain preset emits three staggered bursts across the top edge', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);

        let api!: ReturnType<typeof useCelebration>;
        render(<Harness onReady={(a) => (api = a)} />);
        await act(async () => {
            api.celebrate({ preset: 'rain' });
        });
        await flush(1100);
        expect(calls.length).toBe(3);
        // All three originate from y=0 (top edge).
        for (const c of calls) {
            expect(c.options?.origin?.y).toBe(0);
        }
    });

    it('omitting message skips the toast entirely', async () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);

        let api!: ReturnType<typeof useCelebration>;
        render(<Harness onReady={(a) => (api = a)} />);
        await act(async () => {
            api.celebrate({ preset: 'burst' });
        });
        await flush(0);
        expect(toastSuccessMock).not.toHaveBeenCalled();
    });

    it('without a key, the same ad-hoc trigger fires twice', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);

        let api!: ReturnType<typeof useCelebration>;
        render(<Harness onReady={(a) => (api = a)} />);
        await act(async () => {
            api.celebrate({ preset: 'burst' });
        });
        await flush(0);
        const first = calls.length;
        await act(async () => {
            api.celebrate({ preset: 'burst' });
        });
        await flush(0);
        expect(calls.length).toBeGreaterThan(first);
    });

    it('with a custom key, dedupe applies just like a milestone key', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);

        let api!: ReturnType<typeof useCelebration>;
        render(<Harness onReady={(a) => (api = a)} />);
        await act(async () => {
            api.celebrate({ preset: 'burst', key: 'demo-key' });
        });
        await flush(0);
        const first = calls.length;
        await act(async () => {
            api.celebrate({ preset: 'burst', key: 'demo-key' });
        });
        await flush(0);
        expect(calls.length).toBe(first);
    });
});

describe('useCelebration — barrel export', () => {
    it('is exported from @/components/ui/hooks', () => {
        const barrel = jest.requireActual('@/components/ui/hooks');
        expect(typeof barrel.useCelebration).toBe('function');
    });
});
