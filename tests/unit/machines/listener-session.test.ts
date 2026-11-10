/**
 * The listener's decision logic, driven directly — no sockets, no timers, no
 * database.
 *
 * The properties worth protecting here are mostly NEGATIVE and mostly about
 * order: that an unknown IMEI stores nothing, that garbage never reaches the
 * database, that a refused frame is not acked, and that the allowlist query
 * does not happen for a peer who has not got past the cheap checks. Each of
 * those is satisfied by a session that does nothing at all, so §1 is the
 * control the rest rests on.
 */
import { ListenerSession, MAX_BUFFER_BYTES, ACCEPT, REFUSE } from '@/lib/machines/listener-session';
import { ImeiRateCap } from '@/lib/machines/imei-rate-cap';
import { crc16Ibm, CODEC_8 } from '@/lib/machines/codec8';
import type { TrackerIdentity, Action } from '@/lib/machines/listener-session';

const T0 = 1_794_312_000_000;
const IMEI = '356938035643809';
const IDENTITY: TrackerIdentity = { trackerId: 'mt-1', assetId: 'a-1', tenantId: 't-1' };

function imeiPacket(imei = IMEI): Buffer {
    const body = Buffer.from(imei, 'latin1');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(body.length, 0);
    return Buffer.concat([head, body]);
}

function record(ms = T0): Buffer {
    const head = Buffer.alloc(24);
    head.writeBigUInt64BE(BigInt(ms), 0);
    head.writeUInt8(1, 8);
    head.writeInt32BE(233219000, 9);
    head.writeInt32BE(426977000, 13);
    head.writeInt16BE(550, 17);
    head.writeUInt16BE(180, 19);
    head.writeUInt8(11, 21);
    head.writeUInt16BE(12, 22);
    return Buffer.concat([head, Buffer.from([239, 1, 1, 239, 1, 0, 0, 0])]);
}

function frame(records: Buffer[] = [record()]): Buffer {
    const data = Buffer.concat([
        Buffer.from([CODEC_8, records.length]),
        ...records,
        Buffer.from([records.length]),
    ]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(0, 0);
    head.writeUInt32BE(data.length, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc16Ibm(data), 0);
    return Buffer.concat([head, data, crc]);
}

interface Harness {
    session: ListenerSession;
    lookups: string[];
}

function harness(opts: { identity?: TrackerIdentity | null; cap?: ImeiRateCap } = {}): Harness {
    const lookups: string[] = [];
    const session = new ListenerSession({
        lookup: async (imei) => {
            lookups.push(imei);
            return opts.identity === undefined ? IDENTITY : opts.identity;
        },
        cap: opts.cap,
    });
    return { session, lookups };
}

const kinds = (a: Action[]) => a.map((x) => x.type);
const metrics = (a: Action[]) =>
    a.flatMap((x) => (x.type === 'count' ? [x.metric] : []));
const stores = (a: Action[]) =>
    a.flatMap((x) => (x.type === 'store' ? [x] : []));
const replies = (a: Action[]) =>
    a.flatMap((x) => (x.type === 'reply' ? [x.bytes] : []));

describe('§1 the control — the happy path works, so the refusals mean something', () => {
    it('accepts the handshake and stores a frame', async () => {
        const h = harness();
        const hs = await h.session.feed(imeiPacket(), T0);
        expect(replies(hs)).toEqual([ACCEPT]);
        expect(h.session.authenticated).toBe(true);
        expect(h.lookups).toEqual([IMEI]);

        const f = await h.session.feed(frame(), T0);
        const st = stores(f);
        expect(st).toHaveLength(1);
        expect(st[0].identity).toEqual(IDENTITY);
        expect(st[0].positions).toHaveLength(1);
        expect(st[0].positions[0].lat).toBe('42.6977000');
    });

    it('acks with the accepted record COUNT, as the device expects', async () => {
        const h = harness();
        await h.session.feed(imeiPacket(), T0);
        const out = await h.session.feed(frame([record(), record(T0 + 1000), record(T0 + 2000)]), T0);
        const ack = replies(out).at(-1);
        expect(ack).toBeDefined();
        expect(ack!.readUInt32BE(0)).toBe(3);
    });

    it('reassembles a frame split across chunks — TCP is a stream', async () => {
        const h = harness();
        await h.session.feed(imeiPacket(), T0);
        const f = frame();
        // CONTIGUOUS slices. My first version fed f[0], f[4], f[8] … which is
        // not a split stream but a corrupted one, and it failed for the right
        // reason: the session reassembled exactly the bytes it was given.
        let sent = 0;
        for (const upto of [1, 5, 9, f.length - 1]) {
            const partial = await h.session.feed(f.subarray(sent, upto), T0);
            expect(stores(partial)).toHaveLength(0);
            sent = upto;
        }
        const rest = await h.session.feed(f.subarray(sent), T0);
        expect(stores(rest)).toHaveLength(1);
    });

    it('drains SEVERAL frames arriving in one chunk', async () => {
        const h = harness();
        await h.session.feed(imeiPacket(), T0);
        const out = await h.session.feed(Buffer.concat([frame(), frame(), frame()]), T0);
        expect(stores(out)).toHaveLength(3);
    });

    it('handles a handshake and a frame in ONE chunk', async () => {
        const h = harness();
        const out = await h.session.feed(Buffer.concat([imeiPacket(), frame()]), T0);
        expect(replies(out)[0]).toEqual(ACCEPT);
        expect(stores(out)).toHaveLength(1);
    });
});

describe('§2 the allowlist — an unknown IMEI stores NOTHING', () => {
    it('refuses, counts and closes, with no store', async () => {
        const h = harness({ identity: null });
        const out = await h.session.feed(Buffer.concat([imeiPacket(), frame()]), T0);
        expect(metrics(out)).toContain('imei_unknown');
        expect(replies(out)).toEqual([REFUSE]);
        expect(kinds(out)).toContain('close');
        // The frame rode in on the same chunk and must still not be stored.
        expect(stores(out)).toHaveLength(0);
        expect(h.session.authenticated).toBe(false);
    });

    it('never auto-registers — a second attempt is refused the same way', async () => {
        const h = harness({ identity: null });
        await h.session.feed(imeiPacket(), T0);
        const again = await h.session.feed(frame(), T0);
        // Closed sessions do nothing at all, so there is no path by which a
        // refused IMEI becomes admitted by persistence.
        expect(again).toEqual([]);
    });

    it('does NOT query the allowlist for a malformed IMEI', async () => {
        // Order matters: garbage must not become a database query. An
        // unauthenticated peer that can make us query has turned a packet
        // flood into a query flood against the farm's own database.
        const h = harness();
        const out = await h.session.feed(imeiPacket('35693803564380\n'), T0);
        expect(h.lookups).toEqual([]);
        expect(metrics(out)).toContain('imei_malformed');
        expect(replies(out)).toEqual([REFUSE]);
    });

    it('does not query the allowlist while the handshake is incomplete', async () => {
        const h = harness();
        await h.session.feed(imeiPacket().subarray(0, 8), T0);
        expect(h.lookups).toEqual([]);
        expect(h.session.authenticated).toBe(false);
    });

    it('queries the allowlist exactly ONCE per connection', async () => {
        const h = harness();
        await h.session.feed(imeiPacket(), T0);
        await h.session.feed(frame(), T0);
        await h.session.feed(frame(), T0);
        expect(h.lookups).toEqual([IMEI]);
    });

    it('never puts the IMEI in a close reason', async () => {
        // An unparsed IMEI is attacker-controlled input; a log line carrying it
        // is a terminal-escape or log-injection vector.
        const h = harness({ identity: null });
        const out = await h.session.feed(imeiPacket(), T0);
        const reasons = out.flatMap((a) => (a.type === 'close' ? [a.reason] : []));
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).not.toContain(IMEI);
    });
});

describe('§3 a malformed frame closes and is NOT acked', () => {
    it('counts, closes, stores nothing and sends no ack', async () => {
        const h = harness();
        await h.session.feed(imeiPacket(), T0);
        const bad = Buffer.from(frame());
        bad.writeUInt32BE(0xdeadbeef, bad.length - 4); // break the CRC
        const out = await h.session.feed(bad, T0);
        expect(metrics(out)).toContain('frame_malformed');
        expect(kinds(out)).toContain('close');
        expect(stores(out)).toHaveLength(0);
        // Acking a frame we rejected tells the device its records are stored
        // and lets it discard them — silent field-data loss.
        expect(replies(out)).toHaveLength(0);
    });

    it('stops at the bad frame and does not store a later good one', async () => {
        const h = harness();
        await h.session.feed(imeiPacket(), T0);
        const bad = Buffer.from(frame());
        bad.writeUInt32BE(0xdeadbeef, bad.length - 4);
        const out = await h.session.feed(Buffer.concat([bad, frame()]), T0);
        expect(stores(out)).toHaveLength(0);
    });

    it('a session that closed does nothing on further bytes', async () => {
        const h = harness();
        await h.session.feed(imeiPacket(), T0);
        const bad = Buffer.from(frame());
        bad.writeUInt32BE(0xdeadbeef, bad.length - 4);
        await h.session.feed(bad, T0);
        expect(await h.session.feed(frame(), T0)).toEqual([]);
    });
});

describe('§4 the buffer ceiling — the one resource an unauthenticated peer holds', () => {
    it('closes a peer that accumulates past the ceiling without completing a frame', async () => {
        // A slow-loris is a correct `incomplete` to the parser for ever: the
        // parser decides about bytes, not about how long we wait for them. So
        // the bound lives here.
        const h = harness();
        const out = await h.session.feed(Buffer.alloc(MAX_BUFFER_BYTES + 1), T0);
        expect(metrics(out)).toContain('buffer_overflow');
        expect(kinds(out)).toContain('close');
    });

    it('a pre-handshake peer cannot hold more than 17 bytes anyway', async () => {
        // MEASURED while this suite failed, and it narrows what the ceiling is
        // for. `parseImeiPacket` answers `incomplete` only for fewer than 2
        // bytes, or for a declared length of exactly 15 with fewer than 17
        // present — any other length is MALFORMED immediately. So the
        // slow-loris shape does not exist before the handshake: a peer
        // dribbling arbitrary bytes is closed on its first chunk, not
        // accumulated.
        const h = harness();
        const out = await h.session.feed(Buffer.alloc(8192), T0);
        expect(metrics(out)).toContain('imei_malformed');
        expect(metrics(out)).not.toContain('buffer_overflow');

        // The only pre-handshake state that WAITS is a well-formed prefix,
        // which is bounded at 16 bytes by the protocol itself.
        const h2 = harness();
        const waiting = await h2.session.feed(imeiPacket().subarray(0, 16), T0);
        expect(kinds(waiting)).not.toContain('close');
        expect(h2.session.authenticated).toBe(false);
    });

    it('so what the ceiling actually bounds is ONE oversized write', async () => {
        // Recorded rather than dressed up: post-handshake the frame parser
        // refuses a declared length over its own ceiling and consumes whole
        // frames as they complete, so the accumulated buffer self-limits to
        // roughly one maximal frame. The ceiling's live case is a single large
        // write, where the append happens before any parsing can bound it.
        const h = harness();
        await h.session.feed(imeiPacket(), T0);
        const out = await h.session.feed(Buffer.alloc(MAX_BUFFER_BYTES + 1), T0);
        expect(metrics(out)).toContain('buffer_overflow');
        expect(kinds(out)).toContain('close');
    });

    it('a write just UNDER the ceiling is not an overflow — the boundary control', async () => {
        // Proves the ceiling rejects on SIZE. It still closes, because zero
        // bytes are a malformed frame once authenticated — so the assertion is
        // on the METRIC, not on whether the session closed, which is the
        // distinction my first version got wrong.
        const h = harness();
        await h.session.feed(imeiPacket(), T0);
        const out = await h.session.feed(Buffer.alloc(MAX_BUFFER_BYTES - 1), T0);
        expect(metrics(out)).not.toContain('buffer_overflow');
    });

    it('is larger than one maximal frame, so a pipelining device is not dropped', () => {
        expect(MAX_BUFFER_BYTES).toBeGreaterThan(65_536 * 2);
    });
});

describe('§5 the rate cap drops a frame WITHOUT acking it', () => {
    it('stores nothing and does not ack, so the device replays later', async () => {
        // A cap that acked would silently destroy field work: the device would
        // mark the records delivered and discard them. Retaining them costs a
        // replay; acking costs the data.
        const cap = new ImeiRateCap({ burst: 1, refillPerSecond: 0, maxTracked: 8 });
        const h = harness({ cap });
        await h.session.feed(imeiPacket(), T0);

        const first = await h.session.feed(frame(), T0);
        expect(stores(first)).toHaveLength(1);

        const second = await h.session.feed(frame(), T0);
        expect(metrics(second)).toContain('rate_capped');
        expect(stores(second)).toHaveLength(0);
        expect(replies(second)).toHaveLength(0);
    });

    it('does NOT close the connection — a capped device is not a hostile one', async () => {
        const cap = new ImeiRateCap({ burst: 1, refillPerSecond: 0, maxTracked: 8 });
        const h = harness({ cap });
        await h.session.feed(imeiPacket(), T0);
        await h.session.feed(frame(), T0);
        const out = await h.session.feed(frame(), T0);
        expect(kinds(out)).not.toContain('close');
    });

    it('charges per FRAME, not per record', async () => {
        // Per-record charging would refuse exactly the backlog replay the burst
        // exists to absorb after a GSM outage.
        const cap = new ImeiRateCap({ burst: 1, refillPerSecond: 0, maxTracked: 8 });
        const h = harness({ cap });
        await h.session.feed(imeiPacket(), T0);
        const out = await h.session.feed(
            frame([record(), record(T0 + 1), record(T0 + 2), record(T0 + 3), record(T0 + 4)]),
            T0,
        );
        expect(stores(out)).toHaveLength(1);
        expect(stores(out)[0].positions).toHaveLength(5);
    });

    it('keys the cap on the TRACKER, not the raw IMEI', async () => {
        // The resolved identity is ours; the IMEI is the peer's. Keying on the
        // wire value would let a peer rotate IMEIs to get a fresh bucket each
        // time — though the allowlist already bounds that, two mechanisms
        // disagreeing about the key is how one of them stops working.
        const cap = new ImeiRateCap({ burst: 1, refillPerSecond: 0, maxTracked: 8 });
        const h = harness({ cap });
        await h.session.feed(imeiPacket(), T0);
        await h.session.feed(frame(), T0);
        // Same tracker id, so a second session must find the bucket spent.
        const h2 = harness({ cap });
        await h2.session.feed(imeiPacket(), T0);
        const out = await h2.session.feed(frame(), T0);
        expect(metrics(out)).toContain('rate_capped');
    });
});
