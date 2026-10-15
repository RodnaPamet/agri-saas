/**
 * Automation Epic 10 — structural ratchet for the live monitor + console.
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

describe('Automation Epic 10 — live monitor & manual trigger', () => {
    it('the monitor tab + manual trigger panel exist', () => {
        expect(exists('src/app/t/[tenantSlug]/(app)/processes/MonitorTab.tsx')).toBe(true);
        expect(exists('src/components/processes/ManualTriggerPanel.tsx')).toBe(true);
    });

    it('the live feed, cancel, and dry-run routes exist', () => {
        expect(exists('src/app/api/t/[tenantSlug]/automation/executions/live/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/automation/executions/[id]/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/automation/rules/[id]/dry-run/route.ts')).toBe(true);
    });

    it('the monitor polls live + cancels in-flight', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/processes/MonitorTab.tsx');
        expect(src).toMatch(/refreshInterval: 5000/);
        expect(src).toMatch(/executions\.live\(\)/);
        expect(src).toMatch(/cancel/);
    });

    it('dry-run evaluates without firing; cancel marks SKIPPED', () => {
        const src = read('src/app-layer/usecases/automation-executions.ts');
        expect(src).toMatch(/export async function dryRunRule/);
        expect(src).toMatch(/export async function cancelExecution/);
        expect(src).toMatch(/SKIPPED/);
    });

    it('ProcessesClient mounts the Monitor tab', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx');
        expect(src).toMatch(/MonitorTab/);
        expect(src).toMatch(/"monitor"/);
    });
});
