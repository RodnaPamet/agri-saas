/**
 * Process maps — the canvas, its version history, and two exports (#3080).
 *
 * Eight paths, twelve operations. This is the compliance/GRC surface that
 * survived the teardown: `processes.prisma` is gone, but the models moved to
 * `automation.prisma` rather than being deleted, so these routes are live.
 *
 * Four things here are contract rather than formatting.
 *
 * ── CERTIFICATION gates the WRITES, and reads stay open ──
 *
 * Owner ruling 2026-11-27 (#3291). A farm whose module is off keeps access to
 * maps it already made and to their PDF history, and simply cannot change
 * them. The gate lives in the usecase layer, so every write carries it.
 *
 * One asymmetry is deliberate: the COLLECTION read is gated too, because that
 * predates the ruling and the ruling kept it. So a farm with the module off
 * can open a map it holds an id for and cannot browse to it.
 *
 * ── A save REPLACES the graph; it does not merge ──
 *
 * `PUT /{id}` carries the whole canvas every time, and the repository swaps
 * it atomically. **A node omitted from a save is deleted.** There is no
 * per-node update path, by design: the canvas is the source of truth and the
 * server persists what it is handed.
 *
 * ── Restoring version N does not give you version N ──
 *
 * It gives you `expectedVersion + 1`, whose CONTENT equals N. History is
 * preserved rather than rewound, so a client that expects the version number
 * to go backwards is wrong. See the restore operation.
 *
 * ── A "practice" here is NOT the deleted GRC Practice ──
 *
 * `ProcessEdgePractice` outlived that table. Its `practiceId` FK and the
 * `Practice` model were both dropped in the teardown, so an edge-mounted
 * practice is now `practiceKey` + `label` + a free-form payload, with no row
 * to point at. The word is the same and the entity is not.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import {
    CreateProcessMapSchema,
    SaveProcessMapSchema,
    PatchProcessMapSchema,
    RestoreProcessMapSnapshotSchema,
    ProcessMapPdfExportSchema,
} from '@/app-layer/schemas/process-map';
import { codedErrorResponses, op } from './helpers';

const TAGS = ['Processes'];

const MAP_404 = 'No such process map on this farm.';

const MODULE_403 =
    '`MODULE_DISABLED` — the farm\'s CERTIFICATION module is off, or its plan '
    + 'does not include it (`details.reason` tells the two apart). Every WRITE '
    + 'on this surface carries this; the per-map reads deliberately do not.';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm whose maps these are.' }),
});

const MapParams = TenantParams.extend({
    id: z.string().openapi({ description: 'The process-map id.' }),
});

const VersionParams = MapParams.extend({
    version: z.string().openapi({
        description: 'The snapshot version number, as a path segment.',
        example: '3',
    }),
});

const ProcessMapSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
        canvasMode: z.enum(['DOCUMENT', 'AUTOMATION']).openapi({
            description:
                'Which editor the map opens in. In `AUTOMATION` the canvas SYNCS to '
                + 'automation rules, so a save there changes rule configuration as well as '
                + 'the drawing.',
        }),
        version: z.number().int().openapi({
            description:
                'Increments on every save AND on every restore. Send it back as '
                + '`expectedVersion` to make the next write conditional.',
        }),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
    })
    .openapi('ProcessMap');

const SnapshotSummarySchema = z
    .object({
        id: z.string(),
        version: z.number().int(),
        createdAt: z.string().datetime(),
        createdByName: z.string().nullable(),
    })
    .openapi('ProcessMapSnapshotSummary');

const SnapshotSchema = SnapshotSummarySchema.extend({
    graphJson: z.unknown().openapi({
        description:
            'The full canvas at that version — nodes, edges and edge-practices. Opaque '
            + 'here because its shape is the editor\'s, and the editor is what reads it '
            + 'back for the "view version N" overlay and the visual diff.',
    }),
}).openapi('ProcessMapSnapshot');

const GovernanceGraphSchema = z
    .object({
        nodes: z.array(
            z
                .object({
                    id: z.string(),
                    name: z.string(),
                    canvasMode: z.enum(['DOCUMENT', 'AUTOMATION']),
                    ruleCount: z.number().int(),
                    successRate: z.number().nullable().openapi({
                        description:
                            'Succeeded over TERMINAL executions, or **null when there have '
                            + 'been none**. Null means "no data", not zero — rendering it '
                            + 'as 0% would report a map that has never run as a map that '
                            + 'always fails.',
                    }),
                })
                .openapi('GovernanceGraphNode'),
        ),
        links: z.array(
            z
                .object({ source: z.string(), target: z.string() })
                .openapi('GovernanceGraphLink', {
                    description:
                        'A SUB-FLOW call: a rule on the source map invokes the target map\'s '
                        + 'rule group. Only that relationship — these are not canvas edges.',
                }),
        ),
        generatedAt: z.string().datetime(),
    })
    .openapi('GovernanceGraph');

/**
 * The automation evidence pack.
 *
 * Declared here rather than left opaque because
 * `openapi-response-shapes-ratchet` holds the count of operations with no 2xx
 * shape at zero, and its message is explicit that a hand-written mirror is
 * the wrong way to satisfy it — so this is derived from the `EvidencePack`
 * interface the usecase returns, field for field.
 */
const EvidencePackSchema = z
    .object({
        exportedAt: z.string().datetime(),
        processMapId: z.string(),
        processMapName: z.string(),
        rules: z.array(
            z
                .object({
                    id: z.string(),
                    name: z.string(),
                    triggerEvent: z.string(),
                    status: z.string(),
                    executionCount: z.number().int(),
                    successRate: z.number().openapi({
                        description:
                            'Succeeded over TERMINAL executions, and **0 when there have '
                            + 'been none** — which is NOT how the governance graph reports '
                            + 'the same metric: there it is `null`. So a rule that has '
                            + 'never run reads as 0% here and as "no data" there, and the '
                            + 'two numbers are not comparable across the surfaces. Read '
                            + '`executionCount` beside this one to tell the cases apart.',
                    }),
                    lastTriggeredAt: z.string().datetime().nullable(),
                    chainedRuleId: z.string().nullable().openapi({
                        description:
                            'The rule this one hands off to, if any — the chain is part of '
                            + 'the evidence, not just the individual rule.',
                    }),
                })
                .openapi('AutomationRuleEvidence'),
        ),
        executions30d: z
            .object({
                total: z.number().int(),
                succeeded: z.number().int(),
                failed: z.number().int(),
            })
            .openapi('AutomationExecutionWindow', {
                description:
                    'A FIXED 30-day window, not a parameter. `total` may exceed '
                    + '`succeeded + failed`: an execution still running is counted in the '
                    + 'total and is terminal in neither.',
            }),
    })
    .openapi('AutomationEvidencePack');

export function registerProcessPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/processes',
        operationId: 'listProcessMaps',
        summary: 'List the farm\'s process maps',
        description:
            'Metadata only — no graphs. **Gated on CERTIFICATION**, which makes it the one '
            + 'READ on this surface that a disabled module refuses: the collection gate '
            + 'predates the write/read split and the owner ruling kept it (#3291). A farm '
            + 'with the module off can therefore still open a map it holds an id for.',
        tags: TAGS,
        params: TenantParams,
        success: {
            status: 200,
            description: 'The maps, metadata only.',
            schema: z.array(ProcessMapSchema),
        },
        extraResponses: codedErrorResponses({ 403: MODULE_403 }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/processes',
        operationId: 'createProcessMap',
        summary: 'Create a process map',
        description:
            'Metadata only, so a new map starts EMPTY — the graph arrives through the '
            + 'full-graph PUT. `canvasMode` defaults to `DOCUMENT`.',
        tags: TAGS,
        params: TenantParams,
        body: CreateProcessMapSchema,
        success: { status: 201, description: 'The created map.', schema: ProcessMapSchema },
        extraResponses: codedErrorResponses({
            400: 'Missing `name`, or a field over its cap.',
            403: `${MODULE_403}\n\nOr read-only on this farm.`,
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/processes/{id}',
        operationId: 'getProcessMap',
        summary: 'Read one map, with its graph',
        description:
            'NOT module-gated, deliberately (#3291): a farm keeps access to work it '
            + 'already did even with CERTIFICATION off.\n\n'
            + 'In `AUTOMATION` mode the graph is HYDRATED from the automation rules rather '
            + 'than read verbatim, so the canvas reflects rule configuration that may have '
            + 'changed since the last save.',
        tags: TAGS,
        params: MapParams,
        success: {
            status: 200,
            description: 'The map and its graph.',
            schema: ProcessMapSchema,
        },
        extraResponses: codedErrorResponses({ 404: MAP_404 }),
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/processes/{id}',
        operationId: 'saveProcessMap',
        summary: 'Replace the graph',
        description:
            '**The whole canvas, every save.** The repository swaps the graph atomically '
            + 'and there is no per-node update path, so **a node omitted from the body is '
            + 'deleted**. That is the design — the canvas is the source of truth and the '
            + 'server persists what it is handed — but it means a client that sends a '
            + 'subset has destroyed the rest.\n\n'
            + '**Send `expectedVersion`.** It is optional, and omitting it saves '
            + 'unconditionally: last-write-wins, silently overwriting a concurrent edit. '
            + 'With it, a stale write is refused with **409 `STALE_DATA`** carrying '
            + '`details.currentVersion` so a client can tell the user what it collided '
            + 'with.\n\n'
            + 'In `AUTOMATION` mode a save SYNCS the canvas to automation rules, so this '
            + 'request changes rule configuration too.',
        tags: TAGS,
        params: MapParams,
        body: SaveProcessMapSchema,
        success: {
            status: 200,
            description: 'The saved map, at its new version.',
            schema: ProcessMapSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'Over 500 nodes or 1000 edges, or a malformed node/edge.',
            403: MODULE_403,
            404: MAP_404,
            409: '`STALE_DATA` — `expectedVersion` does not match the stored version. '
                + '`details.currentVersion` is what it actually is.',
        }),
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/processes/{id}',
        operationId: 'setProcessMapCanvasMode',
        summary: 'Switch the canvas mode',
        description:
            'Metadata only — it saves NO graph, which is why it is a PATCH beside the '
            + 'full-graph PUT. Use it to move a map between the drawing surface and the '
            + 'visual rule editor without touching its contents.',
        tags: TAGS,
        params: MapParams,
        body: PatchProcessMapSchema,
        success: { status: 200, description: 'The map, in its new mode.', schema: ProcessMapSchema },
        extraResponses: codedErrorResponses({
            400: 'An unknown `canvasMode`.',
            403: MODULE_403,
            404: MAP_404,
        }),
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/processes/{id}',
        operationId: 'deleteProcessMap',
        summary: 'Soft-delete a map',
        description:
            'SOFT delete — the row survives with its snapshots. It was UNGATED until '
            + '#3291, so a farm with CERTIFICATION off could destroy a map it could not '
            + 'list; it now carries the module assertion like every other write.',
        tags: TAGS,
        params: MapParams,
        success: {
            status: 200,
            description: 'Deleted.',
            schema: z.object({ success: z.literal(true) }).openapi('ProcessMapDeleted'),
        },
        extraResponses: codedErrorResponses({ 403: MODULE_403, 404: MAP_404 }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/processes/{id}/snapshots',
        operationId: 'listProcessMapSnapshots',
        summary: 'The version history',
        description:
            'Summaries only — no `graphJson`, which is what keeps the history sidebar '
            + 'cheap. Descending by version and **capped at 200 in the repository**, so a '
            + 'map edited more than that has older snapshots this endpoint cannot reach and '
            + 'no flag saying so.\n\n'
            + 'Not module-gated: reading your own history is not a write.',
        tags: TAGS,
        params: MapParams,
        success: {
            status: 200,
            description: 'Up to 200 snapshot summaries, newest version first.',
            schema: z.array(SnapshotSummarySchema),
        },
        extraResponses: codedErrorResponses({ 404: MAP_404 }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/processes/{id}/snapshots/{version}',
        operationId: 'getProcessMapSnapshot',
        summary: 'One snapshot, with its full graph',
        description:
            'Carries `graphJson`, which the list deliberately omits — this is what backs '
            + 'the "view version N" overlay and the visual diff. Not module-gated.',
        tags: TAGS,
        params: VersionParams,
        success: { status: 200, description: 'The snapshot.', schema: SnapshotSchema },
        extraResponses: codedErrorResponses({
            404: 'No such map on this farm, or no such version OF THAT MAP.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/processes/{id}/snapshots/{version}/restore',
        operationId: 'restoreProcessMapSnapshot',
        summary: 'Restore the map to a snapshot',
        description:
            '**Restoring version N does not give you version N.** It writes the snapshot\'s '
            + 'content as a NEW version — `expectedVersion + 1` — because history is '
            + 'preserved rather than rewound. A client that expects the version number to '
            + 'go backwards, or that treats the response version as the restored one, is '
            + 'wrong.\n\n'
            + '`expectedVersion` in the body is the version the client believes is CURRENT, '
            + 'not the one being restored — that is in the path. It is REQUIRED here, '
            + 'unlike on a save, and goes through the same optimistic-concurrency check, so '
            + 'a restore cannot clobber an edit made while the history sidebar was open.\n\n'
            + 'Was UNGATED until #3291.',
        tags: TAGS,
        params: VersionParams,
        body: RestoreProcessMapSnapshotSchema,
        success: {
            status: 200,
            description:
                'The map, at `expectedVersion + 1`, carrying the restored content.',
            schema: ProcessMapSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'Missing or non-positive `expectedVersion`.',
            403: MODULE_403,
            404: 'No such map, or no such version of it.',
            409: '`STALE_DATA` — the map moved on while the history was open.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/processes/governance-graph',
        operationId: 'getGovernanceGraph',
        summary: 'How the farm\'s maps call each other',
        description:
            'A map-level overview, NOT a canvas: nodes are process maps and links are '
            + 'SUB-FLOW calls — a rule on one map invoking another map\'s rule group. '
            + 'Canvas edges do not appear here at all.\n\n'
            + 'Read `successRate` carefully: it is null when a map has no terminal '
            + 'executions, and null means "no data" rather than zero. Rendering it as 0% '
            + 'reports a map that has never run as one that always fails.\n\n'
            + '`generatedAt` is the computation time, not a cache stamp — the graph is '
            + 'built per request.',
        tags: TAGS,
        params: TenantParams,
        success: {
            status: 200,
            description: 'The governance graph.',
            schema: GovernanceGraphSchema,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/processes/{id}/export-automation',
        operationId: 'exportProcessMapAutomationPack',
        summary: 'Build an automation evidence pack',
        description:
            'Despite the verb and the method, this **persists nothing** — it is '
            + '`assertCanRead` plus reads, assembling an evidence pack from the map\'s '
            + 'rule-linked nodes and their execution history. A POST because the pack is '
            + 'computed rather than addressed.\n\n'
            + 'Therefore NOT module-gated (#3291): under "writes gated, reads open" it is a '
            + 'read, and it is exactly the kind of compliance record the ruling wanted a '
            + 'farm to keep.',
        tags: TAGS,
        params: MapParams,
        success: {
            status: 200,
            description: 'The evidence pack.',
            schema: EvidencePackSchema,
        },
        extraResponses: codedErrorResponses({ 404: MAP_404 }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/processes/{id}/export-pdf',
        operationId: 'exportProcessMapPdf',
        summary: 'Wrap a canvas PNG in a branded PDF',
        description:
            '**The CLIENT renders the canvas**, posts it as a PNG data URL, and the server '
            + 'only wraps it — so what you send is what prints. The server does not draw '
            + 'the graph and cannot correct it.\n\n'
            + 'Server-side because it reuses the audit-pack PDF factory, so the artefact '
            + 'looks like every other compliance export, and because bundling a PDF library '
            + 'into the client cost ~200 KB.\n\n'
            + 'Persists NOTHING — the PDF is streamed back — so it is not module-gated '
            + '(#3291), and a farm with CERTIFICATION off keeps its PDF history.\n\n'
            + 'The filename is derived from the map name with Cyrillic PRESERVED. An '
            + 'earlier `[a-z0-9]` strip deleted it entirely, so every Bulgarian map '
            + 'exported as `process-map.pdf` whichever map it was.',
        tags: TAGS,
        params: MapParams,
        body: ProcessMapPdfExportSchema,
        bodyContentType: 'application/json',
        success: {
            status: 200,
            description: 'The PDF bytes, as an attachment.',
            content: {
                'application/pdf': z.string().openapi({
                    type: 'string',
                    format: 'binary',
                }),
            },
        },
        extraResponses: codedErrorResponses({
            400: '`pngDataUrl` missing, not a `data:image/png;base64,` URL, or empty.',
            404: MAP_404,
        }),
    });
}
