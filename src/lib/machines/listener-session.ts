/**
 * The per-connection state machine for the Codec 8 listener — #2948 §3.
 *
 * ## Why this is a module and not a `net.Socket` callback
 *
 * Every decision that matters on this port is here: when to accept an IMEI,
 * when to spend a rate token, when to close, and how large a buffer one
 * unauthenticated peer may make us hold. Put that inside an
 * `on('data')` handler and nothing can execute it — which is the
 * `ci-failure-issue.sh` lesson in this repo: the first version of that
 * notifier put its decision logic in workflow YAML and shipped two defects
 * that both fired within two minutes.
 *
 * So `feed()` takes bytes and returns ACTIONS. The socket shim in
 * `scripts/machine-listener.ts` does nothing but perform them, and the tests
 * drive this directly with no sockets, no timers and no database.
 *
 * ## The buffer is the resource an unauthenticated peer controls
 *
 * A peer can open a connection and send one byte an hour. Without a ceiling
 * the accumulated buffer is unbounded per socket, and `parseAvlFrame` is
 * correct to answer `incomplete` the whole time — the parser's job is to
 * decide about bytes, not to decide how long we wait for them. So the cap is
 * here: `MAX_BUFFER_BYTES`, checked after every append.
 *
 * It is deliberately larger than the parser's `MAX_DATA_FIELD_BYTES`, because
 * a legitimate frame at that ceiling plus a partially-arrived next frame must
 * still fit. Sizing it equal would drop a device that pipelines.
 *
 * ## Order of checks, which is the security-relevant part
 *
 *   1. buffer ceiling        — cheapest, and the only unbounded resource
 *   2. rate cap              — in memory, before anything touches Postgres
 *   3. allowlist             — one query, only for a peer within its budget
 *   4. parse                 — bounded, never throws
 *
 * Checking the allowlist first would turn a packet flood into a query flood
 * against the same database the farm's own requests use. Checking the rate cap
 * before the handshake completes is not possible — there is no IMEI yet — so
 * the pre-handshake state is bounded by the buffer ceiling and the idle
 * timeout instead, which is why both exist.
 */
import { parseImeiPacket, parseAvlFrame, type Codec8Position } from './codec8';
import { ImeiRateCap } from './imei-rate-cap';

/**
 * Per-socket buffer ceiling. Four times the parser's data-field ceiling, so a
 * maximal frame plus a pipelined successor still fits while one peer cannot
 * make us hold megabytes.
 */
export const MAX_BUFFER_BYTES = 262_144;

/** Teltonika's handshake replies: one byte, 0x01 accept / 0x00 refuse. */
export const ACCEPT = Buffer.from([0x01]);
export const REFUSE = Buffer.from([0x00]);

export interface TrackerIdentity {
    trackerId: string;
    assetId: string;
    tenantId: string;
}

/** Resolves an IMEI to the row that admits it, or null. Never auto-registers. */
export type AllowlistLookup = (imei: string) => Promise<TrackerIdentity | null>;

export type Action =
    | { type: 'reply'; bytes: Buffer }
    /** Persist these positions for this tracker. The shim awaits it. */
    | { type: 'store'; identity: TrackerIdentity; positions: Codec8Position[] }
    /** Close the connection. `reason` is for the log, never sent on the wire. */
    | { type: 'close'; reason: string }
    /** A counter to bump. Separate from `close` so a drop is observable. */
    | { type: 'count'; metric: DropMetric };

export type DropMetric =
    | 'imei_unknown'
    | 'imei_malformed'
    | 'frame_malformed'
    | 'rate_capped'
    | 'buffer_overflow';

export interface SessionOptions {
    lookup: AllowlistLookup;
    cap?: ImeiRateCap;
    maxBufferBytes?: number;
}

export class ListenerSession {
    private buf: Buffer = Buffer.alloc(0);
    private identity: TrackerIdentity | null = null;
    private closed = false;
    private readonly cap: ImeiRateCap;
    private readonly maxBuffer: number;

    constructor(private readonly opts: SessionOptions) {
        this.cap = opts.cap ?? new ImeiRateCap();
        this.maxBuffer = opts.maxBufferBytes ?? MAX_BUFFER_BYTES;
    }

    /** True once the IMEI handshake has been accepted. */
    get authenticated(): boolean {
        return this.identity !== null;
    }

    /**
     * Feed bytes, get actions.
     *
     * `nowMs` is a parameter for the same reason the rate cap takes one: a
     * frame's records must be judged against ONE instant, and a test must be
     * able to sit exactly on a boundary without sleeping.
     */
    async feed(chunk: Buffer, nowMs: number): Promise<Action[]> {
        if (this.closed) return [];
        const out: Action[] = [];

        this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);

        // FIRST, before any parsing: the one resource a peer controls without
        // authenticating. A slow-loris sending one byte an hour is a correct
        // `incomplete` to the parser for ever.
        if (this.buf.length > this.maxBuffer) {
            this.closed = true;
            return [
                { type: 'count', metric: 'buffer_overflow' },
                { type: 'close', reason: `buffer exceeded ${this.maxBuffer} bytes` },
            ];
        }

        if (!this.identity) {
            const handled = await this.handleHandshake(out);
            // Either the handshake is incomplete (wait for more bytes) or it
            // closed the session; in both cases there is nothing further to do
            // with what we currently hold.
            if (!handled) return out;
        }

        return this.drainFrames(out, nowMs);
    }

    /** @returns true when the handshake completed and framing may proceed. */
    private async handleHandshake(out: Action[]): Promise<boolean> {
        const r = parseImeiPacket(this.buf);
        if (r.kind === 'incomplete') return false;
        if (r.kind === 'malformed') {
            // Refuse on the wire AND close. Teltonika's 0x00 tells a real
            // device to back off, which is kinder than a bare reset; the close
            // is what stops an attacker iterating on one connection.
            this.closed = true;
            out.push(
                { type: 'count', metric: 'imei_malformed' },
                { type: 'reply', bytes: REFUSE },
                { type: 'close', reason: `imei handshake: ${r.reason}` },
            );
            return false;
        }

        const identity = await this.opts.lookup(r.imei);
        if (!identity) {
            // THE ALLOWLIST. Dropped and counted, never auto-registered —
            // self-registration would let anyone holding a tracker write
            // positions into a stranger's farm. The IMEI is not echoed into the
            // reason: it is attacker-controlled input, and an unknown one has
            // no row to be about.
            this.closed = true;
            out.push(
                { type: 'count', metric: 'imei_unknown' },
                { type: 'reply', bytes: REFUSE },
                { type: 'close', reason: 'imei not on the allowlist' },
            );
            return false;
        }

        this.identity = identity;
        this.buf = this.buf.subarray(r.consumed);
        out.push({ type: 'reply', bytes: ACCEPT });
        return true;
    }

    /** Consume as many whole AVL frames as the buffer holds. */
    private drainFrames(out: Action[], nowMs: number): Action[] {
        const identity = this.identity;
        if (!identity) return out;

        for (;;) {
            if (this.buf.length === 0) return out;
            const r = parseAvlFrame(this.buf);

            if (r.kind === 'incomplete') return out;

            if (r.kind === 'malformed') {
                // §3: a malformed frame CLOSES the connection rather than
                // throwing inside a shared process. It is also not acked —
                // acking a frame we rejected would tell the device its records
                // were stored and let it discard them.
                this.closed = true;
                out.push(
                    { type: 'count', metric: 'frame_malformed' },
                    { type: 'close', reason: `avl frame: ${r.reason}` },
                );
                return out;
            }

            this.buf = this.buf.subarray(r.consumed);

            // One token per FRAME, not per record: the cost being bounded is
            // the write, and a frame is one batched insert. Charging per record
            // would refuse exactly the backlog replay the burst exists to
            // absorb after a GSM outage.
            const verdict = this.cap.take(identity.trackerId, nowMs);
            if (!verdict.allowed) {
                // Rate-capped frames are DROPPED, and deliberately NOT acked,
                // so the device retains its records and replays them later —
                // a cap that acked would silently destroy field data.
                out.push({ type: 'count', metric: 'rate_capped' });
                continue;
            }

            out.push({ type: 'store', identity, positions: r.positions });
            // Teltonika expects the accepted record count as a 4-byte
            // big-endian integer; a device that gets no ack replays the frame.
            const ack = Buffer.alloc(4);
            ack.writeUInt32BE(r.positions.length, 0);
            out.push({ type: 'reply', bytes: ack });
        }
    }
}
