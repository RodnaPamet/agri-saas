/**
 * `?limit=abc` must be a 400, not a 500.
 *
 * The routes read the param as `limitRaw ? Number(limitRaw) : undefined`, and
 * `Number('abc')` is NaN. NaN then survives every step that looks like it
 * would stop it — `??` catches null and undefined but not NaN, and Math.min /
 * Math.max propagate it — so `take: NaN` reached Prisma and became a 500 on a
 * plain list read.
 *
 * These are executing tests. The parser is a pure predicate over a string, so
 * there is nothing to assert ABOUT it that cannot simply be run.
 */
import { parseLimitParam } from '@/lib/validation/query-params';

describe('parseLimitParam', () => {
    it('absent is undefined — the caller supplies its own default', () => {
        expect(parseLimitParam(null)).toBeUndefined();
    });

    it.each([
        ['a plain integer', '50', 50],
        ['one', '1', 1],
        ['surrounding whitespace', '  7  ', 7],
        ['leading zeros', '007', 7],
    ])('accepts %s', (_label, raw, expected) => {
        expect(parseLimitParam(raw)).toBe(expected);
    });

    it.each([
        ['letters', 'abc'],
        ['a trailing suffix parseInt would accept', '12abc'],
        ['hex Number() would accept', '0x10'],
        ['exponential', '1e3'],
        ['a decimal', '1.5'],
        ['a negative', '-1'],
        ['zero', '0'],
        ['empty', ''],
        ['whitespace only', '   '],
        ['a plus sign', '+5'],
        ['beyond safe integer', '9007199254740993'],
    ])('REJECTS %s with a 400', (_label, raw) => {
        // Rejecting rather than defaulting: `limit=abc` is a malformed
        // request, not a preference, and a silent default hides the client
        // bug until someone wonders why their page size is wrong.
        expect(() => parseLimitParam(raw)).toThrow();
        try {
            parseLimitParam(raw);
        } catch (e) {
            expect((e as { status?: number }).status ?? 400).toBe(400);
        }
    });

    it('the message names the param and echoes what arrived', () => {
        try {
            parseLimitParam('abc', { label: 'perPage' });
            throw new Error('expected a rejection');
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain('perPage');
            expect(msg).toContain('"abc"');
        }
    });

    it('CLAMPS a too-large value instead of rejecting it', () => {
        // A caller asking for more than the ceiling made a readable request
        // the server declines to serve in full — not the same as one it
        // cannot parse.
        expect(parseLimitParam('1000', { max: 100 })).toBe(100);
        expect(parseLimitParam('50', { max: 100 })).toBe(50);
    });

    it('without `max`, it does not clamp — the usecase owns the ceiling', () => {
        expect(parseLimitParam('100000')).toBe(100000);
    });

    it('control: the OLD expression really does produce NaN', () => {
        // Pins the mechanism this exists for, so the reason survives even if
        // the defective shape is long gone from the routes.
        const limitRaw = 'abc';
        const old = limitRaw ? Number(limitRaw) : undefined;
        expect(Number.isNaN(old)).toBe(true);
        expect(old ?? 100).toBeNaN(); // `??` does not catch NaN
        expect(Math.min(Math.max(old as number, 1), 100)).toBeNaN();
    });
});
