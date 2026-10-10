/**
 * `requestTimestamp()` — the DAY-typed request validator (#1443, #1558).
 *
 * Executing, not structural. The whole argument for the helper is that its
 * behaviour is strictly narrower than a bare `z.string()` — a claim about
 * inputs, provable only by feeding it inputs.
 *
 * ## It no longer guards #1443's seven fields, and these tests still matter
 *
 * Those seven moved to `instantTimestamp()` when the owner ruled that the
 * three web handlers posting a bare `YYYY-MM-DD` should be converted rather
 * than the contract loosened. This function is retained for the **day-typed**
 * fields — `incurredOn`, `from`/`to`, `startDate`/`endDate`, `paidAt` — where
 * a day is what the client means to send and `instantTimestamp()` would be
 * wrong. 24 of those are still unvalidated (#1558) and one records TODAY
 * instead of failing, so this is the validator that issue applies.
 *
 * Which makes the behaviour pinned below the SPECIFICATION for that rollout
 * rather than a record of a past change: accept a day, accept an instant,
 * refuse only what cannot be parsed at all.
 *
 * It is a REFINEMENT and not a transform, and that is the shape CI corrected.
 * The first version piped into `z.coerce.date()`, which parses to a `Date` and
 * broke six route handlers: the usecase input types still declare
 * `dueAt?: string | null`. Reading the consumers had not shown it, because
 * `new Date(aDate)` is valid TypeScript — it was the interface DECLARATIONS
 * that disagreed. So the parsed type staying `string` is a property worth
 * pinning, not an implementation detail.
 */
import { z } from 'zod';

import { requestTimestamp } from '@/lib/schemas/timestamp';

const Nullable = z.object({ at: requestTimestamp().nullable().optional() });
const Required = z.object({ at: requestTimestamp() });

describe('requestTimestamp() (#1443, #1558)', () => {
    it('parses to a STRING, not a Date — the property #1540 was broken by', () => {
        // The regression CI caught when this piped into `z.coerce.date()`:
        // six route handlers stopped compiling at the route-to-usecase
        // boundary, because those usecase signatures take `string`. Still
        // pinned because #1558's day fields have the same shape — their
        // usecases take strings and call `new Date(...)` themselves.
        const { at } = Required.parse({ at: '2026-10-08T14:00:00Z' });
        expect(typeof at).toBe('string');
        expect(at).toBe('2026-10-08T14:00:00Z');
    });

    describe('accepts everything the bare z.string() accepted', () => {
        it.each([
            ['an ISO instant', '2026-10-08T14:00:00Z'],
            ['a date-only value', '2026-10-08'],
            ['an explicit offset', '2026-10-08T14:00:00+03:00'],
            ['a space-separated datetime', '2026-10-08 14:00:00'],
        ])('%s', (_label, input) => {
            expect(Required.safeParse({ at: input }).success).toBe(true);
        });
    });

    describe('rejects what previously became an Invalid Date and reached Prisma', () => {
        it.each(['not-a-date', '', '2026-13-45', 'yesterday', '   '])('%p', (input) => {
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
        // The reason this refines `z.string()` rather than using
        // `z.coerce.date()`. Bare coercion accepts a number as epoch
        // milliseconds, which `z.string()` rejected — a widening, in a change
        // meant to tighten.
        it.each([0, 1760000000000, -1, 1.5])('rejects the number %p', (input) => {
            expect(Required.safeParse({ at: input }).success).toBe(false);
        });

        it('a bare z.coerce.date() WOULD accept those — the control', () => {
            // Pins the claim above against the alternative, so a future
            // "simplification" to `z.coerce.date()` fails here with the reason
            // rather than passing and quietly widening the API.
            const loose = z.object({ at: z.coerce.date() });
            expect(loose.safeParse({ at: 0 }).success).toBe(true);
            expect(loose.safeParse({ at: 1760000000000 }).success).toBe(true);
        });

        it.each([true, {}, [], ['2026-10-08']])('rejects the non-string %p', (input) => {
            expect(Required.safeParse({ at: input }).success).toBe(false);
        });
    });

    describe('composes with nullable / optional without touching null', () => {
        it('null stays null', () => {
            // `new Date(null)` is 1970-01-01, NOT an error, so the order is
            // load-bearing: `.nullable()` has to short-circuit before the
            // refinement runs. Verified rather than assumed.
            expect(new Date(null as unknown as number).toISOString()).toBe(
                '1970-01-01T00:00:00.000Z',
            );
            expect(Nullable.parse({ at: null }).at).toBeNull();
        });

        it('an omitted field stays undefined', () => {
            expect(Nullable.parse({}).at).toBeUndefined();
        });
    });

    describe('what it accepts by DESIGN — not gaps, for a day-typed field', () => {
        // These two were written as "known gaps" while this guarded #1443's
        // instants, where they genuinely were gaps. For the day fields this
        // now serves they are the requirement: a client sending `2026-10-08`
        // for `incurredOn` means that day, and must not get a 400.
        //
        // A field that cannot tolerate either shape wants `instantTimestamp()`.
        // That is the whole division of labour between the two helpers, and
        // these assertions are what stop someone "fixing" this one into it.
        it('a space-separated value is ACCEPTED, and is read as server-local', () => {
            // No `T`, no offset, so the consumer's `new Date` applies the
            // server's zone — this box and the production VM are both
            // Europe/Sofia. Accepted here; refused by `instantTimestamp()`,
            // which is where that ambiguity is a bug rather than a day.
            expect(Required.safeParse({ at: '2026-10-08 14:00:00' }).success).toBe(true);
            if (new Date().getTimezoneOffset() !== 0) {
                expect(new Date('2026-10-08 14:00:00').toISOString()).not.toBe(
                    '2026-10-08T14:00:00.000Z',
                );
            }
        });

        it('a date-only value is ACCEPTED and becomes midnight UTC downstream', () => {
            expect(Required.safeParse({ at: '2026-10-08' }).success).toBe(true);
            expect(new Date('2026-10-08').toISOString()).toBe('2026-10-08T00:00:00.000Z');
        });
    });
});
