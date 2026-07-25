import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest, forbidden, staleData } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { createTask } from './task';
import { WorkItemRepository, TaskLinkRepository } from '../repositories/WorkItemRepository';
import { ParcelRepository } from '../repositories/ParcelRepository';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import { recordInputApplication, type InputApplicationResult } from './inventory';
import { attachAutoEvidenceFromLogEntry } from './auto-evidence';
import { traceAgUsecase } from '@/lib/observability';
import { logger } from '@/lib/observability/logger';
import { trace } from '@opentelemetry/api';
import { emitAutomationEvent } from '../automation';
import { enqueue } from '@/app-layer/jobs/queue';
import { Prisma } from '@prisma/client';

/** Prisma's unique-constraint violation — the idempotency-race backstop. */
function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

type OperationType = 'SPRAY' | 'FERTILIZE' | 'SEED' | 'OTHER';
type ParcelStatus = 'PENDING' | 'DONE' | 'SKIPPED';

const TERMINAL_STATUSES: readonly string[] = TERMINAL_WORK_ITEM_STATUSES;

export interface CreateFieldOperationInput {
    title?: string;
    operationType?: OperationType;
    assigneeUserId: string;
    parcelIds: string[];
    // Exactly one input kind is supplied — a product OR a fertilizer (#3).
    productItemId?: string | null;
    doseValue?: number | null;
    doseUnitId?: string | null;
    fertilizerItemId?: string | null;
    fertilizerDoseValue?: number | null;
    fertilizerDoseUnitId?: string | null;
    /** Optional per-decare water-carrier rate for the spray tank (product only). */
    waterRateValue?: number | null;
    waterRateUnitId?: string | null;
    targetNote?: string | null;
    dueAt?: string | null;
    /** "Техника за приложение / Equipment" — one rig per job (БАБХ record). */
    applicationTechnique?: string | null;
}

interface ChosenInput {
    itemId: string;
    doseValue: number;
    doseUnitId: string;
    isFertilizer: boolean;
}

/**
 * Resolve the single input a field operation applies — a product XOR a
 * fertilizer (#3). Rejects both-present and neither-present (defence in depth;
 * `CreateFieldOperationSchema` already enforces the XOR at the HTTP boundary),
 * and requires the chosen kind's dose + unit.
 */
function resolveChosenInput(input: CreateFieldOperationInput): ChosenInput {
    const hasProduct = !!input.productItemId;
    const hasFertilizer = !!input.fertilizerItemId;
    if (hasProduct === hasFertilizer) {
        throw badRequest('Choose exactly one input — a product OR a fertilizer.');
    }
    if (hasProduct) {
        if (input.doseValue == null || !input.doseUnitId) throw badRequest('A product dose and unit are required.');
        return { itemId: input.productItemId!, doseValue: input.doseValue, doseUnitId: input.doseUnitId, isFertilizer: false };
    }
    if (input.fertilizerDoseValue == null || !input.fertilizerDoseUnitId) throw badRequest('A fertilizer dose and unit are required.');
    return { itemId: input.fertilizerItemId!, doseValue: input.fertilizerDoseValue, doseUnitId: input.fertilizerDoseUnitId, isFertilizer: true };
}

function titleCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Resolve a FIELD_OPERATION's operation type for the БАБХ ДНЕВНИК generator,
 * which must split SPRAY (химични обработки) rows from FERTILIZE (торове)
 * rows. Prefers the persisted `Task.operationType`; for legacy rows written
 * before that column existed (always null) it derives from the title prefix
 * `createFieldOperation` minted (`"Spray — …"` / `"Fertilize — …"`).
 */
export function resolveOperationType(task: {
    operationType?: string | null;
    title?: string | null;
}): OperationType {
    if (task.operationType) return task.operationType as OperationType;
    const t = (task.title ?? '').trim().toLowerCase();
    if (t.startsWith('fertilize')) return 'FERTILIZE';
    if (t.startsWith('seed')) return 'SEED';
    if (t.startsWith('spray')) return 'SPRAY';
    return 'OTHER';
}

/**
 * Create a spray "job" over selected parcels of a Location:
 *   • one FIELD_OPERATION Task (assignee = operator) — created via
 *     `createTask`, so the assignment email + in-app bell come for free,
 *   • a Task→Location TaskLink (entityType LOCATION),
 *   • one OperationParcel prescription line per parcel (product + dose).
 *
 * The selection is validated BEFORE the task is created so a bad request
 * never leaves an orphan FIELD_OPERATION behind.
 */
/**
 * Offline exactly-once: reconstruct the create result for a Task that a
 * replayed request already minted (same outbox id → same idempotency key).
 * Returns the original 201 body so a re-send never doubles the job.
 */
async function findFieldOperationByMutationKey(
    ctx: RequestContext,
    locationId: string,
    idempotencyKey: string,
) {
    return runInTenantContext(ctx, async (db) => {
        const task = await db.task.findFirst({
            where: { tenantId: ctx.tenantId, clientMutationId: idempotencyKey, type: 'FIELD_OPERATION' },
            select: { id: true, key: true },
        });
        if (!task) return null;
        const parcelCount = await db.operationParcel.count({ where: { tenantId: ctx.tenantId, taskId: task.id } });
        return { taskId: task.id, taskKey: task.key, locationId, parcelCount };
    });
}

export async function createFieldOperation(
    ctx: RequestContext,
    locationId: string,
    input: CreateFieldOperationInput,
    idempotencyKey?: string | null,
) {
    assertCanWrite(ctx);

    // Offline exactly-once — a queued spray job re-sent over a flaky link
    // carries the same outbox id as `Idempotency-Key`. If we already minted a
    // Task for that key, return the original result and do no further work.
    if (idempotencyKey) {
        const existing = await findFieldOperationByMutationKey(ctx, locationId, idempotencyKey);
        if (existing) return existing;
    }

    // The operation applies exactly one input — a product XOR a fertilizer.
    const chosen = resolveChosenInput(input);
    // Water carrier only applies to a product spray (never a fertilizer line).
    const waterRateValue = chosen.isFertilizer ? null : input.waterRateValue ?? null;
    const waterRateUnitId = chosen.isFertilizer ? null : input.waterRateUnitId ?? null;

    // 1 — validate location, parcels, the chosen input item, and its unit
    const location = await runInTenantContext(ctx, async (db) => {
        const loc = await db.location.findFirst({
            where: { id: locationId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true },
        });
        if (!loc) throw notFound('Location not found');

        const valid = await ParcelRepository.validIdsForLocation(db, ctx, locationId, input.parcelIds);
        const missing = input.parcelIds.filter((id) => !valid.has(id));
        if (missing.length) throw badRequest('Some selected parcels do not belong to this location.');

        const item = await db.item.findFirst({
            where: { id: chosen.itemId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!item) throw badRequest(chosen.isFertilizer ? 'Fertilizer not found.' : 'Product not found.');

        const unit = await db.unit.findUnique({ where: { id: chosen.doseUnitId }, select: { id: true } });
        if (!unit) throw badRequest('Dose unit not found.');

        // Optional water-carrier rate: a rate value requires a unit, and the
        // unit must exist in the global catalog (like the dose unit above).
        if (waterRateValue != null) {
            if (!waterRateUnitId) throw badRequest('A water-rate unit is required when a water rate is set.');
            const waterUnit = await db.unit.findUnique({ where: { id: waterRateUnitId }, select: { id: true } });
            if (!waterUnit) throw badRequest('Water-rate unit not found.');
        }

        return loc;
    });

    // 2 — create the FIELD_OPERATION Task (reuses createTask's assignment
    //     notification path: email + in-app bell). The op type defaults from
    //     the chosen input kind (fertilizer → FERTILIZE, else SPRAY).
    const opType: OperationType = input.operationType ?? (chosen.isFertilizer ? 'FERTILIZE' : 'SPRAY');
    const title = input.title?.trim() || `${titleCase(opType)} — ${location.name}`;
    let task;
    try {
        task = await createTask(ctx, {
            title,
            type: 'FIELD_OPERATION',
            assigneeUserId: input.assigneeUserId,
            dueAt: input.dueAt ?? null,
            description: input.targetNote ?? null,
            clientMutationId: idempotencyKey ?? null,
        });
    } catch (err) {
        // Race backstop — two replays of the same queued job hit the unique
        // (tenantId, clientMutationId) index concurrently. The loser gets a
        // P2002; re-read the winner's Task and return its result.
        if (idempotencyKey && isUniqueViolation(err)) {
            const existing = await findFieldOperationByMutationKey(ctx, locationId, idempotencyKey);
            if (existing) return existing;
        }
        throw err;
    }

    // 3 — link Task→Location and write the per-parcel prescription lines
    const parcelCount = await runInTenantContext(ctx, async (db) => {
        await TaskLinkRepository.link(db, ctx, task.id, 'LOCATION', locationId);

        // Persist the operation type + application technique on the Task so
        // the БАБХ ДНЕВНИК generator can split SPRAY (химични обработки) from
        // FERTILIZE (торове) rows without re-deriving from the title, and
        // fill the "Техника за приложение" column.
        await db.task.update({
            where: { id: task.id },
            data: {
                operationType: opType,
                ...(input.applicationTechnique !== undefined
                    ? { applicationTechnique: input.applicationTechnique }
                    : {}),
            },
        });

        // One prescription line per parcel for the single chosen input. The
        // line's `productItemId` holds the chosen Item (product or fertilizer);
        // the kind is implicit in the Item's category (there is no separate
        // input-kind column) and reflected in the Task's operationType.
        await db.operationParcel.createMany({
            data: input.parcelIds.map((parcelId) => ({
                tenantId: ctx.tenantId,
                taskId: task.id,
                parcelId,
                productItemId: chosen.itemId,
                doseValue: chosen.doseValue,
                doseUnitId: chosen.doseUnitId,
                waterRateValue,
                waterRateUnitId,
                targetNote: input.targetNote ?? null,
            })),
        });

        await logEvent(db, ctx, {
            action: 'SPRAY_JOB_STARTED',
            entityType: 'Task',
            entityId: task.id,
            details: `Created field operation ${task.key} over ${input.parcelIds.length} parcels`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Task',
                operation: 'created',
                after: {
                    operationType: opType,
                    locationId,
                    parcelCount: input.parcelIds.length,
                    assigneeUserId: input.assigneeUserId,
                },
                summary: `Created field operation ${task.key}`,
            },
        });

        return input.parcelIds.length;
    });

    // Field-workflow automation trigger (Epic 60 bus) — fires AFTER the
    // tx commits so a rule never acts on a rolled-back job. Mirrors the
    // SPRAY_JOB_STARTED audit action one-to-one.
    await emitAutomationEvent(ctx, {
        event: 'SPRAY_JOB_STARTED',
        entityType: 'Task',
        entityId: task.id,
        actorUserId: ctx.userId,
        stableKey: task.id,
        data: {
            taskId: task.id,
            taskKey: task.key,
            locationId,
            operationType: opType,
            parcelCount,
            productItemId: chosen.itemId,
            assigneeUserId: input.assigneeUserId,
        },
    });

    return { taskId: task.id, taskKey: task.key, locationId, parcelCount };
}

/**
 * The operator's view of a spray job: the Task, its per-parcel lines
 * (with product + dose + parcel), the linked Location, and the parcel
 * geometry (GeoJSON) for the read-only map.
 */
export async function getFieldOperation(ctx: RequestContext, taskId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const task = await db.task.findFirst({
            where: { id: taskId, tenantId: ctx.tenantId, type: 'FIELD_OPERATION' },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
        if (!task) throw notFound('Field operation not found');

        const lines = await db.operationParcel.findMany({
            where: { taskId, tenantId: ctx.tenantId },
            include: {
                product: { select: { id: true, name: true } },
                doseUnit: { select: { id: true, symbol: true, name: true } },
                waterRateUnit: { select: { id: true, symbol: true } },
                parcel: { select: { id: true, name: true, areaHa: true } },
                completedBy: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'asc' },
        });

        const link = await db.taskLink.findFirst({
            where: { taskId, tenantId: ctx.tenantId, entityType: 'LOCATION' },
            select: { entityId: true },
        });

        let location: { id: string; name: string; boundsJson: unknown } | null = null;
        let parcels: Awaited<ReturnType<typeof ParcelRepository.listForLocation>> = [];
        if (link) {
            location = await db.location.findFirst({
                where: { id: link.entityId, tenantId: ctx.tenantId },
                select: { id: true, name: true, boundsJson: true },
            });
            parcels = await ParcelRepository.listForLocation(db, ctx, link.entityId);
        }

        const total = lines.length;
        const done = lines.filter((l) => l.status === 'DONE' || l.status === 'SKIPPED').length;
        return { task, lines, location, parcels, progress: { total, done } };
    });
}

/**
 * Operator marks one prescription line DONE / SKIPPED (or back to
 * PENDING). The job auto-resolves (Task → RESOLVED) once no PENDING
 * lines remain. The assigned operator may act on their own job even
 * without general write permission.
 */
export async function markOperationParcel(
    ctx: RequestContext,
    taskId: string,
    lineId: string,
    status: ParcelStatus,
    note?: string | null,
    expectedVersion?: number,
) {
    return traceAgUsecase('field-operation.markOperationParcel', ctx, () =>
        markOperationParcelImpl(ctx, taskId, lineId, status, note, expectedVersion),
    );
}

async function markOperationParcelImpl(
    ctx: RequestContext,
    taskId: string,
    lineId: string,
    status: ParcelStatus,
    note?: string | null,
    expectedVersion?: number,
) {
    const result = await runInTenantContext(ctx, async (db) => {
        const line = await db.operationParcel.findFirst({
            where: { id: lineId, taskId, tenantId: ctx.tenantId },
            include: {
                task: {
                    select: {
                        id: true,
                        assigneeUserId: true,
                        status: true,
                        key: true,
                        applicationTechnique: true,
                    },
                },
            },
        });
        if (!line) throw notFound('Operation parcel not found');

        const isAssignee = line.task.assigneeUserId === ctx.userId;
        if (!ctx.permissions.canWrite && !isAssignee) {
            throw forbidden('You can only update field operations assigned to you.');
        }

        const fromStatus = line.status;
        // Optimistic lock — a mark queued offline carries the row version it
        // saw. If a supervisor/reviewer changed the line meanwhile, reject the
        // stale write with 409 STALE_DATA (details carry the server's current
        // state so the client can offer keep-mine / take-server) rather than
        // silently clobbering. Online edits (no expectedVersion) skip the check.
        if (expectedVersion !== undefined && line.version !== expectedVersion) {
            throw staleData('This job changed while you were offline.', {
                currentVersion: line.version,
                currentStatus: line.status,
                expectedVersion,
            });
        }
        const upd = await db.operationParcel.updateMany({
            where: {
                id: lineId,
                tenantId: ctx.tenantId,
                ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
            },
            data: {
                status,
                completedAt: status === 'PENDING' ? null : new Date(),
                completedByUserId: status === 'PENDING' ? null : ctx.userId,
                ...(note !== undefined ? { targetNote: note } : {}),
                // Every mutation bumps the version so the NEXT reader/replayer
                // sees a fresh number.
                version: { increment: 1 },
            },
        });
        if (upd.count === 0) {
            // Lost the race between the read above and this write — re-read the
            // current version so the client resolves against fresh state.
            const fresh = await db.operationParcel.findFirst({
                where: { id: lineId, tenantId: ctx.tenantId },
                select: { version: true, status: true },
            });
            throw staleData('This job changed while you were offline.', {
                currentVersion: fresh?.version ?? null,
                currentStatus: fresh?.status ?? null,
                expectedVersion,
            });
        }

        await logEvent(db, ctx, {
            action: 'OPERATION_PARCEL_MARKED',
            entityType: 'OperationParcel',
            entityId: lineId,
            details: `Parcel prescription ${fromStatus} → ${status}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'OperationParcel',
                fromStatus,
                toStatus: status,
            },
        });

        trace.getActiveSpan()?.setAttributes({
            'ag.taskId': taskId,
            'ag.operationParcelId': lineId,
            'ag.parcelId': line.parcelId,
            'ag.status': status,
            'ag.doseValue': Number(line.doseValue),
        });

        // Phase 1 — completing a line (from a non-DONE state) makes it a
        // compliant, inventory-accurate spray record: emit the
        // INPUT_APPLICATION journal entry + the CONSUMPTION ledger entry
        // against the product's FEFO lot. Module-gated (JOURNAL /
        // INVENTORY) inside recordInputApplication; a no-op when both are
        // off, so this is backward-compatible with Feature 1. Un-completing
        // does NOT auto-reverse (the ledger is append-only — post an
        // ADJUSTMENT); re-completing re-emits a fresh application.
        let application: InputApplicationResult | null = null;
        if (status === 'DONE' && fromStatus !== 'DONE') {
            application = await recordInputApplication(db, ctx, {
                id: line.id,
                parcelId: line.parcelId,
                productItemId: line.productItemId,
                doseValue: line.doseValue,
                doseUnitId: line.doseUnitId,
            });

            // The spray record is itself the certification evidence for the
            // plant-protection / input-record control points. Attach it to
            // every scheme control the tenant has mapped — in the SAME
            // transaction as the journal write, so they commit atomically.
            // No-op when the tenant hasn't installed a scheme (no mapped
            // controls) or when JOURNAL is off (no journalEntryId).
            if (application?.journalEntryId) {
                await attachAutoEvidenceFromLogEntry(db, ctx, application.journalEntryId);

                // БАБХ farm-record completion snapshot: freeze the applicator's
                // certificates + the application technique into the
                // INPUT_APPLICATION LogEntry.conditionsJson AT THIS MOMENT.
                // Auditability — a later cert renewal (edit on the membership)
                // must not rewrite the historical record. The generator falls
                // back to live membership values for legacy rows that predate
                // this snapshot. The applicator is the assigned operator (who
                // may also be the one marking the line), else the actor.
                const applicatorUserId = line.task.assigneeUserId ?? ctx.userId;
                const membership = await db.tenantMembership.findUnique({
                    where: { tenantId_userId: { tenantId: ctx.tenantId, userId: applicatorUserId } },
                    select: {
                        applicatorCertNo: true,
                        agronomistCertNo: true,
                        agronomistName: true,
                    },
                });
                const existing = await db.logEntry.findUnique({
                    where: { id: application.journalEntryId },
                    select: { conditionsJson: true },
                });
                const priorConditions =
                    existing?.conditionsJson && typeof existing.conditionsJson === 'object'
                        ? (existing.conditionsJson as Record<string, unknown>)
                        : {};
                await db.logEntry.update({
                    where: { id: application.journalEntryId },
                    data: {
                        conditionsJson: {
                            ...priorConditions,
                            operatorCertNo: membership?.applicatorCertNo ?? null,
                            agronomistName: membership?.agronomistName ?? null,
                            agronomistCertNo: membership?.agronomistCertNo ?? null,
                            applicationTechnique: line.task.applicationTechnique ?? null,
                        },
                    },
                });
            }
        }

        // Auto-resolve the job when no PENDING lines remain.
        let resolved = false;
        if (status !== 'PENDING' && !TERMINAL_STATUSES.includes(line.task.status)) {
            const pending = await db.operationParcel.count({
                where: { taskId, tenantId: ctx.tenantId, status: 'PENDING' },
            });
            if (pending === 0) {
                // Review gate (#6): completing the last parcel sends the job
                // to PENDING_REVIEW (not straight to RESOLVED). A reviewer
                // (ADMIN) approves → RESOLVED, or requests changes → IN_PROGRESS
                // (see reviewFieldOperation). The ДНЕВНИК register + automation
                // signal still fire here — the field work IS done; review gates
                // only the task's finalisation.
                await WorkItemRepository.setStatus(db, ctx, taskId, 'PENDING_REVIEW', null);
                await logEvent(db, ctx, {
                    action: 'TASK_STATUS_CHANGED',
                    entityType: 'Task',
                    entityId: taskId,
                    details: 'Field operation completed — awaiting review',
                    detailsJson: {
                        category: 'status_change',
                        entityName: 'Task',
                        fromStatus: line.task.status,
                        toStatus: 'PENDING_REVIEW',
                        reason: 'All parcels completed — awaiting review',
                    },
                });
                resolved = true;
            }
        }

        trace.getActiveSpan()?.setAttribute('ag.jobResolved', resolved);

        // Field-workflow automation trigger (Epic 60 bus) — emitted at the
        // tail of the tenant tx, once `resolved` is known. Mirrors the
        // OPERATION_PARCEL_MARKED audit action.
        await emitAutomationEvent(ctx, {
            event: 'OPERATION_PARCEL_MARKED',
            entityType: 'OperationParcel',
            entityId: lineId,
            actorUserId: ctx.userId,
            stableKey: `${lineId}:${status}`,
            data: {
                taskId,
                operationParcelId: lineId,
                parcelId: line.parcelId,
                status,
                jobResolved: resolved,
            },
        });

        return { success: true, resolved, application, version: line.version + 1 };
    });

    // БАБХ farm-record — when the job auto-resolves, regenerate the location's
    // current-season ДНЕВНИК into its Farm-records register. Enqueued AFTER
    // the tenant tx commits, fire-and-forget + fail-open: a Redis outage must
    // never roll back the completion the operator just recorded. jobId keyed
    // on the task dedups repeated resolve transitions.
    if (result.resolved) {
        try {
            await enqueue(
                'farm-record-pdf',
                { tenantId: ctx.tenantId, taskId },
                { jobId: `farm-record-${taskId}` },
            );
        } catch (err) {
            logger.warn('farm-record-pdf enqueue failed (task completion unaffected)', {
                component: 'usecase',
                tenantId: ctx.tenantId,
                taskId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return result;
}

/**
 * Review a completed field operation (#6).
 *
 * Separation of duties: the operator (EDITOR / canWrite) marks the parcels;
 * a distinct reviewer (ADMIN / canAdmin) approves or rejects — the ADMIN
 * gate is how "not the executing operator" is enforced by role tier
 * (mirroring `reviewEvidence`). Task-review and Evidence-review are DELIBERATELY
 * two separate actions: this gates the field-operation Task's finalisation,
 * while `reviewEvidence` governs the evidence artifact's lifecycle.
 *
 * State machine (only from PENDING_REVIEW):
 *   APPROVE          → RESOLVED   (finalise the job)
 *   REQUEST_CHANGES  → IN_PROGRESS (reopen for the operator to rework)
 */
export async function reviewFieldOperation(
    ctx: RequestContext,
    taskId: string,
    data: { action: 'APPROVE' | 'REQUEST_CHANGES'; comment?: string | null },
) {
    assertCanAdmin(ctx);
    const { action, comment } = data;
    if (action !== 'APPROVE' && action !== 'REQUEST_CHANGES') {
        throw badRequest('Invalid review action.');
    }

    return runInTenantContext(ctx, async (db) => {
        const task = await db.task.findFirst({
            where: { id: taskId, tenantId: ctx.tenantId },
            select: { id: true, status: true, type: true, title: true, assigneeUserId: true },
        });
        if (!task) throw notFound('Task not found');
        if (task.type !== 'FIELD_OPERATION') {
            throw badRequest('Only field-operation tasks can be reviewed here.');
        }
        if (task.status !== 'PENDING_REVIEW') {
            throw badRequest(
                `Task is ${task.status}, not awaiting review — only a PENDING_REVIEW task can be approved or sent back.`,
            );
        }

        const newStatus = action === 'APPROVE' ? 'RESOLVED' : 'IN_PROGRESS';
        const resolution = action === 'APPROVE' ? (comment || 'Approved') : null;
        await WorkItemRepository.setStatus(db, ctx, taskId, newStatus, resolution);

        await logEvent(db, ctx, {
            action: 'TASK_STATUS_CHANGED',
            entityType: 'Task',
            entityId: taskId,
            details: action === 'APPROVE'
                ? `Field operation approved${comment ? `: ${comment}` : ''}`
                : `Field operation sent back for changes${comment ? `: ${comment}` : ''}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Task',
                fromStatus: 'PENDING_REVIEW',
                toStatus: newStatus,
                reason: comment || undefined,
            },
        });

        // Notify the operator who was assigned the job (graceful degrade when
        // unassigned — mirrors the Evidence review notification).
        if (task.assigneeUserId) {
            await db.notification.create({
                data: {
                    tenantId: ctx.tenantId,
                    userId: task.assigneeUserId,
                    type: 'TASK_ASSIGNED',
                    title: action === 'APPROVE'
                        ? `Field operation approved: ${task.title}`
                        : `Changes requested: ${task.title}`,
                    message: comment
                        || (action === 'APPROVE'
                            ? `Your field operation "${task.title}" was approved.`
                            : `Your field operation "${task.title}" needs changes.`),
                    linkUrl: `/farm-tasks/${taskId}`,
                },
            });
        }

        return { success: true, status: newStatus };
    });
}

/**
 * List the FIELD_OPERATION jobs for a Location (its Operations tab),
 * resolved through the Task↔Location TaskLink.
 */
export async function listLocationOperations(ctx: RequestContext, locationId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const links = await db.taskLink.findMany({
            where: { tenantId: ctx.tenantId, entityType: 'LOCATION', entityId: locationId },
            select: { taskId: true },
        });
        const taskIds = links.map((l) => l.taskId);
        if (taskIds.length === 0) return [];
        return db.task.findMany({
            where: { id: { in: taskIds }, tenantId: ctx.tenantId, type: 'FIELD_OPERATION' },
            include: {
                assignee: { select: { id: true, name: true, email: true } },
                _count: { select: { operationParcels: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    });
}
