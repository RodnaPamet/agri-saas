import { z } from 'zod';

/**
 * A timestamp a client SENDS, parsed to a `Date` and rejected if unparseable.
 *
 * ## What this is instead of
 *
 * These fields were bare `z.string()`, and every consumer then did
 * `new Date(value)` — `WorkItemRepository` for `dueAt`, `journal.ts` for
 * `occurredAt`. So an unparseable string became an `Invalid Date` and reached
 * Prisma: a 500 on a request the published contract says should be a 400.
 * Nothing checked it (`grep -nE "isNaN\(.*getTime"` across the three consumer
 * files returns nothing).
 *
 * #1443 proposed `.datetime()`. That is the wrong instrument here: Zod's
 * `.datetime()` requires an ISO instant and rejects BOTH a date-only value and
 * a timezone offset by default, so it would start refusing input these
 * endpoints accept today — and `dueAt` is exactly the field a date picker is
 * most likely to send date-only.
 *
 * ## Why `z.string().pipe(...)` and not `z.coerce.date()` alone
 *
 * Measured, because the difference does not show up by reading:
 *
 *     input                        coerce.date()   this helper
 *     '2026-10-08T14:00:00Z'       accepted        accepted
 *     '2026-10-08'                 accepted        accepted
 *     '2026-10-08T14:00:00+03:00'  accepted        accepted
 *     'not-a-date' / ''            REJECTED        REJECTED
 *     0 / 1760000000000            ACCEPTED        REJECTED
 *
 * `z.coerce.date()` on its own accepts a NUMBER as epoch milliseconds, which
 * `z.string()` rejected — a widening of the contract, in a change whose whole
 * purpose is to tighten it. Leading with `z.string()` keeps the existing
 * string-only shape and adds only the `Invalid Date` rejection, so this is
 * strictly narrower than what shipped before and breaks nothing that worked.
 *
 * `null` is safe to compose with: `.nullable()` short-circuits before the
 * coercion runs, so a null never reaches `new Date(null)` — which would be the
 * epoch, not an error. Verified rather than assumed.
 *
 * ## What it deliberately does NOT fix
 *
 * `'2026-10-08 14:00:00'` — no `T`, no offset — is parsed in the SERVER's
 * timezone, so the same payload stores a different instant depending on where
 * the server runs (this box and the production VM are both `Europe/Sofia`).
 * That is a real correctness bug and it survives this change untouched, because
 * rejecting the form is a contract decision: agrent-ios confirmed it emits that
 * shape nowhere, but the web wizard has not been measured. Tracked on #1443.
 *
 * Likewise a date-only value still means midnight UTC. That was accidental
 * before and is now explicit, which is the whole of what this helper settles.
 */
export function requestTimestamp() {
    return z.string().pipe(z.coerce.date());
}
