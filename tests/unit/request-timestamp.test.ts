/**
 * `requestTimestamp()` — the request-side timestamp parser (#1443).
 *
 * Executing, not structural. The point of the helper is a behaviour change at
 * the validation boundary, and the whole argument for it is that the behaviour
 * is strictly narrower than what shipped before — which is a claim about
 * inputs, provable only by feeding it inputs.
 *
 * The table below is the measurement that chose the implementation. Every row
 * was run before the helper existed; the `before` column is `z.string()`, which
 * is what these seven fields carried.
 */
import { z } from 'zod';

import { requestTimestamp } from '@/lib/schemas/timestamp';

const Nullable = z.object({ at: requestTimestamp().nullable().optional() });
const Required = z.object({ at: requestTimestamp() });

describe('requestTimestamp() (#1443)', () => {
    describe('accepts everything the bare z.string() + new Date() path accepted', () => {
        it.each([
            ['an ISO instant', '2026-10-08T14:00:00Z', '2026-10-08T14:00:00.000Z'],
            ['a date-only value', '2026-10-08', '2026-10-08T00:00:00.000Z'],
            ['an explicit offset', '2026-10-08T14:00:00+03:00', '2026-10-08T11:00:00.000Z'],
        ])('%s', (_label, input, expected) => {
            const r = Required.safeParse({ at: input });
            expect(r.success).toBe(true);
            expect(r.success && r.data.at.toISOString()).toBe(expected);
        });

        it('a date-only value means midnight UTC — explicit now, accidental before', () => {
            // Not asserted as desirable. Asserted so that changing it is a
            // visible decision rather than a side effect: a farm in Sofia
            // sending `2026-10-08` gets an instant three hours before its own
            // midnight, and #1443 carries that question.
            const { at } = Required.parse({ at: '2026-10-08' });
            expect(at.toISOString()).toBe('2026-10-08T00:00:00.000Z');
        });
    });

    describe('rejects what previously became an Invalid Date and reached Prisma', () => {
        it.each(['not-a-date', '', '2026-13-45', 'yesterday'])('%p', (input) => {
            expect(Required.safeParse({ at: input }).success).toBe(false);
        });

        it('is the difference between a 400 and a 500', () => {
            // `new Date('not-a-date')` is an Invalid Date, and nothing between
            // the schema and Prisma checked for one — so the request failed
            // deep instead of at the boundary.
            expect(new Date('not-a-date').getTime()).toBeNaN();
            expect(Required.safeParse({ at: 'not-a-date' }).success).toBe(false);
        });
    });

    describe('does NOT widen the contract', () => {
        // The reason for `z.string().pipe(...)` rather than `z.coerce.date()`
        // alone. Bare coercion accepts a number as epoch milliseconds, which
        // the previous `z.string()` rejected — a widening, in a change meant to
        // tighten. These two rows are the whole justification for the extra
        // `z.string()`, so losing them silently is what this test prevents.
        it.each([0, 1760000000000, -1, 1.5])('rejects the number %p', (input) => {
            expect(Required.safeParse({ at: input }).success).toBe(false);
        });

        it('a bare z.coerce.date() WOULD accept those — the control', () => {
            // Pins the claim above against the alternative, so a future
            // simplification to `z.coerce.date()` fails here with the reason
            // rather than passing and quietly widening the API.
            const loose = z.object({ at: z.coerce.date() });
            expect(loose.safeParse({ at: 0 }).success).toBe(true);
            expect(loose.safeParse({ at: 1760000000000 }).success).toBe(true);
        });

        it.each([true, {}, [], ['2026-10-08']])('rejects the non-string %p', (input) => {
            expect(Required.safeParse({ at: input }).success).toBe(false);
        });
    });

    describe('composes with nullable / optional without coercing null to the epoch', () => {
        it('null stays null', () => {
            // `new Date(null)` is 1970-01-01, NOT an error, so the order here
            // is load-bearing: `.nullable()` has to short-circuit before the
            // coercion runs. Verified rather than assumed.
            expect(new Date(null as unknown as number).toISOString()).toBe(
                '1970-01-01T00:00:00.000Z',
            );
            expect(Nullable.parse({ at: null }).at).toBeNull();
        });

        it('an omitted field stays undefined', () => {
            expect(Nullable.parse({}).at).toBeUndefined();
        });
    });

    describe('the known gap, pinned so it is not mistaken for fixed', () => {
        it('a space-separated value is still parsed in the SERVER timezone', () => {
            // No `T`, no offset. `new Date` reads this as local time, so the
            // stored instant depends on where the server runs — both this box
            // and the production VM are Europe/Sofia. This change does NOT fix
            // it; rejecting the form is a contract decision tracked on #1443.
            //
            // Asserted against the local-time interpretation rather than a
            // literal so the test is honest on a UTC machine too: what is being
            // pinned is that the value is NOT treated as UTC.
            const { at: parsed } = Required.parse({ at: '2026-10-08 14:00:00' });
            const asLocal = new Date('2026-10-08 14:00:00');
            expect(parsed.toISOString()).toBe(asLocal.toISOString());

            const offset = new Date().getTimezoneOffset();
            if (offset !== 0) {
                expect(parsed.toISOString()).not.toBe('2026-10-08T14:00:00.000Z');
            }
        });
    });
});
