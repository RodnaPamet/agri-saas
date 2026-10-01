/**
 * The farm profile — the one-per-tenant identity block behind the ДНЕВНИК.
 *
 * Documented because a native client was about to be told these fields exist
 * and could not have modelled them: the route was on the undocumented-routes
 * baseline, so `urn`, `sizeHa` and `grainProduced` were reachable over HTTP and
 * described nowhere. That is the state this spec has spent the week removing,
 * and it would have been reintroduced by a message rather than by code.
 *
 * ── the request schema is the ROUTE's own ──
 *
 * `UpdateFarmProfileSchema` is imported from the handler, so the documented
 * body cannot drift from the validated one. It is not re-spelled here.
 *
 * ── this is an ADMIN surface, which is a fact about who can call it ──
 *
 * Both operations require `admin.manage`. A field operator (MECHANISATOR)
 * cannot reach it, and neither can a READER — so a client that shows this
 * screen to everyone will show two thirds of its users a 403. Whether a phone
 * should carry an admin editor at all is a product question; the contract only
 * says who the server will answer.
 *
 * ── three fields are not what a paper-form page would suggest ──
 *
 * `sizeHa` is a NUMBER, not the decimal string a Prisma `Decimal` normally
 * serialises to — see the usecase note on why an area differs from money here.
 * `grainProduced` is an ARRAY and is `[]` rather than null when unset. And
 * `egn` / `eik` / `urn` are encrypted at rest and returned as plaintext, so a
 * client must treat them as sensitive on screen and in logs even though they
 * arrive looking ordinary.
 */
import { z } from '@/lib/openapi/zod';
import { UpdateFarmProfileSchema } from '@/app-layer/schemas/farm-profile.schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

const FarmProfileSchema = z
    .object({
        producerName: z.string().nullable(),
        /** ЕГН — a personal ID. Encrypted at rest, plaintext here. */
        egn: z.string().nullable(),
        /** ЕИК — the company. Encrypted at rest, plaintext here. */
        eik: z.string().nullable(),
        /**
         * УРН — the HOLDING's registration number on the земеделски-стопанин
         * register. Distinct from `eik` (company) and `egn` (person), and the
         * number a subsidy or inspection reference cites. Encrypted at rest.
         */
        urn: z.string().nullable(),
        /** The producer's registered / management address. */
        address: z.string().nullable(),
        municipality: z.string().nullable(),
        settlement: z.string().nullable(),
        agricultureDirectorateCity: z.string().nullable(),
        /**
         * «Място на регистриране» — WHERE THE HOLDING IS. This is the location
         * field: there is no separate one, and one was briefly added and
         * removed as a duplicate of this. It is usually also the produce
         * warehouse, though the warehouse itself («Склад за растителна
         * продукция») is recorded PER PARCEL as `ParcelGeo.produceStore`.
         */
        registrationPlace: z.string().nullable(),
        registrationEkatte: z.string().nullable(),
        odbhCity: z.string().nullable(),
        /**
         * DECLARED hectares, as a NUMBER — not the decimal string a Prisma
         * Decimal usually becomes. The farm's parcels also sum to an area and
         * the two can legitimately DISAGREE: this is what the producer declares
         * on the paper form, and a state form must match the declaration.
         *
         * Null means nobody has filled it in. ZERO means a declaration of zero,
         * which is a different claim — do not collapse them.
         */
        sizeHa: z.number().nullable(),
        /**
         * Declared crops. An EMPTY ARRAY when unset, never null, so a client
         * maps over it without a guard. Free values rather than the canonical
         * commodity vocabulary: a farm may grow something the market does not
         * quote.
         */
        grainProduced: z.array(z.string()),
    })
    .openapi('FarmProfile', {
        description:
            'The one-per-tenant farm identity block printed on the БАБХ ДНЕВНИК. Every field is nullable because the paper form tolerates blanks — an all-null body is the normal answer for a tenant that has not filled it in, not an error. egn/eik/urn are encrypted at rest and returned as plaintext: treat them as sensitive on screen and in logs. sizeHa is a number and grainProduced is an array that is [] rather than null.',
    });

export function registerFarmProfilePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/farm-profile',
        operationId: 'getFarmProfile',
        summary: 'The tenant’s farm profile',
        description:
            'Requires `admin.manage`. An all-null body (with `grainProduced: []`) is the ordinary answer for a tenant that has never filled the profile in — it is not a 404 and not an error.',
        tags: ['Admin'],
        params: TenantParams,
        success: { status: 200, description: 'The profile.', schema: FarmProfileSchema },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/admin/farm-profile',
        operationId: 'updateFarmProfile',
        summary: 'Upsert the tenant’s farm profile',
        description:
            'Requires `admin.manage`. An upsert, so the first write creates the row. ' +
            '\n\nA BLANK STRING CLEARS a field — it is not ignored. Send only what you mean to keep, or read first and send the whole object back. ' +
            '\n\nThe server normalises on write: text is trimmed and sanitised, a negative `sizeHa` is refused (stored as null), and `grainProduced` has blanks dropped and duplicates removed case-insensitively while PRESERVING ORDER. So the response can legitimately differ from what you sent — re-read it from the response rather than keeping the submitted values, or the screen will disagree with the database.',
        tags: ['Admin'],
        params: TenantParams,
        // The handler's own schema, imported — so the claim this comment
        // makes is now true. It said exactly this while the code was
        // `z.object({}).passthrough()`, and the published
        // `UpdateFarmProfileRequest` had ZERO properties as a result.
        body: UpdateFarmProfileSchema.openapi('UpdateFarmProfileRequest', {
            description:
                'ABSENT IS NOT "LEAVE ALONE". Every field is optional, and an omitted field is ' +
                'CLEARED — `{"urn":"123"}` nulls the other twelve and empties `grainProduced`. ' +
                'So READ FIRST AND SEND ALL THIRTEEN FIELDS BACK; a per-field PUT silently wipes ' +
                'the record. A blank string clears a field too. (The only caller today is the web ' +
                'admin page, which GETs the whole profile and PUTs it entire, which is why nothing ' +
                'has hit this — see agri-saas#1176, which must choose between merge semantics and ' +
                'marking these `required`.) ' +
                'There is no ETag or If-Match: concurrent edits are last-write-wins across the ' +
                'whole record, not per field. ' +
                '`sizeHa` is a number, bounded at 1,000,000 and refused if negative — and null is ' +
                'not 0: a farm nobody has measured and a farm of zero hectares are different ' +
                'claims. `grainProduced` is an array of up to 50 strings of at most 120 characters; ' +
                'the server drops blanks and de-duplicates case-insensitively while PRESERVING ' +
                'ORDER, so re-read the response rather than keeping what you sent.',
        }),
        success: { status: 200, description: 'The stored profile, AFTER normalisation.', schema: FarmProfileSchema },
    });
}
