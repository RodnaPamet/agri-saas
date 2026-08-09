import type { WorkItemStatus } from '@prisma/client';
import { RequestContext } from '../types';
import { badRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { JournalRepository } from '../repositories/JournalRepository';
import { WorkItemRepository } from '../repositories/WorkItemRepository';
import { createTask, addTaskLink, listTasks } from './task';
import { getFarmTaskType } from '@/lib/agriculture/farm-task-types';

/**
 * Farm tasks — assignable field work tied to places/crops/equipment.
 *
 * This is a THIN orchestration over the IC Task module (reused unchanged):
 * a FARM_TASK is a `Task` whose LiteFarm-catalog type + category ride in
 * `metadataJson`, linked to Location/Parcel/Equipment via `TaskLink`, and
 * assigned through the same path that fires the TASK_ASSIGNED notification.
 * No change to `usecases/task.ts`, `TaskLink`, or the assignment pipeline.
 */

/** The two WorkItemTypes that make up an operator's farm queue. */
const FARM_TASK_TYPES_FILTER = ['FARM_TASK', 'FIELD_OPERATION'] as const;

export interface CreateFarmTaskInput {
    title: string;
    /** A key from the farm-task-type catalog (src/lib/agriculture). */
    farmTaskType: string;
    description?: string | null;
    priority?: string;
    dueAt?: string | null;
    assigneeUserId?: string | null;
    locationIds?: string[];
    parcelIds?: string[];
    equipmentIds?: string[];
}

function assertAllOwned(label: string, requested: string[], valid: Set<string>) {
    const missing = requested.filter((id) => !valid.has(id));
    if (missing.length) {
        throw badRequest('INVALID_LINK', `${label} not found or belongs to a different tenant: ${missing[0]}`);
    }
}

/**
 * Create a farm task. Link ownership is validated BEFORE the task is
 * created so a bad link never leaves an orphan task. Then the IC Task
 * module does the work: createTask (with the FARM_TASK discriminator +
 * catalog type in metadata + assignee → TASK_ASSIGNED) and addTaskLink
 * per place/equipment.
 */
export async function createFarmTask(ctx: RequestContext, input: CreateFarmTaskInput) {
    const typeDef = getFarmTaskType(input.farmTaskType);
    if (!typeDef) throw badRequest('INVALID_FARM_TASK_TYPE', `Unknown farm task type: ${input.farmTaskType}`);

    const locationIds = input.locationIds ?? [];
    const parcelIds = input.parcelIds ?? [];
    const equipmentIds = input.equipmentIds ?? [];

    // Validate every link target belongs to the tenant (no orphan on failure).
    await runInTenantContext(ctx, async (db) => {
        if (locationIds.length) {
            assertAllOwned('Location', locationIds, await JournalRepository.validLocationIds(db, ctx, locationIds));
        }
        if (parcelIds.length) {
            assertAllOwned('Parcel', parcelIds, await JournalRepository.validParcelIds(db, ctx, parcelIds));
        }
        if (equipmentIds.length) {
            assertAllOwned('Equipment', equipmentIds, await JournalRepository.validEquipmentIds(db, ctx, equipmentIds));
        }
    });

    const task = await createTask(ctx, {
        type: 'FARM_TASK',
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        dueAt: input.dueAt ?? null,
        assigneeUserId: input.assigneeUserId ?? null,
        metadataJson: { farmTaskType: typeDef.key, farmTaskCategory: typeDef.category },
    });

    // Reuse TaskLink via the Task module's addTaskLink (entityType is the
    // freshly-widened enum value).
    for (const id of locationIds) await addTaskLink(ctx, task.id, 'LOCATION', id);
    for (const id of parcelIds) await addTaskLink(ctx, task.id, 'PARCEL', id);
    for (const id of equipmentIds) await addTaskLink(ctx, task.id, 'EQUIPMENT', id);

    return task;
}

export interface FarmTaskQueueOptions {
    /** Defaults to the caller (the operator's own queue) when scope is 'mine'.
     *  An ARRAY since the assignee facet is multi-select on /farm-tasks. */
    assigneeUserId?: string[];
    status?: WorkItemStatus[];
    /**
     * When true, return only the operator's OUTSTANDING work — tasks that
     * still need them. Excludes terminal statuses (RESOLVED/CLOSED/CANCELED)
     * AND PENDING_REVIEW (a field operation whose parcels are all marked is
     * the reviewer's turn, not the operator's). Drives the "My work" screen.
     */
    openOnly?: boolean;
    /**
     * 'mine' (default) → tasks assigned to the caller (the operator queue that
     * backs /my-work and the bare endpoint).
     * 'all' → every FARM_TASK + FIELD_OPERATION in the tenant. This backs the
     * /farm-tasks page now that it is the SOLE task UI: OWNER/ADMIN/EDITOR must
     * see and manage tasks they assigned to others, and the assignee filter is
     * only meaningful across assignees. Still gated by task READ permission
     * inside `listTasks` (same visibility the retired compliance list had).
     */
    scope?: 'mine' | 'all';
}

/** Statuses that count as an operator's outstanding to-do. */
const OPERATOR_OPEN_STATUSES = new Set(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED']);

/**
 * An operator's farm-work queue — FARM_TASK + FIELD_OPERATION assigned to
 * the user, soonest-due first. Reuses `listTasks` (one bounded call per
 * type) and merges; no new repository surface.
 */
export async function listMyFarmTasks(ctx: RequestContext, opts: FarmTaskQueueOptions = {}) {
    const scope = opts.scope ?? 'mine';
    // 'all' leaves assignee unset (unless an explicit narrowing was asked for)
    // so `listTasks` returns every tenant task of the type; 'mine' defaults to
    // the caller. `listTasks` still asserts read permission either way.
    // 'all' honours whatever the facet selected (possibly nothing);
    // 'mine' falls back to the caller when the facet is empty.
    const assigneeUserId =
        scope === 'all'
            ? opts.assigneeUserId
            : (opts.assigneeUserId?.length
                ? opts.assigneeUserId
                : ctx.userId
                  ? [ctx.userId]
                  : undefined);

    const lists = await Promise.all(
        FARM_TASK_TYPES_FILTER.map((type) =>
            listTasks(
                ctx,
                {
                    assigneeUserId,
                    status: opts.status,
                    type,
                },
                { take: 200 },
            ),
        ),
    );
    let merged = lists.flat();

    // Operator "outstanding work" filter — drops done + awaiting-review rows.
    if (opts.openOnly) {
        merged = merged.filter((t) => OPERATOR_OPEN_STATUSES.has(t.status));
    }

    // Soonest-due first; null dueAt sinks to the bottom; newest as tiebreak.
    merged.sort((a, b) => {
        const da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
        const db = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
        if (da !== db) return da - db;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return merged.slice(0, 200);
}

// ─── Dashboard trend ───

export interface FarmTaskTrendPoint {
    /** UTC calendar day, ISO `YYYY-MM-DD`. */
    date: string;
    /** Farm tasks created on this day. */
    created: number;
    /** Farm tasks completed (RESOLVED / CLOSED) on this day. */
    completed: number;
}

const TREND_DEFAULT_DAYS = 14;
const TREND_MIN_DAYS = 7;
const TREND_MAX_DAYS = 60;
const DAY_MS = 86_400_000;

/** UTC-midnight epoch ms of the calendar day containing `d`. */
function utcDayStartMs(d: Date): number {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** ISO `YYYY-MM-DD` for a UTC-midnight epoch ms. */
function isoDay(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Daily "created vs completed" farm-task counts over the last N days
 * (default 14), for the dashboard trendline. Buckets by UTC calendar day and
 * pre-seeds every day at zero so gaps render flat, not missing. A task
 * created before the window but completed within it counts only in the
 * completed series (and vice-versa); a task both created and completed
 * in-window counts once in each series, on its respective day.
 */
export async function getFarmTaskTrend(
    ctx: RequestContext,
    days: number = TREND_DEFAULT_DAYS,
): Promise<FarmTaskTrendPoint[]> {
    const span = Math.min(
        TREND_MAX_DAYS,
        Math.max(TREND_MIN_DAYS, Math.floor(days) || TREND_DEFAULT_DAYS),
    );
    const todayStart = utcDayStartMs(new Date());
    const firstDay = todayStart - (span - 1) * DAY_MS;

    const created = new Map<string, number>();
    const completed = new Map<string, number>();
    const order: string[] = [];
    for (let i = 0; i < span; i++) {
        const key = isoDay(firstDay + i * DAY_MS);
        order.push(key);
        created.set(key, 0);
        completed.set(key, 0);
    }

    const rows = await runInTenantContext(ctx, (db) =>
        WorkItemRepository.farmTaskTrendRows(db, ctx, new Date(firstDay)),
    );

    for (const row of rows) {
        const cKey = isoDay(utcDayStartMs(row.createdAt));
        if (created.has(cKey)) created.set(cKey, (created.get(cKey) ?? 0) + 1);
        if (row.completedAt) {
            const dKey = isoDay(utcDayStartMs(row.completedAt));
            if (completed.has(dKey)) completed.set(dKey, (completed.get(dKey) ?? 0) + 1);
        }
    }

    return order.map((date) => ({
        date,
        created: created.get(date) ?? 0,
        completed: completed.get(date) ?? 0,
    }));
}
