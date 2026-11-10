/**
 * A BOUNDED Codec 8 / Codec 8 Extended parser — #2948 §3.
 *
 * ## Why this is the sharp edge of the feature
 *
 * The owner chose a direct listener over a separate ingest VM (#2948 §3,
 * recorded there with the trade legible). Codec 8 over raw TCP has **no TLS
 * and no secret** — the IMEI is the whole identity — and the port faces the
 * public internet on a host that also serves `app.agrent.bg` and two other
 * products' containers. So the first thing to touch an attacker-controlled
 * byte is this function, and it runs in a process whose crash must not be
 * reachable from the wire.
 *
 * ## The invariant: never size anything from an unvalidated number
 *
 * Every length in this protocol arrives IN the frame. The rule here is that a
 * length is checked against the bytes actually remaining **before** it is used
 * to slice, allocate, or bound a loop. There is no `Buffer.alloc(n)` on a
 * wire-supplied `n` anywhere below, and every read goes through `need()`,
 * which refuses rather than throwing a RangeError from Node's accessors.
 *
 * That matters beyond tidiness: `avlCount` is one wire byte (up to 255) and
 * each record's IO section carries four more counts. A loop bounded by those
 * numbers without a buffer check is a denial of service in eight bytes.
 *
 * ## It returns a verdict, it does not throw
 *
 * A malformed frame is an expected input on a public port, not an exception.
 * Throwing would put protocol handling in a `catch` somewhere up the stack,
 * where "the socket said something odd" and "the parser has a bug" become the
 * same observation — and #2948 §3 requires a malformed frame to CLOSE THE
 * CONNECTION rather than throw inside a shared process. So the result is a
 * discriminated union and the caller decides.
 *
 * `incomplete` is deliberately distinct from `malformed`. TCP is a stream: a
 * frame arrives in pieces, and treating a short read as malformed would drop
 * every device whose packet spanned two segments. Only `malformed` closes.
 *
 * ## What it does NOT protect against, stated rather than implied
 *
 * An attacker who learns a real, allowlisted IMEI can forge positions for that
 * machine, and nothing in this file can tell that apart from the real device.
 * Mitigating it needs a per-device secret, which these devices do not offer
 * over Codec 8. The allowlist bounds WHOSE data can be forged, not whether.
 *
 * ## Codec 8 vs 8 Extended
 *
 * Both are accepted because a fleet is rarely uniform and the difference is
 * three field widths, not a different protocol. `0x08` has 1-byte IO ids and
 * 1-byte section counts; `0x8E` has 2-byte ids and 2-byte counts and adds a
 * variable-length section. Anything else is refused by codec id rather than
 * parsed hopefully — an unknown codec whose records happen to decode is the
 * worst available outcome.
 */

/** Teltonika codec ids this parser accepts. */
export const CODEC_8 = 0x08;
export const CODEC_8_EXT = 0x8e;

/**
 * Hard ceiling on one AVL frame's declared data-field length.
 *
 * Not a protocol limit — a resource one. A record is ~40 bytes at minimum and
 * `avlCount` is one byte, so a legitimate 255-record Codec 8 frame is well
 * under 64 KiB even with generous IO sections. Anything claiming more is
 * either a broken device or someone asking us to buffer megabytes per socket,
 * and the listener holds one of these per connection.
 */
export const MAX_DATA_FIELD_BYTES = 65_536;

/** The IMEI handshake is `uint16` length + ASCII digits. */
export const IMEI_LENGTH = 15;

export interface Codec8Position {
    /** Device-recorded instant. UTC; the device sends ms since the epoch. */
    recordedAt: Date;
    priority: number;
    /** WGS84 degrees, as STRINGS — see `toFixedDegrees`. */
    lat: string;
    lon: string;
    altitudeM: number;
    headingDeg: number;
    satellites: number;
    speedKph: number;
    /** `null` when no digital input is wired for it. */
    ignition: boolean | null;
}

export type ImeiResult =
    | { kind: 'imei'; imei: string; consumed: number }
    | { kind: 'incomplete' }
    | { kind: 'malformed'; reason: string };

export type FrameResult =
    | { kind: 'frame'; codecId: number; positions: Codec8Position[]; consumed: number }
    | { kind: 'incomplete' }
    | { kind: 'malformed'; reason: string };

/**
 * A cursor that REFUSES rather than throws.
 *
 * Node's `readUInt32BE` throws `ERR_OUT_OF_RANGE` past the end, which would
 * make every truncated packet an exception. `need()` is checked before every
 * read, so the parser's control flow carries the bounds instead of a try/catch.
 */
class Cursor {
    constructor(
        private readonly buf: Buffer,
        private pos = 0,
    ) {}

    get offset(): number {
        return this.pos;
    }

    get remaining(): number {
        return this.buf.length - this.pos;
    }

    need(n: number): boolean {
        return n >= 0 && this.remaining >= n;
    }

    u8(): number {
        const v = this.buf.readUInt8(this.pos);
        this.pos += 1;
        return v;
    }

    u16(): number {
        const v = this.buf.readUInt16BE(this.pos);
        this.pos += 2;
        return v;
    }

    u32(): number {
        const v = this.buf.readUInt32BE(this.pos);
        this.pos += 4;
        return v;
    }

    i16(): number {
        const v = this.buf.readInt16BE(this.pos);
        this.pos += 2;
        return v;
    }

    i32(): number {
        const v = this.buf.readInt32BE(this.pos);
        this.pos += 4;
        return v;
    }

    u64(): bigint {
        const v = this.buf.readBigUInt64BE(this.pos);
        this.pos += 8;
        return v;
    }

    /** Advance without reading. Caller must have called `need` first. */
    skip(n: number): void {
        this.pos += n;
    }

    slice(n: number): Buffer {
        const v = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return v;
    }
}

/**
 * CRC-16/IBM (also called ARC) over the data field, which is what Teltonika
 * sends in the trailing four bytes — low 16 bits, high 16 always zero.
 *
 * Verifying it is cheap and is the only integrity signal the protocol offers.
 * It is NOT authentication: an attacker computing a valid CRC is trivial, so a
 * passing CRC says "not corrupted in transit", never "from the real device".
 * Keeping those two apart is why this comment exists.
 */
export function crc16Ibm(data: Buffer): number {
    let crc = 0;
    for (const byte of data) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
        }
    }
    return crc & 0xffff;
}

/**
 * Teltonika sends coordinates as `int32` of degrees × 1e7.
 *
 * Rendered as a STRING, not a number, and that is deliberate. The column is
 * `Decimal(10,7)`; handing Prisma a JS float reintroduces the binary-floating-
 * point error the Decimal column exists to avoid, and the worked-parcel
 * derivation compares coordinates. Integer arithmetic to a fixed 7 places has
 * no rounding step at all.
 */
export function toFixedDegrees(raw: number): string {
    const neg = raw < 0;
    const abs = Math.abs(raw);
    const whole = Math.trunc(abs / 1e7);
    const frac = String(abs % 1e7).padStart(7, '0');
    return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Parse the opening IMEI handshake.
 *
 * The device sends `uint16` length then that many ASCII bytes; the server
 * answers one byte, 0x01 to accept and 0x00 to refuse. The length is checked
 * against the buffer before the slice, and the DIGITS are validated — an IMEI
 * is the lookup key for a tenant, so a non-numeric one has nothing to resolve
 * and is refused here rather than reaching a query.
 */
export function parseImeiPacket(buf: Buffer): ImeiResult {
    const c = new Cursor(buf);
    if (!c.need(2)) return { kind: 'incomplete' };
    const len = c.u16();
    // Checked BEFORE the slice: a declared 65535 against 4 real bytes must not
    // produce a 65 KB read, and must not read as "wait for more" forever
    // either, which is why an impossible length is malformed rather than
    // incomplete.
    if (len !== IMEI_LENGTH) {
        return { kind: 'malformed', reason: `imei length ${len}, expected ${IMEI_LENGTH}` };
    }
    if (!c.need(len)) return { kind: 'incomplete' };
    const imei = c.slice(len).toString('latin1');
    if (!/^[0-9]{15}$/.test(imei)) {
        // Not echoed back anywhere: an unparsed IMEI is attacker-controlled
        // bytes, and putting them in a log line is how a terminal escape or a
        // log-injection newline arrives. The LENGTH is safe to report.
        return { kind: 'malformed', reason: 'imei is not 15 ascii digits' };
    }
    return { kind: 'imei', imei, consumed: c.offset };
}

/**
 * Parse one AVL data frame.
 *
 * Layout: 4 zero bytes, `uint32` data-field length, then the data field
 * (codec id, record count, records…, repeated record count) and a `uint32`
 * CRC over the data field only.
 */
export function parseAvlFrame(buf: Buffer): FrameResult {
    const c = new Cursor(buf);

    // 4-byte preamble + 4-byte length before anything can be sized.
    if (!c.need(8)) return { kind: 'incomplete' };
    const preamble = c.u32();
    if (preamble !== 0) {
        return { kind: 'malformed', reason: `preamble ${preamble}, expected 0` };
    }
    const dataLen = c.u32();
    if (dataLen === 0) {
        return { kind: 'malformed', reason: 'data field length 0' };
    }
    // The ceiling is checked BEFORE `need`, so a hostile 0xFFFFFFFF is refused
    // outright instead of parking the connection in `incomplete` while the
    // caller accumulates 4 GiB waiting for a frame that will never arrive.
    if (dataLen > MAX_DATA_FIELD_BYTES) {
        return { kind: 'malformed', reason: `data field length ${dataLen} exceeds ${MAX_DATA_FIELD_BYTES}` };
    }
    if (!c.need(dataLen + 4)) return { kind: 'incomplete' };

    const data = c.slice(dataLen);
    const crcDeclared = c.u32();
    const crcActual = crc16Ibm(data);
    if (crcDeclared !== crcActual) {
        return {
            kind: 'malformed',
            reason: `crc mismatch: declared 0x${crcDeclared.toString(16)}, computed 0x${crcActual.toString(16)}`,
        };
    }

    // Everything below reads from `data`, whose bounds are now known — so a
    // count inside it can still overrun ITS end, and every loop re-checks.
    const d = new Cursor(data);
    if (!d.need(2)) return { kind: 'malformed', reason: 'data field shorter than its header' };
    const codecId = d.u8();
    if (codecId !== CODEC_8 && codecId !== CODEC_8_EXT) {
        return { kind: 'malformed', reason: `unsupported codec id 0x${codecId.toString(16)}` };
    }
    const extended = codecId === CODEC_8_EXT;
    const avlCount = d.u8();
    if (avlCount === 0) {
        return { kind: 'malformed', reason: 'record count 0' };
    }

    const positions: Codec8Position[] = [];
    for (let i = 0; i < avlCount; i++) {
        const rec = parseRecord(d, extended);
        if ('reason' in rec) {
            return { kind: 'malformed', reason: `record ${i}: ${rec.reason}` };
        }
        positions.push(rec.position);
    }

    // The trailing count must equal the leading one. It is the protocol's own
    // consistency check and the cheapest way to catch a record whose IO section
    // we walked wrongly: a mis-walk leaves the cursor somewhere else entirely,
    // so this byte is almost never the right value by accident.
    if (!d.need(1)) return { kind: 'malformed', reason: 'missing trailing record count' };
    const trailing = d.u8();
    if (trailing !== avlCount) {
        return { kind: 'malformed', reason: `trailing count ${trailing} != leading ${avlCount}` };
    }

    return { kind: 'frame', codecId, positions, consumed: c.offset };
}

/** The digital-input id that carries ignition on Teltonika FM devices. */
const IO_IGNITION = 239;

function parseRecord(
    d: Cursor,
    extended: boolean,
): { position: Codec8Position } | { reason: string } {
    // timestamp(8) priority(1) lon(4) lat(4) alt(2) angle(2) sats(1) speed(2)
    if (!d.need(24)) return { reason: 'truncated before the GPS element' };
    const ms = d.u64();
    // A device with a dead clock sends 0 or something absurd. Bounded here
    // because `new Date(Number(huge))` yields an Invalid Date that then
    // propagates as `null` into a timestamp column, and a row whose time is
    // wrong is worse than a row refused.
    if (ms === 0n || ms > 4_102_444_800_000n) {
        return { reason: `implausible timestamp ${ms}` };
    }
    const priority = d.u8();
    const lonRaw = d.i32();
    const latRaw = d.i32();
    const altitudeM = d.i16();
    const headingDeg = d.u16();
    const satellites = d.u8();
    const speedKph = d.u16();

    // Degrees are validated as INTEGERS before formatting: ±90e7 / ±180e7.
    // A device with no fix sends zeroes or garbage, and a 0,0 position in the
    // Gulf of Guinea plotted on a Bulgarian farm is a visible defect, whereas
    // an out-of-range latitude is silently clamped by most map libraries.
    if (latRaw < -900_000_000 || latRaw > 900_000_000) {
        return { reason: `latitude out of range: ${latRaw}` };
    }
    if (lonRaw < -1_800_000_000 || lonRaw > 1_800_000_000) {
        return { reason: `longitude out of range: ${lonRaw}` };
    }
    if (headingDeg > 360) return { reason: `heading out of range: ${headingDeg}` };

    // NOT `typeof x === 'object'`: `typeof null === 'object'` in JavaScript,
    // so an ABSENT ignition (a device with no digital input wired — the
    // common case) was returned as if it were the error object, and the
    // caller then threw `TypeError: Cannot use 'in' operator ... in null`.
    // A WELL-FORMED frame crashing the parser is precisely what §3 forbids,
    // and a union with `null` in it cannot be discriminated by `typeof`.
    const io = walkIoElement(d, extended);
    if (!io.ok) return { reason: io.reason };
    const ignition = io.ignition;

    return {
        position: {
            recordedAt: new Date(Number(ms)),
            priority,
            lat: toFixedDegrees(latRaw),
            lon: toFixedDegrees(lonRaw),
            altitudeM,
            headingDeg,
            satellites,
            speedKph,
            ignition,
        },
    };
}

/**
 * Walk the IO element, returning ignition if present.
 *
 * This is where a bounded parser earns its name. The section declares four
 * counts (how many 1-, 2-, 4- and 8-byte values follow) and in Codec 8
 * Extended a fifth variable-length group. Each count is one or two WIRE bytes,
 * so a loop bounded by them without re-checking the buffer walks off the end —
 * and because records are parsed in sequence, one bad count corrupts every
 * record after it rather than just its own.
 *
 * So every iteration calls `need` before reading, and the id width and count
 * width come from the codec id rather than being assumed.
 */
type IoResult = { ok: true; ignition: boolean | null } | { ok: false; reason: string };

function walkIoElement(d: Cursor, extended: boolean): IoResult {
    const idWidth = extended ? 2 : 1;
    const countWidth = extended ? 2 : 1;
    const readCount = (): number => (countWidth === 2 ? d.u16() : d.u8());

    // event id + total count
    if (!d.need(idWidth + countWidth)) return { ok: false, reason: 'truncated IO header' };
    d.skip(idWidth); // event io id — which property triggered the record
    readCount(); // declared total; deliberately NOT trusted as a loop bound

    let ignition: boolean | null = null;

    for (const valueWidth of [1, 2, 4, 8]) {
        if (!d.need(countWidth)) return { ok: false, reason: `truncated before the ${valueWidth}-byte IO count` };
        const n = readCount();
        // A SHORT-CIRCUIT, not the bound — and measured as such. A mutation
        // deleting this block left all 55 tests green, because the per-element
        // check below catches every case on its own: `n` is at most 65535 and
        // `idWidth + valueWidth` at most 10, so the product cannot overflow
        // into something plausible and there is no case the element check
        // misses. It stays because it refuses a hostile 65535 in one
        // comparison instead of 65535 of them, which is worth having on a
        // public port — but do not read it as the safety property. The loop
        // below is.
        if (!d.need(n * (idWidth + valueWidth))) {
            return { ok: false, reason: `IO group of ${valueWidth}-byte values declares ${n}, buffer has ${d.remaining}` };
        }
        for (let i = 0; i < n; i++) {
            if (!d.need(idWidth + valueWidth)) {
                return { ok: false, reason: `IO element ${i} of the ${valueWidth}-byte group overruns` };
            }
            const id = idWidth === 2 ? d.u16() : d.u8();
            if (valueWidth === 1) {
                const v = d.u8();
                if (id === IO_IGNITION) ignition = v === 1;
            } else {
                d.skip(valueWidth);
            }
        }
    }

    if (extended) {
        // Codec 8 Extended's variable-length group: count, then per element an
        // id, a 2-byte length, and that many bytes. The LENGTH is the hostile
        // field here — it is the only place in the protocol where one element
        // can claim the rest of the frame.
        if (!d.need(countWidth)) return { ok: false, reason: 'truncated before the variable IO count' };
        const n = readCount();
        for (let i = 0; i < n; i++) {
            if (!d.need(idWidth + 2)) return { ok: false, reason: `variable IO element ${i} header overruns` };
            d.skip(idWidth);
            const len = d.u16();
            if (!d.need(len)) {
                return { ok: false, reason: `variable IO element ${i} declares ${len} bytes, buffer has ${d.remaining}` };
            }
            d.skip(len);
        }
    }

    return { ok: true, ignition };
}
