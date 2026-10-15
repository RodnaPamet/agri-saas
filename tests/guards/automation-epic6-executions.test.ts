/**
 * Automation Epic 6 — structural ratchet for execution history + re-trigger.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
// Comments blanked before matching (#1774). Comments only, NOT strings:
// an assertion about a string LITERAL would pass vacuously under
// `{ strings: true }`, which is why this stays a per-file decision.
const read = (p: string) =>
    blankNonCode(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('Automation Epic 6 — execution history & re-trigger', () => {
    it('the executions + re-trigger routes exist', () => {
        expect(
            exists('src/app/api/t/[tenantSlug]/automation/rules/[id]/executions/route.ts'),
        ).toBe(true);
        expect(
            exists('src/app/api/t/[tenantSlug]/automation/rules/[id]/re-trigger/route.ts'),
        ).toBe(true);
    });

    it('the executions usecase scrubs PII + cursor-paginates', () => {
        const src = read('src/app-layer/usecases/automation-executions.ts');
        expect(src).toMatch(/PII_BLOCKLIST/);
        expect(src).toMatch(/scrubPayload/);
        expect(src).toMatch(/listForRulePaginated/);
        expect(src).toMatch(/nextCursor/);
    });

    it('re-trigger targets a single rule via the dispatcher', () => {
        const src = read('src/app-layer/usecases/automation-executions.ts');
        expect(src).toMatch(/targetRuleId/);
        expect(src).toMatch(/triggeredBy: 'manual'/);
        // the dispatcher honours the target
        expect(read('src/app-layer/jobs/automation-event-dispatch.ts')).toMatch(
            /payload\.targetRuleId/,
        );
    });

    it('the detail sheet mounts the executions panel', () => {
        expect(exists('src/components/processes/ExecutionsPanel.tsx')).toBe(true);
        expect(read('src/components/processes/RuleDetailSheet.tsx')).toMatch(/ExecutionsPanel/);
    });
});
