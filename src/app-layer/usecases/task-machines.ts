/**
 * The MECHANISATOR machine reads — #2948 stage 3b.
 *
 * Three reads under `/farm-tasks`, and the PATH is the design rather than a
 * filing choice. `isOperatorAllowedPath`'s API branch enumerates
 * `farm-tasks|field-operations|tasks|locations|agro` and admits no `machines`
 * prefix, so a MECHANISATOR reaches these and is refused `operator_scope` at
 * the Edge on everything in `machines.ts` next door. Moving one of these to
 * `/machines/...` would make it unreachable for the only role that needs it,
 * and the symptom would be a 403 from the Edge rather than anything in a
 * handler.
 *
 * ## They authorise on ASSIGNMENT, not on a permission flag
 *
 * `machines.view` is OWNER + ADMIN, which is right for the fleet and the
 * tracks. The owner's rule for the operator persona is narrower AND different
 * in kind: a mechanisator sees ONLY the machine on their own current task. No
 * role expresses that, so the checks are in the handler path — the shape
 * `requirePermission` cannot carry.
 *
 * ## Every refusal is the same 404
 *
 * A task that does not exist, one belonging to another farm, one assigned to
 * somebody else, and one that is closed all answer alike. Distinguishing them
 * would tell a driver which task ids exist and who they belong to.
 */
import type { AssetType, Role } from '@prisma/client';

import type { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { MachineRepository } from '../repositories/MachineRepository';
import { OPERATOR_OPEN_STATUSES } from './farm-task';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { codedBadRequest, codedForbidden, codedNotFound } from '@/lib/errors/types';
import { rolesWithPermission } from '@/lib/permissions';
import {
    decimalToNumber,
    LOCATABLE_ASSET_TYPES,
    isMoving,
    isSelfPropelled,
    resolvePositionSource,
    type PositionSourceView,
    type PositionView,
} from '@/lib/machines/fleet-view';

export interface TaskMachineView {
    assetId: string;
    name: string;
    type: AssetType;
    lastPosition: PositionView | null;
    /**
     * How many LOCATABLE machines the task has, so a client can say "and one
     * more" instead of presenting one of two as though it were the only one.
     *
     * #2948: "A UI that shows one of N without saying so is how somebody ends
     * up walking to the wrong end of a field." Named `locatableCount` rather
     * than `trackedCount` by the rename agrent-ios agreed — under a vendor
     * source there is no tracker box, so the honest question is whether the
     * machine has a position source at all.
     */
    locatableCount: number;
}

export interface TaskAssetView {
    assetId: string;
    name: string;
    type: AssetType;
    /** Configuration only. The KEY is always present; null means none. */
    positionSource: PositionSourceView | null;
}

export interface TrackedMachinesView {
    /** NAME AND TYPE ONLY — no positions, no IMEI, no last-seen. */
    machines: { name: string; type: AssetType }[];
    /**
     * The roles that can see machine positions, DERIVED from the permission
     * table rather than listed.
     *
     * #2948 returns this instead of letting each client hardcode it "so that
     * if the visibility rule is ever widened, every client's notice changes
     * with it instead of one of them going quietly stale". That promise holds
     * only because `ALL_ROLES` is exhaustive by the type system: a seventh
     * role is a compile error, not a silent omission here.
     */
    visibleTo: Role[];
}

/**
 * The machine on the caller's own open task.
 *
 * Returns ONE machine, chosen by a total order, and discloses the collapse
 * through `locatableCount`.
 */
export async function readTaskMachine(
    ctx: RequestContext,
    taskId: string,
): Promise<TaskMachineView> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const notFound = () => codedNotFound('TASK_NOT_FOUND', 'No such task.');

        const task = await MachineRepository.findTaskAuth(db, ctx, taskId);
        if (task === null) throw notFound();
        // ASSIGNMENT, then OPENNESS — and the same refusal for both, plus for
        // a task in another tenant, which the `where` already excluded. An
        // ADMIN who is not the assignee is refused here too and uses
        // `/machines` instead; the rule is assignment, not seniority.
        if (task.assigneeUserId !== ctx.userId) throw notFound();
        if (!OPERATOR_OPEN_STATUSES.has(task.status)) throw notFound();

        const assets = await MachineRepository.listTaskLocatableAssets(db, ctx, taskId);
        if (assets.length === 0) throw notFound();

        const ids = assets.map((a) => a.id);
        const [installs, positions] = await Promise.all([
            MachineRepository.earliestTrackerInstall(db, ctx, ids),
            MachineRepository.latestPositions(db, ctx, ids),
        ]);

        // The order #2948 specifies, and it is TOTAL on purpose:
        //   1. self-propelled before trailed — an implement has no engine and
        //      sits wherever the tractor pulling it is, so a driver asking
        //      "where is my machine" means the thing that moves itself;
        //   2. earliest live-tracker install;
        //   3. assetId — unique, so there is no tie left to break.
        // Steps 1 and 2 carry the meaning; step 3 carries the guarantee.
        const FAR_FUTURE = 8_640_000_000_000_000;
        const chosen = [...assets].sort((a, b) => {
            const selfA = isSelfPropelled(a.type) ? 0 : 1;
            const selfB = isSelfPropelled(b.type) ? 0 : 1;
            if (selfA !== selfB) return selfA - selfB;
            const ia = installs.get(a.id)?.getTime() ?? FAR_FUTURE;
            const ib = installs.get(b.id)?.getTime() ?? FAR_FUTURE;
            if (ia !== ib) return ia - ib;
            return a.id.localeCompare(b.id);
        })[0];

        const p = positions.find((x) => x.assetId === chosen.id);
        const speedKph = decimalToNumber(p?.speedKph ?? null);

        return {
            assetId: chosen.id,
            name: chosen.name,
            type: chosen.type,
            lastPosition: p
                ? {
                      lat: p.lat.toString(),
                      lon: p.lon.toString(),
                      recordedAt: p.recordedAt.toISOString(),
                      speedKph,
                      ignition: p.ignition,
                      moving: isMoving(speedKph),
                  }
                : null,
            locatableCount: assets.length,
        };
    });
}

/**
 * Every locatable asset on a task, with whether each has a position source.
 *
 * Readable by any member who can read the task — a wider audience than
 * `readTaskMachine`, and safe to be: it carries CONFIGURATION and no
 * coordinates, so it answers "which of these is findable" without saying
 * where anything is.
 */
export async function listTaskAssets(
    ctx: RequestContext,
    taskId: string,
): Promise<{ assets: TaskAssetView[] }> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const task = await MachineRepository.findTaskAuth(db, ctx, taskId);
        if (task === null) throw codedNotFound('TASK_NOT_FOUND', 'No such task.');

        const assets = await MachineRepository.listTaskLocatableAssets(db, ctx, taskId);
        if (assets.length === 0) return { assets: [] };

        const ids = assets.map((a) => a.id);
        const [trackerIds, providers] = await Promise.all([
            MachineRepository.liveTrackerAssetIds(db, ctx, ids),
            MachineRepository.liveTelematicsProviders(db, ctx, ids),
        ]);

        return {
            assets: assets.map((a) => ({
                assetId: a.id,
                name: a.name,
                type: a.type,
                // The key is ALWAYS present, null included — agrent-ios reads
                // key presence, so omitting it for an unconfigured machine
                // would be a different answer rather than a smaller payload.
                positionSource: resolvePositionSource({
                    hasLiveTracker: trackerIds.has(a.id),
                    liveTelematicsProvider: providers.get(a.id) ?? null,
                }),
            })),
        };
    });
}

/**
 * The drivers' transparency notice — every tracked machine on the farm.
 *
 * Tenant-wide and NOT per task, which is the point: a driver is entitled to
 * know which machines are tracked, not merely the one they happen to be on
 * today. Readable by every role, the operator persona included.
 */
export async function listTrackedMachines(
    ctx: RequestContext,
): Promise<TrackedMachinesView> {
    assertCanRead(ctx);

    const machines = await runInTenantContext(ctx, (db) =>
        MachineRepository.listTrackedMachineNames(db, ctx),
    );

    return {
        machines,
        visibleTo: rolesWithPermission((p) => p.machines.view),
    };
}

/**
 * The granular gate, mirroring the route's `requirePermission`.
 *
 * `assertCanWrite` is the coarse first gate and is NOT sufficient here: it
 * admits an EDITOR, and `machines.manage` is false for EDITOR, AUDITOR, READER
 * and MECHANISATOR alike. A usecase weaker than its own route is how a second
 * caller — a job, an admin script, another route — gets a permission the
 * product never granted, which is the C.1 argument applied one layer in.
 *
 * Keeping both means the two refusals stay distinguishable: a READER is told
 * they cannot modify records at all, an EDITOR that this particular register is
 * not theirs.
 */
function assertCanManageMachines(ctx: RequestContext): void {
    assertCanWrite(ctx);
    if (!ctx.appPermissions.machines.manage) {
        throw codedForbidden(
            'MACHINES_MANAGE_REQUIRED',
            'Only an owner or an administrator may change which machines are on a task.',
            { role: ctx.role },
        );
    }
}

/**
 * Attach a machine to a task — #3026, the write half of stage 3b's read.
 *
 * ## Idempotent on the INDEX, not on a pre-read
 *
 * `TaskAsset` carries `@@unique([taskId, assetId])`, so a second POST for the
 * same pair must answer 2xx without writing a second row. That is an `upsert`
 * rather than "read, then create if absent": the pre-read spelling has a
 * window between the two statements, and the phone retries — it is an outbox
 * client on rural LTE, so a duplicate request is the NORMAL case rather than
 * the pathological one.
 *
 * The `update` is deliberately EMPTY. There is nothing on this row to change:
 * it is the association itself, and `createdAt` recording the FIRST attachment
 * is the honest value — a re-attach that moved it would make an idempotent
 * retry look like a new decision in the audit trail.
 *
 * ## What the DATABASE refuses, and what this function has to
 *
 * A cross-farm pairing — one tenant's task with another's asset — violates one
 * of `TaskAsset`'s two composite FKs, so the database refuses it whatever this
 * code does (`machine-tracking-schema` §2 asserts that). What the handler owes
 * is a READABLE refusal rather than a 500, which is why both ids are resolved
 * through the tenant-scoped reads first: an asset in another farm is simply not
 * found, which is also the right disclosure — a 404 says nothing about whether
 * that id exists somewhere else.
 *
 * ## Locatable only, and that is a product rule rather than a type check
 *
 * `listTaskAssets` filters to locatable types because "which of these is
 * findable" is the question every caller asks of that list. Attaching a hand
 * tool would therefore write a row no read returns — the write-with-no-reader
 * shape P9.3 shipped three times — so it is refused here with a code the phone
 * can act on.
 */
export async function attachTaskAsset(
    ctx: RequestContext,
    taskId: string,
    assetId: string,
): Promise<{ attached: true; alreadyAttached: boolean }> {
    assertCanManageMachines(ctx);

    return runInTenantContext(ctx, async (db) => {
        const task = await MachineRepository.findTaskAuth(db, ctx, taskId);
        if (task === null) throw codedNotFound('TASK_NOT_FOUND', 'No such task.');

        const asset = await db.asset.findFirst({
            where: { id: assetId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true, type: true },
        });
        if (asset === null) throw codedNotFound('ASSET_NOT_FOUND', 'No such machine.');
        if (!LOCATABLE_ASSET_TYPES.includes(asset.type)) {
            throw codedBadRequest(
                'ASSET_NOT_LOCATABLE',
                'That asset cannot be located, so it cannot be put on a task as a machine.',
            );
        }

        /*
         * `createMany` + `skipDuplicates` — ONE statement, and the unique index
         * arbitrates.
         *
         * `upsert` was the obvious spelling and is NOT atomic for a compound
         * unique: Prisma reads, then inserts, so two overlapping transactions
         * both miss and the loser raises P2002. Measured here rather than
         * reasoned about — the concurrency case in
         * `task-machine-writes.test.ts` failed intermittently, 2 runs in 4,
         * with `Unique constraint failed on …TaskAsset_taskId_assetId_key`
         * pointing straight at the `upsert` call.
         *
         * `skipDuplicates` compiles to `ON CONFLICT DO NOTHING`, so the
         * database resolves the collision and `count` reports which side of it
         * this call was on: 1 means this call created the row, 0 means it was
         * already there. That also removes the pre-read entirely — the
         * read-then-write window is gone rather than narrowed.
         *
         * Note `skipDuplicates` is deliberately NOT used on `MachinePosition`,
         * for the opposite reason: that table has no unique key, so it would
         * silently do nothing. It works here BECAUSE `@@unique([taskId,
         * assetId])` exists.
         */
        const written = await db.taskAsset.createMany({
            data: [{ tenantId: ctx.tenantId, taskId, assetId }],
            skipDuplicates: true,
        });
        const alreadyAttached = written.count === 0;

        /*
         * The audit row is written only on a REAL attachment. A retry that
         * changed nothing must not append an entry claiming somebody decided
         * something — the trail would then report one farmer's flaky signal as
         * repeated management action.
         *
         * A DOMAIN verb, not `CREATE`: the row-level shape ("a TaskAsset was
         * created") understates it, and `detailsJson.operation` is `created`
         * for every join row in the product, so the verb is the only field a
         * SIEM filter can separate this on. That is CLAUDE.md's stated rule
         * for when the canonical verb is the wrong choice.
         */
        if (!alreadyAttached) {
            await logEvent(db, ctx, {
                action: 'TASK_MACHINE_ATTACHED',
                entityType: 'TaskAsset',
                entityId: `${taskId}:${assetId}`,
                details: `Attached machine ${asset.name} to task ${taskId}`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'TaskAsset',
                    operation: 'created',
                    after: { taskId, assetId },
                    summary: `Attached a machine to a task`,
                },
            });
        }

        return { attached: true, alreadyAttached };
    });
}

/**
 * Detach a machine from a task — idempotent, and silent about absence.
 *
 * `deleteMany` rather than `delete`: the pair may already be gone, and the
 * phone's retry must not meet a 404 for work it already completed. That makes
 * "zero rows affected" ambiguous between already-detached and never-attached,
 * and the API answers the same 2xx for both — the distinction is reported as
 * `wasAttached` for a caller that cares and is deliberately not an error.
 *
 * **The task is resolved first, and that is what the tenant check rests on.**
 * Under RLS a refused DELETE also affects zero rows and returns normally
 * (`rls-delete-is-silent-and-select-governs-it`), so reading "zero rows" as
 * "already gone" without having established that the TASK is this farm's would
 * turn a cross-tenant attempt into a cheerful success.
 */
export async function detachTaskAsset(
    ctx: RequestContext,
    taskId: string,
    assetId: string,
): Promise<{ detached: true; wasAttached: boolean }> {
    assertCanManageMachines(ctx);

    return runInTenantContext(ctx, async (db) => {
        const task = await MachineRepository.findTaskAuth(db, ctx, taskId);
        if (task === null) throw codedNotFound('TASK_NOT_FOUND', 'No such task.');

        /*
         * `tenantId` here is defence in depth and is UNPROVEN by the suite:
         * removing it leaves all fifteen cases green, because
         * `runInTenantContext` has already bound RLS and the policy scopes the
         * delete to this farm. It stays for the reason every repository query
         * in this codebase carries one — the application filter is what makes
         * an error message legible when the app is working correctly — and the
         * cross-farm case is caught one line above, where the TASK fails to
         * resolve.
         */
        const res = await db.taskAsset.deleteMany({
            where: { taskId, assetId, tenantId: ctx.tenantId },
        });

        if (res.count > 0) {
            await logEvent(db, ctx, {
                action: 'TASK_MACHINE_DETACHED',
                entityType: 'TaskAsset',
                entityId: `${taskId}:${assetId}`,
                details: `Detached machine ${assetId} from task ${taskId}`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'TaskAsset',
                    operation: 'deleted',
                    before: { taskId, assetId },
                    summary: `Detached a machine from a task`,
                },
            });
        }

        return { detached: true, wasAttached: res.count > 0 };
    });
}
