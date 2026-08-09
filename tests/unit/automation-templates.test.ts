/**
 * Automation Epic 8 — template content validity.
 *
 * Every shipped template must be a valid, importable rule: its
 * (actionType, actionConfig) pair and trigger filter must pass the same
 * schema the create API enforces, so "Use template" can never produce an
 * invalid DRAFT.
 */
import { AUTOMATION_TEMPLATES, getTemplateById } from '@/data/automation-templates';
import { CreateAutomationRuleSchema } from '@/app-layer/schemas/automation.schemas';
import { isKnownAutomationEvent } from '@/app-layer/automation/events';

describe('automation templates', () => {
    it('ships at least 5 templates with unique ids', () => {
        // Floor lowered from 8 when the risk-register uproot removed the
        // three RISK_* templates — their trigger events no longer exist,
        // so keeping them would have shipped catalogue entries a user
        // could install and never see fire.
        expect(AUTOMATION_TEMPLATES.length).toBeGreaterThanOrEqual(5);
        const ids = new Set(AUTOMATION_TEMPLATES.map((t) => t.id));
        expect(ids.size).toBe(AUTOMATION_TEMPLATES.length);
    });

    it('every template trigger is a known catalog event', () => {
        for (const t of AUTOMATION_TEMPLATES) {
            expect(isKnownAutomationEvent(t.trigger)).toBe(true);
        }
    });

    it('every template is a valid importable rule', () => {
        for (const t of AUTOMATION_TEMPLATES) {
            const res = CreateAutomationRuleSchema.safeParse({
                name: t.name,
                description: t.description,
                triggerEvent: t.trigger,
                triggerFilter: t.filter,
                actionType: t.actionType,
                actionConfig: t.actionConfig,
                status: 'DRAFT',
            });
            if (!res.success) {
                throw new Error(`Template ${t.id} invalid: ${JSON.stringify(res.error.issues)}`);
            }
            expect(res.success).toBe(true);
        }
    });

    it('getTemplateById resolves a known id and undefined otherwise', () => {
        expect(getTemplateById(AUTOMATION_TEMPLATES[0].id)).toBeDefined();
        expect(getTemplateById('nope')).toBeUndefined();
    });
});
