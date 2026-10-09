/**
 * Pre-built automation rule templates (Automation Epic 8).
 *
 * Archer ships out-of-the-box workflow content packs; these are IC's
 * equivalent starter rules. A template is a partial rule the user imports as
 * a DRAFT and customises before enabling.
 *
 * Modelled as a typed TS module rather than YAML files: same data, but no
 * runtime filesystem read (Next-bundle-safe), compile-time-checked against
 * the action-config shapes, and trivially importable by both the API loader
 * and a test. `{{...}}` tokens are runtime template variables resolved when
 * action handlers land — stored verbatim for now.
 */
import type { AutomationActionType } from '@prisma/client';

export type TemplateTag = 'practice' | 'task' | 'issue' | 'notify' | 'webhook';

export interface AutomationTemplate {
    id: string;
    name: string;
    description: string;
    trigger: string;
    /** Recursive FilterGroup or null. */
    filter: Record<string, unknown> | null;
    actionType: AutomationActionType;
    actionConfig: Record<string, unknown>;
    tags: TemplateTag[];
}

export const AUTOMATION_TEMPLATES: ReadonlyArray<AutomationTemplate> = [
    {
        id: 'tpl_overdue_task_escalate',
        name: 'Escalate overdue task to manager',
        description: 'Notifies a manager when a task changes to an overdue/blocked state.',
        trigger: 'TASK_STATUS_CHANGED',
        filter: { logic: 'AND', conditions: [{ field: 'toStatus', operator: 'eq', value: 'BLOCKED' }] },
        actionType: 'NOTIFY_USER',
        actionConfig: { userIds: ['{{task.managerId}}'], message: 'Task {{task.title}} is blocked.' },
        tags: ['task', 'notify'],
    },
];

export function getTemplateById(id: string): AutomationTemplate | undefined {
    return AUTOMATION_TEMPLATES.find((t) => t.id === id);
}
