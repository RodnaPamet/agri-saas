/**
 * @jest-environment jsdom
 */
/**
 * The shared `EventSource` — P7.6 (#1995).
 *
 * The property that matters is the one the issue names: **one connection per
 * browser**. The bell held its own, and live Борса adding a second would mean
 * two per tab against a cap of three per person — so two tabs would exhaust
 * somebody's budget. Several cases below count constructions rather than
 * assert behaviour, because the count IS the requirement.
 *
 * jsdom has no `EventSource`, so one is installed here. That is a real
 * limitation and worth naming: what these cases exercise is the hook's
 * refcounting, routing and state publication, not a browser's reconnect
 * behaviour. The reconnect contract (a non-200 fails permanently, a dropped
 * socket retries) is spec-derived and belongs in an E2E spec — P7.9 (#1998).
 */
import { renderHook, act } from '@testing-library/react';

import {
    useRealtime,
    _resetRealtimeForTesting,
    _unroutedFrameCountForTesting,
} from '@/lib/realtime/use-realtime';
import type { StreamFrame } from '@/lib/realtime/stream-frame';

/** Every EventSource the hook constructed this test. */
let constructed: FakeEventSource[] = [];

class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: MessageEvent<string>) => void) | null = null;
    readyState = FakeEventSource.CONNECTING;
    closed = false;

    constructor(
        readonly url: string,
        readonly init?: { withCredentials?: boolean },
    ) {
        constructed.push(this);
    }

    close() {
        this.closed = true;
        this.readyState = FakeEventSource.CLOSED;
    }

    /** Drive a frame in, as the server would. */
    emit(frame: StreamFrame | string) {
        const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
        this.onmessage?.({ data } as MessageEvent<string>);
    }
}

beforeEach(() => {
    constructed = [];
    _resetRealtimeForTesting();
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
    _resetRealtimeForTesting();
    delete (globalThis as { EventSource?: unknown }).EventSource;
});

const notification = (id: string, tenantId = 't-1'): StreamFrame => ({
    kind: 'notification',
    id,
    tenantId,
});

describe('one connection per browser', () => {
    it('opens exactly one for several subscribers', () => {
        const bell = jest.fn();
        const borsa = jest.fn();

        renderHook(() => useRealtime('notification', bell));
        renderHook(() => useRealtime('listing', borsa));

        // The requirement, counted. Two connections here is what exhausts a
        // person's three-stream budget from two tabs.
        expect(constructed).toHaveLength(1);
        expect(constructed[0].url).toBe('/api/me/stream');
        expect(constructed[0].init?.withCredentials).toBe(true);
    });

    it('opens one even for two subscribers to the SAME kind', () => {
        renderHook(() => useRealtime('notification', jest.fn()));
        renderHook(() => useRealtime('notification', jest.fn()));

        expect(constructed).toHaveLength(1);
    });

    it('closes it when the LAST subscriber leaves, not the first', () => {
        const a = renderHook(() => useRealtime('notification', jest.fn()));
        const b = renderHook(() => useRealtime('listing', jest.fn()));

        a.unmount();
        expect(constructed[0].closed).toBe(false);

        b.unmount();
        expect(constructed[0].closed).toBe(true);
    });

    it('opens a FRESH one after the last subscriber left and a new one arrives', () => {
        // A page that unmounts everything and remounts must get a working
        // stream, not a closed one — which is what reusing the cached
        // reference would give it.
        const a = renderHook(() => useRealtime('notification', jest.fn()));
        a.unmount();

        renderHook(() => useRealtime('notification', jest.fn()));

        expect(constructed).toHaveLength(2);
        expect(constructed[1].closed).toBe(false);
    });
});

describe('routing by kind', () => {
    it('delivers a frame only to its own kind', () => {
        const bell = jest.fn();
        const borsa = jest.fn();
        renderHook(() => useRealtime('notification', bell));
        renderHook(() => useRealtime('listing', borsa));

        act(() => constructed[0].emit(notification('n-1')));

        expect(bell).toHaveBeenCalledWith(notification('n-1'));
        // The whole reason the frame carries a kind: without it the bell
        // refetches notifications for a listing event and Борса refetches
        // listings for a notification.
        expect(borsa).not.toHaveBeenCalled();
    });

    it('delivers to EVERY subscriber of a kind', () => {
        const one = jest.fn();
        const two = jest.fn();
        renderHook(() => useRealtime('notification', one));
        renderHook(() => useRealtime('notification', two));

        act(() => constructed[0].emit(notification('n-1')));

        expect(one).toHaveBeenCalledTimes(1);
        expect(two).toHaveBeenCalledTimes(1);
    });

    it('passes the tenantId through, so a consumer can filter', () => {
        const bell = jest.fn();
        renderHook(() => useRealtime('notification', bell));

        act(() => constructed[0].emit(notification('n-1', 't-9')));

        expect(bell.mock.calls[0][0]).toMatchObject({ tenantId: 't-9' });
    });

    it('counts a kind nobody consumes rather than dropping it silently', () => {
        // Expected during a rollout: `listing` frames arrive before anything
        // subscribes to them. An unrecognised kind is the case worth seeing,
        // and silence is what makes it invisible.
        renderHook(() => useRealtime('notification', jest.fn()));
        const before = _unroutedFrameCountForTesting();

        // The sentinel, not a listing id and a tenant id. That shape was a
        // frame the server cannot produce: every tick carries
        // `LISTING_TICK_ID` in BOTH fields because the tick is coalesced
        // across farms. A fixture modelling a per-listing frame is a fixture
        // a consumer can be written against and still be wrong on the wire —
        // which is exactly what happened to a reader of the old contract
        // docblock (#2168).
        act(() => constructed[0].emit({ kind: 'listing', id: 'listings', tenantId: 'listings' }));

        expect(_unroutedFrameCountForTesting()).toBe(before + 1);
    });

    it('survives a frame that is not JSON', () => {
        // A throw here would take down the handler for every SUBSEQUENT
        // frame, so one malformed line would silence the stream for the life
        // of the connection.
        const bell = jest.fn();
        renderHook(() => useRealtime('notification', bell));

        act(() => constructed[0].emit('not json at all'));
        act(() => constructed[0].emit(notification('n-1')));

        expect(bell).toHaveBeenCalledTimes(1);
        expect(bell).toHaveBeenCalledWith(notification('n-1'));
    });

    it('stops delivering to a subscriber that unmounted', () => {
        const gone = jest.fn();
        const stays = jest.fn();
        const a = renderHook(() => useRealtime('notification', gone));
        renderHook(() => useRealtime('notification', stays));

        a.unmount();
        act(() => constructed[0].emit(notification('n-1')));

        expect(gone).not.toHaveBeenCalled();
        expect(stays).toHaveBeenCalledTimes(1);
    });
});

describe('connection state', () => {
    it('starts idle and opens on the server’s first byte', () => {
        const { result } = renderHook(() => useRealtime('notification', jest.fn()));

        expect(result.current).toBe('idle');
        act(() => constructed[0].onopen?.());
        expect(result.current).toBe('open');
    });

    it('reports error, and does NOT close the connection', () => {
        // `readyState` tells a permanent failure from a retry for free, and
        // closing by hand throws away the automatic reconnect that is most of
        // the reason this is SSE.
        const { result } = renderHook(() => useRealtime('notification', jest.fn()));

        act(() => constructed[0].onerror?.());

        expect(result.current).toBe('error');
        expect(constructed[0].closed).toBe(false);
    });

    it('a subscriber mounting onto an ALREADY-OPEN connection sees open', () => {
        // The dead-branch shape #1983 fixed in the bell: it read a health flag
        // in the same tick it constructed the EventSource, so `onopen` could
        // not have fired and the throttled branch was unreachable. A late
        // subscriber must adopt the current state, not wait for the next
        // transition that may never come.
        renderHook(() => useRealtime('notification', jest.fn()));
        act(() => constructed[0].onopen?.());

        const late = renderHook(() => useRealtime('listing', jest.fn()));

        expect(late.result.current).toBe('open');
    });

    it('tells every subscriber about a transition', () => {
        const a = renderHook(() => useRealtime('notification', jest.fn()));
        const b = renderHook(() => useRealtime('listing', jest.fn()));

        act(() => constructed[0].onopen?.());

        expect(a.result.current).toBe('open');
        expect(b.result.current).toBe('open');
    });
});

describe('without EventSource', () => {
    it('does nothing and stays idle — SSR and jsdom both lack it', () => {
        delete (globalThis as { EventSource?: unknown }).EventSource;

        const { result } = renderHook(() => useRealtime('notification', jest.fn()));

        expect(constructed).toHaveLength(0);
        expect(result.current).toBe('idle');
    });
});
