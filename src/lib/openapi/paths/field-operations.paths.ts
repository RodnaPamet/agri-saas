/**
 * Field operations — the spray job an operator actually executes in a field.
 *
 * Three routes, and the interesting one is the per-parcel mark: it is the
 * write the offline outbox replays, so its `If-Match` contract and its two
 * DIFFERENT answers to a stale version are the things a second client will
 * otherwise reproduce as bugs.
 *
 * Note the shape of the 409 here: `error.details` carries `currentVersion`,
 * `currentStatus` AND `expectedVersion` — three fields, where the journal's
 * stale-data error carries one. Same `STALE_DATA` code, different payload;
 * they are documented as separate components so a client does not assume the
 * journal's narrower shape.
 *
 * There is NO create route in this folder — a field operation is created at
 * `POST /locations/{id}/operations` (see `locations.paths.ts`) because the
 * job is scoped to a location's parcels.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { UpdateOperationParcelSchema } from '@/lib/schemas';
import { ParcelGeo } from './locations.paths';
import { OperationParcelDTOSchema } from '@/lib/dto/operation-parcel.dto';
import { TaskDTOSchema } from '@/lib/dto/task.dto';
import { BoundingBoxSchema } from '@/lib/dto/common';
import { ApiErrorResponseSchema } from '@/lib/dto/common';
import { op } from './helpers';

// ZodObjects, because that is what the generator reads to build inline
// parameters — see the note on OperationInput.params.
const TaskParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
    taskId: z.string().openapi({ param: { name: 'taskId', in: 'path' } }),
});
const LineParams = TaskParams.extend({
    lineId: z.string().openapi({
        param: { name: 'lineId', in: 'path' },
        description: 'OperationParcel id — one prescription LINE, not a parcel id.',
    }),
});

/**
 * The parcel geometry the detail view carries — `ParcelGeo`, imported.
 *
 * This WAS `z.object({}).passthrough()`, with a comment saying to see
 * `ParcelGeo` in `locations.paths.ts` "for the full shape — referenced here
 * only as a loose object so the two cannot drift into contradicting each other
 * from two places". The goal was right and the means inverted it: a schema that
 * accepts any shape and declares none is WORSE for a client than an
 * undocumented route, because an empty object type looks complete. A generated
 * iOS client got a parcel with no fields and had to model from observed wire
 * data instead of the contract (agrent-ios, 2026-10-07).
 *
 * Importing the one definition is what the comment was reaching for: both
 * routes are served by the same `ParcelRepository.listForLocation` call, so
 * there is now exactly one description and a `$ref` to it.
 */

const FieldOperationDetail = z
    .object({
        task: TaskDTOSchema,
        lines: z.array(OperationParcelDTOSchema),
        location: z
            .object({
                id: z.string(),
                name: z.string(),
                boundsJson: BoundingBoxSchema.nullable().optional(),
            })
            .passthrough()
            .nullable()
            .openapi({
                description:
                    'Resolved through the Task↔Location TaskLink. NULL when the job has no ' +
                    'location link — which is exactly what a partially-committed create leaves ' +
                    'behind, so a null here is a signal, not just an absence.',
            }),
        parcels: z.array(ParcelGeo).openapi({
            description:
                'Every parcel of the linked location (for the map backdrop) — NOT only the ' +
                'parcels this job prescribes. The prescribed set is `lines`. Empty when ' +
                '`location` is null.',
        }),
        progress: z
            .object({
                total: z.number().int().openapi({ description: 'Number of prescription lines.' }),
                done: z.number().int().openapi({
                    description: 'Lines that are DONE **or SKIPPED** — a skip counts as progress.',
                }),
            })
            .openapi({ description: 'Derived from `lines`; not stored.' }),
    })
    .openapi('FieldOperationDetail', {
        description:
            'One spray job: the Task, its per-parcel prescription lines, the linked location ' +
            'with all of its parcels for the map, and a derived progress counter.',
    });

const FieldOperationReviewRequest = z
    .object({
        action: z.enum(['APPROVE', 'REQUEST_CHANGES']),
        comment: z.string().max(2000).nullable().optional().openapi({
            description:
                'Sanitised server-side, then reused three ways — Task.resolution (APPROVE only), ' +
                'the audit detail, and the operator notification.',
        }),
    })
    .openapi('FieldOperationReviewRequest', {
        description:
            'Reviewer decision on a completed field operation. ADMIN-gated, and deliberately ' +
            'separate from evidence review: this finalises the Task.',
    });

const FieldOperationReviewResult = z
    .object({
        success: z.literal(true),
        status: z.enum(['RESOLVED', 'IN_PROGRESS']).openapi({
            description: 'APPROVE → RESOLVED; REQUEST_CHANGES → IN_PROGRESS (reopened for rework).',
        }),
    })
    .openapi('FieldOperationReviewResult', {
        description: 'The Task status the review moved the job to.',
    });

const OperationParcelMarkResult = z
    .object({
        success: z.literal(true),
        resolved: z.boolean().openapi({
            description:
                'TRUE when this mark completed the LAST pending line and the job moved to ' +
                'PENDING_REVIEW — not to RESOLVED. It also enqueues the location’s ДНЕВНИК ' +
                'regeneration. Always FALSE on an `alreadyApplied` replay, which is what stops ' +
                'that regeneration running twice for one operator action.',
        }),
        application: z
            .object({
                journalEntryId: z.string().nullable(),
                consumed: z.number(),
                deductedFromLotId: z.string().nullable(),
                note: z
                    .enum([
                        'inventory_disabled',
                        'no_lot_available',
                        'zero_quantity',
                        'already_applied',
                        'over_consumption',
                    ])
                    .optional(),
            })
            .nullable()
            .openapi({
                description:
                    'The inventory + journal effect of COMPLETING a line — non-null only when ' +
                    'this write moved the line into DONE from a non-DONE state. `note` says why ' +
                    'no stock moved, or (`over_consumption`) that it moved and drove the lot ' +
                    'negative. Un-completing does NOT reverse it; the ledger is append-only.',
            }),
        version: z.number().int().openapi({
            description:
                'The line’s version AFTER this write. Send it as the next `If-Match`. On an ' +
                '`alreadyApplied` answer it is the server’s CURRENT version, not the one you ' +
                'expected — sync to it.',
        }),
        alreadyApplied: z.literal(true).optional().openapi({
            description:
                'Present only when the version check failed but the line ALREADY carried the ' +
                'status this write wanted. That is a replay of your own success, not a conflict: ' +
                'no second audit row is written and `resolved` is false.',
        }),
    })
    .openapi('OperationParcelMarkResult', {
        description: 'Result of marking one prescription line DONE / SKIPPED / PENDING.',
    });

const OperationParcelStaleDataError = ApiErrorResponseSchema.openapi(
    'OperationParcelStaleDataError',
    {
        description:
            'A 409 `STALE_DATA` from the per-line optimistic lock. `error.details` carries ' +
            '`currentVersion`, `currentStatus` and `expectedVersion` — read them from ' +
            '`error.details`, NOT from the body root, and note this is WIDER than the journal’s ' +
            'stale-data payload. It means someone else changed the line; it is a conflict to ' +
            'resolve (keep-mine / take-server), never a success.',
    },
);

export function registerFieldOperationPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/field-operations/{taskId}',
        operationId: 'getFieldOperation',
        summary: 'Get one field operation',
        description:
            'The whole job in one read — Task, prescription lines, linked location and its ' +
            'parcels, and a derived progress counter. A 404 also covers "the task exists but is ' +
            'not a FIELD_OPERATION".',
        tags: ['Field operations'],
        params: TaskParams,
        success: { status: 200, description: 'The job.', schema: FieldOperationDetail },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/field-operations/{taskId}/parcels/{lineId}',
        operationId: 'markOperationParcel',
        summary: 'Mark one prescription line DONE / SKIPPED / PENDING',
        description:
            'The write the offline outbox replays, so treat `If-Match: <version>` (digits only) ' +
            'as mandatory: it is what stops a queued mark clobbering a supervisor’s later edit. ' +
            'An absent or non-integer `If-Match` SKIPS the version check entirely — a silent ' +
            'last-write-wins, not an error.\n\n' +
            'A stale version has TWO possible answers, and telling them apart is the point. If ' +
            'the line already carries the status this write wanted, the intent is satisfied: 200 ' +
            'with `alreadyApplied: true`, the current `version`, and `resolved: false`. ' +
            'Otherwise 409 `STALE_DATA`. Answering a replay of the operator’s own success with a ' +
            '409 asks them to resolve keep-mine versus take-server against themselves, which is ' +
            'not a question anyone can answer.\n\n' +
            'Authorisation is unusual here: the ASSIGNED operator may mark their own job even ' +
            'without general write permission. PATCH is the only method — there is no PUT alias, ' +
            'and no way to add a line to an existing job.',
        tags: ['Field operations'],
        params: LineParams,
        // Declared as a HEADER rather than left in the prose above (#1370). A
        // generated client cannot send a precondition it cannot see, and the
        // description calling it "mandatory" while the contract never named
        // it is how iOS ended up the only client sending one.
        headers: z.object({
            'If-Match': z
                .string()
                .optional()
                .openapi({
                    description:
                        'The `version` you last read from the line, DIGITS ONLY (`5`). Unlike ' +
                        'the farm-profile lock, an entity-tag form (`"5"`) is NOT parsed here — ' +
                        'and an absent or non-integer value SKIPS the version check entirely, a ' +
                        'silent last-write-wins rather than an error (#1182). ' +
                        'OPTIONAL in the schema and MANDATORY in practice: it is what stops a ' +
                        'queued offline mark clobbering a supervisor’s later edit, and the only ' +
                        'reason it is not required here is that an installed build may send none.',
                    example: '5',
                }),
        }),
        body: UpdateOperationParcelSchema,
        success: {
            status: 200,
            description: 'The mark landed, or was recognised as an already-applied replay.',
            schema: OperationParcelMarkResult,
        },
        extraResponses: {
            409: {
                description:
                    'Optimistic-lock conflict — the line moved to a DIFFERENT status while you ' +
                    'were offline. Resolve it; do not treat it as success.',
                content: { 'application/json': { schema: OperationParcelStaleDataError } },
            },
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/field-operations/{taskId}/review',
        operationId: 'reviewFieldOperation',
        summary: 'Approve a field operation, or send it back',
        description:
            'ADMIN-gated separation of duties: the operator marks the parcels, a reviewer ' +
            'finalises. Only a task in PENDING_REVIEW can be reviewed — any other status is a ' +
            '400, not a 409, so a client must not retry it as a conflict. Notifies the assigned ' +
            'operator when there is one.',
        tags: ['Field operations'],
        params: TaskParams,
        body: FieldOperationReviewRequest,
        success: {
            status: 200,
            description: 'The review was applied.',
            schema: FieldOperationReviewResult,
        },
    });
}
