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
import { IngestReadingsSchema, CreateDataStreamSchema } from '@/lib/schemas';
import { op } from './helpers';
import { MAX_SIGNAL_DAYS } from '@/lib/agro/signal-window';

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
        body: CreateDataStreamSchema,
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
        body: IngestReadingsSchema,
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

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/agro/signals',
        operationId: 'listAgroSignals',
        summary: "The farm's agro warnings for a date range",
        description:
            'Frost, spray-window and disease-risk signals for the farm, per BLOCK and per day. Built for a client that has to decide whether to show sowing advice on a given day.' +
            '\n\n**The rows are per BLOCK, and that is why this returns rows rather than a verdict.** `AgroSignal` is keyed `(tenantId, locationId, kind, signalDate)`, so a farm with twelve blocks can have frost on two. A day-level boolean computed on the server would either over-suppress the whole farm or say nothing about which block, so the client composes the answer where it holds the location — «Предупреждение за слана в 2 блока».' +
            '\n\n**`horizon` is the field that keeps you honest, and you must read it.** It is the last day a FORECAST actually informed. BEYOND IT, AN ABSENT SIGNAL MEANS *NOT KNOWABLE*, NOT *CLEAR* — nobody can forecast frost three weeks out, so a clean-looking day a month ahead must never be rendered as "checked, nothing found". It is derived from the newest observation the farm holds rather than from the configured forecast length, so a pull that partially failed reports the shorter truth, and a client that hard-coded the window instead would drift silently the day that setting changes. `null` means this farm has no weather at all.' +
            '\n\nIt is ONE value for the farm, deliberately: a block whose own pull failed can have a shorter horizon than this, so treat it as the best case rather than a guarantee per block.' +
            '\n\n**`FROST_RISK` rows are about days that have NOT happened, unlike the other two kinds**, which describe a day already observed. A forecast changes, so a future frost row the next pull no longer supports is REMOVED — but only while it is un-notified, and a past row is never touched. So treat this as the current truth for upcoming days rather than an append-only log: REPLACE a cached day-to-blocks map on refetch, never merge into it.' +
            '\n\n`level` is a free severity label per kind — `UNSUITABLE` for spray, `HIGH` for disease, `FROST` for frost, which has one level by ruling rather than a WARN/SEVERE split.' +
            '\n\n**ETagged, but not deterministic** — unlike `GET /api/lunar`, whose answer is astronomy and never changes. Send `If-None-Match` as a conditional-GET optimisation; do not read a 304 as a promise that the data is immutable.' +
            `\n\nThe range is at most ${MAX_SIGNAL_DAYS} days, the same window as \`GET /api/lunar\`, so one client-side window serves both reads.`,
        tags: ['Agro'],
        params: z.object({
            tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' } }),
        }),
        query: z.object({
            from: z.string().openapi({
                param: { name: 'from', in: 'query', required: true },
                description: 'First day, inclusive. `YYYY-MM-DD`.',
                example: '2026-04-01',
            }),
            to: z.string().openapi({
                param: { name: 'to', in: 'query', required: true },
                description:
                    `Last day, inclusive. \`YYYY-MM-DD\`. At most ${MAX_SIGNAL_DAYS} days after \`from\`; a wider span is a 400, as is a date that does not exist.`,
                example: '2026-04-30',
            }),
        }),
        success: {
            status: 200,
            description:
                'The farm\'s signals in the range, oldest first. An empty array inside the horizon means no warnings; beyond the horizon it means nothing is known.',
            schema: z
                .object({
                    signals: z.array(
                        z.object({
                            locationId: z.string().openapi({
                                description:
                                    'The BLOCK this warning is about. Join it against `GET /api/t/{tenantSlug}/locations`.',
                            }),
                            kind: z
                                .enum(['SPRAY_WINDOW', 'DISEASE_RISK', 'FROST_RISK'])
                                .openapi({
                                    description:
                                        '`SPRAY_WINDOW` is claimed only when the window is UNSUITABLE, so its presence is a warning rather than a good window — the name reads the other way. A growing union: treat an unrecognised kind as a warning of unknown type rather than ignoring it.',
                                }),
                            level: z.string().nullable(),
                            signalDate: z.string().openapi({ example: '2026-04-12' }),
                        }),
                    ),
                    horizon: z.string().nullable().openapi({
                        description:
                            'Last day a forecast informed, `YYYY-MM-DD`. Read the description above before rendering anything beyond it.',
                        example: '2026-04-14',
                    }),
                    frostThresholdC: z.number().openapi({
                        description:
                            'The 2 m air minimum at or below which a frost warning is claimed. Sent so a client can explain the warning without hard-coding the rule. Owner ruling 2026-11-15: 2 °C rather than 0 °C, because ground frost forms while the screen reading is still above zero.',
                        example: 2,
                    }),
                    truncated: z.boolean().openapi({
                        description:
                            'True when the row cap was hit and the list is INCOMPLETE. Reported rather than silently trimmed: a block whose warning was cut off would be the exact failure this endpoint exists to prevent. SAY SO TO THE USER rather than rendering a clean screen — the iOS client words it «Списъкът с предупреждения е непълен. Липсата на предупреждение не значи, че няма такова.», and that second sentence is the one worth copying: with the list cut off, an absent warning is not evidence of safety.',
                    }),
                })
                .openapi('AgroSignals'),
        },
    });

}
