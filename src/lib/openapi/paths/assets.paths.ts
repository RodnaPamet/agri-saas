/**
 * The asset register — machines, buildings, storage and tools (#3080).
 *
 * Eighteen operations over eleven paths. Its own module rather than an
 * extension of `machines.paths.ts`, and that file says why from its own side:
 * a position trace is personal data by linkage, so the live-location surface
 * is deliberately NOT filed with the equipment list. The register is the
 * inventory; machine tracking is who was where. An `Asset` id is the join
 * between them, which is the only thing they share.
 *
 * Three things in here are contract rather than formatting, and each one is
 * capable of handing a client a confidently wrong answer.
 *
 * ── `GET /assets` serves THREE different bodies ──
 *
 * Not a simplification: the handler has two early returns before the branch
 * that does the enriching work, so the envelope AND the row shape both depend
 * on which query parameters were sent. Documented per branch below, because a
 * single `oneOf` with no explanation is how a client picks the wrong one.
 *
 * The divergence is a defect rather than a design, and it is filed as #3272 —
 * the `includeDeleted` branch additionally discards every filter it was sent.
 * The spec describes what the endpoint DOES; it is not the place to pretend
 * the three branches agree.
 *
 * ── The four KPI counts are not a partition ──
 *
 * `active + retired` can exceed `total`, by construction. Each card drops its
 * OWN facet from its own `where` so that the card stays meaningful while that
 * facet is filtered, which is right for four independent headline numbers and
 * nonsense in a pie chart. Spelled out on the operation.
 *
 * ── Decimal columns are decimal STRINGS ──
 *
 * `meterAtService`, `cost` and `nextDueMeter` are `Decimal` in Prisma, so they
 * arrive as strings — `"1250.5"`, not `1250.5`. The write side takes numbers.
 * Same rule as `leases`, `planning` and `catalog`; `machines.paths.ts` carries
 * the reasoning at length for coordinates.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import {
    CreateAssetSchema,
    UpdateAssetSchema,
    LinkAssetEvidenceSchema,
    CreateAssetMaintenanceSchema,
    CloseAssetMaintenanceSchema,
    BulkDeleteAssetSchema,
} from '@/lib/schemas';
import { EvidenceLinkDTOSchema, EvidenceListItemDTOSchema } from '@/lib/dto/evidence.dto';
import { codedErrorResponses, op } from './helpers';

const TAGS = ['Assets'];

/**
 * The two refusals every asset sub-resource shares.
 *
 * `ASSET_NOT_FOUND` is the SAME answer for an id that does not exist and one
 * belonging to another farm — distinguishing them would make the register an
 * enumerator, which is the rule `machines.paths.ts` applies to the same ids.
 */
const ASSET_404 =
    '`ASSET_NOT_FOUND` — no such asset on this farm. An id that exists under a '
    + 'DIFFERENT tenant answers identically, deliberately: a distinguishable '
    + '404 would let a caller enumerate other farms’ registers one id at a '
    + 'time.';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm whose register this is.' }),
});

const AssetParams = TenantParams.extend({
    id: z.string().openapi({ description: 'The asset id.' }),
});

const MaintenanceParams = AssetParams.extend({
    maintenanceId: z.string().openapi({
        description:
            'The maintenance record. Scoped to the asset in the path — a record belonging to '
            + 'another asset on the same farm is refused, so the pair is validated rather than '
            + 'the id alone.',
    }),
});

const EvidenceLinkParams = AssetParams.extend({
    evidenceId: z.string().openapi({ description: 'The attached evidence row to detach.' }),
});

// ─── Shared query facets ───

/**
 * The three multi-select facets and the search term.
 *
 * Every facet is COMMA-JOINED, not repeated: `?type=TRACTOR,HARVESTER`, never
 * `?type=TRACTOR&type=HARVESTER`. That is what the web client's filter layer
 * emits, and reading it as a scalar is what once reached Prisma as an enum
 * equality on the literal string `"TRACTOR,HARVESTER"` and answered 500 where
 * the caller had earned a 400 (#2950's sibling). An invalid member is a 400
 * naming it; a CLEARED facet must be OMITTED rather than sent empty.
 */
const AssetFilterQuery = z.object({
    type: z
        .string()
        .optional()
        .openapi({
            description:
                'Comma-separated `AssetType` members: `TRACTOR`, `HARVESTER`, `IMPLEMENT`, '
                + '`VEHICLE`, `IRRIGATION`, `BUILDING`, `STORAGE`, `LIVESTOCK_EQUIPMENT`, '
                + '`TOOL`, `OTHER`. Every member is validated — one bad member refuses the '
                + 'whole request with a 400 rather than silently dropping it.',
            example: 'TRACTOR,HARVESTER',
        }),
    status: z
        .string()
        .optional()
        .openapi({
            description: 'Comma-separated `AssetStatus`: `ACTIVE`, `IN_MAINTENANCE`, `RETIRED`.',
            example: 'ACTIVE',
        }),
    criticality: z
        .string()
        .optional()
        .openapi({
            description: 'Comma-separated `Criticality`: `LOW`, `MEDIUM`, `HIGH`.',
            example: 'HIGH',
        }),
    q: z.string().optional().openapi({
        description:
            'Case-insensitive substring over FIVE columns — `name`, `manufacturer`, `model`, '
            + '`serialNumber` and the free-text `owner`. Not the structured assignee: a search '
            + 'for a colleague’s name matches only where somebody typed it into the keeper '
            + 'field, never `ownerUserId`.',
        example: 'fendt',
    }),
});

const ListQuery = AssetFilterQuery.extend({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({
        description:
            'Page size. PRESENCE of this or `cursor` switches the response to the paginated '
            + 'envelope — see the operation description, because the row shape changes with '
            + 'it. Clamped to 1–100; absent means 20 once paginating.',
    }),
    cursor: z.string().optional().openapi({
        description:
            'Opaque forward cursor from `pageInfo.nextCursor`. Do not construct or parse it. '
            + 'A stale or malformed cursor restarts the listing rather than erroring.',
    }),
    includeDeleted: z.enum(['true', 'false']).optional().openapi({
        description:
            'ADMIN only, and it REPLACES the read rather than widening it. `true` returns '
            + 'live and soft-deleted rows as a bare array, and — this is a defect, tracked '
            + 'as #3272, not a contract to rely on — every other parameter on this operation '
            + 'is silently ignored: the filters above, `q`, `limit` and `cursor` alike. The '
            + 'rows also arrive WITHOUT `ownerUser` and without the task counts. Treat it as '
            + 'a separate trash-can endpoint that happens to share a path, send it alone, and '
            + 'filter client-side, which is what the web UI does.',
    }),
});

// ─── Row shapes ───

const OwnerUserSchema = z
    .object({
        id: z.string(),
        name: z.string().nullable(),
        email: z.string().nullable(),
    })
    .openapi('AssetOwnerUserRef');

/**
 * The register row.
 *
 * `owner` and `ownerUserId` are two different ideas and both are kept: the
 * first is free text for a keeper who may not have an account, the second a
 * real membership. The list UI prefers the resolved user's name when there is
 * one, which is why `ownerUser` is resolved server-side rather than left to a
 * second request.
 */
const AssetSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        name: z.string(),
        type: z.enum([
            'TRACTOR', 'HARVESTER', 'IMPLEMENT', 'VEHICLE', 'IRRIGATION',
            'BUILDING', 'STORAGE', 'LIVESTOCK_EQUIPMENT', 'TOOL', 'OTHER',
        ]),
        status: z.enum(['ACTIVE', 'IN_MAINTENANCE', 'RETIRED']).openapi({
            description:
                'Never changed as a side effect of logging maintenance. Opening or closing a '
                + 'record returns a `suggestStatus` for the caller to act on; the server does '
                + 'not flip this, because an operator recording an oil change after the fact '
                + 'would not expect the machine to go into maintenance retroactively.',
        }),
        criticality: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable(),
        owner: z.string().nullable().openapi({
            description:
                'FREE TEXT keeper. Not a user reference and not validated against membership.',
        }),
        ownerUserId: z.string().nullable().openapi({
            description:
                'The assigned person, as a `User` id. Checked against ACTIVE membership of '
                + 'this farm on write (#3208), so a body naming somebody else’s user is '
                + 'refused rather than stored.',
        }),
        ownerUser: OwnerUserSchema.nullable().optional().openapi({
            description:
                'Resolved from `ownerUserId`. **Present on the flat read ONLY** — the '
                + 'paginated and `includeDeleted` branches omit it, which is #3272. Absent '
                + 'here never means unassigned; read `ownerUserId` for that.',
        }),
        externalRef: z.string().nullable(),
        location: z.string().nullable().openapi({
            description: 'Free-text location. The structured one is `locationId`.',
        }),
        locationId: z.string().nullable().openapi({
            description:
                'A `Location` id — a «блок» in this product’s vocabulary. Distinct from '
                + '`location` above, which is whatever somebody typed.',
        }),
        manufacturer: z.string().nullable(),
        model: z.string().nullable(),
        serialNumber: z.string().nullable(),
        year: z.number().int().nullable(),
        usefulLifeYears: z.number().int().nullable(),
        purchaseDate: z.string().datetime().nullable(),
        purchaseCost: z.string().nullable().openapi({
            description: 'Decimal as a STRING. See the module note.',
        }),
        deletedAt: z.string().datetime().nullable().openapi({
            description:
                'Non-null only on the `includeDeleted` read. Soft-deleted rows are invisible '
                + 'to every other operation here, including `GET /assets/{id}`.',
        }),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
    })
    .openapi('Asset');

/**
 * The flat read's row — the register row plus two derived task counts.
 *
 * The counts come from `TaskLink` rows of entity type `ASSET`, resolved in one
 * batched query rather than per row. They are **absent from the other two
 * branches** (#3272), so a client that starts paging loses them.
 */
const AssetListRowSchema = AssetSchema.extend({
    taskTotal: z.number().int().openapi({
        description: 'Linked work items, all states. 0 when none, never absent on this branch.',
    }),
    taskDone: z.number().int().openapi({
        description: 'Of those, the completed ones. `taskTotal - taskDone` is what is outstanding.',
    }),
}).openapi('AssetListRow');

const AssetPageSchema = z
    .object({
        items: z.array(AssetSchema).openapi({
            description:
                'Ordered `createdAt` DESC then `id` DESC — a TOTAL order, so the cursor cannot '
                + 'skip or repeat a row when two assets share a creation timestamp. Rows on '
                + 'this branch carry neither `ownerUser` nor the task counts (#3272).',
        }),
        pageInfo: z
            .object({
                nextCursor: z.string().nullable().openapi({
                    description: 'Pass back as `cursor`. Null on the last page.',
                }),
                hasNextPage: z.boolean(),
            })
            .openapi('AssetPageInfo'),
    })
    .openapi('AssetPage');

const AssetKpiSchema = z
    .object({
        total: z.number().int().openapi({
            description: 'Matches the filters EXACTLY as sent, including `status` and `criticality`.',
        }),
        active: z.number().int().openapi({
            description:
                'ACTIVE assets within the filters — **ignoring any `status` filter**, so the '
                + 'card still says something while the user is looking at one status.',
        }),
        critical: z.number().int().openapi({
            description:
                'HIGH-criticality assets within the filters, ignoring any `criticality` filter, '
                + 'for the same reason.',
        }),
        retired: z.number().int().openapi({
            description: 'RETIRED assets within the filters, ignoring any `status` filter.',
        }),
    })
    .openapi('AssetKpiCounts', {
        description:
            'Four INDEPENDENT headline counts, computed in the database over the whole '
            + 'matching set rather than over a page — which is the reason this is a separate '
            + 'endpoint from the list at all.\n\n'
            + '**They are not a partition and must not be summed or charted against each '
            + 'other.** Each card drops its own facet from its own query, so under '
            + '`?status=ACTIVE` the `total` equals `active` while `retired` stays non-zero. '
            + 'That is correct for four cards that each have to remain meaningful when their '
            + 'own facet is filtered, and it means `active + retired` can exceed `total`.\n\n'
            + '`total` is also how a client learns the flat list was truncated: that branch '
            + 'caps at 1,000 rows with no flag in the body, so comparing the array length '
            + 'against this number is the intended signal.',
    });

const AssetActivityEntrySchema = z
    .object({
        id: z.string(),
        action: z.string().openapi({
            description:
                'The audit verb — `CREATE`, `UPDATE`, `SOFT_DELETE`, `ENTITY_RESTORED`, '
                + '`ENTITY_PURGED` and the evidence/link verbs. A bare string rather than an '
                + 'enum: this API does not constrain the audit vocabulary, and a client that '
                + 'switches on it needs a default arm.',
            example: 'UPDATE',
        }),
        createdAt: z.string().datetime(),
        user: z
            .object({ id: z.string(), name: z.string().nullable() })
            .nullable()
            .openapi({
                description:
                    'Who acted. NO email — an activity feed is one of the places where leaking '
                    + 'it would be inappropriate, so only id and name are selected. Null for a '
                    + 'system action.',
            }),
    })
    .openapi('AssetActivityEntry');

const MaintenanceRecordSchema = z
    .object({
        id: z.string(),
        assetId: z.string(),
        kind: z.enum(['SERVICE', 'REPAIR', 'INSPECTION', 'BREAKDOWN']),
        openedAt: z.string().datetime(),
        closedAt: z.string().datetime().nullable().openapi({
            description:
                'Null while the work is open. Closing the LAST open record is what offers to '
                + 'put the asset back to ACTIVE.',
        }),
        meterAtService: z.string().nullable().openapi({
            description:
                'Engine hours or odometer AT THE TIME of service, as a decimal string. Stored '
                + 'per record rather than read from the asset’s current meter, so "hours since '
                + 'last service" stays answerable after the meter has moved on.',
        }),
        description: z.string().nullable().openapi({
            description: 'Free text, sanitised at the usecase layer before storage.',
        }),
        cost: z.string().nullable().openapi({ description: 'Decimal as a STRING.' }),
        nextDueAt: z.string().datetime().nullable().openapi({
            description:
                'Next service due by DATE. Nothing in the product reads it yet — it is stored '
                + 'so a service-due signal becomes possible without back-filling history.',
        }),
        nextDueMeter: z.string().nullable().openapi({
            description: 'Next service due by METER, as a decimal string. Also not yet read.',
        }),
        createdAt: z.string().datetime(),
        createdByUserId: z.string().nullable(),
    })
    .openapi('AssetMaintenanceRecord');

/**
 * `suggestStatus` is ADVISORY. The server has not changed anything.
 */
const SUGGEST_STATUS =
    'A status the caller MAY now want to set on the asset, or null. **Advisory only — the '
    + 'server has not changed `Asset.status`.** Opening a record on an ACTIVE asset suggests '
    + '`IN_MAINTENANCE`; closing the LAST open record on an `IN_MAINTENANCE` asset suggests '
    + '`ACTIVE`. Null whenever neither holds, which includes the case that matters: a machine '
    + 'with two open repairs is not fixed because one of them finished. Acting on it is a '
    + 'separate `PATCH /assets/{id}`.';

const MaintenanceCreateResultSchema = z
    .object({
        record: MaintenanceRecordSchema,
        suggestStatus: z.enum(['IN_MAINTENANCE']).nullable().openapi({ description: SUGGEST_STATUS }),
    })
    .openapi('AssetMaintenanceCreateResult');

const MaintenanceCloseResultSchema = z
    .object({
        record: MaintenanceRecordSchema,
        suggestStatus: z.enum(['ACTIVE']).nullable().openapi({ description: SUGGEST_STATUS }),
        openCount: z.number().int().openapi({
            description:
                'Records still open on this asset AFTER this close. Zero is what makes the '
                + 'suggestion above non-null; a non-zero value is why it is null.',
        }),
    })
    .openapi('AssetMaintenanceCloseResult');

const AttachedEvidenceSchema = z
    .object({
        links: z.array(EvidenceLinkDTOSchema).openapi({
            description:
                'ALWAYS EMPTY. The payload shape is shared with `<EvidenceSubTable>`, which '
                + 'renders inherited links for other entity types; an asset has none, so this '
                + 'is structurally `[]` rather than occasionally so. Do not build a client '
                + 'branch for it being populated.',
        }),
        evidence: z.array(EvidenceListItemDTOSchema).openapi({
            description:
                'Evidence attached DIRECTLY to this asset via `Evidence.assetId`, newest '
                + 'first, soft-deleted rows excluded.',
        }),
    })
    .openapi('AssetAttachedEvidence');

const SuccessSchema = z.object({ success: z.literal(true) }).openapi('AssetSuccess');

const UpdateResultSchema = z
    .object({ success: z.literal(true), asset: AssetSchema })
    .openapi('AssetUpdateResult');

const PurgeResultSchema = z
    .object({ success: z.literal(true), purged: z.literal(true) })
    .openapi('AssetPurgeResult');

const BulkDeleteResultSchema = z
    .object({
        deleted: z.number().int().openapi({
            description:
                'How many rows this call soft-deleted. May be LOWER than the ids sent — ids '
                + 'that do not exist, belong to another farm, or were already deleted are '
                + 'skipped rather than refused, so the call is idempotent. Zero is a '
                + 'successful no-op, not an error.',
        }),
    })
    .openapi('AssetBulkDeleteResult');


export function registerAssetPaths(registry: OpenAPIRegistry): void {
    // ── The register ──

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/assets',
        operationId: 'listAssets',
        summary: 'List the asset register',
        description:
            'Reads the farm’s machines, buildings, storage and tools.\n\n'
            + '**This operation returns one of THREE different bodies, chosen by query '
            + 'parameters, and the row shape changes with the envelope.** The divergence is a '
            + 'defect rather than a design — tracked as #3272 — and is documented because a '
            + 'client has to survive it today:\n\n'
            + '1. **No `limit`, `cursor` or `includeDeleted`** → a BARE ARRAY of '
            + '`AssetListRow`, newest first, capped at **1,000 rows with no flag in the '
            + 'body**. Rows carry the resolved `ownerUser` and the `taskTotal` / `taskDone` '
            + 'counts. Compare the array length against `total` from '
            + '`GET /assets/kpi` to find out whether you are seeing everything.\n\n'
            + '2. **`limit` or `cursor` present** → an `AssetPage` envelope '
            + '(`{items, pageInfo}`). Rows have NEITHER `ownerUser` NOR the task counts, so '
            + 'paging silently costs you the assignee name and the work-item counts you had '
            + 'while unpaged.\n\n'
            + '3. **`includeDeleted=true`** → a BARE ARRAY including soft-deleted rows, '
            + 'requiring ADMIN, **unbounded**, with no `ownerUser` and no task counts, and '
            + 'with every filter, `q`, `limit` and `cursor` SILENTLY IGNORED. Send it alone.\n\n'
            + 'So this one path carries two permission tiers: READ, and ADMIN as soon as '
            + '`includeDeleted=true` is sent. That is not discoverable from the path, which '
            + 'is why it is stated here.',
        tags: TAGS,
        params: TenantParams,
        query: ListQuery,
        success: {
            status: 200,
            description:
                'One of the three shapes above. `AssetListRow[]` for branch 1, `AssetPage` for '
                + 'branch 2, `Asset[]` for branch 3.',
            schema: z.union([z.array(AssetListRowSchema), AssetPageSchema, z.array(AssetSchema)]),
        },
        extraResponses: codedErrorResponses({
            400: 'A facet carried a member that is not in its enum, or `limit` is out of range. '
                + 'The refusal names the offending value rather than dropping it.',
            403: 'Not permitted to read this farm — or `includeDeleted=true` was sent by a '
                + 'non-ADMIN member, which is the same status for a different reason.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/assets',
        operationId: 'createAsset',
        summary: 'Add an asset to the register',
        description:
            '`name` and `type` are required; everything else is optional.\n\n'
            + '`type` is validated against the `AssetType` enum rather than accepted as a '
            + 'string, which is #2950: a typo, a lower-cased value or a localised label used '
            + 'to pass validation and fail at the database as a 500, leaving a mobile client '
            + 'with nothing to show the user. It is a 400 naming the field.\n\n'
            + '`ownerUserId`, if given, must be an ACTIVE member of this farm (#3208) — a body '
            + 'naming somebody else’s user is refused, not stored.',
        tags: TAGS,
        params: TenantParams,
        body: CreateAssetSchema,
        success: {
            status: 201,
            description: 'Created. The body is the stored row.',
            schema: AssetSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'Missing `name`, an unknown `type` / `status` / `criticality`, or an '
                + '`ownerUserId` that is not an active member of this farm.',
            403: 'Read-only on this farm, or the plan’s limits refuse another asset.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/assets/kpi',
        operationId: 'getAssetKpiCounts',
        summary: 'The four register headline counts',
        description:
            'Takes the SAME filter parameters as the list, so the cards always describe the '
            + 'set the user is looking at. Counted in the database over the whole matching '
            + 'population — deriving them from loaded rows is correct only while the list is '
            + 'unbounded, and the moment it pages "Total" quietly becomes "total on this '
            + 'page", which is a wrong number wearing a right one’s costume.\n\n'
            + 'Read `AssetKpiCounts` before using these: **they are four independent counts, '
            + 'not a breakdown, and summing them is meaningless.**\n\n'
            + 'Carries a weak `ETag`; send `If-None-Match` for a 304.',
        tags: TAGS,
        params: TenantParams,
        query: AssetFilterQuery,
        success: {
            status: 200,
            description: 'The four counts over the filtered set.',
            schema: AssetKpiSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'A facet carried a member that is not in its enum.',
        }),
    });

    // ── One asset ──

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/assets/{id}',
        operationId: 'getAsset',
        summary: 'Read one asset',
        description:
            'Soft-deleted assets are NOT visible here — a deleted id answers 404 exactly as a '
            + 'nonexistent one does. The trash can is `GET /assets?includeDeleted=true`.\n\n'
            + 'The row carries neither `ownerUser` nor the task counts; this is the plain '
            + 'register row.',
        tags: TAGS,
        params: AssetParams,
        success: { status: 200, description: 'The asset.', schema: AssetSchema },
        extraResponses: codedErrorResponses({ 404: ASSET_404 }),
    });

    for (const method of ['put', 'patch'] as const) {
        op(registry, {
            method,
            path: '/api/t/{tenantSlug}/assets/{id}',
            operationId: method === 'put' ? 'updateAsset' : 'patchAsset',
            summary: 'Update an asset',
            description:
                '**`PUT` and `PATCH` are the SAME handler** — the route exports '
                + '`PATCH = PUT` — and the semantics are PATCH’s on both: every field in the '
                + 'body is optional and only the fields present are written.\n\n'
                + 'So `PUT` does NOT replace the resource, and a client sending a partial body '
                + 'under `PUT` expecting the omitted fields to be cleared will find them '
                + 'untouched. Prefer `PATCH`, which says what actually happens. To CLEAR a '
                + 'nullable field, send it explicitly as `null` — omitting it leaves it '
                + 'alone.\n\n'
                + '`type` is enum-validated here as well as on create, and that is not an '
                + 'afterthought: #2950 named only the create schema, so fixing that alone '
                + 'would have left the identical 500 reachable through this route.\n\n'
                + 'The response is `{success, asset}` rather than the bare row — an envelope '
                + 'this domain uses only on its writes.',
            tags: TAGS,
            params: AssetParams,
            body: UpdateAssetSchema,
            success: {
                status: 200,
                description: 'Updated. `asset` is the stored row after the write.',
                schema: UpdateResultSchema,
            },
            extraResponses: codedErrorResponses({
                400: 'An unknown enum member, or an `ownerUserId` that is not an active member '
                    + 'of this farm.',
                404: ASSET_404,
            }),
        });
    }

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/assets/{id}',
        operationId: 'deleteAsset',
        summary: 'Soft-delete an asset',
        description:
            'SOFT delete: the row keeps its id, its maintenance history and its attached '
            + 'evidence, and is recoverable with `POST /assets/{id}/restore`. It disappears '
            + 'from every read here except `?includeDeleted=true`.\n\n'
            + 'ADMIN, unlike the update above, which needs only write.',
        tags: TAGS,
        params: AssetParams,
        success: { status: 200, description: 'Soft-deleted.', schema: SuccessSchema },
        extraResponses: codedErrorResponses({
            403: 'Not an administrator of this farm.',
            404: ASSET_404,
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/assets/{id}/restore',
        operationId: 'restoreAsset',
        summary: 'Restore a soft-deleted asset',
        description:
            'Clears `deletedAt`. ADMIN. The body is the restored row.\n\n'
            + 'Restoring an asset that is **not deleted** answers **404**, not 409 — and the '
            + '404s on this operation are UNCODED: they carry a `message` and no `error.code`, '
            + 'unlike the `ASSET_NOT_FOUND` every read here returns. Switch on the status, not '
            + 'on a code, and do not expect the two cases to be distinguishable '
            + 'programmatically.',
        tags: TAGS,
        params: AssetParams,
        success: { status: 200, description: 'Restored. The body is the row.', schema: AssetSchema },
        extraResponses: codedErrorResponses({
            403: 'Not an administrator of this farm.',
            404: 'No such asset on this farm, OR the asset is not deleted. Uncoded, and the '
                + 'two are not distinguishable from the response.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/assets/{id}/purge',
        operationId: 'purgeAsset',
        summary: 'Permanently delete a soft-deleted asset',
        description:
            'HARD delete — the row is gone and there is no undo. ADMIN.\n\n'
            + 'The asset MUST already be soft-deleted: purging a live one answers **404**, '
            + 'uncoded, like `restore` above. That two-step is the whole safety mechanism, so '
            + 'a client offering this should not chain it onto a delete.\n\n'
            + 'Maintenance records cascade with the row. The audit trail does NOT: the '
            + 'hash-chained entries describing this asset’s life, including the purge itself, '
            + 'survive it — so the activity feed outlives the asset while '
            + '`GET /assets/{id}` answers 404.',
        tags: TAGS,
        params: AssetParams,
        success: { status: 200, description: 'Purged.', schema: PurgeResultSchema },
        extraResponses: codedErrorResponses({
            403: 'Not an administrator of this farm.',
            404: 'No such asset on this farm, OR it has not been soft-deleted first. Uncoded.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/assets/bulk/delete',
        operationId: 'bulkDeleteAssets',
        summary: 'Soft-delete up to 100 assets',
        description:
            'The table’s selection action. ADMIN, soft delete, same recoverability as the '
            + 'single-asset route.\n\n'
            + 'PARTIAL SUCCESS is normal and is not reported as an error: ids that do not '
            + 'exist, belong to another farm, or were already deleted are skipped, and '
            + '`deleted` is how many rows actually moved. A caller that needs to know WHICH '
            + 'ids were skipped has to diff the count against what it sent — the response '
            + 'does not name them, deliberately, since naming an id as absent would answer a '
            + 'question about another farm’s register.',
        tags: TAGS,
        params: TenantParams,
        body: BulkDeleteAssetSchema,
        success: {
            status: 200,
            description: 'The number of rows soft-deleted. Zero is a successful no-op.',
            schema: BulkDeleteResultSchema,
        },
        extraResponses: codedErrorResponses({
            400: '`assetIds` was empty, missing, or longer than 100.',
            403: 'Not an administrator of this farm.',
        }),
    });

    // ── Activity ──

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/assets/{id}/activity',
        operationId: 'getAssetActivity',
        summary: 'This asset’s audit history',
        description:
            'A bounded read-only view of the immutable, hash-chained audit trail for this '
            + 'asset — the 50 most recent entries, newest first. The chain is never touched '
            + 'by this read.\n\n'
            + 'The cap is **fixed at 50 and there is no paging and no `truncated` flag**, so '
            + 'this is a recent-activity panel rather than a complete history: an asset with '
            + 'more than 50 events has older ones that this endpoint cannot reach at all.',
        tags: TAGS,
        params: AssetParams,
        success: {
            status: 200,
            description: 'Up to 50 entries, newest first.',
            schema: z.array(AssetActivityEntrySchema),
        },
        extraResponses: codedErrorResponses({ 404: ASSET_404 }),
    });

    // ── Maintenance ──

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/assets/{id}/maintenance',
        operationId: 'listAssetMaintenance',
        summary: 'Service, repair, inspection and breakdown log',
        description:
            'The machine’s maintenance history, newest first. Needs only READ — this is the '
            + 'tab a farm actually wants, and it is not gated behind the compliance-era '
            + 'surfaces a plain-farm tenant hides.',
        tags: TAGS,
        params: AssetParams,
        success: {
            status: 200,
            description: 'The log, newest first.',
            schema: z.array(MaintenanceRecordSchema),
        },
        extraResponses: codedErrorResponses({ 404: ASSET_404 }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/assets/{id}/maintenance',
        operationId: 'createAssetMaintenance',
        summary: 'Open or record a maintenance entry',
        description:
            'One endpoint for both "this machine is in the workshop now" and "record the '
            + 'service it had last month": send `closedAt` to log completed work, omit it to '
            + 'leave the record open.\n\n'
            + 'Read `suggestStatus` in the response. The server does NOT change the asset’s '
            + 'status — see the field description.',
        tags: TAGS,
        params: AssetParams,
        body: CreateAssetMaintenanceSchema,
        success: {
            status: 201,
            description: 'Created, with an advisory status suggestion.',
            schema: MaintenanceCreateResultSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'An unknown `kind`, a malformed timestamp, a negative meter or cost, or a '
                + 'description over 5,000 characters.',
            404: ASSET_404,
        }),
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/assets/{id}/maintenance/{maintenanceId}',
        operationId: 'closeAssetMaintenance',
        summary: 'Close a maintenance record',
        description:
            'CLOSING is the only mutation this record supports — there is no general edit. To '
            + 'correct a mistaken entry, delete it and create it again.\n\n'
            + '`openCount` in the response is how many records remain open on the asset, and '
            + 'it is what makes `suggestStatus` meaningful: a machine with two open repairs is '
            + 'not fixed because one of them finished.',
        tags: TAGS,
        params: MaintenanceParams,
        body: CloseAssetMaintenanceSchema,
        success: {
            status: 200,
            description: 'Closed, with the remaining open count and an advisory suggestion.',
            schema: MaintenanceCloseResultSchema,
        },
        extraResponses: codedErrorResponses({
            400: '`closedAt` is not a valid timestamp.',
            404: 'No such asset on this farm, or no such maintenance record ON THAT ASSET.',
        }),
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/assets/{id}/maintenance/{maintenanceId}',
        operationId: 'deleteAssetMaintenance',
        summary: 'Remove a mistaken maintenance record',
        description:
            'A HARD delete of the record — this history has no soft-delete tier, so there is '
            + 'no undo. It needs WRITE rather than ADMIN, unlike deleting the asset itself.\n\n'
            + 'Removing a record can change what a later close would suggest, since '
            + '`suggestStatus` is computed from how many records are still open. The asset’s '
            + 'own `status` is not touched.',
        tags: TAGS,
        params: MaintenanceParams,
        success: { status: 200, description: 'Removed.', schema: SuccessSchema },
        extraResponses: codedErrorResponses({
            404: 'No such asset on this farm, or no such maintenance record ON THAT ASSET.',
        }),
    });

    // ── Attached evidence ──

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/assets/{id}/evidence/attached',
        operationId: 'getAssetAttachedEvidence',
        summary: 'Evidence attached to this asset',
        description:
            'Evidence linked DIRECTLY to the asset via `Evidence.assetId` — a service invoice, '
            + 'a registration document, an inspection certificate. Newest first, soft-deleted '
            + 'rows excluded.\n\n'
            + 'The `links` array is always empty; see its description before writing a client '
            + 'branch for it.',
        tags: TAGS,
        params: AssetParams,
        success: {
            status: 200,
            description: 'The attached evidence, and an always-empty `links` array.',
            schema: AttachedEvidenceSchema,
        },
        extraResponses: codedErrorResponses({ 404: ASSET_404 }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/assets/{id}/evidence/attached',
        operationId: 'linkAssetEvidence',
        summary: 'Attach a URL as evidence on this asset',
        description:
            'For a LINK, not a file. **Uploading bytes goes to the multipart '
            + '`/evidence/uploads` endpoint with an `assetId`** — bytes have to reach the '
            + 'scanner, and this route never handles any.\n\n'
            + '`url` must be `https:`. That is contract-narrowing rather than XSS '
            + 'remediation: the loose URL validator in the installed zod accepts `http:`, '
            + '`ftp:`, `file:`, `data:` and `javascript:`, which is a field contract far wider '
            + 'than the field’s purpose. A plain `http://` link is refused.\n\n'
            + 'Note that an `https:` scheme is NOT a guarantee the server will fetch the '
            + 'link — nothing here does. It is stored and rendered.',
        tags: TAGS,
        params: AssetParams,
        body: LinkAssetEvidenceSchema,
        success: {
            status: 201,
            description: 'Attached.',
            schema: EvidenceListItemDTOSchema,
        },
        extraResponses: codedErrorResponses({
            400: '`url` is missing, is not `https:`, or `note` is over 2,000 characters.',
            404: ASSET_404,
        }),
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/assets/{id}/evidence/attached/{evidenceId}',
        operationId: 'unlinkAssetEvidence',
        summary: 'Detach evidence from this asset',
        description:
            'DETACHES rather than deletes — the vocabulary is deliberate. The evidence row '
            + 'survives and stays reachable in the evidence domain; what goes is the link to '
            + 'this asset. WRITE, not ADMIN.',
        tags: TAGS,
        params: EvidenceLinkParams,
        success: { status: 200, description: 'Detached.', schema: SuccessSchema },
        extraResponses: codedErrorResponses({
            404: 'No such asset on this farm, or no such evidence attached TO THAT ASSET.',
        }),
    });
}
