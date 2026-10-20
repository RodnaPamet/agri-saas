/**
 * One Server-Sent Events stream, with its lifecycle in one place — P7.2 (#1991).
 *
 * ## Why this is extracted
 *
 * `/api/notifications/stream` inlined its own `ReadableStream`, and the
 * lifecycle is the part that goes wrong: two leaks have been found in it, both
 * in the bookkeeping rather than in the routing. A second SSE route copying
 * that code would copy the bookkeeping, so the bookkeeping lives here and the
 * routes carry only what differs.
 *
 * ## The two facts that must not share a flag — leak 2
 *
 * The inlined version kept one boolean, `closed`, and used it for two
 * different things:
 *
 *   - `safeEnqueue` set it to mean "stop writing", which happens whenever a
 *     client disconnects mid-flush and `controller.enqueue` throws;
 *   - `cleanup` read it to mean "cleanup has already run" and returned early.
 *
 * So after any failed enqueue, cleanup was a no-op: no `clearInterval`, no
 * `unsubscribe`. The heartbeat and the bus subscription then lived until the
 * process restarted.
 *
 * #1984's fix did not reach it, and that is the instructive part: it added a
 * second TRIGGER (releasing on stream `cancel()` as well as on request
 * `abort`), and both triggers call the same release, which still returned
 * early on the same flag. Two doors into a room whose light switch is broken.
 *
 * Hence two flags with one meaning each: {@link State.writable} and
 * {@link State.released}. Separate names are the fix — nothing else here is
 * cleverer than the version it replaces.
 *
 * ## Releasing is idempotent, and has to be
 *
 * Both triggers can fire for one stream. The bus subscription is
 * reference-counted (`notification-bus.ts` holds ONE connection and counts
 * holders), so a second `unsubscribe()` would decrement a count this stream no
 * longer owns and could tear down another stream's delivery.
 */

/** What the caller supplies. Everything else is lifecycle. */
export interface SseOptions {
    /**
     * Attach the event source and return its releaser.
     *
     * Called once, synchronously, inside `start`. The `send` it receives is
     * already guarded: writing after teardown is dropped rather than thrown.
     */
    subscribe: (send: (chunk: string) => void) => () => void;
    /**
     * Heartbeat period. A comment line on this interval keeps proxies from
     * closing an idle connection, and is what makes a dead stream detectable
     * from the client.
     */
    heartbeatMs: number;
    /** Optional first line. Defaults to a comment, which is what opens the channel. */
    openingComment?: string;
}

interface State {
    /** False once a write has failed — stop enqueuing, but stay releasable. */
    writable: boolean;
    /** True once resources have been released — makes release idempotent. */
    released: boolean;
}

export interface SseStream {
    /** Pass to `new ReadableStream({ start })`. */
    start: (controller: Pick<ReadableStreamDefaultController<Uint8Array>, 'enqueue' | 'close'>) => void;
    /**
     * Release the heartbeat and the subscription, and close the stream.
     *
     * Idempotent and safe to call from every trigger. Call it from BOTH the
     * request's `abort` and the stream's `cancel` — see the file docblock for
     * what happens when only one is wired.
     */
    release: () => void;
}

export function createSseResponse(opts: SseOptions): SseStream {
    const encoder = new TextEncoder();
    const state: State = { writable: true, released: false };

    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let close: (() => void) | null = null;

    const release = (): void => {
        // Guarded on `released`, NEVER on writability. That distinction is the
        // whole of leak 2: a stream whose last write failed is exactly the
        // stream most in need of releasing.
        if (state.released) return;
        state.released = true;
        state.writable = false;

        if (heartbeat !== null) {
            clearInterval(heartbeat);
            heartbeat = null;
        }
        // Nulled before calling, so a throw inside the releaser cannot leave
        // it callable a second time — the reference-counted bus would
        // decrement twice.
        const u = unsubscribe;
        unsubscribe = null;
        try {
            u?.();
        } catch {
            // A failing releaser must not stop the stream being closed.
        }
        try {
            close?.();
        } catch {
            // Already closed upstream — fine, and the ordinary case when the
            // client went away first.
        }
    };

    const start: SseStream['start'] = (controller) => {
        close = () => controller.close();

        const send = (chunk: string): void => {
            if (!state.writable) return;
            try {
                controller.enqueue(encoder.encode(chunk));
            } catch {
                // The client disconnected mid-flush. Stop writing — and
                // deliberately do NOT touch `released`, so the release path
                // stays armed.
                state.writable = false;
            }
        };

        // First, so the channel is open before anything else can fail: some
        // browsers do not fire `onopen` until a byte has arrived, and a
        // channel that looks dead is worse than one that is.
        send(opts.openingComment ?? ': connected\n\n');

        unsubscribe = opts.subscribe(send);
        heartbeat = setInterval(() => send(': hb\n\n'), opts.heartbeatMs);
    };

    return { start, release };
}
