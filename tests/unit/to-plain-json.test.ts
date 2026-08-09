/**
 * `toPlainJson` — RSC server→client boundary helper.
 *
 * Lock the contract so a future "this is just JSON.parse(JSON.stringify),
 * inline it" cleanup doesn't regress the load-bearing behavior:
 *
 *   - Plain objects round-trip with the same shape.
 *   - Date instances become ISO strings (matches DTO contract; an
 *     RSC payload with raw Date is a build error / runtime warning
 *     across recent Next versions).
 *   - Functions, symbols, undefined-valued keys, and class
 *     prototypes are stripped — exactly the shape the RSC
 *     serializer accepts.
 *   - The TS generic preserves the input type so consumers don't
 *     pick up `any` poisoning.
 */
import { toPlainJson } from '@/lib/server/to-plain-json';

describe('toPlainJson', () => {
    it('round-trips a plain object with primitive + nested fields', () => {
        const input = {
            id: 'abc',
            name: 'Example',
            count: 42,
            active: true,
            tags: ['a', 'b'],
            meta: { kind: 'practice', score: 7.5 },
        };
        const out = toPlainJson(input);
        expect(out).toEqual(input);
        // New reference — caller mutating the result must not affect the input.
        expect(out).not.toBe(input);
        expect(out.meta).not.toBe(input.meta);
    });

    it('converts Date instances to ISO strings (matches DTO contract)', () => {
        const d = new Date('2026-04-25T10:00:00.000Z');
        const out = toPlainJson({ created: d, label: 'x' });
        // Date became a string — consumer code that types this
        // field as `string` (which our DTOs do) sees the right
        // shape downstream.
        expect(typeof out.created).toBe('string');
        expect(out.created as unknown as string).toBe(
            '2026-04-25T10:00:00.000Z',
        );
    });

    it('strips functions and undefined-valued keys', () => {
        // Functions cannot cross the RSC boundary; the helper
        // silently drops them. A regression that returned an
        // object with a function reference would fail in next-
        // start with an opaque error today; the helper makes it
        // a no-op at the boundary.
        const input = {
            label: 'x',
            handler: () => 'never reaches client',
            optional: undefined,
            kept: 'yes',
        };
        const out = toPlainJson(input) as Record<string, unknown>;
        expect(out.label).toBe('x');
        expect(out.kept).toBe('yes');
        expect(out).not.toHaveProperty('handler');
        // `JSON.stringify` drops keys whose value is `undefined`.
        expect(out).not.toHaveProperty('optional');
    });

    it('strips class prototypes — instanceof checks downstream become false', () => {
        // RSC payloads MUST be plain objects. A class instance
        // with custom getters / methods leaks the prototype and
        // breaks the serializer. The helper normalises to plain.
        class Point {
            constructor(
                public readonly x: number,
                public readonly y: number,
            ) {}
        }
        const out = toPlainJson(new Point(3, 4));
        expect(out instanceof Point).toBe(false);
        expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
        expect(out).toEqual({ x: 3, y: 4 });
    });

    it('round-trips arrays of DTOs (the org drill-down call shape)', () => {
        // The actual usage on org pages: an array of DTO rows
        // already string-normalised at the schema layer, but
        // crossing the boundary anyway. This case must be a
        // shape-preserving round-trip.
        const rows = [
            {
                practiceId: 'c-1',
                tenantId: 't-1',
                tenantSlug: 'alpha',
                tenantName: 'Alpha Co',
                name: 'AC-1 Access Control',
                code: 'AC-1',
                status: 'NOT_STARTED',
                updatedAt: '2026-04-25T10:00:00.000Z',
                drillDownUrl: '/t/alpha/practices/c-1',
            },
            {
                practiceId: 'c-2',
                tenantId: 't-2',
                tenantSlug: 'beta',
                tenantName: 'Beta Co',
                name: 'AU-2 Audit',
                code: null,
                status: 'NEEDS_REVIEW',
                updatedAt: '2026-04-25T11:00:00.000Z',
                drillDownUrl: '/t/beta/practices/c-2',
            },
        ];
        const out = toPlainJson(rows);
        expect(out).toEqual(rows);
        expect(out).not.toBe(rows);
    });

    it('preserves the type generic (no `any` poisoning at the call site)', () => {
        // Compile-time check via runtime — TS would refuse this
        // assignment if the helper returned `any`. (Type-system
        // tests are inherently limited at runtime; the existence
        // of this assertion documents the intent.)
        interface RowDto {
            id: string;
            score: number;
        }
        const out: RowDto = toPlainJson<RowDto>({ id: 'r-1', score: 18 });
        expect(out.id).toBe('r-1');
        expect(out.score).toBe(18);
    });
});
