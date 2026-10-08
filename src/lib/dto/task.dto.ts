/**
 * Task (Work Item) DTOs
 */
import { z } from '@/lib/openapi/zod';
import { UserRefSchema } from './common';
import { MultiPolygonGeometrySchema } from '@/app-layer/schemas/geo.schemas';

/**
 * A task comment, as both the list and the create return it.
 *
 * Read off the repository's own `include` rather than guessed: every scalar of
 * `TaskComment` plus `createdBy` narrowed to `{id, name, email}`, which is
 * exactly `UserRef`. `tenantId` is on the wire — it is the caller's own tenant,
 * so it discloses nothing, but it is documented rather than hidden because a
 * client will see it.
 *
 * Comments are PLAIN TEXT. The usecase strips HTML before persistence so a
 * future renderer change cannot re-enable a stored XSS vector, which means a
 * client must not treat the body as markup either.
 */
export const TaskCommentDTOSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        taskId: z.string(),
        body: z.string(),
        createdByUserId: z.string(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        createdBy: UserRefSchema.nullable().optional(),
    })
    .passthrough()
    .openapi('TaskComment');

/**
 * A `TaskLink` row, as `GET /tasks/{taskId}` and `GET /tasks/{taskId}/links`
 * both return it.
 *
 * Documented because the link route already EXISTS and was simply absent from
 * the spec — a documentation gap rather than a missing capability. Raised by
 * the native client (agrent-ios#177), which needed a task's parcels and could
 * not discover that the route was there.
 *
 * A `PARCEL` link carries only `entityId`. It does NOT resolve to the parcel's
 * location or geometry, which is why drawing a task's parcels needs
 * `GET /tasks/{taskId}/parcels` rather than this.
 */
export const TaskLinkDTOSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        taskId: z.string(),
        entityType: z.string().openapi({
            description:
                'What the task is linked TO: `ASSET`, `EVIDENCE`, `FILE`, `LOCATION`, `PARCEL`, `EQUIPMENT` or `PLANTING`. A growing union — treat an unrecognised value as an opaque link rather than an error.',
        }),
        entityId: z.string().openapi({
            description:
                'The linked row\'s id. An id ONLY — nothing about the entity is resolved here.',
        }),
        relation: z.string().openapi({
            description:
                '`RELATES_TO` (the default), `EVIDENCE_FOR`, `BLOCKED_BY`, `CAUSED_BY` or `MITIGATED_BY`.',
        }),
        createdAt: z.string().datetime().optional(),
    })
    .passthrough()
    .openapi('TaskLink', {
        description: 'One edge from a task to another record. Ordered newest first.',
    });

/**
 * A watcher, as the task detail returns it.
 *
 * `user` is `{ id, name }` with NO email, and that narrowing is deliberate —
 * see `WorkItemRepository.getById`, where shipping a full list of people's
 * addresses on every task open was trimmed because nothing renders a watcher.
 */
export const TaskWatcherDTOSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        taskId: z.string(),
        userId: z.string(),
        user: z
            .object({ id: z.string(), name: z.string().nullable().optional() })
            .nullable()
            .optional()
            .openapi({ description: 'Deliberately NO email — see the DTO docblock.' }),
    })
    .passthrough()
    .openapi('TaskWatcher');

export const TaskDTOSchema = z.object({
    id: z.string(),
    tenantId: z.string(),
    title: z.string(),
    type: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    severity: z.string().nullable().optional(),
    priority: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
    /**
     * NEVER SENT. There is no `resolvedAt` column on `Task`.
     *
     * Kept rather than deleted because removing a documented property is a
     * breaking change by `scripts/openapi-breaking.ts`'s classes, and
     * `contract-version.ts` ties that to an `API_VERSION` bump — which is
     * disproportionate for a field no server has ever produced, so no client
     * can be depending on a value. It has exactly one reference in `src/`:
     * this declaration.
     *
     * Read `completedAt` instead. Delete this at the next deliberate version
     * bump.
     */
    resolvedAt: z.string().nullable().optional().openapi({
        deprecated: true,
        description:
            '**NEVER SENT — there is no such column.** Use `completedAt`. Documented in error; kept only because removing it is a breaking change requiring an API_VERSION bump, which a field that has never been produced does not warrant.',
    }),
    /** The real completion timestamp, and what both clients read. */
    completedAt: z.string().datetime().nullable().optional().openapi({
        description:
            'When the task was completed. THIS is the field the server sends — `resolvedAt` above is documented in error and never arrives. Detail only: the list projection omits it.',
    }),
    key: z.string().nullable().optional().openapi({
        description:
            'Human-readable handle, e.g. `FT-102`. Present on BOTH the list and the detail — one of the few non-list-projection fields that is.',
    }),
    operationType: z.string().nullable().optional().openapi({
        description:
            'FIELD_OPERATION only: `SPRAY`, `FERTILIZE`, `SEED` or `OTHER`. Persisted so the БАБХ ДНЕВНИК generator can split химични обработки from торове without re-deriving from the title; legacy rows are null and fall back to a derive-from-title reader. Detail only.',
    }),
    applicationTechnique: z.string().nullable().optional().openapi({
        description:
            'FIELD_OPERATION only — «Техника за приложение», one rig per job. Detail only.',
    }),
    clientMutationId: z.string().nullable().optional().openapi({
        description:
            'Offline exactly-once handle. When a FIELD_OPERATION is created from a queued outbox the client\'s outbox-item id rides in as `Idempotency-Key`; a replayed write dedupes on (tenantId, clientMutationId) and returns the original task. Null for online creates. Detail only.',
    }),
    resolution: z.string().nullable().optional(),
    practiceId: z.string().nullable().optional(),
    assigneeUserId: z.string().nullable().optional(),
    reviewerUserId: z.string().nullable().optional(),
    createdByUserId: z.string().nullable().optional(),
    metadataJson: z.unknown().optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    assignee: UserRefSchema.nullable().optional(),
    reviewer: UserRefSchema.nullable().optional(),
    createdBy: UserRefSchema.nullable().optional(),

}).passthrough().openapi('Task', {
    description: 'Unified work-item record covering audit findings, practice gaps, incidents, improvements, and ad-hoc tasks. The type field discriminates which UI surfaces this row appears in.\n\nThe full row. `GET /tasks` serves the narrower `TaskListItem`; `GET /tasks/{taskId}` serves `TaskDetail`, which is this plus its relations.',
});

/**
 * What `GET /tasks` actually sends: twelve fields, not the full row.
 *
 * `.pick()` from `TaskDTOSchema` rather than a fresh field list, deliberately.
 * This module's own note warns against adding a second spelling of the same
 * record, and that warning is right — so there is still ONE definition of what
 * a task's `title` or `status` is, and these are two VIEWS of it. A new column
 * reaches whichever views project it by editing one place.
 *
 * The twelve are `taskListSelect` in `WorkItemRepository`, read off the
 * projection rather than guessed. Before this split both responses were
 * documented as `Task`, so the list promised ten properties it has never
 * sent — `description`, `tenantId`, `source`, `resolution`, `metadataJson`,
 * `reviewer`, `createdBy` and more. All optional, so a decoder survived; the
 * contract was simply false.
 *
 * `priority` is in the projection because the list is ORDERED by it — see the
 * comment on `taskListSelect`, which records that omitting it meant the server
 * sorted by a field no caller could see.
 */
export const TaskListItemDTOSchema = TaskDTOSchema.pick({
    id: true,
    key: true,
    title: true,
    type: true,
    severity: true,
    priority: true,
    status: true,
    dueAt: true,
    createdAt: true,
    updatedAt: true,
    assigneeUserId: true,
    assignee: true,
})
    .passthrough()
    .openapi('TaskListItem', {
        description:
            'One row of `GET /tasks`. A PROJECTION of `Task`, not the whole record — twelve fields, matching `taskListSelect`. Do not decode a list row as a detail row: `description`, `resolution`, `metadataJson`, `reviewer`, `createdBy` and the relations are absent here and present on `TaskDetail`.',
    });

/**
 * What `GET /tasks/{taskId}` sends: the full row plus its relations.
 *
 * `links`, `comments`, `watchers` and `_count` come from
 * `WorkItemRepository.getById`'s own `include`; `sla` is added by `getTask` and
 * is DERIVED per request from severity + createdAt + status, which is why it is
 * on no model. None of the five existed in the spec before this change, and
 * `TaskLink` and `TaskWatcher` had no schema at all.
 */
export const TaskDetailDTOSchema = TaskDTOSchema.extend({
    links: z.array(TaskLinkDTOSchema).optional().openapi({
        description:
            'Edges to other records, newest first. DETAIL ONLY. Also available on its own at `GET /tasks/{taskId}/links`.',
    }),
    comments: z.array(TaskCommentDTOSchema).optional().openapi({
        description: 'Oldest first. DETAIL ONLY.',
    }),
    watchers: z.array(TaskWatcherDTOSchema).optional().openapi({
        description:
            'DETAIL ONLY. Nothing renders a watcher on either client today — the native app shows `_count.watchers` alone.',
    }),
    _count: z
        .object({
            links: z.number().int(),
            comments: z.number().int(),
            watchers: z.number().int(),
            evidence: z.number().int(),
        })
        .optional()
        .openapi({
            description:
                'Relation counts, so a client can badge without fetching the collections. DETAIL ONLY.',
        }),
    sla: z
        .object({
            triageBreach: z.boolean(),
            resolveBreach: z.boolean(),
            label: z.string().openapi({
                description:
                    '`SLA Breached`, `Triage SLA Breached`, or EMPTY when neither — including for every terminal status. An empty string is the normal case, not a missing value.',
            }),
        })
        .optional()
        .openapi({
            description:
                'DERIVED per request from severity + createdAt + status, not a stored column, which is why it is on no model. Added by `getTask`, so DETAIL ONLY.',
        }),
})
    .passthrough()
    .openapi('TaskDetail', {
        description:
            'The task detail. `Task` plus the relations `getById` includes and the `sla` `getTask` derives. `GET /tasks` serves `TaskListItem` instead.',
    });

export type TaskListItemDTO = z.infer<typeof TaskListItemDTOSchema>;
export type TaskDetailDTO = z.infer<typeof TaskDetailDTOSchema>;

export type TaskDTO = z.infer<typeof TaskDTOSchema>;

/**
 * A parcel as the task map needs it: who it is and where it is.
 *
 * NOT a narrowing of `ParcelGeo`, which carries thirteen fields the location
 * map renders — soil, ownership, lease state, crop, area. The task map draws
 * an outline and labels it, so every other field would be a contract nobody
 * reads and nobody could later remove. Contract agreed with agrent-ios and
 * recorded on #1391.
 */
export const TaskParcelDTOSchema = z
    .object({
        id: z.string(),
        name: z.string().openapi({
            description:
                'The parcel name as the farmer wrote it. NOT unique — two parcels on one farm may share a name, which is why the response is ordered by name AND id.',
            example: 'Дерманци (20688)',
        }),
        geometry: MultiPolygonGeometrySchema.nullable().openapi({
            description:
                'The outline as GeoJSON **MultiPolygon** in WGS84, simplified for display. ' +
                'Always MultiPolygon, never Polygon: the column is `geometry(MultiPolygon, 4326)` ' +
                'and every write path normalises to it, so a client needs no Polygon branch.\n\n' +
                '**`null` means the parcel has no outline** — a normal state, not an error. Keep ' +
                'the parcel and say it is not drawn rather than dropping it, or your count will ' +
                'disagree with the task. A parcel whose geometry COLLAPSES at the display ' +
                'tolerance falls back to its exact outline rather than arriving as null, so null ' +
                'means exactly one thing.',
        }),
    })
    .openapi('TaskParcel', {
        description:
            'A parcel linked to a task, for a display-only map. Deliberately status-free: per-parcel operation status lives on the field-operation detail route, so this shape means the same thing whatever the task type is.',
    });
