/**
 * The Codec 8 parser is the first thing to touch an attacker-controlled byte
 * on a public port with no TLS and no secret (#2948 §3), so this suite is
 * mostly about what it REFUSES.
 *
 * ## Every negative is a mutation of a frame the parser accepts
 *
 * `buildFrame()` constructs a valid frame and each refusal test mutates one
 * field of it. That ordering is the whole design: a suite of hand-written
 * malformed buffers passes perfectly against a parser that refuses
 * EVERYTHING, which is what P8.1 shipped — three refusal cases green while an
 * `infinite recursion` error meant nothing could be inserted at all. §0 below
 * is the control that makes the rest mean something.
 *
 * ## `incomplete` is not `malformed`, and the distinction is load-bearing
 *
 * TCP is a stream. A frame arriving in two segments must be `incomplete`
 * (wait for more), while a frame claiming 4 GiB must be `malformed` (close
 * the connection) — otherwise a single hostile length parks a socket forever
 * accumulating a buffer that will never complete. Several tests below exist
 * only to pin which side of that line a case falls on.
 */
import {
    parseAvlFrame,
    parseImeiPacket,
    crc16Ibm,
    toFixedDegrees,
    CODEC_8,
    CODEC_8_EXT,
    MAX_DATA_FIELD_BYTES,
} from '@/lib/machines/codec8';

/** Sofia, 2026-11-10T12:00:00Z, as the device would send it. */
const TS_MS = 1794312000000;

interface RecordSpec {
    ms?: number;
    lonRaw?: number;
    latRaw?: number;
    heading?: number;
    sats?: number;
    speed?: number;
    /** 1-byte IO values as [id, value] pairs. */
    io1?: [number, number][];
}

/** One Codec 8 AVL record. */
function buildRecord(s: RecordSpec = {}): Buffer {
    const io1 = s.io1 ?? [[239, 1]];
    const head = Buffer.alloc(24);
    head.writeBigUInt64BE(BigInt(s.ms ?? TS_MS), 0);
    head.writeUInt8(1, 8); // priority
    head.writeInt32BE(s.lonRaw ?? 233219000, 9); // 23.3219
    head.writeInt32BE(s.latRaw ?? 426977000, 13); // 42.6977
    head.writeInt16BE(550, 17); // altitude
    head.writeUInt16BE(s.heading ?? 180, 19);
    head.writeUInt8(s.sats ?? 11, 21);
    head.writeUInt16BE(s.speed ?? 12, 22);

    const io = [Buffer.from([239, io1.length])]; // event id, total count
    io.push(Buffer.from([io1.length]));
    for (const [id, v] of io1) io.push(Buffer.from([id, v]));
    io.push(Buffer.from([0])); // 2-byte group
    io.push(Buffer.from([0])); // 4-byte group
    io.push(Buffer.from([0])); // 8-byte group
    return Buffer.concat([head, ...io]);
}

/** A complete AVL frame: preamble, length, data field, CRC. */
function buildFrame(opts: { codecId?: number; records?: Buffer[]; trailing?: number } = {}): Buffer {
    const codecId = opts.codecId ?? CODEC_8;
    const records = opts.records ?? [buildRecord()];
    const data = Buffer.concat([
        Buffer.from([codecId, records.length]),
        ...records,
        Buffer.from([opts.trailing ?? records.length]),
    ]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(0, 0);
    head.writeUInt32BE(data.length, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc16Ibm(data), 0);
    return Buffer.concat([head, data, crc]);
}

/** Replace one byte, so a mutation is visibly one field and not a new buffer. */
function withByteAt(buf: Buffer, offset: number, value: number): Buffer {
    const out = Buffer.from(buf);
    out.writeUInt8(value, offset);
    return out;
}

/** Recompute the CRC after mutating the data field, so CRC is not the cause. */
function resealed(frame: Buffer): Buffer {
    const dataLen = frame.readUInt32BE(4);
    const data = frame.subarray(8, 8 + dataLen);
    const out = Buffer.from(frame);
    out.writeUInt32BE(crc16Ibm(data), 8 + dataLen);
    return out;
}

describe('§0 the control — the builder produces something the parser ACCEPTS', () => {
    it('parses a well-formed Codec 8 frame', () => {
        // Without this, every refusal below is satisfied by a parser that
        // refuses everything.
        const r = parseAvlFrame(buildFrame());
        expect(r.kind).toBe('frame');
        if (r.kind !== 'frame') return;
        expect(r.codecId).toBe(CODEC_8);
        expect(r.positions).toHaveLength(1);
        expect(r.consumed).toBe(buildFrame().length);
    });

    it('decodes the fields a position actually needs', () => {
        const r = parseAvlFrame(buildFrame());
        if (r.kind !== 'frame') throw new Error(`expected a frame, got ${r.kind}`);
        const p = r.positions[0];
        expect(p.lat).toBe('42.6977000');
        expect(p.lon).toBe('23.3219000');
        expect(p.recordedAt.toISOString()).toBe('2026-11-10T12:00:00.000Z');
        expect(p.satellites).toBe(11);
        expect(p.speedKph).toBe(12);
        expect(p.headingDeg).toBe(180);
        expect(p.ignition).toBe(true);
    });

    it('parses several records in one frame', () => {
        const r = parseAvlFrame(
            buildFrame({ records: [buildRecord(), buildRecord({ ms: TS_MS + 30_000 }), buildRecord({ ms: TS_MS + 60_000 })] }),
        );
        if (r.kind !== 'frame') throw new Error(`expected a frame, got ${r.kind}`);
        expect(r.positions).toHaveLength(3);
        expect(r.positions[2].recordedAt.getTime() - r.positions[0].recordedAt.getTime()).toBe(60_000);
    });
});

describe('§1 incomplete is NOT malformed — a frame may arrive in pieces', () => {
    const full = buildFrame();

    it.each([0, 1, 4, 7, 8, 12, 20, full.length - 1])(
        'the first %i byte(s) read as incomplete, never malformed',
        (n) => {
            // A short read is the normal case on a stream socket. Reporting it
            // as malformed would close the connection of every device whose
            // packet spanned two TCP segments.
            expect(parseAvlFrame(full.subarray(0, n)).kind).toBe('incomplete');
        },
    );

    it('the whole buffer is a frame, so the boundary above is the only difference', () => {
        expect(parseAvlFrame(full).kind).toBe('frame');
    });
});

describe('§2 hostile LENGTHS are malformed, so a socket cannot be parked', () => {
    it('refuses a data length of 0xFFFFFFFF rather than waiting for 4 GiB', () => {
        // The dangerous answer here is `incomplete`: the caller would buffer
        // for ever waiting for a frame that will never arrive, on one wire
        // field. That is why the ceiling is checked BEFORE the bounds check.
        const f = Buffer.from(buildFrame());
        f.writeUInt32BE(0xffffffff, 4);
        const r = parseAvlFrame(f);
        expect(r.kind).toBe('malformed');
        if (r.kind === 'malformed') expect(r.reason).toMatch(/exceeds/);
    });

    it('refuses a length just over the ceiling', () => {
        const f = Buffer.from(buildFrame());
        f.writeUInt32BE(MAX_DATA_FIELD_BYTES + 1, 4);
        expect(parseAvlFrame(f).kind).toBe('malformed');
    });

    it('a length just UNDER the ceiling is still only incomplete — the boundary control', () => {
        // Proves the ceiling rejects on SIZE rather than rejecting everything
        // large, which an off-by-one in the comparison would also satisfy.
        const f = Buffer.from(buildFrame());
        f.writeUInt32BE(MAX_DATA_FIELD_BYTES, 4);
        expect(parseAvlFrame(f).kind).toBe('incomplete');
    });

    it('refuses a zero-length data field', () => {
        const f = Buffer.from(buildFrame());
        f.writeUInt32BE(0, 4);
        expect(parseAvlFrame(f).kind).toBe('malformed');
    });

    it('refuses a non-zero preamble', () => {
        const f = Buffer.from(buildFrame());
        f.writeUInt32BE(1, 0);
        expect(parseAvlFrame(f).kind).toBe('malformed');
    });
});

describe('§3 the IO section is where a count can walk off the end', () => {
    it('refuses a 1-byte IO group claiming 255 elements', () => {
        // One wire byte. Without a per-group bounds check this reads 255 pairs
        // past the end of the data field and into the next record — or past
        // the buffer entirely.
        const rec = buildRecord();
        const mutated = Buffer.from(rec);
        mutated.writeUInt8(255, 26); // the 1-byte group's count
        const r = parseAvlFrame(resealed(buildFrame({ records: [mutated] })));
        expect(r.kind).toBe('malformed');
        if (r.kind === 'malformed') expect(r.reason).toMatch(/IO group|overruns/);
    });

    // Offsets, with one 1-byte IO element present: 24 event id, 25 total
    // count, 26 n1 count, 27-28 the element, then the three group counts.
    it.each([
        ['2-byte', 29],
        ['4-byte', 30],
        ['8-byte', 31],
    ])('refuses a %s IO group claiming 255 elements', (_label, offset) => {
        const mutated = Buffer.from(buildRecord());
        mutated.writeUInt8(255, offset);
        const r = parseAvlFrame(resealed(buildFrame({ records: [mutated] })));
        expect(r.kind).toBe('malformed');
    });

    it('reads ignition as FALSE when the device says 0, not as absent', () => {
        // `false` and `null` mean different things — engine off versus not
        // wired — and collapsing them would claim every uninstrumented machine
        // is switched off.
        const r = parseAvlFrame(buildFrame({ records: [buildRecord({ io1: [[239, 0]] })] }));
        if (r.kind !== 'frame') throw new Error(`expected a frame, got ${r.kind}`);
        expect(r.positions[0].ignition).toBe(false);
    });

    it('reads ignition as NULL when no such input is present', () => {
        const r = parseAvlFrame(buildFrame({ records: [buildRecord({ io1: [[1, 1]] })] }));
        if (r.kind !== 'frame') throw new Error(`expected a frame, got ${r.kind}`);
        expect(r.positions[0].ignition).toBeNull();
    });
});

describe('§4 the frame-level consistency checks', () => {
    it('refuses a CRC mismatch', () => {
        const f = Buffer.from(buildFrame());
        f.writeUInt32BE(0xdeadbeef, f.length - 4);
        const r = parseAvlFrame(f);
        expect(r.kind).toBe('malformed');
        if (r.kind === 'malformed') expect(r.reason).toMatch(/crc/);
    });

    it('refuses a trailing record count that disagrees with the leading one', () => {
        const r = parseAvlFrame(resealed(buildFrame({ trailing: 7 })));
        expect(r.kind).toBe('malformed');
        if (r.kind === 'malformed') expect(r.reason).toMatch(/trailing/);
    });

    it('refuses a record count of 0', () => {
        const data = Buffer.concat([Buffer.from([CODEC_8, 0]), Buffer.from([0])]);
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 4);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc16Ibm(data), 0);
        expect(parseAvlFrame(Buffer.concat([head, data, crc])).kind).toBe('malformed');
    });

    it.each([0x07, 0x09, 0x10, 0x8f, 0xff])('refuses codec id 0x%s', (id) => {
        // An unknown codec whose records happen to decode is the worst
        // available outcome: plausible-looking positions from a protocol
        // nobody checked. Refused on the id, not on whether it parses.
        const r = parseAvlFrame(resealed(buildFrame({ codecId: id as number })));
        expect(r.kind).toBe('malformed');
        if (r.kind === 'malformed') expect(r.reason).toMatch(/codec id/);
    });
});

describe('§5 implausible GPS values are refused, not stored', () => {
    it('refuses a latitude past the poles', () => {
        const r = parseAvlFrame(resealed(buildFrame({ records: [buildRecord({ latRaw: 900_000_001 })] })));
        expect(r.kind).toBe('malformed');
        if (r.kind === 'malformed') expect(r.reason).toMatch(/latitude/);
    });

    it('accepts exactly the pole — the boundary control', () => {
        const r = parseAvlFrame(resealed(buildFrame({ records: [buildRecord({ latRaw: 900_000_000 })] })));
        expect(r.kind).toBe('frame');
    });

    it('refuses a longitude past the antimeridian', () => {
        const r = parseAvlFrame(resealed(buildFrame({ records: [buildRecord({ lonRaw: -1_800_000_001 })] })));
        expect(r.kind).toBe('malformed');
        if (r.kind === 'malformed') expect(r.reason).toMatch(/longitude/);
    });

    it('refuses a heading over 360', () => {
        const r = parseAvlFrame(resealed(buildFrame({ records: [buildRecord({ heading: 361 })] })));
        expect(r.kind).toBe('malformed');
    });

    it('refuses a zero timestamp — a device with a dead clock', () => {
        // `new Date(0)` is 1970 and would land in the database as a real row,
        // dragging every "a day's track" range scan back to the epoch.
        const r = parseAvlFrame(resealed(buildFrame({ records: [buildRecord({ ms: 0 })] })));
        expect(r.kind).toBe('malformed');
        if (r.kind === 'malformed') expect(r.reason).toMatch(/timestamp/);
    });

    it('refuses a timestamp past 2100', () => {
        const r = parseAvlFrame(resealed(buildFrame({ records: [buildRecord({ ms: 4_102_444_800_001 })] })));
        expect(r.kind).toBe('malformed');
    });
});

describe('§6 Codec 8 Extended', () => {
    /** An extended record: 2-byte ids, 2-byte counts, plus a variable group. */
    function buildExtRecord(variable: [number, Buffer][] = []): Buffer {
        const head = Buffer.alloc(24);
        head.writeBigUInt64BE(BigInt(TS_MS), 0);
        head.writeUInt8(1, 8);
        head.writeInt32BE(233219000, 9);
        head.writeInt32BE(426977000, 13);
        head.writeInt16BE(550, 17);
        head.writeUInt16BE(180, 19);
        head.writeUInt8(11, 21);
        head.writeUInt16BE(12, 22);

        const parts: Buffer[] = [];
        const eventId = Buffer.alloc(2);
        eventId.writeUInt16BE(239, 0);
        parts.push(eventId);
        const total = Buffer.alloc(2);
        total.writeUInt16BE(1, 0);
        parts.push(total);
        // one 1-byte value: ignition
        const n1 = Buffer.alloc(2);
        n1.writeUInt16BE(1, 0);
        parts.push(n1);
        const ign = Buffer.alloc(3);
        ign.writeUInt16BE(239, 0);
        ign.writeUInt8(1, 2);
        parts.push(ign);
        for (const _ of [2, 4, 8]) {
            const z = Buffer.alloc(2);
            z.writeUInt16BE(0, 0);
            parts.push(z);
        }
        const nv = Buffer.alloc(2);
        nv.writeUInt16BE(variable.length, 0);
        parts.push(nv);
        for (const [id, payload] of variable) {
            const h = Buffer.alloc(4);
            h.writeUInt16BE(id, 0);
            h.writeUInt16BE(payload.length, 2);
            parts.push(h, payload);
        }
        return Buffer.concat([head, ...parts]);
    }

    it('parses an extended frame, including its variable-length group', () => {
        const r = parseAvlFrame(
            buildFrame({ codecId: CODEC_8_EXT, records: [buildExtRecord([[300, Buffer.from('abcd')]])] }),
        );
        expect(r.kind).toBe('frame');
        if (r.kind !== 'frame') return;
        expect(r.codecId).toBe(CODEC_8_EXT);
        expect(r.positions[0].ignition).toBe(true);
        expect(r.positions[0].lat).toBe('42.6977000');
    });

    it('refuses a variable element whose declared length overruns the frame', () => {
        // The one place in the protocol where a single element can claim the
        // rest of the frame.
        const rec = buildExtRecord([[300, Buffer.from('abcd')]]);
        const mutated = Buffer.from(rec);
        // the variable element's 2-byte length sits at the end: id(2) len(2) payload(4)
        mutated.writeUInt16BE(0xffff, mutated.length - 6);
        const r = parseAvlFrame(resealed(buildFrame({ codecId: CODEC_8_EXT, records: [mutated] })));
        expect(r.kind).toBe('malformed');
        if (r.kind === 'malformed') expect(r.reason).toMatch(/variable IO/);
    });
});

describe('§7 the IMEI handshake', () => {
    function imeiPacket(imei: string, declared?: number): Buffer {
        const body = Buffer.from(imei, 'latin1');
        const head = Buffer.alloc(2);
        head.writeUInt16BE(declared ?? body.length, 0);
        return Buffer.concat([head, body]);
    }

    it('accepts 15 ascii digits', () => {
        const r = parseImeiPacket(imeiPacket('356938035643809'));
        expect(r.kind).toBe('imei');
        if (r.kind === 'imei') {
            expect(r.imei).toBe('356938035643809');
            expect(r.consumed).toBe(17);
        }
    });

    it('reads a truncated handshake as incomplete', () => {
        expect(parseImeiPacket(Buffer.alloc(0)).kind).toBe('incomplete');
        expect(parseImeiPacket(Buffer.from([0x00])).kind).toBe('incomplete');
        expect(parseImeiPacket(imeiPacket('356938035643809').subarray(0, 10)).kind).toBe('incomplete');
    });

    it('refuses a declared length that is not 15', () => {
        expect(parseImeiPacket(imeiPacket('12345', 5)).kind).toBe('malformed');
        expect(parseImeiPacket(imeiPacket('356938035643809', 0xffff).subarray(0, 6)).kind).toBe('malformed');
    });

    it('refuses a non-numeric IMEI, and does not echo the bytes back', () => {
        // An unparsed IMEI is attacker-controlled input; putting it in a
        // message is how a terminal escape or a log-injection newline gets
        // into a log line.
        const r = parseImeiPacket(imeiPacket('35693803564380\n'));
        expect(r.kind).toBe('malformed');
        if (r.kind === 'malformed') {
            expect(r.reason).toBe('imei is not 15 ascii digits');
            expect(r.reason).not.toContain('\n');
        }
    });
});

describe('§8 coordinate formatting is integer arithmetic, not a float', () => {
    it.each([
        [426977000, '42.6977000'],
        [233219000, '23.3219000'],
        [-1_800_000_000, '-180.0000000'],
        [900_000_000, '90.0000000'],
        [1, '0.0000001'],
        [0, '0.0000000'],
        [-1, '-0.0000001'],
        [10_000_000, '1.0000000'],
    ])('%i -> %s', (raw, expected) => {
        expect(toFixedDegrees(raw as number)).toBe(expected);
    });

    it('always renders exactly 7 fractional digits', () => {
        // The column is Decimal(10,7); a short fraction would be a different
        // value after Prisma scales it.
        for (const raw of [0, 1, 10, 1_000_000, 426977000, -1]) {
            expect(toFixedDegrees(raw).split('.')[1]).toHaveLength(7);
        }
    });

    it('never produces a float artefact — the reason this is not `raw / 1e7`', () => {
        // 1234567 / 1e7 is 0.1234567 in decimal and 0.12345670000000000...
        // in binary; the string form has no such step.
        expect(toFixedDegrees(1234567)).toBe('0.1234567');
        expect(toFixedDegrees(426977001)).toBe('42.6977001');
    });
});

describe('§9 CRC-16/IBM', () => {
    it('matches known vectors', () => {
        expect(crc16Ibm(Buffer.from(''))).toBe(0);
        expect(crc16Ibm(Buffer.from('123456789', 'latin1'))).toBe(0xbb3d);
    });

    it('changes when any byte changes — otherwise the CRC test is vacuous', () => {
        const base = Buffer.from([CODEC_8, 1, 2, 3, 4, 5]);
        const seen = new Set<number>();
        for (let i = 0; i < base.length; i++) {
            seen.add(crc16Ibm(withByteAt(base, i, base[i] ^ 0xff)));
        }
        expect(seen.size).toBe(base.length);
        expect(seen.has(crc16Ibm(base))).toBe(false);
    });
});
