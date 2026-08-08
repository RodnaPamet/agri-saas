/**
 * App-layer contracts for the Epic 60 automation foundation.
 *
 * Persistence shapes come from Prisma; this file adds the producer-side
 * typings: event payloads, action configs, and input DTOs used by the
 * dispatcher + repositories. Keeping these here (rather than on the
 * Prisma model) lets the action-type contract evolve without a schema
 * migration — `actionConfigJson` holds the JSON, this file holds the
 * TypeScript shape per action type.
 */

import type {
    AutomationActionType,
    AutomationExecutionStatus,
    AutomationRuleStatus,
} from '@prisma/client';
import type { AutomationEventName } from './events';

// ─── Action payload shapes ─────────────────────────────────────────────
//
// Discriminated union keyed on `actionType`. The dispatcher narrows by
// reading the rule's `actionType` then casts `actionConfigJson` to the
// matching config shape. New action classes require a new enum value +
// an entry here; in-class config tweaks stay in JSON.

export interface NotifyUserActionConfig {
    userIds: string[];
    message: string;
    /** Optional deep link the notification should open. */
    linkUrl?: string;
}

export interface CreateTaskActionConfig {
    title: string;
    severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    priority?: 'P0' | 'P1' | 'P2' | 'P3';
    assigneeUserId?: string;
    /** Linked entity populated from the event payload at fire time. */
    linkEntityType?: string;
    linkEntityIdField?: string;
}

export interface UpdateStatusActionConfig {
    entityType: 'Risk' | 'Task' | 'Control' | 'Issue';
    field: string;
    toStatus: string;
}

export interface WebhookActionConfig {
    url: string;
    method?: 'POST' | 'PUT' | 'PATCH';
    headers?: Record<string, string>;
    /** Reference into the secret store (never the raw secret). */
    secretRef?: string;
}

export type AutomationActionConfig =
    | { type: 'NOTIFY_USER'; config: NotifyUserActionConfig }
    | { type: 'CREATE_TASK'; config: CreateTaskActionConfig }
    | { type: 'UPDATE_STATUS'; config: UpdateStatusActionConfig }
    | { type: 'WEBHOOK'; config: WebhookActionConfig };

// ─── Filter expression (DSL v2, Epic 4) ────────────────────────────────
//
// A recursive condition tree with AND/OR grouping and value-set + range
// operators, matching Archer's conditional-routing capability. The
// evaluator (`filters.ts`) ALSO accepts the legacy flat equality map
// (`{ field: value }`) so pre-Epic-4 rows keep firing without a migration
// — the migration is convenience, the dual-shape evaluator is the contract.

export type FilterOperator =
    | 'eq'
    | 'neq'
    | 'in'
    | 'not_in'
    | 'gt'
    | 'lt'
    | 'contains';

export interface FilterCondition {
    field: string;
    operator: FilterOperator;
    value: string | number | boolean | string[];
}

export interface FilterGroup {
    logic: 'AND' | 'OR';
    conditions: Array<FilterCondition | FilterGroup>;
}

/** Legacy pre-Epic-4 shape: a flat top-level equality map. */
export type LegacyTriggerFilter = Record<string, string | number | boolean>;

/**
 * Stored filter shape. New rules write a `FilterGroup`; legacy rows hold a
 * `LegacyTriggerFilter`. The evaluator narrows by structure at read time.
 */
export type AutomationTriggerFilter = FilterGroup | LegacyTriggerFilter;

/** Type guard — is this value the new recursive group shape? */
export function isFilterGroup(f: unknown): f is FilterGroup {
    return (
        !!f &&
        typeof f === 'object' &&
        'logic' in f &&
        'conditions' in f &&
        Array.isArray((f as FilterGroup).conditions)
    );
}

// The producer-side event shape lives in `event-contracts.ts` as the
// `AutomationDomainEvent` discriminated union. That's the canonical
// type callers should import; this file stays focused on config +
// repository DTOs.

// ─── Repository input DTOs ─────────────────────────────────────────────

/** SLA + chain fields shared by create/update (Epics 5, 7). */
export interface AutomationRuleSlaInput {
    slaWindowMinutes?: number | null;
    slaReminderMinutes?: number | null;
    slaBreachActionType?: AutomationActionType | null;
    slaBreachConfig?: Record<string, unknown> | null;
    /** Epic 7 — chain to this rule after success. */
    nextRuleId?: string | null;
    nextRuleDelay?: number | null;
    /** PR-F — chain to this rule when the (chained) rule's filter does NOT
     * match the payload (the else / condition-fail branch). */
    elseRuleId?: string | null;
    /** PR-E — schedule config for time-based (SCHEDULE) triggers. */
    scheduleConfig?: {
        kind: 'DATE_RELATIVE';
        target: 'Evidence';
        offsetDays: number;
    } | null;
}

export interface CreateAutomationRuleInput extends AutomationRuleSlaInput {
    name: string;
    description?: string | null;
    triggerEvent: AutomationEventName | string;
    triggerFilter?: AutomationTriggerFilter | null;
    actionType: AutomationActionType;
    actionConfig:
        | NotifyUserActionConfig
        | CreateTaskActionConfig
        | UpdateStatusActionConfig
        | WebhookActionConfig;
    status?: AutomationRuleStatus;
    priority?: number;
}

export interface UpdateAutomationRuleInput extends AutomationRuleSlaInput {
    name?: string;
    description?: string | null;
    triggerEvent?: AutomationEventName | string;
    triggerFilter?: AutomationTriggerFilter | null;
    actionType?: AutomationActionType;
    actionConfig?:
        | NotifyUserActionConfig
        | CreateTaskActionConfig
        | UpdateStatusActionConfig
        | WebhookActionConfig;
    status?: AutomationRuleStatus;
    priority?: number;
}

export interface AutomationRuleListFilters {
    status?: AutomationRuleStatus;
    triggerEvent?: string;
    actionType?: AutomationActionType;
    /** When true, include soft-deleted (archived) rules. Default: false. */
    includeDeleted?: boolean;
}

export interface RecordAutomationExecutionStartInput {
    ruleId: string;
    triggerEvent: string;
    triggerPayload: Record<string, unknown>;
    idempotencyKey?: string | null;
    /** 'event' | 'manual' | 'schedule' — free-form string for extension. */
    triggeredBy?: string;
    jobRunId?: string | null;
}

export interface RecordAutomationExecutionCompletionInput {
    status: Extract<
        AutomationExecutionStatus,
        'SUCCEEDED' | 'FAILED' | 'SKIPPED'
    >;
    outcome?: Record<string, unknown> | null;
    errorMessage?: string | null;
    errorStack?: string | null;
    durationMs?: number | null;
}

export interface AutomationExecutionListFilters {
    ruleId?: string;
    status?: AutomationExecutionStatus;
    triggerEvent?: string;
}
