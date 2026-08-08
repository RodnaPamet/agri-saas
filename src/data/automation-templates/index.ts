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

export type TemplateTag = 'control' | 'task' | 'issue' | 'notify' | 'webhook';

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
        id: 'tpl_failed_test_task',
        name: 'Create remediation task on failed test run',
        description: 'Fires on TEST_RUN_FAILED and opens a remediation task.',
        trigger: 'TEST_RUN_FAILED',
        filter: null,
        actionType: 'CREATE_TASK',
        actionConfig: { title: 'Remediate failed control test {{control.code}}', priority: 'P2' },
        tags: ['control', 'task'],
    },
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
    {
        id: 'tpl_critical_issue_ciso',
        name: 'Notify CISO on critical issue',
        description: 'Fires on ISSUE_CREATED with CRITICAL severity.',
        trigger: 'ISSUE_CREATED',
        filter: { logic: 'AND', conditions: [{ field: 'severity', operator: 'eq', value: 'CRITICAL' }] },
        actionType: 'NOTIFY_USER',
        actionConfig: { userIds: ['{{tenant.cisoId}}'], message: 'Critical issue: {{issue.title}}.' },
        tags: ['issue', 'notify'],
    },
    {
        id: 'tpl_evidence_control_review',
        name: 'Move control to IN_REVIEW on evidence upload',
        description: 'When a test run completes, set the control to IN_REVIEW.',
        trigger: 'TEST_RUN_COMPLETED',
        filter: null,
        actionType: 'UPDATE_STATUS',
        actionConfig: { entityType: 'Control', field: 'status', toStatus: 'IN_REVIEW' },
        tags: ['control'],
    },
    {
        id: 'tpl_slack_finding_webhook',
        name: 'Push to Slack on audit finding',
        description: 'Fires on ISSUE_CREATED and POSTs to a Slack incoming webhook.',
        trigger: 'ISSUE_CREATED',
        filter: null,
        actionType: 'WEBHOOK',
        actionConfig: { url: 'https://hooks.slack.com/services/REPLACE/ME', method: 'POST' },
        tags: ['issue', 'webhook'],
    },
];

export function getTemplateById(id: string): AutomationTemplate | undefined {
    return AUTOMATION_TEMPLATES.find((t) => t.id === id);
}
