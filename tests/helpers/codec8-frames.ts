/**
 * Codec 8 wire fixtures, shared by the two suites that drive the listener.
 *
 * `tests/unit/machines/listener-session.test.ts` drives the decision logic with
 * no socket; `tests/integration/machine-listener-process.test.ts` speaks these
 * same bytes to the real process over TCP. They are here rather than copied
 * because a second frame builder is a second definition of what a VALID frame
 * is — and the negative cases in both files mean "the listener refused this",
 * which is only true if the frame itself is good. Two builders drifting apart
 * would turn a refusal-for-the-wrong-reason into a passing test.
 */
import { crc16Ibm, CODEC_8 } from '@/lib/machines/codec8';

/** A fixed instant, so a stored `recordedAt` is assertable. */
export const T0 = 1_794_312_000_000;

/** A syntactically valid IMEI, used wherever the identity does not matter. */
export const IMEI = '356938035643809';

/** The Teltonika handshake: a 2-byte length, then the IMEI as ASCII. */
export function imeiPacket(imei = IMEI): Buffer {
    const body = Buffer.from(imei, 'latin1');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(body.length, 0);
    return Buffer.concat([head, body]);
}

/**
 * One AVL record: timestamp, priority, lon/lat in 1e-7 degrees, altitude,
 * heading, satellites, speed, then a minimal IO section (one 1-byte element,
 * id 239 = ignition, value 1).
 */
export function record(ms = T0): Buffer {
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

/** A complete AVL data packet: preamble, length, codec, records, CRC. */
export function frame(records: Buffer[] = [record()]): Buffer {
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
