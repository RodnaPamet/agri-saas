/**
 * Cycle-2 follow-up — the three domain-coverage emits the audit flagged as
 * missing must stay wired at their producer sites (and in the catalog).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('domain-coverage emits', () => {
    it('all three events are in the catalog + builder labels', () => {
        const events = read('src/app-layer/automation/events.ts');
        const labels = read('src/lib/automation/event-labels.ts');
        for (const ev of ['CONTROL_STATUS_CHANGED', 'POLICY_REVIEW_DUE', 'VENDOR_ASSESSMENT_OVERDUE']) {
            expect(events).toContain(ev);
            expect(labels).toContain(ev);
        }
    });

    it('practice status change emits CONTROL_STATUS_CHANGED', () => {
        const src = read('src/app-layer/usecases/practice/mutations.ts');
        expect(src).toMatch(/emitAutomationEvent\(/);
        expect(src).toMatch(/event: 'CONTROL_STATUS_CHANGED'/);
    });

    it('the policy-review job emits POLICY_REVIEW_DUE', () => {
        const src = read('src/app-layer/jobs/policyReviewReminder.ts');
        expect(src).toMatch(/event: 'POLICY_REVIEW_DUE'/);
    });

    it('the vendor-renewal job emits VENDOR_ASSESSMENT_OVERDUE for overdue items', () => {
        const src = read('src/app-layer/jobs/vendor-renewal-check.ts');
        expect(src).toMatch(/event: 'VENDOR_ASSESSMENT_OVERDUE'/);
        expect(src).toMatch(/_OVERDUE'/); // gated on overdue vendors only
    });
});
