/**
 * «Ортофотокарта» — МЗХ orthophoto, flight dates and physical blocks (#2421).
 *
 * The phone builds against this, so the three answers a tile can give are
 * documented as a table rather than left to be discovered: the difference
 * between 204 and 503 is a behavioural contract, not an implementation note.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { codedErrorResponses, op } from './helpers';

const TenantParams = z.object({ tenantSlug: z.string() });

const TileParams = TenantParams.extend({
    z: z.string().openapi({ description: 'Web Mercator zoom, 10-19.' }),
    x: z.string(),
    y: z.string().openapi({ description: 'May carry a `.jpg` suffix from a tile template.' }),
});

const BboxQuery = z.object({
    bbox: z.string().openapi({
        description:
            '`minLon,minLat,maxLon,maxLat` — LONGITUDE first, the GeoJSON order. Refused above '
            + '0.5° on either axis, so one request cannot sweep the country.',
        example: '24.39,43.07,24.41,43.09',
    }),
});

const Coverage = z
    .object({
        year: z.number().int().nullable().openapi({
            description:
                'The newest flight year with imagery over this area, or null when none has. Null '
                + 'is an ORDINARY answer, not a failure — about two thirds of the country is '
                + 'uncovered in any single year.',
        }),
        flightDate: z.string().nullable().openapi({
            description:
                '`YYYY-MM-DD`, the calendar day **in Bulgaria**. The source stores a local date '
                + 'serialised as UTC (`2023-10-13T21:00:00Z` is midnight in Sofia on the 14th), so '
                + 'this is resolved in `Europe/Sofia` — reading it as UTC reports the flight a day '
                + 'early.',
        }),
        attribution: z.string().openapi({ example: 'Ортофото: МЗХ' }),
    })
    .openapi('OrthoCoverage');

const Blocks = z
    .object({
        type: z.literal('FeatureCollection'),
        year: z.number().int().nullable(),
        truncated: z.boolean().openapi({
            description:
                'True when the server’s cap cut the list. **Read it** — a cut list that does '
                + 'not say so is indistinguishable from a complete one, and the farmer would see a '
                + 'map missing blocks with nothing to indicate it.',
        }),
        features: z.array(
            z.object({
                type: z.literal('Feature'),
                geometry: z.unknown().openapi({
                    description: 'Polygon or MultiPolygon in EPSG:4326, lon/lat.',
                }),
                properties: z.object({
                    id: z.string().openapi({
                        description: 'The Ministry’s `PHBIDENT`, e.g. `56722-1033`.',
                        example: '56722-1033',
                    }),
                    usage: z.string().nullable().openapi({ example: 'Обработваеми земи' }),
                    usageCode: z.string().nullable().openapi({ example: '010' }),
                }),
            }),
        ),
    })
    .openapi('OrthoBlocks');

const TileBody = z.string().openapi({ type: 'string', format: 'binary' });

export function registerOrthoPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/ortho/tiles/{z}/{x}/{y}',
        operationId: 'getOrthoTile',
        summary: 'A МЗХ orthophoto tile',
        description:
            'A 256² Web Mercator JPEG from the newest flight year whose coverage polygon '
            + 'includes the tile. Signed-in only, so this is not an open proxy onto a government '
            + 'service, and the upstream URL never reaches the client.\n\n'
            + '**Three answers, and the difference between two of them is a contract:**\n\n'
            + '| status | meaning | what a client should do |\n'
            + '| --- | --- | --- |\n'
            + '| `200` `image/jpeg` | imagery | draw it |\n'
            + '| `204` | no imagery here, and that is FINAL | draw plain ground; safe to remember |\n'
            + '| `503` | the server could not find out | draw ground and ASK AGAIN later |\n\n'
            + 'A 204 means the Ministry has not photographed this — no covering flight year, or '
            + 'the source’s blank tile. It is safe to cache for a session. A 503 means an '
            + 'upstream failure and must NOT be remembered: caching it would show bare ground over '
            + 'land that is photographed until the client restarts.\n\n'
            + '`X-Ortho-Year` names the flight year the pixels came from, so a client need not '
            + 'ask `/ortho/coverage` again to label them.\n\n'
            + '**No `ETag`, deliberately.** `Cache-Control: immutable` gets the caching benefit '
            + 'without a conditional round-trip, and an `ETag` invites `If-None-Match` — a 304 '
            + 'that a client without a 304 branch would read as "not an image" and draw as ground, '
            + 'which is the same silent blank the 204/503 split exists to prevent.\n\n'
            + 'Zoom is clamped to 10-19: 25 cm native resolution means the source has nothing '
            + 'beyond z19, and below z10 one tile fans across the whole country. Behind the '
            + '`agro.orthophoto` flag AND an operator-set upstream; either absent answers 404.',
        tags: ['Maps'],
        params: TileParams,
        success: {
            status: 200,
            description: 'The tile. `X-Ortho-Year` carries the flight year.',
            content: { 'image/jpeg': TileBody },
        },
        extraResponses: {
            204: { description: 'No imagery here, and that is final. Empty body.' },
            503: {
                description:
                    'The upstream could not be reached or refused. NOT a statement about whether '
                    + 'imagery exists — ask again.',
            },
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/ortho/coverage',
        operationId: 'getOrthoCoverage',
        summary: 'Which flight year covers an area, and when it was flown',
        description:
            'The footer under «Ортофотокарта»: «Ортофото: МЗХ, заснемане <date>».\n\n'
            + 'Resolved ONCE per area rather than per tile, which is why it is its own endpoint: '
            + 'the source serves each year as a separate layer, stacking them in one request '
            + 'returns blank, and probing year-by-year per tile would mean up to six upstream '
            + 'requests for every tile of a cold pan.\n\n'
            + '`year: null` is an ordinary answer. Each year’s flight covers roughly a third '
            + 'of the country, and an area outside Bulgaria answers null without the Ministry '
            + 'being asked at all.\n\n'
            + 'Behind the `agro.orthophoto` flag AND an operator-set upstream.',
        tags: ['Maps'],
        params: TenantParams,
        query: BboxQuery,
        success: { status: 200, description: 'The newest covering year and its flight date.', schema: Coverage },
        extraResponses: {
            ...codedErrorResponses({
                400:
                    '`ORTHO_BBOX_INVALID` — the `bbox` is malformed, out of range, inverted, or '
                    + 'wider than 0.5° on an axis. One code for all of them: every one is a client '
                    + 'bug rather than something a farmer can act on, and the message says which. '
                    + 'A well-formed box OUTSIDE Bulgaria is not an error — it answers '
                    + '`year: null`, because panning too far is not a mistake.',
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/ortho/blocks',
        operationId: 'getOrthoBlocks',
        summary: 'The Ministry’s physical blocks (ФБ) over an area',
        description:
            'GeoJSON in EPSG:4326, drawn as thin labelled outlines under the farm’s own '
            + 'parcels. `properties.id` is the Ministry’s `PHBIDENT`, which is what a farmer '
            + 'matches against a Ministry document.\n\n'
            + 'The server caps the list at its own number regardless of the area asked for, and '
            + '`truncated` says when it did. A client should still bound its own requests — but a '
            + 'cap that lives only in the client is not a cap.\n\n'
            + 'A feature arriving without `PHBIDENT` is DROPPED rather than returned unlabelled: '
            + 'an outline a farmer cannot match to a document is worse than one fewer outline.\n\n'
            + 'Behind the `agro.orthophoto` flag AND an operator-set upstream.',
        tags: ['Maps'],
        params: TenantParams,
        query: BboxQuery,
        success: { status: 200, description: 'The blocks intersecting the area.', schema: Blocks },
        extraResponses: {
            ...codedErrorResponses({
                400: '`ORTHO_BBOX_INVALID` — see `/ortho/coverage`; the same parser bounds both.',
            }),
        },
    });
}
