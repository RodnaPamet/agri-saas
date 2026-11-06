/**
 * `/api/public/farms` — the public farm directory (P6.8, #1817).
 *
 * Its own module rather than appended to `public-registry.paths.ts`: that one
 * documents the ЕИК registry lookups, which answer "is this company real?"
 * against an external source. This answers "which farms have published a
 * page?" from our own projection. Filing a directory search under a registry
 * check would be the kind of misplacement nobody finds later.
 *
 * The query schema is IMPORTED from `@/app-layer/schemas/public-farms.schemas`,
 * not redeclared — `request-body-declared-once` caps a second declaration at
 * zero.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { PublicFarmSearchQuerySchema } from '@/app-layer/schemas/public-farms.schemas';
import { NO_AUTH, op } from './helpers';

const FarmSearchHitSchema = z
    .object({
        handle: z.string().openapi({
            description: 'The farm’s public address. Its page is at `/f/{handle}`.',
        }),
        displayName: z.string(),
        tagline: z.string().nullable(),
        oblast: z.string().nullable(),
        crops: z.array(z.string()),
        score: z.number().openapi({
            description:
                'Trigram similarity, 0–1. **Zero when browsing** — a request with no `q` has no ranking signal, so every score is 0 rather than a meaningless small number. Do not render it as a relevance percentage; it is a sort key.',
        }),
    })
    .openapi('PublicFarmSearchHit');

const PublicFarmProfileSchema = z
    .object({
        handle: z.string(),
        displayName: z.string(),
        tagline: z.string().nullable(),
        about: z.string().nullable(),
        oblast: z.string().nullable(),
        crops: z.array(z.string()),
        logoUrl: z.string().nullable().openapi({
            description:
                'ROOT-RELATIVE `/api/public/media/{hash}`, or null. A URL and not the hash it contains — decided with agrent-ios (2026-10-20) on their own argument: the server owns the path shape, so correcting it never needs a client release, and the phone already follows a server-given root-relative path for `/me`’s `avatarUrl`. The hash is recoverable from the URL and is deliberately not also returned.',
        }),
        photoUrls: z.array(z.string()).openapi({
            description: 'Root-relative gallery URLs, in display order.',
        }),
    })
    .openapi('PublicFarmProfile');

export function registerPublicFarmsPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/public/farms',
        operationId: 'searchPublicFarms',
        // Anonymous by design — see NO_AUTH (#1843).
        security: NO_AUTH,
        summary: 'Search the public farm directory',
        description:
            'ANONYMOUS. No session, no tenant, no credential — a stranger with a shared link browses the same surface.\n\n'
            + '**Latin and Cyrillic both work, and you do not have to choose.** A farm named «Стопанство Победа» is found by `Победа` and by `Pobeda`. That is not a client-side convenience: the server stores the transliterated form alongside the Cyrillic one, because cross-script trigram similarity is ZERO and no threshold would bridge it. Transliteration follows the Закон за транслитерацията (2009) Streamlined System — the spelling on Bulgarian passports and road signs.\n\n'
            + 'Matching is by SIMILARITY, not equality, and that matters for a real case: «АгроТех» transliterates to `AgroTeh` (`х → h` — transliteration is not translation), so a visitor typing the English-looking `AgroTech` matches nothing exactly and is found anyway.\n\n'
            + 'All parameters are optional. With no `q` this BROWSES: results are ordered by handle and every `score` is 0. With a `q` they are ordered by best match. `oblast` is exact; `crop` is array containment against the farm’s declared crops.\n\n'
            + '**Bounded at 50 and not pageable.** A visitor who needs more should narrow by `oblast` or `crop`, which is what the filters are for — a public endpoint is not a data export.\n\n'
            + 'Answers a BARE ARRAY. Only published profiles appear, because a row exists in the projection only while a farm is published; withdrawing one removes it rather than flagging it.\n\n'
            + '**Refusal codes.** None of its own. A malformed `limit` (non-numeric, below 1, above 50) is a `VALIDATION_ERROR` naming the field; everything else is optional and an absent value is a legitimate request rather than an error.',
        tags: ['Public'],
        query: PublicFarmSearchQuerySchema,
        success: {
            status: 200,
            description: 'Matching farms, best match first. A BARE ARRAY.',
            schema: z.array(FarmSearchHitSchema),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/public/farms/{handle}',
        operationId: 'getPublicFarmProfile',
        // Anonymous by design — see NO_AUTH (#1843).
        security: NO_AUTH,
        summary: 'One public farm profile, by handle',
        description:
            'ANONYMOUS. The JSON behind `/f/{handle}`, for the native profile screen — the page and '
            + 'this route share `readPublicFarmProfile`, so they cannot disagree about what a '
            + 'published profile contains.\n\n'
            + '**A hidden field is `null` or `[]`, never accompanied by a flag.** The projection row '
            + 'IS the allowlisted shape, so per-field visibility is applied where the row is '
            + 'written rather than filtered again on read. There is no `visible` boolean to '
            + 'interpret and no field that arrives empty-but-present meaning "withheld".\n\n'
            + '**Images are root-relative URLs, not hashes** — see `logoUrl`.\n\n'
            + '`indexable` and `projectedAt` are on the server-side view and deliberately NOT '
            + 'exposed: the first drives robots and the sitemap, the second would be a second '
            + 'caching mechanism beside the ETag.\n\n'
            + '**Refusal codes: one, and it discloses nothing.** A malformed handle, a farm that '
            + 'never existed and one that has withdrawn its profile all answer the SAME `404` with '
            + '`{ "error": "NOT_FOUND" }`. That is structural rather than three branches kept in '
            + 'step: a row exists in the projection only while the farm is published, and '
            + 'withdrawal DELETES it instead of flagging it, so "not published" and "never existed" '
            + 'are one absence. Do not treat the 404 as evidence a handle is free.\n\n'
            + 'The handle is trimmed and lower-cased before lookup, so a trailing space pasted from '
            + 'a shared link or read off printed A6 paper does not read as a missing farm.',
        tags: ['Public'],
        params: z.object({
            handle: z.string().openapi({
                param: { name: 'handle', in: 'path' },
                example: 'pobeda',
                description: 'The farm’s public address, as it appears in `/f/{handle}`.',
            }),
        }),
        success: {
            status: 200,
            description: 'The published profile. Carries a weak ETag; honours `If-None-Match` with a 304.',
            schema: PublicFarmProfileSchema,
        },
        extraResponses: {
            404: {
                description:
                    '`{ "error": "NOT_FOUND" }` — no published profile at that handle. Identical for '
                    + 'a malformed handle, an unpublished farm and a nonexistent one, by design.',
            },
        },
    });
}
