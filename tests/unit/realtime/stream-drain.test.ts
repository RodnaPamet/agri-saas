/**
 * Closing open streams on SIGTERM — P7.3 (#1992).
 *
 * The property that matters is not "streams get closed" but "streams get
 * closed SYNCHRONOUSLY", because the drain is racing `next start`'s own
 * handler, which ends in `process.exit(143)`. #2091 measured what losing that
 * race looks like: 58 `graceful shutdown initiated`, 1 `graceful shutdown
 * complete`, over 7 days. So several cases below assert on what has happened
 * at a point in time with no `await` in between — that is the test, not an
 * incidental style.
 */
import {
    registerOpenStream,
    drainOpenStreams,
    isDraining,
    openStreamCount,
    _resetStreamDrainForTesting,
} from '@/lib/realtime/stream-drain';

const warn = jest.fn();
const info = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        warn: (...a: unknown[]) => warn(...a),
        info: (...a: unknown[]) => info(...a),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

beforeEach(() => {
    _resetStreamDrainForTesting();
    warn.mockClear();
    info.mockClear();
});

describe('the drain registry', () => {
    it('closes every registered stream', () => {
        const a = jest.fn();
        const b = jest.fn();
        registerOpenStream(a);
        registerOpenStream(b);

        expect(drainOpenStreams()).toBe(2);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('closes them SYNCHRONOUSLY — the property the race depends on', () => {
        // Asserted with no `await` between the call and the check. An async
        // drain would be indistinguishable here on a passing run and would
        // lose to `process.exit(143)` in production.
        const closed: string[] = [];
        registerOpenStream(() => closed.push('one'));
        registerOpenStream(() => closed.push('two'));

        drainOpenStreams();

        expect(closed).toEqual(['one', 'two']);
    });

    it('a deregistered stream is NOT closed again', () => {
        // The ordinary case: a tab that closed before the deploy. Calling its
        // releaser again would decrement the reference-counted bus twice.
        const gone = jest.fn();
        const deregister = registerOpenStream(gone);
        deregister();

        expect(openStreamCount()).toBe(0);
        expect(drainOpenStreams()).toBe(0);
        expect(gone).not.toHaveBeenCalled();
    });

    it('one throwing closer does not strand the streams after it', () => {
        // A `Set` iterates in insertion order, so without the per-closer guard
        // the OLDEST stream's failure would abandon every newer one — the
        // streams most likely to be healthy.
        const boom = jest.fn(() => {
            throw new Error('enqueue on a dead controller');
        });
        const after = jest.fn();
        registerOpenStream(boom);
        registerOpenStream(after);

        expect(drainOpenStreams()).toBe(1);
        expect(after).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('sse.drain_close_failed', expect.anything());
    });

    it('survives a closer that deregisters itself mid-drain', () => {
        // Which is what the real ones do: `release()` removes the stream from
        // the registry, so the set is mutated while being iterated.
        const order: string[] = [];
        let deregB: (() => void) | null = null;
        registerOpenStream(() => {
            order.push('a');
            deregB?.();
        });
        deregB = registerOpenStream(() => order.push('b'));

        drainOpenStreams();

        // Both still ran: the snapshot is taken before any closer executes, so
        // a mid-drain deregistration cannot skip a stream that was open when
        // the signal arrived.
        expect(order).toEqual(['a', 'b']);
    });

    it('is idempotent, so a second SIGTERM closes nothing twice', () => {
        const once = jest.fn();
        registerOpenStream(once);

        drainOpenStreams();
        drainOpenStreams();

        expect(once).toHaveBeenCalledTimes(1);
    });

    it('says nothing when there was nothing open', () => {
        // Most deploys have no stream open. A log line per deploy claiming a
        // drain that drained nothing is noise that makes the real ones
        // unfindable.
        expect(drainOpenStreams()).toBe(0);
        expect(info).not.toHaveBeenCalled();
    });

    it('reports the count it closed, so a deploy can be counted', () => {
        registerOpenStream(jest.fn());
        drainOpenStreams();

        expect(info).toHaveBeenCalledWith(
            'sse.drained',
            expect.objectContaining({ streams: 1, closed: 1 }),
        );
    });

    describe('isDraining', () => {
        it('is false before the signal and true after', () => {
            expect(isDraining()).toBe(false);
            drainOpenStreams();
            expect(isDraining()).toBe(true);
        });

        it('flips even when no stream was open', () => {
            // A request arriving on an already-open keep-alive connection
            // after `server.close()` must still see the draining state, and
            // whether anything happened to be streaming at that moment is
            // unrelated.
            expect(drainOpenStreams()).toBe(0);
            expect(isDraining()).toBe(true);
        });
    });
});
