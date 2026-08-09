/**
 * Farm-tasks list-page filter configuration (Epic 53).
 *
 * The farm queue is the sole task UI, so it exposes the manager-relevant
 * subset of the task filters: status, assignee, and a due-date shortcut.
 * Compliance-only axes (type / severity / linked-practice) live on the retired
 * /tasks list and are intentionally omitted here.
 *
 * Filtering is applied CLIENT-SIDE over the bounded queue (the endpoint
 * returns a flat merged FARM_TASK + FIELD_OPERATION array), mirroring the
 * Journal list page — these defs drive the FilterToolbar UI; the client reads
 * `useFilters()` state to narrow the loaded rows.
 */

import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import type { FilterOption, Filter as FilterType } from '@/components/ui/filter/types';
import { CircleDot, Clock, UserCircle2 } from 'lucide-react';

/** The `taskEnums` translator the client passes in (`useTranslations`). */
type TaskEnumTranslator = (key: string) => string;

// Status VALUES are load-bearing (they equal the WorkItemStatus enum); the
// DISPLAY labels resolve via the `taskEnums` translator at build time. These
// English strings are only fallbacks for `optionsFromEnum`'s static shape.
export const FARM_STATUS_LABELS = {
    OPEN: 'Open',
    TRIAGED: 'Planned',
    IN_PROGRESS: 'In Progress',
    BLOCKED: 'Blocked',
    PENDING_REVIEW: 'Pending review',
    RESOLVED: 'Done',
    CLOSED: 'Closed',
    CANCELED: 'Canceled',
} as const;

export const FARM_DUE_LABELS = {
    overdue: 'Overdue',
    next7d: 'Due in 7 days',
} as const;

const STATIC_DEFS = {
    status: {
        label: 'Status',
        description: 'Task lifecycle state.',
        group: 'Attributes',
        icon: CircleDot,
        options: optionsFromEnum(FARM_STATUS_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
    assigneeUserId: {
        label: 'Assignee',
        labelPlural: 'Assignees',
        description: 'Only show tasks assigned to this person.',
        group: 'People',
        icon: UserCircle2,
        options: null, // derived from the loaded rows at render time
        multiple: true,
        shouldFilter: true,
        resetBehavior: 'clearable',
    },
    due: {
        label: 'Due',
        description: 'Shortcut for overdue / due-soon filtering.',
        group: 'Timeline',
        icon: Clock,
        options: optionsFromEnum(FARM_DUE_LABELS),
        // Single-select — the chip semantics are mutually exclusive.
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

export const farmTaskFilterDefs = createTypedFilterDefs()(STATIC_DEFS);
export const FARM_TASK_FILTER_KEYS = farmTaskFilterDefs.filterKeys;

interface FarmAssigneeLike {
    assignee?: { id: string; name: string | null; email: string | null } | null;
}

export function assigneeOptionsFromFarmTasks(
    tasks: ReadonlyArray<FarmAssigneeLike>,
    unknownLabel = 'Unknown',
): FilterOption[] {
    const seen = new Map<string, FilterOption>();
    for (const t of tasks) {
        const a = t.assignee;
        if (!a?.id || seen.has(a.id)) continue;
        const name = a.name?.trim() || a.email?.trim() || unknownLabel;
        seen.set(a.id, {
            value: a.id,
            label: a.email ? `${name} — ${a.email}` : name,
            displayLabel: name,
        });
    }
    return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
}

const FARM_STATUS_VALUES = Object.keys(FARM_STATUS_LABELS);
const FARM_DUE_VALUES = Object.keys(FARM_DUE_LABELS);

export function buildFarmTaskFilters(
    t: TaskEnumTranslator,
    tasks: ReadonlyArray<FarmAssigneeLike>,
): FilterType[] {
    const assigneeOpts = assigneeOptionsFromFarmTasks(tasks, t('ui.unknown'));
    const localizedOptions = (sub: string, values: readonly string[]): FilterOption[] =>
        values.map((v) => ({ value: v, label: t(`${sub}.${v}`) }));
    return farmTaskFilterDefs.filters.map((f): FilterType => {
        switch (f.key) {
            case 'status':
                return { ...f, label: t('ui.filterStatus'), description: t('filterDesc.status'), options: localizedOptions('status', FARM_STATUS_VALUES) };
            case 'assigneeUserId':
                return { ...f, label: t('ui.filterAssignee'), labelPlural: t('ui.filterAssigneePlural'), description: t('filterDesc.assignee'), options: assigneeOpts };
            case 'due':
                return { ...f, label: t('ui.filterDue'), description: t('filterDesc.due'), options: localizedOptions('due', FARM_DUE_VALUES) };
            default:
                return f;
        }
    });
}
