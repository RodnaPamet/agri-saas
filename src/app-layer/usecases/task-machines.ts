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
import { assertCanRead } from '../policies/common';
import { MachineRepository } from '../repositories/MachineRepository';
import { OPERATOR_OPEN_STATUSES } from './farm-task';
import { runInTenantContext } from '@/lib/db-context';
import { codedNotFound } from '@/lib/errors/types';
import { rolesWithPermission } from '@/lib/permissions';
import {
    decimalToNumber,
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
