/**
 * БАБХ farm-record — the one-per-tenant `FarmProfile` identity block.
 *
 * Here rather than inline in the route because TWO places need the same
 * answer: the handler that parses the body, and
 * `src/lib/openapi/paths/farm-profile.paths.ts`, which documents it. The
 * paths file used to carry `z.object({}).passthrough()` under a comment
 * reading "the handler's own schema, so the documented body cannot drift" —
 * a claim the code did not have. `UpdateFarmProfileRequest` therefore reached
 * the published spec with ZERO properties, so a native client could not read
 * the field list from the contract at all, which is the one thing
 * agrent-ios#110 had resolved to do ("read `FarmProfile` out of the spec when
 * it lands; do not model from this message"). The response half landed; the
 * request half was a stub.
 *
 * A route file cannot export it: `tests/guards/app-router-module-exports.test.ts`
 * blocks extra exports from `route.ts`, because Next rejects them with TS2344
 * only after a build.
 *
 * Most fields are optional free text — the paper form tolerates blanks.
 * `sizeHa` and `grainProduced` are not, and the difference matters: a size
 * that accepts "abc" is bad data on a page whose figures reach a state form,
 * and one grain string cannot express a farm that grows three.
 *
 * ── Absent is not "leave alone" ──
 *
 * Every field below is `.optional()`, and `upsertFarmProfile` maps each one
 * through a normaliser that returns `null` for `undefined`. So an omitted
 * field is CLEARED, not preserved: `{ "urn": "123" }` nulls the other twelve
 * and empties `grainProduced`. The only caller today is the web page, which
 * GETs the whole profile and PUTs all thirteen fields every time, so nothing
 * has hit it. Tracked as #1176, which has to choose between merge semantics
 * and a contract that says `required`. Until then a client MUST
 * read-modify-write, and the schema description below says so — because a
 * caveat the contract does not carry is a caveat a generated client never
 * sees.
 */
import { z } from 'zod';

/** The thirteen fields, in the order the БАБХ form lists them. */
export const UpdateFarmProfileSchema = z
    .object({
        producerName: z.string().max(300).nullable().optional(),
        egn: z.string().max(20).nullable().optional(),
        eik: z.string().max(20).nullable().optional(),
        // УРН — the HOLDING's registration number, distinct from eik/egn.
        urn: z.string().max(40).nullable().optional(),
        address: z.string().max(500).nullable().optional(),
        municipality: z.string().max(200).nullable().optional(),
        settlement: z.string().max(200).nullable().optional(),
        agricultureDirectorateCity: z.string().max(200).nullable().optional(),
        registrationPlace: z.string().max(200).nullable().optional(),
        registrationEkatte: z.string().max(20).nullable().optional(),
        odbhCity: z.string().max(200).nullable().optional(),
        /**
         * Declared hectares, as a NUMBER. Bounded at a million: the largest
         * Bulgarian holdings are five figures, so anything beyond this is a
         * mis-keyed unit rather than a farm, and a 400 is kinder than storing
         * it. Negative is refused for the same reason.
         */
        sizeHa: z.number().nonnegative().max(1_000_000).nullable().optional(),
        /**
         * Declared grains. Capped at 50 entries and 120 characters each — a
         * bound, not a vocabulary: a farm may grow something the market does
         * not quote, and a picker that refused it would be wrong.
         */
        grainProduced: z.array(z.string().max(120)).max(50).nullable().optional(),
    })
    .strip();

export type UpdateFarmProfileInput = z.infer<typeof UpdateFarmProfileSchema>;
