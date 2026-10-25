/**
 * The calendar day a record happened, parsed strictly.
 *
 * Extracted from `diary-treatment.ts` for #2316, where it was
 * `parseTreatmentDay`: a pruning or a harvest is dated the same way a treatment
 * is, and the timezone correction in here is not something to reimplement.
 *
 * ## The error codes keep their `TREATMENT_` prefix, deliberately
 *
 * `TREATMENT_DATE_INVALID` and `TREATMENT_DATE_IN_FUTURE` are what the phone
 * already handles. The prefix is historical — these describe a problem with the
 * DATE, not with a treatment — and renaming them would make the client handle
 * two codes for one condition, or handle a new one and lose the old. The
 * narrower cost is a prefix that reads oddly on an activity; the wider one is a
 * client that mishandles a refusal.
 */
import { codedBadRequest } from '@/lib/errors/types';

/**
 * Midnight UTC on the given calendar day.
 *
 * Parsed strictly rather than handed to `new Date(string)`: that accepts
 * plenty of things that are not a day (`'2026-3'`, `'tomorrow'` in some
 * runtimes) and silently resolves others against the server's zone, which
 * would move a treatment across a date boundary depending on where the server
 * runs.
 */
export function parseRecordedDay(value: string): { day: Date; key: string } {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!m) {
        throw codedBadRequest(
            'TREATMENT_DATE_INVALID',
            'The treatment date must be a calendar day in the form YYYY-MM-DD.',
            { field: 'occurredOn' },
        );
    }
    const [, y, mo, d] = m;
    const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    // Round-trip check: `Date.UTC(2026, 1, 31)` silently becomes 2 March, so
    // a nonsense day would otherwise be accepted and recorded as a real one.
    if (
        day.getUTCFullYear() !== Number(y) ||
        day.getUTCMonth() !== Number(mo) - 1 ||
        day.getUTCDate() !== Number(d)
    ) {
        throw codedBadRequest(
            'TREATMENT_DATE_INVALID',
            'That calendar day does not exist.',
            { field: 'occurredOn' },
        );
    }
    // The key is the day as the register writes it, rebuilt from the matched
    // groups rather than re-derived from `day` — `day` is a UTC instant and
    // reading a calendar day back out of it is the mistake this function
    // exists to prevent one level down.
    return { day, key: `${y}-${mo}-${d}` };
}
