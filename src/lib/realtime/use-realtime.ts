'use client';

/**
 * ONE `EventSource` per browser, shared by every consumer — P7.6 (#1995).
 *
 * ## Why a shared connection rather than one per surface
 *
 * The bell held its own `EventSource`. Live Борса adding a second would mean
 * two long-lived connections per TAB, against a cap of three streams per
 * person (P7.2) — so two tabs would exhaust somebody's budget and the third
 * would be refused. The cap is per person precisely because a person is what
 * costs the server, and that only works if a person's browser opens one
 * connection.
 *
 * So the connection is a module singleton with a reference count: the first
 * subscriber opens it, the last one closes it. Same shape as the server's
 * per-channel refcount in `notification-bus.ts`, and for the same reason — a
 * connection owned by a component is a connection that reopens on every
 * remount.
 *
 * ## Routing is by `kind`, which is why the frame carries one
 *
 * A shared connection carrying undifferentiated ids would make the bell
 * refetch notifications for a listing event and Борса refetch listings for a
 * notification: each surface doing twice the work and seeing half of it as
 * noise. `kind` is a FIELD rather than a named SSE `event:` line — see
 * `stream-frame.ts` for why, and note the consequence here: an unrecognised
 * kind is counted and ignored rather than silently undelivered.
 *
 * ## The connection state is a signal consumers need
 *
 * The bell throttles its poll from 60s to 5 minutes while the stream is
 * healthy, which is the only reason it still polls at all. That throttle was
 * dead code until #1983 because it read a health flag in the same tick that
 * constructed the `EventSource` — `onopen` cannot have fired yet. Here the
 * state is published to subscribers as it changes, so a consumer reacts to a
 * transition rather than sampling a value that cannot be true yet.
 *
 * ## Nothing is closed on error, deliberately
 *
 * `readyState` tells the two cases apart for free: CLOSED after a non-200
 * means the browser has given up permanently — which is what a 204 from a
 * disabled channel, an absent session lineage or a stream cap produces — and
 * CONNECTING means it is retrying a real blip. Closing by hand would throw
 * away the automatic reconnect that is most of the reason this is SSE.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { StreamEventKind, StreamFrame } from './stream-frame';

/** Where the shared connection points. */
const STREAM_PATH = '/api/me/stream';

export type RealtimeState = 'idle' | 'open' | 'error';

type Listener = (frame: StreamFrame) => void;

interface Shared {
    source: EventSource;
    /** Listeners by kind. A kind with none is simply not routed. */
    byKind: Map<StreamEventKind, Set<Listener>>;
    /** Notified on every state transition. */
    stateListeners: Set<(s: RealtimeState) => void>;
    state: RealtimeState;
    /** Subscribers across every kind — the refcount. */
    refs: number;
}

let shared: Shared | null = null;

/** Frames whose `kind` no consumer understood. Exposed for tests and metrics. */
let unroutedFrames = 0;

function setState(s: Shared, next: RealtimeState): void {
    if (s.state === next) return;
    s.state = next;
    for (const l of s.stateListeners) l(next);
}

function open(): Shared {
    if (shared) return shared;

    // `typeof` rather than a feature flag: SSR and jsdom both lack
    // `EventSource`, and the server decides whether the channel is live — the
    // client always ASKS (#1982). A build-time gate is what made this channel
    // unreachable rather than off.
    const source = new EventSource(STREAM_PATH, { withCredentials: true });
    const s: Shared = {
        source,
        byKind: new Map(),
        stateListeners: new Set(),
        state: 'idle',
        refs: 0,
    };

    source.onopen = () => setState(s, 'open');
    source.onerror = () => setState(s, 'error');
    source.onmessage = (ev: MessageEvent<string>) => {
        let frame: StreamFrame;
        try {
            frame = JSON.parse(ev.data) as StreamFrame;
        } catch {
            // A frame that is not JSON is not actionable, and throwing here
            // would take down the handler for every subsequent frame.
            unroutedFrames += 1;
            return;
        }
        const listeners = s.byKind.get(frame.kind);
        if (!listeners || listeners.size === 0) {
            // Counted rather than dropped in silence. A kind nobody consumes
            // is the expected state during a rollout — `listing` arrives
            // before anything subscribes to it — and an unrecognised kind is
            // the thing worth being able to see.
            unroutedFrames += 1;
            return;
        }
        for (const l of listeners) l(frame);
    };

    shared = s;
    return s;
}

function release(s: Shared): void {
    s.refs -= 1;
    if (s.refs > 0) return;
    // Last subscriber out closes the connection. Without this a page that
    // unmounts every consumer keeps a stream — and a stream slot — for as long
    // as the tab lives.
    s.source.close();
    if (shared === s) shared = null;
}

/**
 * Subscribe to one kind of event on the shared connection.
 *
 * Returns the connection state, which transitions `idle` → `open` on the
 * server's first byte and `idle`/`open` → `error` when the browser gives up or
 * retries. A consumer that only wants frames can ignore it.
 */
export function useRealtime(kind: StreamEventKind, onFrame: Listener): RealtimeState {
    const [state, setLocalState] = useState<RealtimeState>('idle');

    /**
     * The caller's callback, held in a ref so the subscription does not depend
     * on its identity.
     *
     * This is not a micro-optimisation, and the first version of this hook got
     * it wrong in a way a test caught. With `onFrame` in the effect's
     * dependency list, a consumer passing an inline closure re-runs the effect
     * on EVERY render — and the cleanup does not merely re-register, it calls
     * `release()`, which drops the refcount to zero and CLOSES the shared
     * connection. The next effect then opens a new one. So a component that
     * re-rendered on a keystroke would churn the stream, and each new
     * connection takes another of the person's three slots until the old ones
     * lapse.
     *
     * The ref keeps the registered listener stable while always calling the
     * latest callback, so neither a stale closure nor a reopened connection is
     * possible.
     */
    const latest = useRef(onFrame);
    latest.current = onFrame;

    const stable = useCallback<Listener>((frame) => latest.current(frame), []);

    useEffect(() => {
        if (typeof EventSource === 'undefined') return;

        const s = open();
        s.refs += 1;

        const listeners = s.byKind.get(kind) ?? new Set<Listener>();
        listeners.add(stable);
        s.byKind.set(kind, listeners);

        s.stateListeners.add(setLocalState);
        // Adopt the CURRENT state rather than waiting for the next transition:
        // a consumer mounting onto an already-open connection would otherwise
        // sit at `idle` for ever, which is the dead-branch shape #1983 fixed
        // in the bell.
        setLocalState(s.state);

        return () => {
            listeners.delete(stable);
            if (listeners.size === 0) s.byKind.delete(kind);
            s.stateListeners.delete(setLocalState);
            release(s);
        };
        // `kind` and the STABLE wrapper only. See the ref above for what
        // including the caller's own callback here cost.
    }, [kind, stable]);

    return state;
}

/** Test-only: how many frames no consumer routed. @internal */
export function _unroutedFrameCountForTesting(): number {
    return unroutedFrames;
}

/** Test-only: drop the shared connection and the counter. @internal */
export function _resetRealtimeForTesting(): void {
    if (shared) {
        try {
            shared.source.close();
        } catch {
            // Already closed — nothing to do.
        }
        shared = null;
    }
    unroutedFrames = 0;
}
