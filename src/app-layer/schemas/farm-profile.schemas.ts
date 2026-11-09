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
 * ── Absent IS "leave alone", since #1181 ──
 *
 * Every field below is `.optional()`, and an ABSENT field is LEFT UNCHANGED:
 * only an explicit `null` clears one, and a blank string clears one too. The
 * discriminator is `Object.hasOwn` in `upsertFarmProfile` — not `!= null`,
 * which cannot separate "said nothing" from "said null". An empty `{}` body
 * writes nothing at all, not even the optimistic lock's version bump (#1184),
 * though the precondition is still checked so a caller holding a stale token
 * is told.
 *
 * This docblock described the OPPOSITE until 2026-11-09, and the history is
 * why the paragraph is still here. Every field mapped through a normaliser
 * returning `null` for `undefined`, so `{ "urn": "123" }` nulled the other
 * twelve and emptied `grainProduced` — a partial body silently wiping the
 * record (#1176). It was unreachable in practice because the only caller was
 * the web page, which GETs the whole profile and PUTs all thirteen fields.
 *
 * The stale text ended "a client MUST read-modify-write, and the schema
 * description below says so", and **neither half was true any more**: the
 * semantics changed under it, and there is no description below — the
 * MERGE SEMANTICS text went to `farm-profile.paths.ts` with #1178, which is
 * the file a generated client reads. It named #1176 as its tracker, and
 * #1176 closed COMPLETED six weeks before, so the pointer read as live work
 * while being a record of finished work.
 */
import { z } from 'zod';

/** The thirteen fields, in the order the БАБХ form lists them. */
export const UpdateFarmProfileSchema = z
    .object({
        producerName: z.string().max(300).nullable().optional(),
        /**
         * Accepted and ALWAYS REFUSED when it carries a value (#2257).
         *
         * There is no `egn` column — owner ruling 2026-10-24 dropped it, and
         * the response schema carries no such field. This property survives
         * for exactly the reason given for `eik` below: `.strip()` at the
         * bottom of this object would make zod discard an `egn` the caller
         * sent without a word, and a client that believes it stored a national
         * identity number would be told it succeeded.
         *
         * Refused CONDITIONALLY — only a non-null value — because the iOS
         * editor PUTs every field on every save, so it mentions `egn` whether
         * or not anyone typed one. #1352 records that an unconditional refusal
         * on `eik` 400'd every farm-profile save from the owner's phone;
         * agrent-ios confirmed on 2026-10-24 that builds ≤13.1 still echo a
         * stored `egn` back, which the migration has made null.
         */
        egn: z.string().max(20).nullable().optional(),
        /**
         * Present in the contract and REJECTED at the usecase (#1352).
         *
         * It is written only by the staff verification path (P3.9), from the
         * number a reviewer found in the Търговски регистър — never
         * self-asserted. But it stays in this schema for two reasons:
         *
         * 1. Removing a published property is a breaking change. There IS a
         *    waiver now — `tests/contracts/acknowledged-breaking-changes.ts`,
         *    which did not exist when this note was written and takes an
         *    owner-approved entry per break — so this reason no longer
         *    decides it on its own. A client built against the old contract
         *    is still a real client.
         * 2. And this is what actually decides it: `.strip()` would DROP an
         *    `eik` key silently, which looks to a client exactly like a
         *    successful write. An explicit refusal tells them; silence lets
         *    them believe they set a regulator-facing number that was
         *    discarded.
         *
         * So the property is accepted syntactically and refused with a coded
         * 400 in `upsertFarmProfile`.
         */
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
