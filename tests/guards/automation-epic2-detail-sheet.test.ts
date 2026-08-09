/**
 * Automation Epic 2 — structural ratchet.
 *
 * Locks the rule detail-sheet slice:
 *   1. RuleDetailSheet composes the shared <Sheet> primitive and mutates
 *      via useTenantMutation (optimistic), not a bespoke overlay/fetch.
 *   2. The [id] route exposes a PATCH for the toggle/priority quick edits.
 *   3. The repository toggle refuses archived rules; the usecase wraps it.
 *   4. RulesTab opens the sheet on row click.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

const SHEET = 'src/components/processes/RuleDetailSheet.tsx';
const ROUTE_DETAIL = 'src/app/api/t/[tenantSlug]/automation/rules/[id]/route.ts';
const REPO = 'src/app-layer/automation/AutomationRuleRepository.ts';
const USECASE = 'src/app-layer/usecases/automation-rules.ts';
const RULES_TAB = 'src/app/t/[tenantSlug]/(app)/processes/RulesTab.tsx';

describe('Automation Epic 2 — Rule detail sheet & toggle', () => {
    it('RuleDetailSheet uses the Sheet primitive + optimistic mutation', () => {
        expect(exists(SHEET)).toBe(true);
        const src = read(SHEET);
        expect(src).toMatch(/from '@\/components\/ui\/sheet'/);
        expect(src).toMatch(/<Sheet\b/);
        expect(src).toMatch(/useTenantMutation/);
        expect(src).toMatch(/optimisticUpdate/);
        // toggle + priority quick practices
        expect(src).toMatch(/Switch/);
        expect(src).toMatch(/NumberStepper/);
    });

    it('the [id] route exposes a PATCH handler', () => {
        const src = read(ROUTE_DETAIL);
        expect(src).toMatch(/export const PATCH/);
    });

    it('the repository toggle refuses ARCHIVED rules', () => {
        const src = read(REPO);
        expect(src).toMatch(/static async toggle\(/);
        expect(src).toMatch(/ARCHIVED/);
    });

    it('the usecase exposes toggleAutomationRule gated on manage', () => {
        const src = read(USECASE);
        expect(src).toMatch(/export async function toggleAutomationRule/);
        expect(src).toMatch(/assertCanManageAutomation/);
    });

    it('RulesTab opens the detail sheet on row click', () => {
        const src = read(RULES_TAB);
        expect(src).toMatch(/RuleDetailSheet/);
        expect(src).toMatch(/onRowClick/);
    });
});
