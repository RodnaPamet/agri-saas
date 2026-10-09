/**
 * Automation Epic 1 — rule input schema validation.
 *
 * The (actionType, actionConfig) pair must agree: a NOTIFY_USER rule can't
 * ship a webhook config. The schema enforces this via superRefine.
 */
import {
    CreateAutomationRuleSchema,
    UpdateAutomationRuleSchema,
} from '@/app-layer/schemas/automation.schemas';

describe('CreateAutomationRuleSchema', () => {
    it('accepts a well-formed NOTIFY_USER rule', () => {
        const res = CreateAutomationRuleSchema.safeParse({
            name: 'Notify owner',
            triggerEvent: 'RISK_CREATED',
            actionType: 'NOTIFY_USER',
            actionConfig: { userIds: ['u1'], message: 'Heads up' },
        });
        expect(res.success).toBe(true);
    });

    it('rejects a NOTIFY_USER rule carrying a webhook config', () => {
        const res = CreateAutomationRuleSchema.safeParse({
            name: 'Mismatch',
            triggerEvent: 'RISK_CREATED',
            actionType: 'NOTIFY_USER',
            actionConfig: { url: 'https://example.com/hook' },
        });
        expect(res.success).toBe(false);
        if (!res.success) {
            expect(res.error.issues.some((i) => i.path.includes('actionConfig'))).toBe(true);
        }
    });

    it('rejects an empty name', () => {
        const res = CreateAutomationRuleSchema.safeParse({
            name: '',
            triggerEvent: 'RISK_CREATED',
            actionType: 'WEBHOOK',
            actionConfig: { url: 'https://example.com/hook' },
        });
        expect(res.success).toBe(false);
    });

    it('accepts a FilterGroup trigger filter (DSL v2)', () => {
        const res = CreateAutomationRuleSchema.safeParse({
            name: 'Grouped',
            triggerEvent: 'RISK_CREATED',
            triggerFilter: {
                logic: 'AND',
                conditions: [
                    { field: 'severity', operator: 'in', value: ['HIGH', 'CRITICAL'] },
                    {
                        logic: 'OR',
                        conditions: [{ field: 'score', operator: 'gt', value: 15 }],
                    },
                ],
            },
            actionType: 'NOTIFY_USER',
            actionConfig: { userIds: ['u1'], message: 'hi' },
        });
        expect(res.success).toBe(true);
    });

    it('still accepts the legacy flat trigger filter', () => {
        const res = CreateAutomationRuleSchema.safeParse({
            name: 'Legacy',
            triggerEvent: 'RISK_CREATED',
            triggerFilter: { severity: 'CRITICAL' },
            actionType: 'NOTIFY_USER',
            actionConfig: { userIds: ['u1'], message: 'hi' },
        });
        expect(res.success).toBe(true);
    });

    it('accepts a valid WEBHOOK rule with method + headers', () => {
        const res = CreateAutomationRuleSchema.safeParse({
            name: 'Slack push',
            triggerEvent: 'TASK_CREATED',
            actionType: 'WEBHOOK',
            actionConfig: {
                url: 'https://hooks.slack.com/x',
                method: 'POST',
                headers: { 'X-Token': 'abc' },
            },
        });
        expect(res.success).toBe(true);
    });
});

describe('UpdateAutomationRuleSchema', () => {
    it('allows a partial update (priority only) with no action config', () => {
        const res = UpdateAutomationRuleSchema.safeParse({ priority: 7 });
        expect(res.success).toBe(true);
    });

    it('validates config when both actionType and actionConfig are present', () => {
        const res = UpdateAutomationRuleSchema.safeParse({
            actionType: 'CREATE_TASK',
            actionConfig: { severity: 'HIGH' }, // missing required `title`
        });
        expect(res.success).toBe(false);
    });
});
