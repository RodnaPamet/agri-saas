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
    it('ships a non-empty catalogue with unique ids', () => {
        // This assertion used to carry a floor: >= 8, then >= 5 when the
        // risk-register uproot took the three RISK_* templates, then it
        // would have been >= 3 after the GRC teardown took
        // tpl_failed_test_task and tpl_evidence_practice_review (both
        // triggered on TEST_RUN_* events whose subject models no longer
        // exist — plan §8k).
        //
        // A floor that is lowered every time it fails is not measuring
        // anything; it is the "green by running less" shape CLAUDE.md
        // warns about. What actually matters is that the catalogue is
        // non-empty and internally consistent — and, crucially, that no
        // template points at a stranded trigger. The latter is NOT
        // provable here: `isKnownAutomationEvent` below compares
        // templates against the CATALOGUE, so when the catalogue is the
        // thing that is wrong it passes with full confidence. That gap
        // is covered by
        // tests/guards/automation-catalog-emitter-coverage.test.ts.
        expect(AUTOMATION_TEMPLATES.length).toBeGreaterThan(0);
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
