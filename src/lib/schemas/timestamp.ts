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

/**
 * A timestamp a MACHINE sends: a real RFC 3339 instant, offset permitted.
 *
 * ## Why this is stricter than `requestTimestamp()`
 *
 * `requestTimestamp()` only asks for parseability, because the fields it
 * guards sit behind a date picker and a human — rejecting `2026-10-08` there
 * would break a working UI, so its docblock records the ambiguity as a
 * deliberate survival.
 *
 * `POST /api/agro/data-streams/{streamId}/ingest` has no human and no picker.
 * It is token-gated and device-facing, which is the same carve-out
 * `agri-event.schemas.ts` already states for the other key-gated API:
 *
 * > this is a machine-facing key-gated API with no date picker in front of it,
 * > so an unparseable date should fail at the boundary, not persist as an
 * > Invalid Date
 *
 * Two shapes `requestTimestamp()` tolerates are real bugs for a device feed:
 *
 *   - `'2026-10-08 14:00:00'` — no `T`, no offset, so `new Date` reads it in
 *     the SERVER's timezone. The same payload stores a different instant
 *     depending on where the server runs. For a sensor feed, where the whole
 *     value of a reading is *when* it was taken, that is silent corruption.
 *   - `'2026-10-08'` — becomes midnight UTC, i.e. a reading attributed to an
 *     instant nobody measured.
 *
 * ## `offset: true` is not a loosening, it is what the format MEANS
 *
 * Zod's bare `.datetime()` refuses an offset and accepts only `Z`. OpenAPI's
 * `format: date-time` is RFC 3339, which permits `+03:00`. So bare
 * `.datetime()` publishes a contract WIDER than it enforces — the response
 * schema at `agro.paths.ts:216` does exactly that, harmlessly, because
 * response schemas are registration-only and never `.parse()`d.
 *
 * `{ offset: true }` is the precise Zod expression of the rendered format, so
 * the published `format: date-time` and the executing check describe the same
 * set of strings. A device on Bulgarian local time may send `+03:00` and be
 * believed.
 *
 * ## The parsed type stays `string`, and that is load-bearing
 *
 * `IngestReading.recordedAt` is declared `string`, and `data-stream.ts:241`
 * does `new Date(r.recordedAt)`. A `z.coerce.date()` here would change the
 * parsed type and break that boundary — which is not a prediction: it is what
 * #1540 did to six route handlers before CI caught it. `.datetime()` is a
 * check, not a transform, so nothing downstream moves.
 *
 * ## Safe to tighten because there is nothing to break — measured
 *
 * The route's first act is `if (env.AGRO_DATASTREAMS_ENABLED !== '1') → 503`.
 * On production that key is ABSENT from `/opt/agrent/.env` and empty in the
 * running container, and `DataStream` / `DataStreamReading` hold 0 and 0 rows
 * (counted as `postgres` with `rolsuper=t`, because `app_user` reads zero
 * under RLS and exits 0). Every caller gets a 503 today and no reading has
 * ever been ingested, so no device encoding exists to break.
 *
 * Exported for the spec as well as the route: `agro.paths.ts` imports this
 * same function, so the published `IngestReadings` and the executing schema
 * cannot disagree about this field. That sharing is the point — two
 * hand-written declarations of one request body is #1555.
 */
export function instantTimestamp() {
    return z.string().datetime({ offset: true });
}
