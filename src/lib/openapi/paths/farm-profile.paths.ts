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
import { ApiErrorResponseSchema } from '@/lib/dto/common';

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
        /**
         * Optimistic-lock version. Send it back as `If-Match` on PUT.
         *
         * 0 is a SENTINEL meaning NO ROW EXISTS YET — the column defaults to 1,
         * so a stored row always reports >= 1 and `If-Match: 0` can only ever
         * mean "create". Also returned as a strong `ETag`.
         */
        version: z.number().int(),
    })
    .openapi('FarmProfile', {
        description:
            'The one-per-tenant farm identity block printed on the БАБХ ДНЕВНИК. Every field is nullable because the paper form tolerates blanks — an all-null body is the normal answer for a tenant that has not filled it in, not an error. egn/eik/urn are encrypted at rest and returned as plaintext: treat them as sensitive on screen and in logs. sizeHa is a number and grainProduced is an array that is [] rather than null.',
    });

const FarmProfileStaleDataError = ApiErrorResponseSchema.openapi(
    'FarmProfileStaleDataError',
    {
        description:
            'A 409 `STALE_DATA` from the farm-profile optimistic lock. `error.details` carries ' +
            '`currentVersion` (the stored version) and `expectedVersion` (what you sent). Read them ' +
            'from `error.details`, NOT from the body root — the envelope is nested, and a client that ' +
            'reads the root gets nothing and may then retry with no precondition at all. ' +
            '`currentVersion: 0` means the row does not exist: re-read and retry as a create. ' +
            'It is a conflict to resolve, never a success.',
    },
);

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
        success: {
            status: 200,
            description:
                'The profile. `ETag` carries the version as a strong tag; `version` carries it in the body.',
            schema: FarmProfileSchema,
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/admin/farm-profile',
        operationId: 'updateFarmProfile',
        summary: 'Upsert the tenant’s farm profile',
        description:
            'Requires `admin.manage`. An upsert, so the first write creates the row. ' +
            '\n\nA BLANK STRING CLEARS a field — it is not ignored. An ABSENT field is left ALONE (see the body schema) — true since #1176, and this sentence previously said the opposite. ' +
            '\n\nThe server normalises on write: text is trimmed and sanitised, a negative `sizeHa` is refused (stored as null), and `grainProduced` has blanks dropped and duplicates removed case-insensitively while PRESERVING ORDER. So the response can legitimately differ from what you sent — re-read it from the response rather than keeping the submitted values, or the screen will disagree with the database.',
        tags: ['Admin'],
        params: TenantParams,
        headers: z.object({
            'If-Match': z
                .string()
                .optional()
                .openapi({
                    description:
                        'The `version` you last read, as a BARE INTEGER (`5`) or a STRONG entity-tag ' +
                        '(`"5"`) — both are accepted, and the `ETag` from GET round-trips verbatim. ' +
                        'A WEAK tag (`W/"5"`) is REFUSED with a 400: RFC 7232 forbids weak comparison ' +
                        'for If-Match and it is meaningless for a version lock. Anything else ' +
                        'non-numeric is also a 400 rather than being ignored — unlike the journal and ' +
                        'field-operations routes, which silently fall through to NO precondition on a ' +
                        'header they cannot parse (#1182). ' +
                        'OPTIONAL: omit it and the write is last-write-wins, exactly as before this ' +
                        'lock existed. Omitting it is not an error and never will be without notice — ' +
                        'an installed mobile build sends none. ' +
                        '`If-Match: 0` means "the profile does not exist yet, create it": 0 is a ' +
                        'sentinel no stored row carries, so it fails with a 409 if someone created ' +
                        'the row first.',
                    example: '5',
                }),
        }),
        // The handler's own schema, imported — so the claim this comment
        // makes is now true. It said exactly this while the code was
        // `z.object({}).passthrough()`, and the published
        // `UpdateFarmProfileRequest` had ZERO properties as a result.
        body: UpdateFarmProfileSchema.openapi('UpdateFarmProfileRequest', {
            description:
                'MERGE SEMANTICS (#1176). Every field is optional and an ABSENT field is LEFT ' +
                'UNCHANGED — only an explicit `null` clears one, and a blank string clears one too. ' +
                'So `{"urn":"123"}` sets `urn` and touches nothing else. `grainProduced` follows the ' +
                'same rule: absent leaves the list alone, while `[]` or `null` clears it. ' +
                'This was NOT the behaviour before #1176, when an omitted field was nulled and a ' +
                'per-field PUT wiped the record — if you are reading a cached copy of this spec, ' +
                'check that it carries this sentence. ' +
                'A read-modify-write that sends all thirteen fields is still correct and is what the ' +
                'web admin page does; it is simply no longer required. ' +
                'Concurrency: send `If-Match: <version>` to get a precondition — a stale one is a 409 ' +
                '(see below). WITHOUT it, writes are last-write-wins per FIELD: merge semantics already ' +
                'means two admins editing DIFFERENT fields no longer clobber each other, so the ' +
                'precondition closes the narrower SAME-field race rather than the whole lost-update ' +
                'problem. A body that mentions NO field is a true no-op: nothing is written and the ' +
                'version does NOT move, so an empty PUT cannot manufacture a conflict for anyone else. ' +
                '`sizeHa` is a number, bounded at 1,000,000 and refused if negative — and null is ' +
                'not 0: a farm nobody has measured and a farm of zero hectares are different ' +
                'claims. `grainProduced` holds up to 50 strings of at most 120 characters; the ' +
                'server drops blanks and de-duplicates case-insensitively while PRESERVING ORDER, ' +
                'so re-read the response rather than keeping what you sent.',
        }),
        success: {
            status: 200,
            description:
                'The stored profile, AFTER normalisation. `ETag` carries the NEW version, so a client need not re-GET before its next write.',
            schema: FarmProfileSchema,
        },
        extraResponses: {
            409: {
                description:
                    'Optimistic-lock conflict — the profile moved on, or you sent a version for a row that does not exist. Re-read and retry; do NOT treat it as success.',
                content: { 'application/json': { schema: FarmProfileStaleDataError } },
            },
        },
    });
}
