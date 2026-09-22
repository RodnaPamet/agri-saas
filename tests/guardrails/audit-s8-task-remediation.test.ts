/**
 * Audit Coherence S8 (2026-05-24) — structural ratchet locking the
 * Task & Issue Remediation gap closures.
 *
 * Four gaps addressed in this PR:
 *
 *   Gap A — work-item state machine. `WORK_ITEM_TRANSITIONS` table
 *   in `domain/work-item-status.ts` + `checkWorkItemTransition` +
 *   `formatTransitionError`. Wired into setTaskStatus,
 *   bulkSetTaskStatus, setIssueStatus, bulkSetStatus.
 *
 *   Gap B — required `resolution` on terminal transitions
 *   (RESOLVED / CLOSED / CANCELED) on both task + issue paths.
 *
 *   Gap C — `detailsJson.fromStatus = null` hardcode bug. Every
 *   STATUS_CHANGED audit row now ships the real fromStatus + the
 *   real toStatus. (Pre-S8 these were `null` + the action-name
 *   placeholder.)
 *
 *   Gap D — `services/sla.ts` integration. `getTask` + `getIssue`
 *   attach the derived `sla: { triageBreach, resolveBreach, label }`
 *   shape so the frontend stops needing client-side SLA math.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Audit S8 — Task & Issue Remediation', () => {
    describe('Gap A — work-item state machine', () => {
        const domain = read('src/app-layer/domain/work-item-status.ts');

        it('declares WORK_ITEM_TRANSITIONS table', () => {
            expect(domain).toMatch(/export const WORK_ITEM_TRANSITIONS/);
        });

        it('terminal statuses have an empty transition set', () => {
            // Pull the table block out so regexes don't accidentally
            // pick up matching text in unrelated source comments.
            const block = domain.slice(
                domain.indexOf('WORK_ITEM_TRANSITIONS'),
            );
            expect(block).toMatch(/CLOSED:\s*new Set\(\[?\s*\]?\)/);
            expect(block).toMatch(/CANCELED:\s*new Set\(\[?\s*\]?\)/);
        });

        it('declares OPEN/TRIAGED/IN_PROGRESS/BLOCKED/RESOLVED with non-empty target sets', () => {
            expect(domain).toMatch(/OPEN:\s*new Set\(\[\s*['"]TRIAGED/);
            expect(domain).toMatch(/TRIAGED:\s*new Set\(\[\s*['"]IN_PROGRESS/);
            expect(domain).toMatch(/IN_PROGRESS:\s*new Set\(\[\s*['"]BLOCKED/);
            expect(domain).toMatch(/BLOCKED:\s*new Set\(\[\s*['"]IN_PROGRESS/);
            expect(domain).toMatch(/RESOLVED:\s*new Set\(\[\s*['"]CLOSED/);
        });

        it('exports the pure checker + formatter pair', () => {
            expect(domain).toMatch(
                /export function checkWorkItemTransition/,
            );
            expect(domain).toMatch(
                /export function formatTransitionError/,
            );
        });

        it('task.ts wires the gate into setTaskStatus', () => {
            const src = read('src/app-layer/usecases/task.ts');
            expect(src).toMatch(/import\s*\{[\s\S]*?checkWorkItemTransition[\s\S]*?\}\s*from\s*['"]\.\.\/domain\/work-item-status['"]/);
            // The gate fires BEFORE the repository write.
            const setBlock = src.slice(
                src.indexOf('export async function setTaskStatus'),
                src.indexOf('export async function setTaskStatus') + 2500,
            );
            expect(setBlock).toMatch(/checkWorkItemTransition\(fromStatus,\s*status\)/);
            // The refusal is CODED as of the i18n batch-two work: the English
            // from `formatTransitionError` stays as the fallback, with
            // `transitionErrorCode` beside it so a client can translate
            // "Illegal work-item transition: IN_PROGRESS → OPEN." instead of
            // showing it to a Bulgarian operator. Both halves are asserted —
            // dropping the message would lose the fallback, and dropping the
            // code would silently undo the translation work.
            expect(setBlock).toMatch(/throw codedBadRequest\(/);
            expect(setBlock).toMatch(/transitionErrorCode\(transitionErr\)/);
            expect(setBlock).toMatch(/formatTransitionError\(transitionErr\)/);
        });

        it('task.ts wires the gate into bulkSetTaskStatus (all-or-nothing)', () => {
            const src = read('src/app-layer/usecases/task.ts');
            const block = src.slice(
                src.indexOf('export async function bulkSetTaskStatus'),
            );
            expect(block).toMatch(/WorkItemRepository\.listByIds/);
            expect(block).toMatch(/checkWorkItemTransition\(/);
        });

        it('issue.ts wires the gate into setIssueStatus + bulkSetStatus', () => {
            const src = read('src/app-layer/usecases/issue.ts');
            expect(src).toMatch(/import\s*\{[\s\S]*?checkWorkItemTransition[\s\S]*?\}\s*from\s*['"]\.\.\/domain\/work-item-status['"]/);
            const setBlock = src.slice(
                src.indexOf('export async function setIssueStatus'),
                src.indexOf('export async function setIssueStatus') + 2500,
            );
            expect(setBlock).toMatch(/checkWorkItemTransition\(fromStatus,\s*status\)/);
            const bulkBlock = src.slice(
                src.indexOf('export async function bulkSetStatus'),
            );
            expect(bulkBlock).toMatch(/WorkItemRepository\.listByIds/);
            expect(bulkBlock).toMatch(/checkWorkItemTransition\(/);
        });
    });

    describe('Gap B — resolution required on terminal transitions', () => {
        const taskSrc = read('src/app-layer/usecases/task.ts');
        const issueSrc = read('src/app-layer/usecases/issue.ts');

        it('setTaskStatus refuses an empty resolution on terminal moves', () => {
            expect(taskSrc).toMatch(
                /A resolution is required when moving a task to/,
            );
        });

        it('bulkSetTaskStatus refuses an empty resolution on terminal moves', () => {
            // Same message; appears once for each call site after
            // the inline if-block in bulkSetTaskStatus.
            const occurrences = taskSrc.match(
                /A resolution is required when moving a task to/g,
            );
            expect(occurrences?.length).toBeGreaterThanOrEqual(2);
        });

        it('setIssueStatus / bulk refuse an empty resolution on terminal moves', () => {
            const occurrences = issueSrc.match(
                /A resolution is required when moving an issue to/g,
            );
            expect(occurrences?.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('Gap C — detailsJson fromStatus + toStatus carry real values', () => {
        const taskSrc = read('src/app-layer/usecases/task.ts');
        const issueSrc = read('src/app-layer/usecases/issue.ts');

        // Anchor every Task STATUS_CHANGED audit row to the real
        // fromStatus identifier; the hardcoded `fromStatus: null`
        // shape was the bug being fixed.
        it('task.ts emits fromStatus / toStatus from the prefetched values', () => {
            // No `fromStatus: null` in the STATUS_CHANGED audit
            // detailsJson on the Task path.
            const stripped = taskSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            expect(stripped).not.toMatch(
                /entityName:\s*['"]Task['"][\s\S]{0,80}fromStatus:\s*null/,
            );
            expect(stripped).not.toMatch(/toStatus:\s*['"]TASK_STATUS_CHANGED['"]/);
            // Affirmative: each STATUS_CHANGED block writes
            // `fromStatus,` (real identifier) and `toStatus: status,`.
            const matches = stripped.match(/category:\s*['"]status_change['"][\s\S]{0,200}fromStatus[\s\S]{0,200}toStatus:\s*status/g) || [];
            expect(matches.length).toBeGreaterThanOrEqual(2);
        });

        it('issue.ts emits fromStatus / toStatus from the prefetched values', () => {
            const stripped = issueSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            expect(stripped).not.toMatch(
                /entityName:\s*['"]Issue['"][\s\S]{0,80}fromStatus:\s*null/,
            );
            expect(stripped).not.toMatch(/toStatus:\s*['"]ISSUE_STATUS_CHANGED['"]/);
            const matches = stripped.match(/category:\s*['"]status_change['"][\s\S]{0,200}fromStatus[\s\S]{0,200}toStatus:\s*status/g) || [];
            expect(matches.length).toBeGreaterThanOrEqual(2);
        });

        it('BUNDLE_FROZEN is re-categorised away from status_change', () => {
            // Bundle freeze is an entity_lifecycle event on the
            // bundle, not a status transition on the issue. The
            // hardcoded `toStatus: 'BUNDLE_FROZEN'` is gone.
            expect(issueSrc).not.toMatch(
                /toStatus:\s*['"]BUNDLE_FROZEN['"]/,
            );
            const bundleBlock = issueSrc.slice(
                issueSrc.indexOf('BUNDLE_FROZEN'),
            );
            expect(bundleBlock).toMatch(/category:\s*['"]entity_lifecycle['"]/);
        });
    });

    describe('Gap D — sla.ts wired into getTask + getIssue', () => {
        const taskSrc = read('src/app-layer/usecases/task.ts');
        const issueSrc = read('src/app-layer/usecases/issue.ts');

        it('task.ts imports getSlaStatus and attaches sla on getTask', () => {
            expect(taskSrc).toMatch(
                /import\s*\{\s*getSlaStatus\s*\}\s*from\s*['"]\.\.\/services\/sla['"]/,
            );
            const getBlock = taskSrc.slice(
                taskSrc.indexOf('export async function getTask('),
                taskSrc.indexOf('export async function getTask(') + 1200,
            );
            expect(getBlock).toMatch(
                /sla:\s*getSlaStatus\(task\.severity,\s*task\.createdAt,\s*task\.status\)/,
            );
        });

        it('issue.ts imports getSlaStatus and attaches sla on getIssue', () => {
            expect(issueSrc).toMatch(
                /import\s*\{\s*getSlaStatus\s*\}\s*from\s*['"]\.\.\/services\/sla['"]/,
            );
            const getBlock = issueSrc.slice(
                issueSrc.indexOf('export async function getIssue('),
                issueSrc.indexOf('export async function getIssue(') + 1200,
            );
            expect(getBlock).toMatch(
                /sla:\s*getSlaStatus\(issue\.severity,\s*issue\.createdAt,\s*issue\.status\)/,
            );
        });
    });
});
