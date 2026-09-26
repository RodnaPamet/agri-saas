/**
 * Agro-intel — satellite index overlays and device data streams.
 *
 * ── the five tile routes are ONE contract ──
 *
 * NDVI, NDMI, NDRE, GNDVI and EVI differ only in which Earth-Engine function
 * they call; `handleIndexTiles` is the shared implementation and the response
 * shape is identical. They are documented separately because they are separate
 * paths, and with the same schema because they are the same answer.
 *
 * They return JSON, NOT imagery: `{ configured, tileUrl, date?, error? }`. The
 * tile URL is what a map layer then fetches.
 *
 * **Three states, and two of them look like failure without being one:**
 *
 *   configured: false            this deployment has no Earth-Engine
 *                                credentials. Show a muted hint, not an error.
 *   configured: true, tileUrl:'' configured, but nothing to show — no field
 *                                geometry, or a transient generation failure
 *                                named in `error`. The overlay stays OFF and
 *                                the map keeps working.
 *   tileUrl: '<url>'             an overlay to render.
 *
 * **`date` is the imagery's REAL acquisition date, not the one requested.** The
 * composite falls back to the latest available window when the requested one
 * holds no imagery — the wall clock outruns the published Sentinel-2 archive,
 * and a cloudy stretch can empty a window. Echoing the request back would
 * label old imagery as fresh, so a client must display THIS date rather than
 * the one it asked for.
 *
 * **The location id is a PATH SEGMENT and `date` is a query param, on purpose.**
 * iOS writes the full request URL, query string included, to the unified log
 * from Apple's own networking layer — below anything an app can suppress. So an
 * id in a query string is an id in a device-local log for every client built on
 * the route. A date is not an identifier, so it stays in the query.
 *
 * ── the ingest route is PUBLIC and token-gated ──
 *
 * `POST /api/agro/data-streams/{streamId}/ingest` carries no session. The token
 * in the body IS the credential; the tenant is resolved from the stream the
 * token matches. Every mismatch — unknown stream, wrong token, disabled stream
 * — answers the SAME vague 401, so probing stream ids yields no oracle. A
 * client must not branch on the reason, because there is only one.
 *
 * It is also a BARE route: the standard error envelope is deliberately not
 * used, and its `{ error }` shapes are the contract (registered in
 * `route-exemptions.ts`). That is why the errors here look unlike the rest of
 * this API.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const TileParams = TenantParams.extend({
    locationId: z.string().openapi({ param: { name: 'locationId', in: 'path' } }),
});
const StreamParams = TenantParams.extend({
    streamId: z.string().openapi({ param: { name: 'streamId', in: 'path' } }),
});

const IndexTilesSchema = z
    .object({
        /** False when this deployment has no Earth-Engine credentials. */
        configured: z.boolean(),
        /**
         * The URL a map layer fetches. EMPTY STRING when configured but there
         * is nothing to show — not an error state, and not null.
         */
        tileUrl: z.string(),
        /**
         * The imagery's REAL acquisition date, which may be older than the one
         * requested. Display this, never the request.
         */
        date: z.string().date().optional(),
        /** Names a transient generation failure. `tileUrl` is empty with it. */
        error: z.string().optional(),
    })
    .openapi('IndexTiles', {
        description:
            'A satellite-index overlay source. configured:false means no Earth-Engine credentials on this deployment; configured:true with an EMPTY tileUrl means there is nothing to show (no field geometry, or a transient failure named in error) and the overlay should simply stay off. `date` is the imagery’s real acquisition date and can be older than the date requested, because the composite falls back to the latest available window.',
    });

const INDEX_QUERY = z.object({
    date: z
        .string()
        .optional()
        .openapi({ description: 'YYYY-MM-DD. A REQUEST; the response may report an older date.' }),
});

const DataStreamSchema = z
    .object({
        id: z.string(),
        /** Stable machine key for the stream. */
        key: z.string(),
        name: z.string(),
        kind: z.enum([
            'TEMPERATURE',
            'SOIL_MOISTURE',
            'HUMIDITY',
            'RAINFALL',
            'WIND',
            'LEAF_WETNESS',
            'CUSTOM',
        ]),
        unit: z.string().nullable(),
        status: z.string(),
        locationId: z.string().nullable(),
        createdAt: z.string().datetime(),
    })
    .openapi('DataStream', {
        description:
            'A device data stream. The ingest token’s HASH is never projected onto the wire — this shape is what every read returns, and the raw token appears exactly once, in the create response.',
    });

export function registerAgroPaths(registry: OpenAPIRegistry): void {
    for (const index of ['ndvi', 'ndmi', 'ndre', 'gndvi', 'evi'] as const) {
        const upper = index.toUpperCase();
        op(registry, {
            method: 'get',
            path: `/api/t/{tenantSlug}/agro/locations/{locationId}/${index}-tiles`,
            operationId: `get${upper}Tiles`,
            summary: `${upper} tile source for a location`,
            description:
                `A recent cloud-masked Sentinel-2 ${upper} composite for the location’s field, via Google Earth Engine, Redis-cached. ` +
                '\n\nReturns JSON, not imagery — `tileUrl` is what a map layer then fetches. ' +
                '\n\nHandle all THREE states: `configured:false` (no credentials — show a muted hint, not an error), `configured:true` with an EMPTY `tileUrl` (nothing to show; keep the map, leave the overlay off), and a real URL. ' +
                '\n\n**Display the returned `date`, not the one you asked for** — the composite falls back to the latest available window, so they legitimately differ. ' +
                '\n\nReachable by the restricted MECHANISATOR persona, which is deliberate: the sprayer needs the map on the job.',
            tags: ['Agro'],
            params: TileParams,
            query: INDEX_QUERY,
            success: { status: 200, description: `The ${upper} overlay source.`, schema: IndexTilesSchema },
        });
    }

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/agro/data-streams',
        operationId: 'listDataStreams',
        summary: 'List device data streams',
        description:
            'The tenant’s sensor streams, newest first. The ingest token hash is deliberately NOT projected — there is no read that returns it.',
        tags: ['Agro'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The streams. A BARE ARRAY.',
            schema: z.array(DataStreamSchema),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/agro/data-streams',
        operationId: 'createDataStream',
        summary: 'Create a device data stream',
        description:
            '**The response carries `ingestToken` — the RAW token, and this is the ONLY time it is returned.** Every later read projects the stream without it, and only a hash is stored, so it cannot be recovered. A client must persist it at creation or the stream has to be recreated. ' +
            '\n\nThat token is what a device sends to the public ingest route; treat it as a credential, not as an identifier.',
        tags: ['Agro'],
        params: TenantParams,
        body: z
            .object({
                key: z.string().min(1).max(120),
                name: z.string().min(1).max(200),
                kind: z.enum([
                    'TEMPERATURE',
                    'SOIL_MOISTURE',
                    'HUMIDITY',
                    'RAINFALL',
                    'WIND',
                    'LEAF_WETNESS',
                    'CUSTOM',
                ]),
                unit: z.string().max(32).nullable().optional(),
                locationId: z.string().nullable().optional(),
            })
            .openapi('CreateDataStream'),
        success: {
            status: 201,
            description: 'The created stream AND its raw ingest token, returned once.',
            schema: z
                .object({
                    id: z.string(),
                    key: z.string(),
                    name: z.string(),
                    kind: z.string(),
                    /** RAW. Shown once, never again. Store it now. */
                    ingestToken: z.string(),
                })
                .openapi('CreatedDataStream', {
                    description:
                        'The create response. ingestToken is the raw credential and appears ONLY here — the server keeps a hash, so it cannot be shown again or recovered.',
                }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/agro/data-streams/{streamId}/readings',
        operationId: 'listDataStreamReadings',
        summary: 'Recent readings for a stream',
        description: 'Readings newest-first, capped server-side. Values are plain numbers.',
        tags: ['Agro'],
        params: StreamParams,
        success: {
            status: 200,
            description: 'The readings. A BARE ARRAY.',
            schema: z.array(
                z
                    .object({
                        id: z.string(),
                        recordedAt: z.string().datetime(),
                        value: z.number(),
                        /** Overrides the stream's unit for this reading. */
                        unit: z.string().nullable(),
                    })
                    .openapi('DataStreamReading', {
                        description:
                            'One sensor reading. `unit` is per-reading and may differ from the stream’s declared unit.',
                    }),
            ),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/agro/data-streams/{streamId}/ingest',
        operationId: 'ingestDataStreamReadings',
        summary: 'Device reading ingestion (public, token-gated)',
        description:
            'PUBLIC and session-less — the `token` in the body IS the credential, and the tenant is resolved from the stream it matches. Device-facing. ' +
            '\n\n**Every rejection is the SAME vague 401** `{ "error": "access_denied" }` — unknown stream, wrong token and disabled stream are indistinguishable on purpose, so probing stream ids gives no oracle. Do not branch on the reason. ' +
            '\n\n**503 `{ "error": "feature_disabled" }`** when the operator has not enabled the feature; that is a deployment state, not a client error, and retrying will not change it. ' +
            '\n\nThis route deliberately does NOT use the standard error envelope — these bare `{ error }` shapes are its contract, which is why its failures look unlike the rest of this API.',
        tags: ['Agro'],
        security: [],
        params: z.object({
            streamId: z.string().openapi({ param: { name: 'streamId', in: 'path' } }),
        }),
        body: z
            .object({
                token: z.string().min(16).max(512),
                readings: z.array(
                    z.object({
                        recordedAt: z.string(),
                        value: z.number(),
                        unit: z.string().max(32).nullable().optional(),
                    }),
                ),
            })
            .openapi('IngestReadings', {
                description:
                    'A batch of readings plus the stream’s raw ingest token. The batch is bounded server-side (~1000).',
            }),
        success: {
            status: 200,
            description: 'Accepted. `inserted` is how many rows landed.',
            schema: z
                .object({ status: z.literal('ok'), inserted: z.number() })
                .openapi('IngestAck', {
                    description:
                        'inserted may be LOWER than the batch size — duplicates and out-of-range readings are dropped rather than failing the batch.',
                }),
        },
    });
}
