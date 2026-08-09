/**
 * Zod schemas for automation-rule API input (Workflow Automation Epic 1).
 *
 * The action config is a discriminated union keyed on `actionType`, mirroring
 * `AutomationActionConfig` in `src/app-layer/automation/types.ts`. The trigger
 * filter stays a permissive record at Epic 1 (flat equality map); Epic 4
 * replaces it with the recursive FilterGroup DSL.
 */
import { z } from 'zod';
import { AutomationActionType, AutomationRuleStatus } from '@prisma/client';

const Name = z.string().min(1, 'Name is required').max(200).transform((s) => s.trim());
const OptionalDescription = z
    .union([z.string().max(2000).transform((s) => s.trim()), z.null()])
    .optional();

// ─── Action config (discriminated union) ────────────────────────────

const NotifyUserConfig = z.object({
    userIds: z.array(z.string().min(1)).min(1, 'Select at least one recipient'),
    message: z.string().min(1).max(2000),
    linkUrl: z.string().url().optional(),
});

const CreateTaskConfig = z.object({
    title: z.string().min(1).max(300),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
    assigneeUserId: z.string().optional(),
    linkEntityType: z.string().optional(),
    linkEntityIdField: z.string().optional(),
});

const UpdateStatusConfig = z.object({
    entityType: z.enum(['Risk', 'Task', 'Control', 'Issue']),
    field: z.string().min(1),
    toStatus: z.string().min(1),
});

const WebhookConfig = z.object({
    url: z.string().url(),
    method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    secretRef: z.string().optional(),
});

// VR-7 — invoke a sub-flow group's entry rule.
const InvokeSubflowConfig = z.object({
    targetGroupId: z.string().min(1),
});

/**
 * A rule's `(actionType, actionConfig)` pair must agree. We validate the
 * config shape against the declared action type via `superRefine` so a
 * NOTIFY_USER rule can't ship a webhook config.
 */
const ACTION_CONFIG_BY_TYPE = {
    NOTIFY_USER: NotifyUserConfig,
    CREATE_TASK: CreateTaskConfig,
    UPDATE_STATUS: UpdateStatusConfig,
    WEBHOOK: WebhookConfig,
    INVOKE_SUBFLOW: InvokeSubflowConfig,
} as const;

// Filter DSL v2 (Epic 4) — a recursive FilterGroup, OR the legacy flat
// equality map for backward compatibility. The evaluator (filters.ts)
// narrows by structure at read time.
const FilterCondition = z.object({
    field: z.string().min(1),
    operator: z.enum(['eq', 'neq', 'in', 'not_in', 'gt', 'lt', 'contains']),
    value: z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.string()),
    ]),
});

// Recursive group: conditions may be leaf conditions or nested groups.
type FilterGroupShape = {
    logic: 'AND' | 'OR';
    conditions: Array<z.infer<typeof FilterCondition> | FilterGroupShape>;
};
const FilterGroup: z.ZodType<FilterGroupShape> = z.lazy(() =>
    z.object({
        logic: z.enum(['AND', 'OR']),
        conditions: z.array(z.union([FilterCondition, FilterGroup])),
    }),
);

const LegacyFlatFilter = z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
);

const TriggerFilter = z.union([FilterGroup, LegacyFlatFilter]).nullable().optional();

// PR-E — time-based trigger schedule (for triggerEvent === 'SCHEDULE').
const ScheduleConfig = z
    .object({
        kind: z.literal('DATE_RELATIVE'),
        target: z.enum(['Evidence']),
        offsetDays: z.number().int().min(0).max(365),
    })
    .nullable()
    .optional();

// SLA (Epic 5) + chain (Epic 7) fields — shared by create/update.
const SlaFields = {
    slaWindowMinutes: z.number().int().min(1).max(525600).nullable().optional(),
    slaReminderMinutes: z.number().int().min(1).max(525600).nullable().optional(),
    slaBreachActionType: z.nativeEnum(AutomationActionType).nullable().optional(),
    slaBreachConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    nextRuleId: z.string().min(1).nullable().optional(),
    nextRuleDelay: z.number().int().min(0).max(525600).nullable().optional(),
    elseRuleId: z.string().min(1).nullable().optional(),
    scheduleConfig: ScheduleConfig,
};

export const CreateAutomationRuleSchema = z
    .object({
        name: Name,
        description: OptionalDescription,
        triggerEvent: z.string().min(1, 'Trigger event is required'),
        triggerFilter: TriggerFilter,
        actionType: z.nativeEnum(AutomationActionType),
        actionConfig: z.record(z.string(), z.unknown()),
        status: z.nativeEnum(AutomationRuleStatus).optional(),
        priority: z.number().int().min(0).max(1000).optional(),
        ...SlaFields,
    })
    .superRefine((val, ctx) => {
        const schema = ACTION_CONFIG_BY_TYPE[val.actionType];
        const res = schema.safeParse(val.actionConfig);
        if (!res.success) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['actionConfig'],
                message: `Invalid config for ${val.actionType}: ${res.error.issues[0]?.message ?? 'invalid'}`,
            });
        }
    });

export const UpdateAutomationRuleSchema = z
    .object({
        name: Name.optional(),
        description: OptionalDescription,
        triggerEvent: z.string().min(1).optional(),
        triggerFilter: TriggerFilter,
        actionType: z.nativeEnum(AutomationActionType).optional(),
        actionConfig: z.record(z.string(), z.unknown()).optional(),
        status: z.nativeEnum(AutomationRuleStatus).optional(),
        priority: z.number().int().min(0).max(1000).optional(),
        ...SlaFields,
    })
    .superRefine((val, ctx) => {
        // Only validate config when BOTH type and config are present together
        // (a partial update of just `priority` carries neither).
        if (val.actionType && val.actionConfig) {
            const res = ACTION_CONFIG_BY_TYPE[val.actionType].safeParse(val.actionConfig);
            if (!res.success) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['actionConfig'],
                    message: `Invalid config for ${val.actionType}: ${res.error.issues[0]?.message ?? 'invalid'}`,
                });
            }
        }
    });

export type CreateAutomationRuleBody = z.infer<typeof CreateAutomationRuleSchema>;
export type UpdateAutomationRuleBody = z.infer<typeof UpdateAutomationRuleSchema>;
