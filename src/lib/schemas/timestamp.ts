import { z } from 'zod';

/**
 * A DAY-typed value a client sends — every parseable date string is
 * accepted, and only an unparseable one is refused.
 *
 * (Worded without the two-character sequence that `no-explicit-any-ratchet`
 * matches: it counts RAW TEXT across `src/`, comments included, so a docblock
 * describing a loose type trips the same cap as a loose type. Measured — the
 * first draft of this sentence pushed the count to 132 against a cap of 131
 * and reddened two CI shards, with nothing in the diff that was actually a
 * loose type.)
 *
 * ## Its seven original call sites have moved — read this before reusing it
 *
 * This was written for #1443's seven request-side timestamps, on the reasoning
 * preserved below. Those seven now use `instantTimestamp()`: the owner's
 * ruling on 2026-10-10 was to convert the three web handlers that posted a
 * bare `YYYY-MM-DD` and declare `format: date-time` across all seven, rather
 * than publish a looser format or none.
 *
 * It is retained — deliberately, with no call sites for the moment — because
 * it is the correct validator for the **day-typed** fields, which are a real
 * and separate category: `incurredOn`, `from`/`to`, `startDate`/`endDate`,
 * `paidAt`. agrent-ios sends those as days on purpose ("days in the books
 * rather than instants"), and `calendar.schemas.ts` says so in its own error
 * message. `instantTimestamp()` would refuse them.
 *
 * 24 such fields are still unvalidated, and one of them silently records
 * TODAY rather than failing (`lease-payment.ts:42`). That is #1558, and this
 * function is what it should apply. If #1558 is closed some other way, delete
 * this rather than leave it.
 *
 * ## What it was written for (unchanged, and still the argument)
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
 * `Europe/Sofia`). This function still ACCEPTS that, and a date-only value
 * likewise still means midnight UTC downstream.
 *
 * Both are correct for a day field and wrong for an instant, which is the
 * whole reason there are two functions in this file. If a field cannot
 * tolerate either shape, it wants `instantTimestamp()`, not a stricter version
 * of this.
 *
 * The web client was unmeasured when that was first written; it is measured
 * now (#1443, 2026-10-10). It sent the space-separated form NOWHERE, and
 * date-only on two fields only — both since converted at the client.
 *
 * It declares NO format in the spec, and must not be made to. `format:
 * date-time` on a check this loose publishes a contract it does not keep —
 * which is exactly the defect #1539 turned out to be, one endpoint over. A day
 * field wanting a declared format wants `format: date`, which is a different
 * decision and belongs on #1558.
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
 * `requestTimestamp()` only asks for parseability. It was written for #1443's
 * seven fields on the reasoning that they sit behind a date picker, so
 * rejecting `2026-10-08` would break a working UI.
 *
 * That reasoning was correct about the UI and wrong about the fix. Measured,
 * the web client sent date-only on exactly **two** of the seven, and only
 * because three submit handlers posted the picker's `toYMD()` state raw while
 * every other handler called `.toISOString()` first. It was a missing
 * conversion in three places, not a day-granularity contract — so the owner's
 * ruling on 2026-10-10 was to fix the three handlers (`ymdToInstant`, in
 * `date-picker/date-utils.ts`) and let all seven declare and enforce
 * `format: date-time`. Those seven now call THIS function.
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
 * ## Safe to tighten because there is nothing to break — measured, per group
 *
 * **The ingest route (#1539).** Its first act is
 * `if (env.AGRO_DATASTREAMS_ENABLED !== '1') → 503`. On production that key is
 * ABSENT from `/opt/agrent/.env` and empty in the running container, and
 * `DataStream` / `DataStreamReading` hold 0 and 0 rows. Every caller gets a
 * 503 today and no reading has ever been ingested, so no device encoding
 * exists to break.
 *
 * **The seven task / journal fields (#1443).** Every web send site was traced
 * to the endpoint it posts to: five already sent `.toISOString()`, two sent a
 * bare day and are now converted at the client, and two had no sender at all
 * (`UpdateTaskSchema.dueAt`, and `CreateFieldOperationSchema.dueAt` — both of
 * `POST /locations/{id}/operations`'s callers send no due date, matching what
 * agrent-ios reported). agrent-ios sends `occurredAt` as a UTC instant and
 * sends `dueAt` and `recordedAt` nowhere. And no third party can be sending
 * anything: production holds 6 `TenantApiKey` rows and **0** un-revoked, with
 * 15 tasks of which **0** carry a `dueAt`.
 *
 * Both row counts were taken as `postgres` with `rolsuper=t` printed beside
 * them, because `app_user` returns zero rows for a populated table under RLS
 * and exits 0 — a silent zero is the failure mode this kind of claim rests on.
 *
 * Exported for the spec as well as the route: `agro.paths.ts` imports this
 * same function, so the published `IngestReadings` and the executing schema
 * cannot disagree about this field. That sharing is the point — two
 * hand-written declarations of one request body is #1555.
 */
export function instantTimestamp() {
    return z.string().datetime({ offset: true });
}
