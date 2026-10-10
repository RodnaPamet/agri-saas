/**
 * `ymdToInstant()` — the day→instant conversion the request contract needs
 * (#1443).
 *
 * ## Why this exists at all
 *
 * Every date input in the app is one `DatePicker` whose `onChange` stores
 * `toYMD(next)` — a bare `YYYY-MM-DD`. Most submit handlers then called
 * `.toISOString()`; three posted that state raw. So ONE request field received
 * two different shapes depending on which form you happened to use, which is
 * what made `TaskCreateRequest.dueAt` undeclarable in the spec.
 *
 * The owner's ruling was to fix the three handlers rather than loosen the
 * contract, so the seven request timestamps now enforce `format: date-time`
 * via `instantTimestamp()`. This function is the conversion that makes those
 * three handlers compliant, and the property that matters is that it produces
 * something `instantTimestamp()` ACCEPTS — asserted here directly against the
 * real validator rather than against a hand-written expectation of it.
 */
import { instantTimestamp } from '@/lib/schemas/timestamp';
import { ymdToInstant, toYMD } from '@/components/ui/date-picker/date-utils';

const check = instantTimestamp();

describe('ymdToInstant() (#1443)', () => {
    it('turns a picker day into the instant the schema accepts — the whole point', () => {
        // The two halves of the fix, asserted together. If either the
        // conversion or the validator moves, this fails.
        const iso = ymdToInstant('2026-10-08');
        expect(iso).toBe('2026-10-08T00:00:00.000Z');
        expect(check.safeParse(iso).success).toBe(true);
    });

    it('the UNCONVERTED day is refused — so the conversion is load-bearing', () => {
        // The control. Without this, the test above would pass even if
        // `instantTimestamp()` accepted everything.
        expect(check.safeParse('2026-10-08').success).toBe(false);
    });

    it('round-trips with toYMD, which is what the picker stores', () => {
        const day = toYMD(new Date(Date.UTC(2026, 9, 8)));
        expect(day).toBe('2026-10-08');
        expect(ymdToInstant(day)).toBe('2026-10-08T00:00:00.000Z');
    });

    it('midnight UTC is the instant the server ALREADY stored — no value changes', () => {
        // The reason this is a wire-format change and not a data migration.
        // The consumers did `new Date('2026-10-08')`, which is midnight UTC.
        expect(new Date('2026-10-08').toISOString()).toBe(ymdToInstant('2026-10-08'));
    });

    describe('composes from parseYMD rather than new Date — and that is deliberate', () => {
        it('rejects a rolled-over date that new Date() would silently accept', () => {
            // `new Date('2026-02-30')` is March 2nd, not an error. Sending that
            // as an instant would store a day the user never picked, with a
            // 200. `parseYMD` refuses it, so the handler sends nothing instead.
            expect(new Date('2026-02-30').getUTCMonth()).toBe(2); // March
            expect(ymdToInstant('2026-02-30')).toBeNull();
        });

        it.each(['', '   ', 'abcd', '2026-13-01', '08/10/2026', '2026-10'])(
            'returns null for %p rather than an Invalid Date',
            (input) => {
                expect(ymdToInstant(input)).toBeNull();
            },
        );

        it.each([null, undefined])('passes %p straight through as null', (input) => {
            expect(ymdToInstant(input)).toBeNull();
        });
    });

    it('accepts an ISO instant already, so a converted handler is idempotent', () => {
        // `parseYMD` truncates an ISO-like prefix to its date portion. A
        // handler that gets an instant rather than a day still produces a
        // valid instant — it just loses the time, which for a day-granular
        // picker is the existing behaviour.
        const out = ymdToInstant('2026-10-08T13:45:00Z');
        expect(out).toBe('2026-10-08T00:00:00.000Z');
        expect(check.safeParse(out).success).toBe(true);
    });
});
