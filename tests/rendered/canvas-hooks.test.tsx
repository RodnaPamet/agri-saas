/* eslint-disable @typescript-eslint/no-explicit-any -- xyflow Node/Edge fixtures are
 * structurally typed; full generic construction per fixture has poor cost/benefit. */

/**
 * Zero-coverage canvas hooks, wave 9: the stateful half of `src/lib/processes`.
 *
 *   use-canvas-history · use-canvas-autosave
 *   use-canvas-drill-stack · use-canvas-presence
 *
 * Two of these hold invariants that lose user work when they regress, and
 * neither had a test.
 *
 * `use-canvas-history` is undo/redo. The pair `push` / `pushRedo` looks
 * redundant and is not: `push` records a forward edit and CLEARS the redo
 * stack (branching semantics — you cannot redo into a future you just
 * overwrote), while `pushRedo` records the reverse path and must clear
 * nothing. Collapsing them into one function is the obvious-looking
 * simplification and it silently destroys redo.
 *
 * `use-canvas-autosave` carries the subtler one. When an edit arrives WHILE
 * a save is in flight, the hook compares `dirtySince` against the save's
 * own `startedAt` and, if the edit is newer, schedules another cycle. Drop
 * that comparison and the edits a user made during the save are marked
 * clean and never persisted — silent data loss with no error anywhere.
 */
import { renderHook, act } from '@testing-library/react';

const mockUseKeyboardShortcut = jest.fn();
jest.mock('@/lib/hooks/use-keyboard-shortcut', () => ({
    useKeyboardShortcut: (...a: unknown[]) => mockUseKeyboardShortcut(...a),
}));

import { useCanvasHistory } from '@/lib/processes/use-canvas-history';
import { useCanvasAutosave } from '@/lib/processes/use-canvas-autosave';
import { useCanvasDrillStack } from '@/lib/processes/use-canvas-drill-stack';
import { useCanvasPresence, __INTERNAL_PRESENCE } from '@/lib/processes/use-canvas-presence';

const node = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, position: { x: 1, y: 2 }, data: { label: id }, ...over }) as any;
const snap = (ids: string[]) => ({ nodes: ids.map((i) => node(i)), edges: [] as any[] });

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── use-canvas-history ──────────────────────────────────────────────

describe('useCanvasHistory', () => {
    it('starts empty with nothing to undo or redo', () => {
        const { result } = renderHook(() => useCanvasHistory());

        expect(result.current.canUndo).toBe(false);
        expect(result.current.canRedo).toBe(false);
        expect(result.current.depth).toBe(0);
        expect(result.current.undo()).toBeNull();
        expect(result.current.redo()).toBeNull();
    });

    it('pushes and undoes LIFO', () => {
        const { result } = renderHook(() => useCanvasHistory());

        act(() => result.current.push(snap(['a'])));
        act(() => result.current.push(snap(['a', 'b'])));
        expect(result.current.depth).toBe(2);
        expect(result.current.canUndo).toBe(true);

        let popped: any;
        act(() => {
            popped = result.current.undo();
        });
        expect(popped.nodes.map((n: any) => n.id)).toEqual(['a', 'b']);
        expect(result.current.depth).toBe(1);
    });

    it('snapshots on push, so later mutations cannot corrupt history', () => {
        // structuredClone is deliberately avoided (xyflow attaches
        // non-cloneable metadata), so the two-level copy is doing this work
        // and is worth pinning directly.
        const { result } = renderHook(() => useCanvasHistory());
        const live = snap(['a']);

        act(() => result.current.push(live));
        live.nodes[0].position.x = 999;
        live.nodes[0].data.label = 'mutated';

        let popped: any;
        act(() => {
            popped = result.current.undo();
        });
        expect(popped.nodes[0].position.x).toBe(1);
        expect(popped.nodes[0].data.label).toBe('a');
    });

    it('clones edge data too, not just node data', () => {
        const { result } = renderHook(() => useCanvasHistory());
        const live = {
            nodes: [node('a')],
            edges: [{ id: 'e1', source: 'a', target: 'b', data: { controls: ['C-1'] } }] as any,
        };

        act(() => result.current.push(live));
        live.edges[0].data.controls.push('C-2-added-after-copy');

        let popped: any;
        act(() => {
            popped = result.current.undo();
        });
        // The copy is two-level: the `data` object is fresh, so replacing a
        // key cannot bleed in. (A nested ARRAY is still shared — the clone is
        // deliberately shallow past `data`, which is why the pushed value
        // here reflects the mutation. Pinning the real depth, not an
        // aspirational one.)
        expect(popped.edges[0].data).not.toBe(live.edges[0].data);
    });

    it('tolerates a node or edge with no data', () => {
        const { result } = renderHook(() => useCanvasHistory());

        act(() =>
            result.current.push({
                nodes: [node('a', { data: undefined })],
                edges: [{ id: 'e', source: 'a', target: 'b', data: null }] as any,
            }),
        );

        let popped: any;
        act(() => {
            popped = result.current.undo();
        });
        expect(popped.nodes[0].data).toBeUndefined();
        expect(popped.edges[0].data).toBeNull();
    });

    describe('push vs pushRedo — the distinction that makes redo work', () => {
        it('a forward push CLEARS the redo stack', () => {
            // Branching semantics: you cannot redo into a future you just
            // overwrote with a new edit.
            const { result } = renderHook(() => useCanvasHistory());

            act(() => result.current.pushRedo(snap(['future'])));
            expect(result.current.canRedo).toBe(true);

            act(() => result.current.push(snap(['new edit'])));

            expect(result.current.canRedo).toBe(false);
            expect(result.current.redo()).toBeNull();
        });

        it('pushRedo clears nothing — it records the reverse path', () => {
            const { result } = renderHook(() => useCanvasHistory());

            act(() => result.current.push(snap(['a'])));
            act(() => result.current.pushRedo(snap(['pre-undo'])));

            expect(result.current.canUndo).toBe(true); // past survived
            expect(result.current.canRedo).toBe(true);
        });

        it('round-trips undo → redo through the consumer’s stash', () => {
            // The documented contract: the hook does not know the live
            // graph, so the CONSUMER pushes the pre-undo state to pushRedo.
            const { result } = renderHook(() => useCanvasHistory());

            act(() => result.current.push(snap(['v1'])));
            act(() => result.current.pushRedo(snap(['v2-live'])));

            let undone: any;
            act(() => {
                undone = result.current.undo();
            });
            expect(undone.nodes[0].id).toBe('v1');

            let redone: any;
            act(() => {
                redone = result.current.redo();
            });
            expect(redone.nodes[0].id).toBe('v2-live');
            expect(result.current.canRedo).toBe(false);
        });
    });

    describe('bounded depth', () => {
        it('caps the past at 50 and drops the OLDEST', () => {
            // shift(), not pop() — the recent history is what a user
            // actually reaches for.
            const { result } = renderHook(() => useCanvasHistory());

            act(() => {
                for (let i = 0; i < 55; i++) result.current.push(snap([`s${i}`]));
            });

            expect(result.current.depth).toBe(50);
            let popped: any;
            act(() => {
                popped = result.current.undo();
            });
            expect(popped.nodes[0].id).toBe('s54'); // newest retained
        });

        it('caps the redo stack at 50 too', () => {
            const { result } = renderHook(() => useCanvasHistory());

            act(() => {
                for (let i = 0; i < 55; i++) result.current.pushRedo(snap([`r${i}`]));
            });

            let popped: any;
            act(() => {
                popped = result.current.redo();
            });
            expect(popped.nodes[0].id).toBe('r54');
        });
    });

    describe('reset', () => {
        it('clears both stacks', () => {
            const { result } = renderHook(() => useCanvasHistory());
            act(() => result.current.push(snap(['a'])));
            act(() => result.current.pushRedo(snap(['b'])));

            act(() => result.current.reset());

            expect(result.current.canUndo).toBe(false);
            expect(result.current.canRedo).toBe(false);
            expect(result.current.depth).toBe(0);
        });

        it('seeds the past when given an initial snapshot', () => {
            // So the very next edit has somewhere to undo back to — without
            // this, the first edit after a load is unundoable.
            const { result } = renderHook(() => useCanvasHistory());

            act(() => result.current.reset(snap(['loaded'])));

            expect(result.current.depth).toBe(1);
            expect(result.current.canUndo).toBe(true);
            let popped: any;
            act(() => {
                popped = result.current.undo();
            });
            expect(popped.nodes[0].id).toBe('loaded');
        });
    });
});

// ─── use-canvas-autosave ─────────────────────────────────────────────

describe('useCanvasAutosave', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    const setup = (over: Partial<Parameters<typeof useCanvasAutosave>[0]> = {}) => {
        const save = (over.save ?? jest.fn().mockResolvedValue(undefined)) as jest.Mock;
        const view = renderHook((props: any) => useCanvasAutosave(props), {
            initialProps: { save, enabled: true, ...over },
        });
        return { ...view, save };
    };

    it('does nothing until an edit is flagged — no autosave on mount', () => {
        // The rehydration sequence must not trigger a save.
        const { result, save } = setup();

        expect(result.current.status).toBe('idle');
        act(() => {
            jest.advanceTimersByTime(10_000);
        });
        expect(save).not.toHaveBeenCalled();
    });

    it('goes pending then saves after the debounce window', async () => {
        const { result, save } = setup();

        act(() => result.current.markDirty());
        expect(result.current.status).toBe('pending');
        expect(save).not.toHaveBeenCalled();

        await act(async () => {
            jest.advanceTimersByTime(3000);
        });

        expect(save).toHaveBeenCalledTimes(1);
        expect(result.current.status).toBe('saved');
        expect(result.current.lastSavedAt).toEqual(expect.any(Number));
    });

    it('restarts the debounce on each edit — a typing burst saves once', async () => {
        const { result, save } = setup();

        act(() => result.current.markDirty());
        act(() => {
            jest.advanceTimersByTime(2000);
        });
        act(() => result.current.markDirty());
        act(() => {
            jest.advanceTimersByTime(2000);
        });
        expect(save).not.toHaveBeenCalled(); // never went 3s idle

        await act(async () => {
            jest.advanceTimersByTime(1000);
        });
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('honours a custom delay', async () => {
        const { result, save } = setup({ delayMs: 500 });

        act(() => result.current.markDirty());
        await act(async () => {
            jest.advanceTimersByTime(500);
        });

        expect(save).toHaveBeenCalledTimes(1);
    });

    it('is inert while disabled', async () => {
        const { result, save } = setup({ enabled: false });

        act(() => result.current.markDirty());
        expect(result.current.status).toBe('idle');

        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });
        expect(save).not.toHaveBeenCalled();
    });

    it('PRESERVES edits made during an in-flight save', async () => {
        // The invariant worth the whole file. Without the
        // `dirtySince > startedAt` re-check, edits made while the save was
        // in flight get marked clean and are never persisted — silent data
        // loss with no error surfaced anywhere.
        let release!: () => void;
        const save = jest.fn(
            () =>
                new Promise<void>((res) => {
                    release = res;
                }),
        );
        const { result } = setup({ save });

        act(() => result.current.markDirty());
        act(() => {
            jest.advanceTimersByTime(3000);
        });
        expect(save).toHaveBeenCalledTimes(1);
        expect(result.current.status).toBe('saving');

        // An edit lands mid-save, strictly after the save started.
        act(() => {
            jest.advanceTimersByTime(100);
        });
        act(() => result.current.markDirty());

        await act(async () => {
            release();
        });

        // Not "saved" — the hook knows it is still dirty and re-arms.
        expect(result.current.status).toBe('pending');

        await act(async () => {
            jest.advanceTimersByTime(3000);
        });
        expect(save).toHaveBeenCalledTimes(2);
    });

    it('settles to saved when nothing changed during the save', async () => {
        let release!: () => void;
        const save = jest.fn(() => new Promise<void>((res) => (release = res)));
        const { result } = setup({ save });

        act(() => result.current.markDirty());
        act(() => {
            jest.advanceTimersByTime(3000);
        });
        await act(async () => {
            release();
        });

        expect(result.current.status).toBe('saved');
        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });
        expect(save).toHaveBeenCalledTimes(1); // no spurious second cycle
    });

    it('never runs two saves concurrently', async () => {
        let release!: () => void;
        const save = jest.fn(() => new Promise<void>((res) => (release = res)));
        const { result } = setup({ save });

        act(() => result.current.markDirty());
        act(() => {
            jest.advanceTimersByTime(3000);
        });
        // A second timer firing mid-flight must be swallowed by the
        // in-flight guard, not stack a parallel PUT on the same map.
        act(() => result.current.markDirty());
        act(() => {
            jest.advanceTimersByTime(3000);
        });

        expect(save).toHaveBeenCalledTimes(1);
        await act(async () => {
            release();
        });
    });

    describe('failure', () => {
        it('surfaces the error message and stops retrying', async () => {
            // Manual retry required — an autosave loop hammering a failing
            // endpoint every 3s is worse than a visible error.
            const save = jest.fn().mockRejectedValue(new Error('409 version conflict'));
            const { result } = setup({ save });

            act(() => result.current.markDirty());
            await act(async () => {
                jest.advanceTimersByTime(3000);
            });

            expect(result.current.status).toBe('error');
            expect(result.current.error).toBe('409 version conflict');

            await act(async () => {
                jest.advanceTimersByTime(30_000);
            });
            expect(save).toHaveBeenCalledTimes(1);
        });

        it('falls back to a generic message for a non-Error rejection', async () => {
            const { result } = setup({ save: jest.fn().mockRejectedValue('boom') });

            act(() => result.current.markDirty());
            await act(async () => {
                jest.advanceTimersByTime(3000);
            });

            expect(result.current.error).toBe('Autosave failed');
        });

        it('clears the error when a later save succeeds', async () => {
            const save = jest
                .fn()
                .mockRejectedValueOnce(new Error('transient'))
                .mockResolvedValueOnce(undefined);
            const { result } = setup({ save });

            act(() => result.current.markDirty());
            await act(async () => {
                jest.advanceTimersByTime(3000);
            });
            expect(result.current.status).toBe('error');

            act(() => result.current.markDirty());
            await act(async () => {
                jest.advanceTimersByTime(3000);
            });
            expect(result.current.status).toBe('saved');
            expect(result.current.error).toBeNull();
        });
    });

    it('markClean cancels a pending save without persisting', async () => {
        const { result, save } = setup();

        act(() => result.current.markDirty());
        act(() => result.current.markClean());

        expect(result.current.status).toBe('idle');
        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });
        expect(save).not.toHaveBeenCalled();
    });

    it('markClean clears a previous error', async () => {
        const { result } = setup({ save: jest.fn().mockRejectedValue(new Error('x')) });
        act(() => result.current.markDirty());
        await act(async () => {
            jest.advanceTimersByTime(3000);
        });

        act(() => result.current.markClean());

        expect(result.current.error).toBeNull();
        expect(result.current.status).toBe('idle');
    });

    it('still fires a save if `enabled` flips false mid-debounce (documented)', async () => {
        // Documenting real behaviour, not asserting the ideal. runSave has its
        // own `if (!enabled) return` guard, but it is unreachable through the
        // public API: markDirty refuses to schedule while disabled, and the
        // timer it DID schedule closes over the runSave built when enabled
        // was true. So disabling mid-debounce does not cancel the save.
        //
        // In practice the canvas unmounts (covered below) or calls markClean,
        // both of which do cancel. Worth knowing before someone relies on
        // `enabled: false` alone as a kill switch.
        const save = jest.fn().mockResolvedValue(undefined);
        const { result, rerender } = renderHook((props: any) => useCanvasAutosave(props), {
            initialProps: { save, enabled: true },
        });

        act(() => result.current.markDirty());
        rerender({ save, enabled: false });

        await act(async () => {
            jest.advanceTimersByTime(3000);
        });

        expect(save).toHaveBeenCalledTimes(1);
    });

    it('cancels the pending timer on unmount', async () => {
        // Never fire a save against a canvas that is gone.
        const { result, unmount, save } = setup();

        act(() => result.current.markDirty());
        unmount();

        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });
        expect(save).not.toHaveBeenCalled();
    });

    it('uses the LATEST save callback, not the one bound when the timer started', async () => {
        // The ref-as-mailbox in the hook. A re-rendered consumer passes a
        // fresh closure (new graph state); firing the stale one would
        // persist an outdated snapshot.
        const stale = jest.fn().mockResolvedValue(undefined);
        const fresh = jest.fn().mockResolvedValue(undefined);
        const { result, rerender } = renderHook((props: any) => useCanvasAutosave(props), {
            initialProps: { save: stale, enabled: true },
        });

        act(() => result.current.markDirty());
        rerender({ save: fresh, enabled: true });

        await act(async () => {
            jest.advanceTimersByTime(3000);
        });

        expect(fresh).toHaveBeenCalledTimes(1);
        expect(stale).not.toHaveBeenCalled();
    });
});

// ─── use-canvas-drill-stack ──────────────────────────────────────────

describe('useCanvasDrillStack', () => {
    it('starts at root', () => {
        const { result } = renderHook(() => useCanvasDrillStack());

        expect(result.current.stack).toEqual([]);
        expect(result.current.currentGroupId).toBeNull();
    });

    it('enters and exits one level at a time', () => {
        const { result } = renderHook(() => useCanvasDrillStack());

        act(() => result.current.enter('g1'));
        expect(result.current.currentGroupId).toBe('g1');

        act(() => result.current.enter('g2'));
        expect(result.current.stack).toEqual(['g1', 'g2']);
        expect(result.current.currentGroupId).toBe('g2');

        act(() => result.current.exit());
        expect(result.current.currentGroupId).toBe('g1');
    });

    it('exiting at root is a no-op that keeps the same array identity', () => {
        // `s.length === 0 ? s : s.slice(0, -1)` — returning the same
        // reference avoids a pointless re-render at the root level.
        const { result } = renderHook(() => useCanvasDrillStack());
        const before = result.current.stack;

        act(() => result.current.exit());

        expect(result.current.stack).toBe(before);
        expect(result.current.currentGroupId).toBeNull();
    });

    it('reset returns to root from any depth in one step', () => {
        const { result } = renderHook(() => useCanvasDrillStack());
        act(() => result.current.enter('g1'));
        act(() => result.current.enter('g2'));
        act(() => result.current.enter('g3'));

        act(() => result.current.reset());

        expect(result.current.stack).toEqual([]);
        expect(result.current.currentGroupId).toBeNull();
    });

    describe('Escape binding', () => {
        const lastCall = () =>
            mockUseKeyboardShortcut.mock.calls[mockUseKeyboardShortcut.mock.calls.length - 1];

        it('registers escape through the shared registry, not a raw listener', () => {
            // The keyboard-shortcut-conventions guardrail bans raw keydown
            // listeners; this asserts the hook honours that at runtime too.
            renderHook(() => useCanvasDrillStack());

            const [key, handler, opts] = lastCall();
            expect(key).toBe('escape');
            expect(typeof handler).toBe('function');
            expect(opts.description).toBeTruthy();
        });

        it('is DISABLED at root so it does not fight modal / popover dismiss', () => {
            const { result } = renderHook(() => useCanvasDrillStack());
            expect(lastCall()[2].enabled).toBe(false);

            act(() => result.current.enter('g1'));
            expect(lastCall()[2].enabled).toBe(true);

            act(() => result.current.exit());
            expect(lastCall()[2].enabled).toBe(false);
        });

        it('binds the handler to exit — Escape pops exactly one level', () => {
            const { result } = renderHook(() => useCanvasDrillStack());
            act(() => result.current.enter('g1'));
            act(() => result.current.enter('g2'));

            act(() => lastCall()[1]());

            expect(result.current.stack).toEqual(['g1']);
        });
    });
});

// ─── use-canvas-presence ─────────────────────────────────────────────

describe('useCanvasPresence (Stage-1 no-op seam)', () => {
    it('returns an empty roster and callable no-op publishers', () => {
        const { result } = renderHook(() => useCanvasPresence({ mapId: 'm1', userId: 'u1' }));

        expect(result.current.roster).toEqual([]);
        expect(() => result.current.publishCursor({ x: 1, y: 2 })).not.toThrow();
        expect(() => result.current.publishCursor(null)).not.toThrow();
        expect(() => result.current.publishSelection(['n1'])).not.toThrow();
    });

    it('keeps every returned value referentially stable across renders', () => {
        // The documented reason the callbacks are memoised: consumers put
        // them in dep arrays, so a new identity per render would re-trigger
        // the canvas's mousemove/selection effects on every render.
        const { result, rerender } = renderHook(() =>
            useCanvasPresence({ mapId: 'm1', userId: 'u1' }),
        );
        const first = result.current;

        rerender();

        expect(result.current.publishCursor).toBe(first.publishCursor);
        expect(result.current.publishSelection).toBe(first.publishSelection);
        expect(result.current.roster).toBe(first.roster);
    });

    it('works with no active map', () => {
        const { result } = renderHook(() => useCanvasPresence({ mapId: null, userId: 'u1' }));
        expect(result.current.roster).toEqual([]);
    });

    it('exposes the Stage-2 flag name for the rollout ratchet', () => {
        expect(__INTERNAL_PRESENCE.flagName).toBe('NEXT_PUBLIC_ENABLE_CANVAS_PRESENCE');
        expect(__INTERNAL_PRESENCE.defaultRoster).toEqual([]);
    });
});
