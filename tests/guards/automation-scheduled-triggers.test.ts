/**
 * PR-E — scheduled/time-based triggers ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('scheduled triggers', () => {
    it('SCHEDULE is a subscribable catalog trigger with a builder label', () => {
        expect(read('src/app-layer/automation/events.ts')).toMatch(/SCHEDULE: 'SCHEDULE'/);
        expect(read('src/lib/automation/event-labels.ts')).toMatch(/On a schedule/);
    });

    it('the schema persists scheduleConfig', () => {
        expect(read('prisma/schema/automation.prisma')).toMatch(/scheduleConfigJson\s+Json\?/);
        expect(read('src/app-layer/schemas/automation.schemas.ts')).toMatch(/DATE_RELATIVE/);
    });

    it('the sweep job + cron registration exist', () => {
        expect(exists('src/app-layer/jobs/schedule-trigger-sweep.ts')).toBe(true);
        const job = read('src/app-layer/jobs/schedule-trigger-sweep.ts');
        // target allowlist (no arbitrary table/column scan)
        expect(job).toMatch(/SCHEDULE_TARGETS/);
        expect(job).toMatch(/triggeredBy: 'schedule'/);
        // scheduled in the cron registry + the executor
        expect(read('src/app-layer/jobs/schedules.ts')).toMatch(/'schedule-trigger-sweep'/);
        expect(read('src/app-layer/jobs/executor-registry.ts')).toMatch(/runScheduleTriggerSweep/);
    });

    it('the sweep only allowlists known date targets (no arbitrary entity)', () => {
        const job = read('src/app-layer/jobs/schedule-trigger-sweep.ts');
        // ControlException / ControlTestPlan were dropped in the compliance
        // uproot; Evidence retention is the remaining date-relative target.
        // The point of this assertion is that the allowlist is CLOSED, so it
        // also checks the union type has not been widened back to a string.
        expect(job).toMatch(/Evidence:/);
        expect(job).toMatch(/export type ScheduleTarget = 'Evidence';/);
    });
});
