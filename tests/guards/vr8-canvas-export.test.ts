/**
 * VR-8 — automation canvas export ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
// Comments blanked before matching (#1774). Comments only, NOT strings:
// some assertions below are about string LITERALS, and `{ strings: true }`
// would blank those too and pass vacuously — the trap that makes this
// conversion a per-file decision rather than a sweep.
const read = (p: string) =>
    blankNonCode(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('VR-8 — canvas export', () => {
    it('the evidence-pack usecase + route exist', () => {
        expect(exists('src/app-layer/usecases/automation-export.ts')).toBe(true);
        expect(
            exists('src/app/api/t/[tenantSlug]/processes/[id]/export-automation/route.ts'),
        ).toBe(true);
        const uc = read('src/app-layer/usecases/automation-export.ts');
        expect(uc).toMatch(/export function summarizeRuleExecutions/);
        expect(uc).toMatch(/export async function buildAutomationEvidencePack/);
        // 30-day window + success rate are the audit-relevant aggregates
        expect(uc).toMatch(/executions30d/);
        expect(uc).toMatch(/successRate/);
    });
});
