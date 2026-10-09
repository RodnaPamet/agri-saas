import { z } from 'zod';

/**
 * A timestamp a client SENDS: the same string as before, refused when it is
 * not a parseable date.
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
 * ## A refinement, NOT a transform, and CI taught me the difference
 *
 * The first version of this was `z.string().pipe(z.coerce.date())`, which
 * parses to a `Date`. That is a nicer value and it broke the build: the
 * usecase input types still declare `dueAt?: string | null` and
 * `occurredAt?: string`, so six route handlers stopped compiling at the
 * route-to-usecase boundary. Reading the CONSUMERS had not shown it —
 * `new Date(aDate)` is valid TypeScript, so every call site I checked looked
 * fine; it was the interface DECLARATIONS that disagreed.
 *
 * A refinement keeps the parsed type `string`, so nothing downstream moves and
 * the existing `new Date(...)` calls stay load-bearing rather than becoming
 * redundant. It buys the whole of what this is for — the boundary rejection —
 * for none of the propagation. Converting these fields to real `Date` values
 * is a worthwhile separate change, and it is a change to six usecase
 * signatures, not to a schema.
 *
 * ## Measured, because none of this shows up by reading
 *
 *     input                        before      now
 *     '2026-10-08T14:00:00Z'       accepted    accepted
 *     '2026-10-08'                 accepted    accepted
 *     '2026-10-08T14:00:00+03:00'  accepted    accepted
 *     'not-a-date' / ''            accepted    REJECTED
 *     0 / 1760000000000            REJECTED    REJECTED
 *
 * The last row is why this is a refinement on `z.string()` rather than
 * `z.coerce.date()`: bare coercion ACCEPTS a number as epoch milliseconds,
 * which `z.string()` rejected — a widening of the contract, in a change whose
 * purpose is to tighten it.
 *
 * `null` composes safely: `.nullable()` short-circuits before the refinement
 * runs, so a null never reaches `new Date(null)` — which is the epoch, not an
 * error. Verified rather than assumed.
 *
 * ## What it deliberately does NOT fix
 *
 * `'2026-10-08 14:00:00'` — no `T`, no offset — is parsed by the consumer in
 * the SERVER's timezone, so the same payload stores a different instant
 * depending on where the server runs (this box and the production VM are both
 * `Europe/Sofia`). That is a real correctness bug and it survives untouched,
 * because rejecting the form is a contract decision: agrent-ios confirmed it
 * emits that shape nowhere, but the web wizard has not been measured.
 *
 * A date-only value likewise still means midnight UTC downstream. Both are
 * tracked on #1443, and neither is made worse here.
 *
 * It also declares NO format in the spec. `format: date-time` would publish a
 * contract this does not keep — the exact defect #1539 reports one endpoint
 * over — so the documentation half of #1391's timestamp item stays open and
 * still needs the behaviour decision above.
 */
export function requestTimestamp() {
    return z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), {
        message: 'Expected a parseable date string',
    });
}
