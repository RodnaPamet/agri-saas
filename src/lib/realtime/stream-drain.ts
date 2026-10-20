/**
 * Close every open stream on SIGTERM — P7.3 (#1992).
 *
 * ## Why a registry rather than waiting for the streams to end
 *
 * `next start`'s own SIGTERM handler calls `server.close()`, which stops
 * accepting connections and then WAITS for the open ones to finish — in
 * production it deliberately does not call `closeAllConnections()`. An SSE
 * stream never finishes on its own: it holds a heartbeat `setInterval` and a
 * bus subscription for as long as the tab is open. So "wait for the open
 * connections" and "a connection that is open for ever" compose into "wait for
 * ever", and the container is SIGKILLed at the end of its grace period with
 * every stream dying mid-chunk.
 *
 * The app container is recreated roughly eight times a day on `:latest`, so
 * that is the normal path, not an edge case.
 *
 * ## The drain must be SYNCHRONOUS, and that is what makes it work at all
 *
 * Node invokes every `SIGTERM` listener synchronously, in registration order,
 * inside one `emit`. Next's handler does its work inside an `async` IIFE, so it
 * cannot reach its `process.exit(143)` before yielding at its first `await`.
 * Any synchronous work in another listener therefore completes first —
 * whatever the registration order, which is not something we control.
 *
 * That is why this closes streams with plain synchronous enqueues and does not
 * await anything. An async drain would be racing Next's exit, which is the race
 * `shutdown.ts`'s own async stages lose (#2091: 58 `initiated`, 1 `complete`).
 *
 * ## Why clients are closed rather than left to notice
 *
 * `EventSource` reconnects by itself when a stream it holds is closed, and does
 * NOT reconnect when a response fails with a non-200. So closing is the signal
 * that gets a client to come back: it reconnects, lands on the new container,
 * and replays from `Last-Event-ID`. A dropped socket gets there too, eventually
 * and less predictably; an error status would not get there at all.
 *
 * A final frame goes out before the close so the client can tell a deploy from
 * a crash. It is a COMMENT line (`: draining`), not an `event:` — every
 * consumer here uses the default message handler, and a named event would be
 * silently dropped by all of them while looking like it had been delivered.
 *
 * ## What this does NOT do
 *
 * Refuse new streams with an error status. During a deploy that would be
 * exactly wrong: a non-200 tells `EventSource` to stop asking, so a client
 * would go silent until the user reloaded. `server.close()` already stops new
 * CONNECTIONS at the TCP level, and a browser treats that as a network failure
 * and retries — which is the behaviour we want and get for free. The only gap
 * is a request arriving on an already-open keep-alive connection, which is what
 * {@link isDraining} is for: such a request gets a well-formed stream that
 * closes immediately, and the client reconnects rather than holding a
 * subscription on a dying process.
 */
import { logger } from '@/lib/observability/logger';

/**
 * Close functions for the streams open in THIS process.
 *
 * A `Set` of closures rather than a list of stream objects: the two SSE
 * producers that go through `createSseResponse` already own an idempotent
 * `release`, and the copilot route owns its own `cleanup`. Registering the
 * function they already have avoids giving three different stream shapes a
 * common interface they do not otherwise need.
 */
const open = new Set<() => void>();

let draining = false;

/**
 * True once SIGTERM has started the drain.
 *
 * A handler that opens a long-lived stream should check this and answer with a
 * stream that closes immediately instead — see the docblock for why that is
 * not a refusal status.
 */
export function isDraining(): boolean {
    return draining;
}

/**
 * Register a stream's close function; returns the deregistration.
 *
 * The caller MUST call the returned function when the stream ends on its own,
 * or the set grows for the lifetime of the process — the same leak the stream
 * lifecycle itself was fixed for in #1984.
 */
export function registerOpenStream(close: () => void): () => void {
    open.add(close);
    return () => {
        open.delete(close);
    };
}

/** How many streams this process currently holds. For tests and metrics. */
export function openStreamCount(): number {
    return open.size;
}

/**
 * Close every open stream, synchronously.
 *
 * Idempotent, and safe to call when nothing is open. Each close is individually
 * guarded: one throwing releaser must not strand the streams after it in the
 * set, which — with a `Set` iterated in insertion order — would otherwise mean
 * the oldest stream's failure abandons every newer one.
 */
export function drainOpenStreams(): number {
    draining = true;

    // Snapshot first. Every registered closer deregisters itself as it runs,
    // which mutates `open` during iteration.
    const closers = [...open];
    open.clear();

    let closed = 0;
    for (const close of closers) {
        try {
            close();
            closed += 1;
        } catch (err) {
            logger.warn('sse.drain_close_failed', {
                component: 'realtime',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (closers.length > 0) {
        logger.info('sse.drained', {
            component: 'realtime',
            streams: closers.length,
            closed,
        });
    }
    return closed;
}

/** Test-only: forget the drain flag and any registrations. @internal */
export function _resetStreamDrainForTesting(): void {
    open.clear();
    draining = false;
}
