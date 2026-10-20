/**
 * An SSE stream releases its resources — P7.2 (#1991).
 *
 * ## Leak 2, named from evidence rather than assumed
 *
 * #1991 says "both leaks" and records one as fixed in #1984 (`cleanup` was
 * reachable only from an `abort`, so cancelling the response stream released
 * nothing). It deliberately leaves the second unidentified and asks for it to
 * be named from the code. It is this:
 *
 * `closed` carries TWO different facts. `safeEnqueue` sets it to mean "stop
 * writing" when `controller.enqueue` throws — which happens whenever a client
 * disconnects mid-flush. `cleanup` reads the same flag to mean "cleanup has
 * already run" and returns early.
 *
 * So once an enqueue has thrown, `cleanup` is a no-op: it never reaches
 * `clearInterval(heartbeat)` and never calls `unsubscribe()`. The 25-second
 * heartbeat and the bus subscription then live until the process restarts.
 *
 * The #1984 fix does not help, and that is the part worth stating: it added a
 * second TRIGGER (`cancel()`), and both triggers call the same `cleanup`,
 * which still returns early on the same flag. Two doors into a room whose
 * light switch is broken.
 *
 * Neither candidate #1991 lists is quite this. "Keeps its interval until an
 * abort arrives" understates it — the abort arrives and still releases
 * nothing.
 *
 * ## Why these tests drive the helper rather than the route
 *
 * The leak is in the lifecycle, not in the routing: the same flag confusion
 * would be in any stream built this way. Driving `createSseResponse` directly
 * means the reproduction is one function call instead of a mocked request, a
 * flag, a tenant context and an auth session — and the route's own gate is
 * already covered by `notifications-stream-flag-gate`.
 */
import { createSseResponse } from '@/lib/realtime/sse';
import {
    drainOpenStreams,
    openStreamCount,
    _resetStreamDrainForTesting,
} from '@/lib/realtime/stream-drain';

/** A controller whose `enqueue` can be made to throw on demand. */
function harness() {
    const chunks: string[] = [];
    let throwOnEnqueue = false;
    let closeCalls = 0;
    return {
        chunks,
        breakEnqueue: () => {
            throwOnEnqueue = true;
        },
        get closeCalls() {
            return closeCalls;
        },
        controller: {
            enqueue: (b: Uint8Array) => {
                if (throwOnEnqueue) throw new TypeError('stream already torn down');
                chunks.push(Buffer.from(b).toString());
            },
            close: () => {
                closeCalls += 1;
            },
        },
    };
}

describe('createSseResponse releases its resources', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('clears the heartbeat and unsubscribes on a clean close — the control', () => {
        // Without this, every assertion below is satisfied by a helper that
        // releases nothing on any path.
        const unsubscribe = jest.fn();
        const h = harness();

        const { start, release } = createSseResponse({
            subscribe: () => unsubscribe,
            heartbeatMs: 25_000,
        });
        start(h.controller);

        expect(jest.getTimerCount()).toBe(1);
        release();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
        expect(h.closeCalls).toBe(1);
    });

    it('STILL releases after an enqueue has thrown — leak 2', () => {
        // The reproduction. A client disconnecting mid-flush makes `enqueue`
        // throw, which is the ordinary case rather than an exotic one, and it
        // must not disarm the release path.
        const unsubscribe = jest.fn();
        const h = harness();

        const { start, release } = createSseResponse({
            subscribe: () => unsubscribe,
            heartbeatMs: 25_000,
        });
        start(h.controller);
        expect(jest.getTimerCount()).toBe(1);

        // The client goes away mid-write.
        h.breakEnqueue();
        jest.advanceTimersByTime(25_000); // a heartbeat throws

        release();

        // Both of these failed before the fix: `release` saw the flag that
        // the failed enqueue had set and returned without doing anything.
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('is idempotent across BOTH triggers', () => {
        // #1984 added `cancel()` beside `abort`, so release can arrive twice.
        // It must unsubscribe once — a double unsubscribe on a
        // reference-counted bus would decrement another stream's hold.
        const unsubscribe = jest.fn();
        const h = harness();

        const { start, release } = createSseResponse({
            subscribe: () => unsubscribe,
            heartbeatMs: 25_000,
        });
        start(h.controller);
        release();
        release();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
        // The CLOSE count, and this is the assertion that gives the
        // `released` guard teeth. A first version of this case checked only
        // the unsubscribe count and passed with the guard removed — because
        // idempotence there comes from nulling the releaser before calling
        // it, not from the guard. `close` is not nulled, so without the guard
        // a second release calls it again, and only this line notices.
        expect(h.closeCalls).toBe(1);
    });

    it('stops writing after a throw, but keeps the stream releasable', () => {
        // The two facts the old flag conflated, asserted apart: writing stops
        // (no further chunks) AND releasing still works. A fix that merely
        // renamed the flag would pass one of these.
        const h = harness();
        const { start, release } = createSseResponse({
            subscribe: () => () => {},
            heartbeatMs: 25_000,
        });
        start(h.controller);
        const afterOpen = h.chunks.length;

        h.breakEnqueue();
        jest.advanceTimersByTime(75_000); // three heartbeats, all throwing

        expect(h.chunks.length).toBe(afterOpen);
        expect(() => release()).not.toThrow();
        expect(jest.getTimerCount()).toBe(0);
    });

    it('sends an opening comment, so EventSource fires onopen', () => {
        // Some browsers do not fire `onopen` until a byte arrives, so the
        // channel looks dead until the first real event.
        const h = harness();
        const { start } = createSseResponse({
            subscribe: () => () => {},
            heartbeatMs: 25_000,
        });
        start(h.controller);

        expect(h.chunks[0]).toContain(':');
    });

    it('heartbeats on the interval it was given', () => {
        const h = harness();
        const { start } = createSseResponse({
            subscribe: () => () => {},
            heartbeatMs: 25_000,
        });
        start(h.controller);
        const afterOpen = h.chunks.length;

        jest.advanceTimersByTime(25_000);
        expect(h.chunks.length).toBe(afterOpen + 1);
        jest.advanceTimersByTime(50_000);
        expect(h.chunks.length).toBe(afterOpen + 3);
    });
});

describe('createSseResponse joins the SIGTERM drain — P7.3 (#1992)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        _resetStreamDrainForTesting();
    });
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        _resetStreamDrainForTesting();
    });

    it('registers only once the stream is LIVE, not when it is constructed', () => {
        // Registering at construction would put a closer in the set for a
        // stream whose `subscribe` then threw, and the drain would close
        // something that never opened.
        const h = harness();
        const { start } = createSseResponse({
            subscribe: () => () => {},
            heartbeatMs: 25_000,
        });

        expect(openStreamCount()).toBe(0);
        start(h.controller);
        expect(openStreamCount()).toBe(1);
    });

    it('sends a final comment frame and closes, so the client reconnects', () => {
        // A COMMENT and not an `event:` — every consumer of these streams uses
        // the default message handler, so a named event would be dropped by
        // all of them while looking delivered.
        const unsubscribe = jest.fn();
        const h = harness();
        const { start } = createSseResponse({
            subscribe: () => unsubscribe,
            heartbeatMs: 25_000,
        });
        start(h.controller);

        drainOpenStreams();

        expect(h.chunks.at(-1)).toBe(': draining\n\n');
        expect(h.closeCalls).toBe(1);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('a stream released before the signal is not in the registry', () => {
        // The ordinary case — a tab closed before the deploy. Closing it again
        // would decrement the reference-counted bus twice.
        const unsubscribe = jest.fn();
        const h = harness();
        const { start, release } = createSseResponse({
            subscribe: () => unsubscribe,
            heartbeatMs: 25_000,
        });
        start(h.controller);
        release();

        expect(openStreamCount()).toBe(0);
        expect(drainOpenStreams()).toBe(0);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(h.chunks).not.toContain(': draining\n\n');
    });

    it('the drain clears the heartbeat, so the process can actually exit', () => {
        // The reason a drain is needed at all rather than waiting: an open
        // stream holds a 25s interval with no `unref()`, so `server.close()`
        // waits for a connection that never ends.
        const h = harness();
        const { start } = createSseResponse({
            subscribe: () => () => {},
            heartbeatMs: 25_000,
        });
        start(h.controller);
        expect(jest.getTimerCount()).toBeGreaterThan(0);

        drainOpenStreams();

        expect(jest.getTimerCount()).toBe(0);
    });

    it('a drained stream writes nothing further, even on a late event', () => {
        let send: ((chunk: string) => void) | null = null;
        const h = harness();
        const { start } = createSseResponse({
            subscribe: (s) => {
                send = s;
                return () => {};
            },
            heartbeatMs: 25_000,
        });
        start(h.controller);

        drainOpenStreams();
        const after = h.chunks.length;
        send!('data: late\n\n');

        expect(h.chunks.length).toBe(after);
    });
});
