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
}
