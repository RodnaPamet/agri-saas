/**
 * Locations — the farm's places, their parcels, and everything an operator's
 * client hangs off a field: the spray jobs, the map tiles, the land-use
 * agreements, the imports and the БАБХ ДНЕВНИК register.
 *
 * Twenty route files, so this is the module where the surprises live. The
 * ones worth reading before generating a client:
 *
 *   - `GET /locations` returns a FLAT ARRAY, or `{ items, pageInfo }` if you
 *     sent `limit` or `cursor`. Two bodies, one operation.
 *   - `PATCH` and `PUT` on a location are the SAME handler
 *     (`export const PATCH = PUT`), and both answer `{ success, location }`
 *     rather than the bare row the create returns.
 *   - The parcel writes return AREA, not the parcel. `POST` gives
 *     `{ id, areaHa }`; `PATCH` gives `{ areaHa }` with no id.
 *   - On every parcel- and lease-scoped route the location `{id}` in the path
 *     is DECORATIVE. The handler resolves the parcel or lease by its own id
 *     within the tenant and never checks it against `{id}`, so a request that
 *     names the wrong location succeeds. Tenant isolation still holds; the
 *     location segment simply is not a filter.
 *   - The two import-status polls and the two import POSTs answer errors as
 *     `{ "error": "…" }` — a bare string, NOT the canonical
 *     `{ error: { code, message } }` envelope every other route shares. A
 *     client that reads `error.code` gets `undefined` there.
 *   - The tile endpoints are BINARY and their 204 is meaningful.
 *
 * Request schemas are imported wherever the handler imports one that is
 * exported and prisma-free (`@/app-layer/schemas/geo.schemas`,
 * `@/app-layer/schemas/lease.schemas`, `@/lib/schemas`). The three declared
 * inline inside route files are mirrored here, field for field, because the
 * route modules cannot be loaded during spec generation — see `helpers.ts`.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
    CreateLocationSchema,
    UpdateLocationSchema,
    CreateFieldOperationSchema,
    BulkDeleteLocationsSchema,
    FarmRecordGenerateSchema,
} from '@/lib/schemas';
import {
    CreateParcelSchema,
    UpdateParcelSchema,
    MergeParcelsSchema,
    SplitParcelSchema,
} from '@/app-layer/schemas/geo.schemas';
import { ParcelLeaseSchema } from '@/app-layer/schemas/lease.schemas';
import { LocationListItemDTOSchema } from '@/lib/dto/location.dto';
import { UserRefSchema } from '@/lib/dto/common';
import { codedErrorResponses, op } from './helpers';
import { RawErrorResponseSchema } from '@/lib/dto/common';

// ─── Path parameters ────────────────────────────────────────────────
//
// ZodObjects, because that is what the generator reads to build inline
// parameters — see the note on OperationInput.params.

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const LocationParams = TenantParams.extend({
    id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'Location id.' }),
});
const ParcelParams = LocationParams.extend({
    parcelId: z.string().openapi({
        param: { name: 'parcelId', in: 'path' },
        description:
            'Parcel id. This — not the location `{id}` beside it — is what the handler resolves; ' +
            'the location segment is not checked against the parcel.',
    }),
});
const LeaseParams = ParcelParams.extend({
    leaseId: z.string().openapi({
        param: { name: 'leaseId', in: 'path' },
        description:
            'Lease id, resolved within the tenant. Neither `{id}` nor `{parcelId}` is checked ' +
            'against it.',
    }),
});
const JobParams = LocationParams.extend({
    jobId: z.string().openapi({
        param: { name: 'jobId', in: 'path' },
        description:
            'The BullMQ job id returned by the staging POST. Pinned to the tenant AND the ' +
            'location: a job belonging to either another tenant or another location answers 404, ' +
            'so ids cannot be enumerated.',
    }),
});
const TileParams = LocationParams.extend({
    z: z.string().openapi({ param: { name: 'z', in: 'path' }, description: 'Tile zoom.' }),
    x: z.string().openapi({ param: { name: 'x', in: 'path' }, description: 'Tile column.' }),
    y: z.string().openapi({
        param: { name: 'y', in: 'path' },
        description:
            'Tile row. A trailing `.pbf` is accepted and stripped — MapLibre’s tile URL template ' +
            'appends it.',
    }),
});

// ─── Shared shapes ──────────────────────────────────────────────────

/**
 * The error body the import routes return — a bare string under `error`.
 *
 * This is NOT the canonical envelope. `jsonResponse({ error: 'Job not found' },
 * { status: 404 })` bypasses `withApiErrorHandling`'s formatter entirely, so
 * there is no `code`, no `requestId` and no `details`. Documented as its own
 * component rather than quietly listed as `ErrorResponse`, because a client
 * that branches on `error.code` reads `undefined` on exactly the paths a
 * flaky field upload hits most.
 */

/**
 * Exported so `field-operations.paths.ts` can reference THIS object rather than
 * describing the shape a second time. Both routes are served by the same
 * `ParcelRepository.listForLocation` call, so two descriptions could only ever
 * drift apart — which is the reasoning the field-operations module already had,
 * it just reached for `z.object({}).passthrough()` instead of an import. A
 * shared reference achieves "cannot contradict itself" without the cost of
 * documenting nothing.
 */
export const ParcelGeo = z
    .object({
        id: z.string(),
        name: z.string(),
        cropType: z.string().nullable(),
        areaHa: z.number().nullable().openapi({
            description: 'On-ellipsoid hectares, computed in PostGIS. A NUMBER here, unlike the STRING on an OperationParcel line.',
        }),
        // Was `z.unknown()`, which published a description and no TYPE (#1391).
        // That is the shape a probe misreads as fixed: checking "is this `{}`"
        // passes the moment a description is added, while a generator still
        // emits `any`.
        geometry: z
            .object({
                type: z.literal('MultiPolygon'),
                coordinates: z.array(z.unknown()).openapi({
                    description:
                        'Nested coordinate arrays, as GeoJSON nests them — `[[[lon, lat], …]]` for a Polygon, one level deeper for a MultiPolygon. Left unconstrained here rather than modelled to four levels, which no generator handles usefully.',
                }),
            })
            .passthrough()
            .nullable()
            .openapi({
                description:
                    'GeoJSON geometry, WGS84. Simplified when the read passed `?simplify=` — never for ' +
                    'sketch/edit, which needs exact geometry.' +
                    '\n\n**Null is reachable and is not an error.** A simplify tolerance large enough to ' +
                    'collapse a small parcel returns null rather than a degenerate shape, so a client ' +
                    'must handle a parcel it cannot draw. Re-read without `?simplify=` to get the exact ' +
                    'geometry.',
            }),
        properties: z.unknown().nullable(),
        cadastralId: z.string().nullable().openapi({
            description: 'КАИС identifier `ЕКАТТЕ.масив.парцел`; null when not linked.',
        }),
        ekatte: z.string().nullable().openapi({ description: '5-digit settlement prefix of `cadastralId`.' }),
        soilType: z.string().nullable().openapi({
            description: 'Modelled soil label. Null while the async SoilGrids fetch is still pending.',
        }),
        soilJson: z.unknown().nullable(),
        absentFromImportAt: z.string().datetime().nullable().openapi({
            description:
                'When the location’s LAST spatial import did not contain this parcel — it was ' +
                'kept, with all of its history, and marked. Null means it WAS in the last import, ' +
                'or that the location has never been imported into; both mean nothing to warn ' +
                'about. A TIMESTAMP rather than a boolean because "not in the last import" and ' +
                '"not in any import since March" are different facts and only the first is ' +
                'actionable — compare it against the location’s last import.',
        }),
        companyOwners: z
            .array(
                z.object({
                    name: z.string(),
                    eik: z.string(),
                    rightType: z.string().nullable(),
                    subjectKind: z.string().nullable(),
                }),
            )
            .openapi({
                description:
                    'LEGAL-ENTITY owners from the КАИС register, joined at read time on ' +
                    '`cadastralId`. Physical persons are never stored, so an individually-owned ' +
                    'parcel has an EMPTY array — that is not "unknown owner".',
            }),
        hasActiveLease: z.boolean().openapi({
            description: 'A non-deleted lease with no end date, or an end date in the future.',
        }),
    })
    .passthrough()
    .openapi('ParcelGeo', {
        description:
            'A parcel as the map and the parcel list receive it — geometry as GeoJSON plus the ' +
            'soil and land-administration columns. Wider than the `Parcel` DTO, which describes ' +
            'the `LocationDetail` shape.',
    });

// ─── Locations ──────────────────────────────────────────────────────

const LocationListQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({
        param: { name: 'limit', in: 'query' },
        description: 'Sending `limit` OR `cursor` switches the response to the paginated envelope.',
    }),
    cursor: z.string().optional().openapi({ param: { name: 'cursor', in: 'query' } }),
    status: z.string().optional().openapi({
        param: { name: 'status', in: 'query' },
        description: 'ACTIVE or ARCHIVED.',
    }),
    q: z.string().optional().openapi({ param: { name: 'q', in: 'query' }, description: 'Free-text search.' }),
    kind: z.string().optional().openapi({
        param: { name: 'kind', in: 'query' },
        description:
            'Comma-separated LocationKind members, e.g. `BIN,STORAGE`. A Location is a field or ' +
            'a storage row depending on kind, so an unfiltered list MIXES growing areas with ' +
            'grain bins. Values that are not real enum members are dropped rather than rejected.',
        example: 'BIN,STORAGE',
    }),
});

const LocationListPage = z
    .object({
        items: z.array(LocationListItemDTOSchema),
        pageInfo: z.object({
            nextCursor: z.string().optional(),
            hasNextPage: z.boolean(),
        }),
    })
    .openapi('LocationListPage', {
        description:
            'The paginated envelope, returned ONLY when `limit` or `cursor` was sent. Note ' +
            '`pageInfo.nextCursor` — the cursor is nested, not at the root.',
    });

const LocationUpdated = z
    .object({ success: z.literal(true), location: LocationListItemDTOSchema })
    .openapi('LocationUpdated', {
        description:
            'The update envelope. Deliberately different from the create, which returns the bare ' +
            'Location row with no wrapper.',
    });



const LocationBulkDeleteResult = z
    .object({ deleted: z.number().int() })
    .openapi('LocationBulkDeleteResult', {
        description:
            'How many locations were soft-deleted. Ids that do not resolve are SKIPPED, not ' +
            'errors, so `deleted` can be lower than the number you sent — a re-submit deletes 0.',
    });

const LocationParcels = z
    .object({
        locationId: z.string(),
        bounds: z
            .array(z.number())
            .nullable()
            .openapi({
                minItems: 4,
                maxItems: 4,
                description:
                    'Bounding box as `[west, south, east, north]` — `[minLon, minLat, maxLon, maxLat]`, **longitude first**, per GeoJSON and the reverse of the `lat, lon` a human quotes. WGS84 degrees, exactly four numbers. Null when no parcel in this location has geometry, which is distinct from an empty box.',
            }),
        parcels: z.array(ParcelGeo),
    })
    .openapi('LocationParcels', {
        description: 'A location’s parcels as GeoJSON, with the location’s bounding box.',
    });

// ─── Parcels by crop (#1740) ────────────────────────────────────────

const ParcelDisplayGeometry = z
    .object({
        type: z.literal('MultiPolygon'),
        coordinates: z.array(z.unknown()).openapi({
            description:
                'Nested coordinate arrays, as GeoJSON nests them. Left unconstrained here rather than modelled to four levels, which no generator handles usefully — the same choice `ParcelGeo` makes.',
        }),
    })
    .passthrough();

const ParcelCropTotal = z
    .object({
        cropType: z.string().openapi({
            description:
                'The crop VALUE as stored, verbatim and un-normalised. Usually one of the `crops` catalogue values (`Wheat`, `Barley`, `Canola`, `Maize`, `Sunflower`, `Peas`, `Grass`), but NOT guaranteed: `Parcel.cropType` is a free string and a spatial or cadastre import stamps whatever the source file carried. Label it the way the web does — `crops.<value>` when that key exists, the raw value otherwise, never hidden.',
        }),
        parcelCount: z.number().int().openapi({
            description: 'How many non-deleted parcels carry this crop, farm-wide across every block.',
        }),
        areaHaTotal: z.number().nullable().openapi({
            description:
                'Total area in HECTARES, summed over those parcels. Null when none of them has a measured area — distinct from 0, which means measured and empty. Convert to дка for display; the server stores hectares.',
        }),
    })
    .openapi('ParcelCropTotal', { description: 'One crop a farm grows, with its parcel count and area.' });

const ParcelCropTotals = z
    .object({ crops: z.array(ParcelCropTotal) })
    .openapi('ParcelCropTotals', {
        description:
            'Every crop this farm grows. Parcels with NO crop are excluded — "no crop" is not an answer to "which crop did you treat", and such a parcel is still reachable through the per-block list.',
    });

const ParcelByCrop = z
    .object({
        id: z.string(),
        name: z.string(),
        cropType: z.string(),
        areaHa: z.number().nullable().openapi({
            description: 'Area in HECTARES as stored, or null when unmeasured.',
        }),
        locationId: z.string(),
        locationName: z.string().openapi({
            description:
                'The block this parcel sits in. Not a convenience: two blocks can each hold a field named «1», so a flat farm-wide list is ambiguous without it.',
        }),
        geometry: ParcelDisplayGeometry.nullable().openapi({
            description:
                'GeoJSON in WGS84, always SIMPLIFIED for display. Null when the parcel has no outline, which is a normal state — keep the parcel and say it is not drawn, rather than dropping it, so the count still agrees with `parcelCount`.',
        }),
    })
    .openapi('ParcelByCrop', { description: 'A parcel of one crop, with its block and a display outline.' });

const ParcelsByCrop = z
    .object({
        cropType: z.string().openapi({ description: 'The crop asked for, trimmed — echoed back so a client can match a response to a request.' }),
        parcels: z.array(ParcelByCrop),
    })
    .openapi('ParcelsByCrop', { description: 'The parcels of one crop, farm-wide.' });

// ─── Parcels ────────────────────────────────────────────────────────

const ParcelCreated = z
    .object({
        id: z.string(),
        areaHa: z.number().nullable().openapi({ description: 'Re-derived server-side from the stored geometry.' }),
    })
    .openapi('ParcelCreated', { description: 'Identity and area of a newly written parcel — NOT the full parcel.' });

const ParcelUpdated = z
    .object({ areaHa: z.number().nullable() })
    .openapi('ParcelUpdated', {
        description:
            'Area only. There is no `id` and no echoed parcel — re-read the parcel list if you ' +
            'need the updated row.',
    });

const ParcelSplitResult = z
    .object({ pieces: z.array(ParcelCreated) })
    .openapi('ParcelSplitResult', { description: 'The pieces the blade cut, each a brand-new parcel.' });

const ParcelCreateRequest = CreateParcelSchema.openapi('ParcelCreateRequest', {
    description:
        'Hand-drawn parcel. `geometry` is a GeoJSON Polygon or MultiPolygon in WGS84; rings need ' +
        '≥4 positions and lon/lat must be in range. A self-intersecting shape is a 400 — PostGIS ' +
        'is the final arbiter, this only catches the common cases early.',
});

const ParcelUpdateRequest = UpdateParcelSchema.openapi('ParcelUpdateRequest', {
    description:
        'At least one field is required. Sending `geometry` RESHAPES the parcel (area is ' +
        're-derived and a soil re-fetch is enqueued). Sending an empty `cadastralId` CLEARS the ' +
        'cadastral link; a malformed one is a 400.',
});

const ParcelMergeRequest = MergeParcelsSchema.openapi('ParcelMergeRequest', {
    description:
        'Union ≥2 of the location’s parcels into one new parcel. The originals are SOFT-DELETED ' +
        'and their ids stop resolving — the response carries the new parcel only.',
});

const ParcelSplitRequest = SplitParcelSchema.openapi('ParcelSplitRequest', {
    description:
        'A GeoJSON LineString blade. It must fully cross the parcel into ≥2 pieces or the request ' +
        'is a 400 and nothing changes.',
});

// ─── Leases ─────────────────────────────────────────────────────────

const ParcelLease = z
    .object({
        id: z.string(),
        parcelId: z.string(),
        lessorName: z.string(),
        lessorEik: z.string().nullable(),
        kind: z.enum(['ARENDA', 'NAEM']),
        rentAmount: z.string().nullable().openapi({
            description: 'Decimal(14,2) → a JSON STRING, not a number. Parse it before arithmetic.',
        }),
        rentUnit: z.string().nullable().openapi({
            description:
                'The CANONICAL unit the rent roll groups by — derived from what was sent, not ' +
                'the operator’s literal text.',
        }),
        rentUnitRaw: z.string().nullable().openapi({ description: 'What the operator actually typed, verbatim.' }),
        startDate: z.string().nullable(),
        endDate: z.string().nullable(),
        documentRef: z.string().nullable(),
        notes: z.string().nullable(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
    })
    .openapi('ParcelLease', {
        description: 'One land-use agreement (аренда/наем) over a parcel.',
    });

const ParcelLeaseListResponse = z
    .object({ leases: z.array(ParcelLease) })
    .openapi('ParcelLeaseListResponse', {
        description:
            'Leases for one parcel, newest term first, capped at 100. Wrapped in `{ leases }` — ' +
            'the create and update return a BARE lease, unwrapped.',
    });

const ParcelLeaseRequest = ParcelLeaseSchema.openapi('ParcelLeaseRequest', {
    description:
        'Create/update payload for a lease. The same schema serves both, so a PATCH is a FULL ' +
        'replacement: an omitted optional field is written as null, not left alone. Dates are ' +
        'loose strings parsed server-side; an unparseable one becomes null rather than a 400.',
});

const ParcelLeaseDeleted = z
    .object({ id: z.string() })
    .openapi('ParcelLeaseDeleted', { description: 'The soft-deleted lease id.' });

// ─── Field operations on a location ─────────────────────────────────

const LocationOperationListItem = z
    .object({
        id: z.string(),
        key: z.string().nullable().optional(),
        title: z.string(),
        type: z.string(),
        status: z.string(),
        dueAt: z.string().datetime().nullable().optional(),
        createdAt: z.string().datetime(),
        assignee: UserRefSchema.nullable().optional(),
        _count: z.object({ operationParcels: z.number().int() }).optional(),
    })
    .passthrough()
    .openapi('LocationOperationListItem', {
        description:
            'A FIELD_OPERATION job on this location, resolved through the Task↔Location TaskLink, ' +
            'newest first. `_count.operationParcels` is the number of prescription lines.',
    });

const FieldOperationCreated = z
    .object({
        taskId: z.string(),
        taskKey: z.string().nullable().openapi({ description: 'The human `TSK-N` handle.' }),
        locationId: z.string(),
        parcelCount: z.number().int().openapi({
            description:
                'Lines written. `0` is the tell of a PARTIALLY COMMITTED create: the Task exists ' +
                'but has no location link, no operationType and no lines, and nothing can add ' +
                'them afterwards. It is also the discriminator the idempotent-replay check uses, ' +
                'so a replay only short-circuits on a job that really landed.',
        }),
    })
    .openapi('FieldOperationCreated', { description: 'Identity of the spray job that was created.' });

// ─── Map overview ───────────────────────────────────────────────────

const ParcelClusterOverview = z
    .object({
        clusters: z.array(
            z.object({
                id: z.string().openapi({
                    description:
                        'Hash of the SORTED member ids, not of the grid cell — so a cluster id in ' +
                        'a shared URL resolves to the same parcels, and only changes when the ' +
                        'membership genuinely differs.',
                }),
                lon: z.number(),
                lat: z.number(),
                count: z.number().int(),
                parcelIds: z.array(z.string()),
                totalAreaHa: z.number(),
                label: z.string().nullable().openapi({ description: 'Nearest settlement name.' }),
            }),
        ),
        parcels: z.array(z.object({ id: z.string(), lon: z.number(), lat: z.number() })).openapi({
            description:
                'Every POSITIONED parcel, so the view can switch from clusters to parcels once ' +
                'zoomed in — the cluster grid bottoms out at 200 m and cannot separate them.',
        }),
        bbox: z
            .array(z.number())
            .nullable()
            .openapi({
                minItems: 4,
                maxItems: 4,
                description:
                    'Bounding box as `[west, south, east, north]` — `[minLon, minLat, maxLon, maxLat]`, **longitude first**, per GeoJSON and the reverse of the `lat, lon` a human quotes. WGS84 degrees, exactly four numbers. Covers the POSITIONED parcels only — a location whose parcels all lack geometry contributes nothing to it.',
            }),
        positionedCount: z.number().int(),
        unpositionedCount: z.number().int().openapi({
            description:
                'Parcels with NULL geometry. Never folded into the total: a holding whose map ' +
                'silently omits 30 fields is data loss the farmer cannot see.',
        }),
        unpositionedParcelIds: z.array(z.string()),
        truncated: z.boolean().openapi({ description: 'The read hit its 2000-parcel bound; this is a subset.' }),
    })
    .openapi('ParcelClusterOverview', {
        description: 'Proximity clusters for a location’s parcels, labelled with the nearest settlement.',
    });

const LocationSmartDefaults = z
    .object({
        repeatLast: z
            .object({
                parcelIds: z.array(z.string()),
                productItemId: z.string(),
                doseValue: z.number(),
                doseUnitId: z.string(),
                occurredAt: z.string().datetime(),
            })
            .nullable()
            .openapi({ description: 'The latest field operation here, regrouped into one repeatable job.' }),
        byParcel: z
            .record(
                z.string(),
                z.object({ productItemId: z.string(), doseValue: z.number(), doseUnitId: z.string() }),
            )
            .openapi({ description: 'Last-used product + dose per parcel, keyed by parcel id.' }),
        defaultUnitId: z.string().nullable(),
        sprayWindow: z
            .object({
                status: z.string(),
                reasons: z.array(z.string()),
                reasonCodes: z.array(z.string()).openapi({
                    description: 'Structured codes — translate these; `reasons` is already-rendered prose.',
                }),
                obsDate: z.string(),
                windows: z.array(z.unknown()).openapi({
                    description:
                        'Suitable time ranges REMAINING today (past hours dropped or clipped). ' +
                        'Empty means none left today, which the daily `status` alone does not say.',
                }),
            })
            .nullable(),
        nextPlanting: z
            .object({
                id: z.string(),
                label: z.string(),
                stage: z.enum(['sow', 'transplant', 'harvest']),
                date: z.string(),
            })
            .nullable(),
    })
    .openapi('LocationSmartDefaults', {
        description: 'Pre-fill hints for the spray-job wizard on this location.',
    });

// ─── БАБХ farm records ──────────────────────────────────────────────



const FarmRecordSaved = z
    .object({ fileRecordId: z.string(), fileName: z.string() })
    .openapi('FarmRecordSaved', { description: 'Where the generated ДНЕВНИК was filed.' });

const FarmRecordRegister = z
    .object({
        records: z.array(
            z.object({
                fileRecordId: z.string(),
                fileName: z.string(),
                from: z.string(),
                to: z.string(),
                generatedAt: z.string().datetime(),
                auto: z.boolean().openapi({ description: 'Generated by the completion job rather than by hand.' }),
                generatedByName: z.string().nullable(),
                sizeBytes: z.number().int(),
            }),
        ),
        completeness: z.object({
            missingLabels: z.array(z.string()).openapi({
                description:
                    'Bulgarian labels of the FarmProfile / certificate fields still missing — ' +
                    '„Земеделски производител", „ЕИК", „сертификат на оператора". A non-blocking ' +
                    'nudge, not a validation error.',
            }),
        }),
    })
    .openapi('FarmRecordRegister', {
        description: 'The location’s generated ДНЕВНИК documents, newest first, plus a completeness nudge.',
    });

// ─── Imports ────────────────────────────────────────────────────────

/**
 * The envelope EVERY job executor returns, and which the poll routes hand back
 * verbatim as `result`.
 *
 * It was `z.unknown()` with prose saying `details` "carries the counters" —
 * no names, no types. A client could not model it without running an import
 * against a live tenant to see what came back, which is the measured-not-
 * contracted state this spec exists to end. Worse, checking it revealed the
 * spatial executor was not forwarding its reconciliation counts AT ALL: they
 * reached the audit log and the worker's return type and stopped there.
 */
const JobRunEnvelope = z
    .object({
        jobName: z.string(),
        jobRunId: z.string(),
        success: z.boolean(),
        startedAt: z.string().datetime(),
        completedAt: z.string().datetime(),
        durationMs: z.number(),
        /** Generic progress counters; per-job meaning lives in `details`. */
        itemsScanned: z.number(),
        itemsActioned: z.number(),
        itemsSkipped: z.number(),
        errorMessage: z.string().optional(),
        details: z.unknown().optional().openapi({
            description:
                'Per-job payload. For `spatial-import` it carries `tenantId`, `locationId`, ' +
                '`fileRecordId`, `format`, `bounds`, `jobRunId`, `parcelCount` and the ' +
                'reconciliation counts `matched` / `created` / `flagged` — see ' +
                '`SpatialImportDetails`. Other job names carry their own keys.',
        }),
    })
    .openapi('JobRunEnvelope', {
        description:
            'What an off-thread job returns. `itemsScanned`/`itemsActioned`/`itemsSkipped` are generic; the job-specific answer is in `details`.',
    });

/**
 * Registered so a client can generate a type for it even though `details` is
 * necessarily loose on the shared envelope — two different job kinds poll
 * through the same route.
 */
const SpatialImportDetails = z
    .object({
        tenantId: z.string(),
        locationId: z.string(),
        fileRecordId: z.string(),
        format: z.string(),
        /**
         * The shapes the FILE contained — `matched + created`. NOT the number
         * of parcels the location now has, and `flagged` is not part of it.
         */
        parcelCount: z.number(),
        /** Existing parcels the file matched and UPDATED IN PLACE, keeping their history. */
        matched: z.number(),
        /** Shapes that matched nothing and were inserted as new parcels. */
        created: z.number(),
        /**
         * Existing parcels the file did NOT contain. Kept with all of their
         * history and marked with `absentFromImportAt`; nothing is deleted by
         * an import. Reporting "imported N parcels" must not include these.
         */
        flagged: z.number(),
        bounds: z
            .array(z.number())
            .nullable()
            .openapi({
                minItems: 4,
                maxItems: 4,
                description:
                    'Bounding box as `[west, south, east, north]` — `[minLon, minLat, maxLon, maxLat]`, **longitude first**, per GeoJSON and the reverse of the `lat, lon` a human quotes. WGS84 degrees, exactly four numbers. Null when the import produced no bounded geometry.',
            }),
        jobRunId: z.string(),
    })
    .openapi('SpatialImportDetails', {
        description:
            'The `details` payload of a completed `spatial-import` job. parcelCount is matched + created — what the file contained. flagged counts existing parcels the file omitted, which were kept rather than deleted, so it is deliberately NOT part of parcelCount.',
    });

const ImportJobStatus = z
    .object({
        jobId: z.string().nullable(),
        state: z.string().openapi({ description: 'BullMQ job state: waiting, active, completed, failed, …' }),
        progress: z.unknown(),
        result: JobRunEnvelope.nullable().openapi({
            description:
                'The worker’s return value once `state` is completed. NULL until then — poll ' +
                'until `state` is `completed` rather than treating a null result as a failure.',
        }),
        failedReason: z.string().nullable().openapi({
            description:
                'ENGLISH free text, and a FALLBACK — not UI copy. It is whatever the worker ' +
                'threw, which is all BullMQ persists about a failure. Render it only when you ' +
                'do not recognise `failedCode`.',
        }),
        failedCode: z
            .string()
            .nullable()
            .openapi({
                description:
                    'Stable code for WHY the import failed, for a client that wants to say it ' +
                    'in its own language (#1447). NULL unless `state` is `failed`.\n\n' +
                    'Also null when the job DIED rather than refused — and in that case do ' +
                    'not show `failedReason`. A refusal names itself with a code, so a null ' +
                    'code means the message is whatever the exception carried: «connect ' +
                    'ECONNREFUSED 127.0.0.1:6379», a stack-trace line, an ORM error. Show ' +
                    'your own "something went wrong, try again" copy, as for ' +
                    '`SPATIAL_IMPORT_INTERNAL`. `failedReason` is the fallback for a code you ' +
                    'do not RECOGNISE — a sentence written for a person — not the fallback ' +
                    'for no code at all. (Raised by agrent-ios, who shipped this distinction ' +
                    'in their client before the spec said it.)\n\n' +
                    'A boundary upload (`getSpatialImportJob`) sends: ' +
                    '`SPATIAL_PARSE_TIMEOUT` (`params.seconds`) when the parse outran its ' +
                    'budget; `SPATIAL_TOO_MANY_PARCELS`, `SPATIAL_PARCEL_TOO_COMPLEX` and ' +
                    '`SPATIAL_IMPORT_TOO_COMPLEX` (each `params.limit`, plus `params.count` ' +
                    'or `params.vertices`) for the complexity caps; ' +
                    '`SPATIAL_GEOMETRY_UNPARSEABLE` and `SPATIAL_GEOMETRY_INVALID` ' +
                    '(`params.count`) for topology; `SPATIAL_SOURCE_CRS_UNRESOLVED` when a ' +
                    'prj-less projected layer could not be placed in Bulgaria; and ' +
                    '`SPATIAL_IMPORT_INTERNAL` for a broken server invariant — the one case ' +
                    'where the uploader can do nothing but retry, so it carries no params and ' +
                    'no detail.\n\n' +
                    'A cadastre import (`getCadastreImportJob`) sends ' +
                    '`CADASTRE_GEOMETRY_UNPARSEABLE`, `CADASTRE_GEOMETRY_INVALID` ' +
                    '(`params.count`) and `CADASTRE_SOURCE_CRS_UNRESOLVED`. Those three ' +
                    'conditions are the same ones the upload path hits, and they are ' +
                    'deliberately DIFFERENT codes: nobody uploaded a file, so "fix the ' +
                    'geometry and re-upload" is not the remedy. It also sends ' +
                    '`CADASTRE_NOT_CONFIGURED` when КАИС OpenData is not configured on the ' +
                    'deployment — `GET …/cadastre-import` reports that as `enabled: false` ' +
                    'up front, but the POST does not gate on it, so a client that enqueues ' +
                    'anyway learns it here — and `CADASTRE_IMPORT_INTERNAL`, the counterpart ' +
                    'of `SPATIAL_IMPORT_INTERNAL`.',
                example: 'SPATIAL_IMPORT_TOO_COMPLEX',
            }),
        failedParams: z
            .record(z.string(), z.union([z.string(), z.number()]))
            .nullable()
            .openapi({
                description:
                    'The scalars behind `failedCode`, to interpolate into your own sentence — ' +
                    'same contract as `ErrorResponse.params`: ids and quantities only, never ' +
                    'an object and never personal data. Sizes are raw integer BYTES, not ' +
                    'pre-formatted megabytes, so you format them in your own locale. Null ' +
                    'when the code needs no values.',
                example: { vertices: 812_340, limit: 500_000 },
            }),
    })
    .openapi('ImportJobStatus', {
        description:
            'Poll response for an off-thread import, shared by the boundary-upload and ' +
            'cadastre polls. A not-found or wrong-tenant job answers 404 instead of this ' +
            'shape — the canonical `ErrorResponse` envelope with `IMPORT_JOB_NOT_FOUND` for ' +
            '`getSpatialImportJob`, still a bare `{ error }` body for `getCadastreImportJob`.',
    });



const CadastreImportSettings = z
    .object({
        enabled: z.boolean().openapi({
            description:
                'Whether КАИС OpenData is configured on this deployment. The upstream URL is ' +
                'NEVER exposed — the client learns only the boolean.',
        }),
        maxIdentifiers: z.number().int(),
    })
    .openapi('CadastreImportSettings', { description: 'Whether the cadastre-import tab should be offered.' });

const CadastreImportRequest = z
    .object({ identifiers: z.array(z.string()).min(1) })
    .openapi('CadastreImportRequest', {
        description:
            'КАИС identifiers to import. Validated by hand in the handler, NOT by a Zod schema: ' +
            'non-string members are silently filtered out, and an empty result is a 400 carrying ' +
            'the bare `{ error }` body.',
    });

const CadastreImportAccepted = z
    .object({
        jobId: z.string(),
        accepted: z.number().int().openapi({ description: 'Valid, de-duplicated identifiers queued.' }),
        invalid: z.array(z.string()).openapi({ description: 'Normalised lines that failed validation, echoed back.' }),
        status: z.literal('queued'),
    })
    .openapi('CadastreImportAccepted', { description: 'The cadastre import was queued.' });

const SpatialImportUpload = z
    .object({
        file: z.string().openapi({
            format: 'binary',
            description:
                'Shapefile `.zip`, `.kml`/`.kmz`, or `.geojson`/`.json`. The byte cap is enforced ' +
                'on the declared size BEFORE the body is buffered: 5 MB for a shapefile, 10 MB ' +
                'for KML/GeoJSON.',
        }),
        cropType: z.string().optional().openapi({
            description: 'Default crop stamped on every imported parcel. Blank means "mixed / set later".',
        }),
    })
    .openapi('SpatialImportUpload', { description: 'multipart/form-data body for a parcel-boundary import.' });

const SpatialImportAccepted = z
    .object({
        jobId: z.string(),
        fileRecordId: z.string().openapi({ description: 'The staged upload; becomes Location.spatialFileId on success.' }),
        format: z.enum(['shapefile', 'kml', 'geojson']),
        status: z.literal('queued'),
    })
    .openapi('SpatialImportAccepted', {
        description:
            'The upload was staged and the parse queued. It has NOT been parsed yet — the ' +
            'parcels are replaced by the worker, so poll the job before refreshing the map.',
    });

// ─── Binary bodies ──────────────────────────────────────────────────

const VectorTileBody = z.string().openapi({
    format: 'binary',
    description: 'Mapbox Vector Tile (protobuf).',
});

const PdfBody = z.string().openapi({
    format: 'binary',
    description: 'The ДНЕВНИК as a PDF document.',
});

const rawErrorJson = { 'application/json': { schema: RawErrorResponseSchema } };
const plainTextError = { 'text/plain': { schema: z.string() } };

export function registerLocationPaths(registry: OpenAPIRegistry): void {
    // Registered explicitly because nothing REFERENCES it: `details` is
    // necessarily loose on the shared envelope (two job kinds poll through one
    // route), so a `$ref` there would over-claim. A client still needs a name
    // to generate a type from, and `.openapi()` alone only labels a schema —
    // it does not emit one that no path reaches.
    registry.register('SpatialImportDetails', SpatialImportDetails);

    // ─── Locations ──────────────────────────────────────────────────

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations',
        operationId: 'listLocations',
        summary: 'List locations',
        description:
            'Returns a FLAT ARRAY by default. Send `limit` or `cursor` and the SAME operation ' +
            'returns `{ items, pageInfo }` instead — a client must branch on the query it sent. ' +
            'Both shapes carry a weak ETag and honour `If-None-Match` with a 304.',
        tags: ['Locations'],
        params: TenantParams,
        query: LocationListQuery,
        success: {
            status: 200,
            description: 'An array of locations, or the paginated envelope (see description).',
            schema: z.union([z.array(LocationListItemDTOSchema), LocationListPage]),
        },
        extraResponses: {
            304: { description: 'Not Modified — the payload still matches the client’s `If-None-Match`.' },
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/locations',
        operationId: 'createLocation',
        summary: 'Create a location',
        description:
            'A plan gate runs first: a FREE tenant at its farm/field cap gets 403 with ' +
            '`code: "PLAN_LIMIT_EXCEEDED"` and `params` carrying `plan`, `resource`, ' +
            '`limit` and `current` (#1679) — a permission-shaped status for a billing ' +
            'condition, so do not treat every 403 here as "not allowed". The shared 403 ' +
            'description says what the code means and what a client should do with it. ' +
            'The `message` no longer begins with the legacy `plan_limit_exceeded:` prefix ' +
            '(#1677), which was this refusal\'s only identifier before #1679 — switch on ' +
            'the code. It is NOT yet translated: `PLAN_LIMIT_EXCEEDED` is one of the three ' +
            'whose Bulgarian needs ICU plural agreement, so it still carries an English ' +
            'developer-facing sentence rather than copy with `exchange_listing` ' +
            'interpolated into it. Parcels are added afterwards, by import or by drawing.',
        tags: ['Locations'],
        params: TenantParams,
        body: CreateLocationSchema,
        success: {
            status: 201,
            description: 'The created location, bare (no `{ success }` wrapper).',
            schema: LocationListItemDTOSchema,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}',
        operationId: 'getLocation',
        summary: 'Get one location',
        description:
            'The location row with its owner and parcel COUNT — it does NOT include the parcels ' +
            'themselves. Use `listLocationParcels` for those.',
        tags: ['Locations'],
        params: LocationParams,
        success: { status: 200, description: 'The location.', schema: LocationListItemDTOSchema },
    });

    for (const method of ['put', 'patch'] as const) {
        op(registry, {
            method,
            path: '/api/t/{tenantSlug}/locations/{id}',
            operationId: method === 'put' ? 'replaceLocation' : 'updateLocation',
            summary: method === 'put' ? 'Replace a location' : 'Update a location',
            description:
                'PATCH and PUT are the SAME handler (`export const PATCH = PUT`) and both apply a ' +
                'PARTIAL update — only the fields present are written. There is no optimistic ' +
                'lock on a location: no `If-Match`, no version, last write wins.',
            tags: ['Locations'],
            params: LocationParams,
            body: UpdateLocationSchema,
            success: { status: 200, description: 'The updated location, wrapped.', schema: LocationUpdated },
        });
    }

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/locations/{id}',
        operationId: 'deleteLocation',
        summary: 'Soft-delete a location',
        description:
            'ADMIN-gated. Refused with a 400 while the location still holds inventory lots — move ' +
            'or unassign them first. The row survives; reads filter it out.',
        tags: ['Locations'],
        params: LocationParams,
        success: { status: 200, description: 'Deleted.', schema: z.object({ success: z.literal(true) }) },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/locations/bulk/delete',
        operationId: 'bulkDeleteLocations',
        summary: 'Soft-delete several locations',
        description:
            'ADMIN-gated. WHOLE-BATCH refusal: if ANY location still holds stock the request is a ' +
            '400 and nothing is deleted — it runs in one transaction, so a partial delete would ' +
            'roll back anyway.',
        tags: ['Locations'],
        params: TenantParams,
        body: BulkDeleteLocationsSchema,
        success: { status: 200, description: 'How many were deleted.', schema: LocationBulkDeleteResult },
    });

    // ─── Parcels ────────────────────────────────────────────────────

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/parcels/by-crop',
        operationId: 'listParcelsByCrop',
        summary: 'Farm-wide parcels grouped by crop',
        description:
            'TWO answers behind one path, chosen by `crop`. **Without it** you get the farm\u2019s crops with parcel counts and total hectares, and no geometry \u2014 a crop picker draws nothing. **With it** you get that crop\u2019s parcels, each carrying the block it sits in and a simplified outline for a map beside the list.' +
            '\n\nSplit on a parameter rather than returned together because the caller shows ONE crop at a time: a single response carrying every crop\u2019s geometry would be large for a client that discards all but one group.' +
            '\n\n**This is the farm-wide read that `GET /locations/{id}/parcels` is not.** That one answers "what is in this block" and carries soil, ownership and lease state; this one answers "where on the farm is this crop" and carries the block name instead. Before it existed a client had to fan out one request per block and group them itself.' +
            '\n\n**Matching on `crop` is case-insensitive and trimmed.** `Parcel.cropType` is a free string that an import stamps, so stored rows can disagree about case among themselves; a value round-tripped from the crop list resolves regardless.' +
            '\n\n**An unknown crop is an empty list, not a 404.** A crop is not an entity here, so "no parcels carry this value" is an answer \u2014 and a 404 would leak whether a vocabulary value is in use.' +
            '\n\nParcels with no crop appear in NEITHER answer. "No crop" does not answer "which crop did you treat", and such a parcel is still reachable through the per-block list.' +
            '\n\nOrder is `name`, then `id`. The id tiebreak is contractual (#1391): parcel names are not unique, so without it a capped read could return a different subset between requests with nothing changed.',
        tags: ['Parcels'],
        params: TenantParams,
        query: z.object({
            crop: z.string().optional().openapi({
                param: { name: 'crop', in: 'query' },
                description:
                    'A crop value as returned by this same operation without the parameter. Omit for the crop list. Case-insensitive, trimmed; blank is treated as omitted.',
            }),
            simplify: z.coerce.number().optional().openapi({
                param: { name: 'simplify', in: 'query' },
                description:
                    'Geometry simplification tolerance in DEGREES. Geometry here is simplified either way \u2014 every caller draws a picker map \u2014 so this only chooses how much. A non-positive or unparseable value is IGNORED rather than refused: it is a display hint, and failing a parcel list over a tolerance that did not parse would turn a cosmetic mistake into an empty map. Ignored entirely without `crop`.',
            }),
        }),
        success: {
            status: 200,
            description: 'The farm\u2019s crops, or one crop\u2019s parcels when `crop` is given.',
            content: { 'application/json': z.union([ParcelCropTotals, ParcelsByCrop]) },
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/parcels',
        operationId: 'listLocationParcels',
        summary: 'List a location’s parcels',
        tags: ['Parcels'],
        params: LocationParams,
        query: z.object({
            simplify: z.coerce.number().optional().openapi({
                param: { name: 'simplify', in: 'query' },
                description:
                    'Geometry simplification tolerance in DEGREES, for a lighter display payload. Clamped to ' +
                    '0.01; a non-positive or unparseable value is ignored and full geometry is ' +
                    'returned. Never send it for sketch/edit — the simplified geometry would be ' +
                    'saved back.',
            }),
        }),
        success: { status: 200, description: 'The parcels, with the location’s bounds.', schema: LocationParcels },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/locations/{id}/parcels',
        operationId: 'createParcel',
        summary: 'Draw a parcel',
        description:
            'Enqueues an async SoilGrids fetch after commit, so `soilType` and `soilJson` stay ' +
            'null on the next read for a while. No `Idempotency-Key` is read here — a replayed ' +
            'create draws a SECOND parcel.',
        tags: ['Parcels'],
        params: LocationParams,
        body: ParcelCreateRequest,
        success: { status: 201, description: 'The new parcel’s id and area.', schema: ParcelCreated },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/locations/{id}/parcels/{parcelId}',
        operationId: 'updateParcel',
        summary: 'Edit or reshape a parcel',
        description:
            'PATCH only — there is no PUT alias. The `{id}` in the path is NOT checked against ' +
            'the parcel’s own location; the parcel is resolved by `{parcelId}` within the tenant.',
        tags: ['Parcels'],
        params: ParcelParams,
        body: ParcelUpdateRequest,
        success: { status: 200, description: 'The parcel’s re-derived area.', schema: ParcelUpdated },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/locations/{id}/parcels/{parcelId}',
        operationId: 'deleteParcel',
        summary: 'Soft-delete a parcel',
        tags: ['Parcels'],
        params: ParcelParams,
        success: { status: 200, description: 'Deleted; the location’s bounds are refreshed.', schema: z.object({ success: z.literal(true) }) },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/locations/{id}/parcels/merge',
        operationId: 'mergeParcels',
        summary: 'Merge parcels into their union',
        tags: ['Parcels'],
        params: LocationParams,
        body: ParcelMergeRequest,
        success: { status: 201, description: 'The union parcel.', schema: ParcelCreated },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/locations/{id}/parcels/{parcelId}/split',
        operationId: 'splitParcel',
        summary: 'Split a parcel along a drawn line',
        description:
            'The original is soft-deleted and each piece becomes a new parcel named ' +
            '`${original} (n)`. A blade that does not fully cross the parcel is a 400 and nothing ' +
            'changes.',
        tags: ['Parcels'],
        params: ParcelParams,
        body: ParcelSplitRequest,
        success: { status: 201, description: 'The pieces.', schema: ParcelSplitResult },
    });

    // ─── Leases ─────────────────────────────────────────────────────

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/parcels/{parcelId}/leases',
        operationId: 'listParcelLeases',
        summary: 'List a parcel’s leases',
        tags: ['Leases'],
        params: ParcelParams,
        success: { status: 200, description: 'The leases, wrapped in `{ leases }`.', schema: ParcelLeaseListResponse },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/locations/{id}/parcels/{parcelId}/leases',
        operationId: 'createParcelLease',
        summary: 'Record a lease over a parcel',
        tags: ['Leases'],
        params: ParcelParams,
        body: ParcelLeaseRequest,
        success: { status: 201, description: 'The created lease, BARE (not wrapped).', schema: ParcelLease },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/locations/{id}/parcels/{parcelId}/leases/{leaseId}',
        operationId: 'updateParcelLease',
        summary: 'Update a lease',
        description:
            'Despite the verb this is a FULL replacement — it validates the create schema, so ' +
            'every optional field you omit is written as null. Send the whole lease back.',
        tags: ['Leases'],
        params: LeaseParams,
        body: ParcelLeaseRequest,
        success: { status: 200, description: 'The updated lease.', schema: ParcelLease },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/locations/{id}/parcels/{parcelId}/leases/{leaseId}',
        operationId: 'deleteParcelLease',
        summary: 'Soft-delete a lease',
        tags: ['Leases'],
        params: LeaseParams,
        success: {
            status: 200,
            description: 'Deleted. Answers `{ id }` — NOT the `{ success: true }` the other deletes use.',
            schema: ParcelLeaseDeleted,
        },
    });

    // ─── Field operations on a location ─────────────────────────────

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/operations',
        operationId: 'listLocationOperations',
        summary: 'List a location’s field operations',
        tags: ['Field operations'],
        params: LocationParams,
        success: { status: 200, description: 'A flat array of jobs, newest first.', schema: z.array(LocationOperationListItem) },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/locations/{id}/operations',
        operationId: 'createFieldOperation',
        summary: 'Create a field operation (spray job)',
        description:
            'This is where a field operation is created — there is no POST under ' +
            '`/field-operations`. Exactly ONE input: a product OR a fertilizer, never both and ' +
            'never neither, and the chosen kind’s dose and unit are then required.\n\n' +
            'Send `Idempotency-Key` — the outbox replays a queued job with its item id, and the ' +
            'usecase returns the original instead of a duplicate. The replay check requires ' +
            '`parcelCount > 0` on the existing job, because the create spans TWO transactions ' +
            'and a crash between them leaves a Task with no lines that must NOT be reported as ' +
            'synced.' +
            '\n\n**400 codes for the input a job applies.** `OPERATION_INPUT_AMBIGUOUS` — not exactly one kind, or an id AND a name for the same kind. `PRODUCT_DOSE_REQUIRED` / `FERTILIZER_DOSE_REQUIRED` — the chosen kind needs its dose and unit. `PRODUCT_NOT_FOUND` / `FERTILIZER_NOT_FOUND` — the id names nothing in this farm. `FERTILIZER_EXPECTED` — the fertiliser field was given an item that is not a `FERTILIZER`. **The converse is deliberately NOT enforced**: a liquid fertiliser applied through a sprayer is a legitimate SPRAY, so the product field accepts any category. `PRODUCT_NAME_REQUIRED` — a `productName` empty once trimmed and sanitised. `PESTICIDE_REGULATORY_FIELDS_REQUIRED` — a typed name has to CREATE a plant protection product and `newProductRegistration` is missing a field, named in `params.missing`. `DOSE_UNIT_HAS_NO_BASE` — a typed name has to create a product but the dose unit is not a `<base>-per-<area>` rate, so no stock unit can be derived; create the product from the catalogue instead.',
        tags: ['Field operations'],
        params: LocationParams,
        body: CreateFieldOperationSchema,
        success: { status: 201, description: 'The job that was created, or the original on a replay.', schema: FieldOperationCreated },
    });

    // ─── Map ────────────────────────────────────────────────────────

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/parcel-clusters',
        operationId: 'getParcelClusters',
        summary: 'Proximity clusters for the 2D overview',
        description: 'Carries a weak ETag and honours `If-None-Match` with a 304.',
        tags: ['Map'],
        params: LocationParams,
        query: z.object({
            zoom: z.coerce.number().min(1).max(20).optional().openapi({
                param: { name: 'zoom', in: 'query' },
                description: 'Clustering grid pitch. Out-of-range values are a 400, not a clamp.',
            }),
        }),
        success: { status: 200, description: 'The clustered overview.', schema: ParcelClusterOverview },
        extraResponses: {
            304: { description: 'Not Modified — the payload still matches the client’s `If-None-Match`.' },
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/tiles/{z}/{x}/{y}',
        operationId: 'getParcelTile',
        summary: 'Parcel vector tile (MVT)',
        description:
            'BINARY, not JSON — `application/vnd.mapbox-vector-tile`, `Cache-Control: private, ' +
            'max-age=300`. Tenant- and location-scoped in the repository, so a tile can never ' +
            'carry another field’s parcels. A bad tile address is a 400 whose body is PLAIN TEXT ' +
            '(`Invalid tile coordinates`), not the error envelope.',
        tags: ['Map'],
        params: TileParams,
        success: {
            status: 200,
            description: 'The tile.',
            content: { 'application/vnd.mapbox-vector-tile': VectorTileBody },
        },
        extraResponses: {
            204: { description: 'No parcel touches this tile. The map skips it; this is not an error.' },
            400: { description: 'Invalid tile coordinates. PLAIN TEXT body.', content: plainTextError },
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/basemap/{z}/{x}/{y}',
        operationId: 'getBasemapTile',
        summary: 'Same-origin basemap tile (offline pack)',
        description:
            'Re-serves public-domain MapLibre demotiles SAME-ORIGIN so an installed field client ' +
            'can pre-download a location’s backdrop; the service worker passes cross-origin tile ' +
            'requests through untouched, which is why the map blanks at zero bars without this.\n\n' +
            'Bounded to the demotiles zoom range AND, when the location has one, to its bbox — a ' +
            'tile outside it is a 404, so this can never fan out into an unbounded crawl.\n\n' +
            'Read `X-Basemap-Source` on EVERY response. The 204s mean opposite things: ' +
            '`upstream-empty` is a correct "nothing here, the pack is complete", while ' +
            '`upstream-unreachable` is a failure. Counting both as cached produced a full sweep ' +
            'of 204s and a cheerful "Offline map ready" over an empty pack.',
        tags: ['Map'],
        params: TileParams,
        success: {
            status: 200,
            description:
                'The tile. `X-Basemap-Source` is `upstream` or `fixture`; `Cache-Control: public, ' +
                'max-age=604800, immutable`.',
            content: { 'application/x-protobuf': VectorTileBody },
        },
        extraResponses: {
            204: {
                description:
                    'No tile bytes. `X-Basemap-Source: upstream-empty` means there genuinely is ' +
                    'nothing at this address; `upstream-unreachable` means the fetch failed or ' +
                    'timed out after 5s and the pack is INCOMPLETE.',
            },
            400: { description: 'Invalid tile coordinates. PLAIN TEXT body.', content: plainTextError },
            502: { description: 'The upstream answered, but not with a tile. Empty body.' },
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/smart-defaults',
        operationId: 'getLocationSmartDefaults',
        summary: 'Spray-job pre-fill hints',
        tags: ['Locations'],
        params: LocationParams,
        success: { status: 200, description: 'The hints. Every branch is independently nullable.', schema: LocationSmartDefaults },
    });

    // ─── БАБХ farm records ──────────────────────────────────────────

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/locations/{id}/farm-record',
        operationId: 'generateFarmRecord',
        summary: 'Generate the БАБХ ДНЕВНИК',
        description:
            'ONE 200 with TWO media types, chosen by the `save` flag in the body. Default ' +
            '(`save` absent or false) → `application/pdf` bytes with `Content-Disposition: ' +
            'attachment`. `save: true` → `application/json` `{ fileRecordId, fileName }`, with ' +
            'the PDF filed in the register instead. Negotiate on what you SENT; an `Accept` ' +
            'header has no effect.\n\n' +
            'Read-only data, authorised by `assertCanRead` inside the generator. Runs on the ' +
            'Node runtime with a 60s budget.',
        tags: ['Farm records'],
        params: LocationParams,
        body: FarmRecordGenerateSchema,
        success: {
            status: 200,
            description: 'The ДНЕВНИК as PDF bytes, or the saved file’s identity when `save` was true.',
            content: { 'application/pdf': PdfBody, 'application/json': FarmRecordSaved },
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/farm-records',
        operationId: 'listFarmRecords',
        summary: 'The location’s ДНЕВНИК register',
        tags: ['Farm records'],
        params: LocationParams,
        success: { status: 200, description: 'The generated documents plus a completeness nudge.', schema: FarmRecordRegister },
    });

    // ─── Imports ────────────────────────────────────────────────────

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/cadastre-import',
        operationId: 'getCadastreImportSettings',
        summary: 'Is cadastre import available?',
        description:
            'Requires WRITE permission even though it only reads a flag — the answer gates a ' +
            'write-only tab.',
        tags: ['Imports'],
        params: LocationParams,
        success: { status: 200, description: 'Whether the feature is configured, and the identifier cap.', schema: CadastreImportSettings },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/locations/{id}/cadastre-import',
        operationId: 'startCadastreImport',
        summary: 'Import parcels by КАИС identifier',
        description:
            'Stages the walk and queues it off-thread; poll `getImportJobStatus`. A missing or ' +
            'empty `identifiers` array answers 400 with the BARE `{ error }` body, not the ' +
            'canonical envelope.',
        tags: ['Imports'],
        params: LocationParams,
        body: CadastreImportRequest,
        success: { status: 202, description: 'Queued.', schema: CadastreImportAccepted },
        extraResponses: {
            400: { description: 'No usable identifiers. BARE `{ error }` body.', content: rawErrorJson },
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/cadastre-import/{jobId}',
        operationId: 'getCadastreImportJob',
        summary: 'Poll a cadastre import',
        description: 'On completion `result` carries the imported / notFound counters.',
        tags: ['Imports'],
        params: JobParams,
        success: { status: 200, description: 'The job’s state.', schema: ImportJobStatus },
        extraResponses: {
            404: {
                description:
                    'Unknown job, or one belonging to another tenant or location — deliberately ' +
                    'indistinguishable. BARE `{ error }` body.',
                content: rawErrorJson,
            },
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/locations/{id}/spatial-import',
        operationId: 'startSpatialImport',
        summary: 'Upload parcel boundaries',
        description:
            'multipart/form-data. The parse NEVER runs on the request thread — the handler ' +
            'validates the extension, enforces the per-format byte cap on `file.size` before ' +
            'buffering anything, stages the bytes and queues the job. The worker REPLACES the ' +
            'location’s parcels, so nothing has changed yet when this returns; poll ' +
            '`getSpatialImportJob` first.\n\n' +
            'Every failure answers the canonical `ErrorResponse` envelope with a code (#1447). It did NOT until then: it answered a bare `{ error: "<sentence>" }`, and with no code to translate by a native client passed the English sentence through to a Bulgarian screen. Switch on `error.code`; `message` is only the fallback for a code you do not recognise.',
        tags: ['Imports'],
        params: LocationParams,
        body: SpatialImportUpload,
        bodyContentType: 'multipart/form-data',
        success: { status: 202, description: 'Staged and queued.', schema: SpatialImportAccepted },
        extraResponses: codedErrorResponses({
            400:
                'Missing, non-file, or empty upload. `error.code` is `FILE_REQUIRED` when no ' +
                'file part was sent and `FILE_EMPTY` when one was sent with no bytes — a ' +
                'different fix for the person uploading, which is why they are two codes.',
            413:
                'Over the per-format byte cap. `error.code` is `SPATIAL_UPLOAD_TOO_LARGE`, with ' +
                '`params.sizeBytes`, `params.limitBytes` and `params.format`. The caps differ ' +
                'per format (5 MB shapefile, 10 MB KML·GeoJSON), so the limit TRAVELS rather ' +
                'than being restated by each client. Raw integer bytes and not the «5.0 MB» ' +
                'the message uses: that string carries an English decimal point, and a client ' +
                'writing «7,2 MB» would have had to parse it back out (#1447).',
            415:
                'Unsupported extension. `error.code` is `UNSUPPORTED_FILE_TYPE`, with the ' +
                'accepted extensions in `params.allowed` so a client can list them in its own ' +
                'language.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/locations/{id}/spatial-import/{jobId}',
        operationId: 'getSpatialImportJob',
        summary: 'Poll a boundary import',
        description:
            'On completion `result.details` carries parcelCount / format / bounds; on failure ' +
            '`failedCode` + `failedParams` carry the complexity, topology or CRS refusal in a ' +
            'form you can translate, and `failedReason` keeps the English sentence as the ' +
            'fallback. See `ImportJobStatus.failedCode` for the codes this poll can send.',
        tags: ['Imports'],
        params: JobParams,
        success: { status: 200, description: 'The job’s state.', schema: ImportJobStatus },
        extraResponses: codedErrorResponses({
            404:
                '`error.code` is `IMPORT_JOB_NOT_FOUND`. Unknown job, or one belonging to ' +
                'another tenant or location — deliberately INDISTINGUISHABLE: the same code, ' +
                'the same message and no params on either branch. Telling them apart would ' +
                'make job ids enumerable across tenants, so do not expect a reason.',
        }),
    });
}
