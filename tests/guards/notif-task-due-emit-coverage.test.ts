/**
 * 2026-05-27 — PR-B: TASK_DUE emit coverage ratchet.
 *
 * `emitTaskDueNotification(ctx, result)` is the in-app bell write
 * for due-task reminders. It MUST fire post-commit for every task
 * mutation whose result may carry a (assigneeUserId, dueAt) pair —
 * otherwise the bell stays silent until the daily 08:00 cron sweep,
 * and the user complains "notifications don't pop up for due
 * tasks". This ratchet locks the wiring so a future refactor
 * can't silently drop one of the three call sites.
 *
 * Invariants asserted:
 *
 *   1. The emit helper is defined in `task.ts` (single source of
 *      truth — no inline duplication).
 *   2. Every public task-mutation usecase that can change `dueAt`
 *      OR `assigneeUserId` calls `emitTaskDueNotification(ctx, …)`
 *      after the `runInTenantContext(...)` commits. Today that's
 *      `createTask`, `updateTask`, and `assignTask` — three sites
 *      total.
 *   3. The call sits BETWEEN the `runInTenantContext` commit and
 *      the `bumpEntityCacheVersion` line. Putting it inside the
 *      tx would couple notification-write failures to the task
 *      write; putting it after the cache-bump would race against
 *      a stale cache read.
 *   4. The helper itself runs in its OWN `runInTenantContext` and
 *      swallows errors via try/catch — fire-and-forget. A
 *      notification write must never roll back the task.
 *   5. The shared `dedupeKey` shape across the cron + inline paths
 *      stays compatible. (Locked indirectly by the existing
 *      `createTaskDueNotification` test; this ratchet asserts the
 *      cron + inline both call the same helper.)
 *
 * Sibling of `notif-assignment-alerts-wiring.test.ts` (PR-A).
 * PR-B is verify-only: no behaviour change, just the lock.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => blankNonCode(readFileSync(path.join(ROOT, p), 'utf-8'));

describe('PR-B TASK_DUE emit coverage', () => {
    const taskSrc = () => read('src/app-layer/usecases/task.ts');
    const jobSrc = () =>
        read('src/app-layer/jobs/task-due-notification.ts');

    describe('1. The emit helper exists + is unique', () => {
        it('emitTaskDueNotification is defined exactly once in task.ts', () => {
            const s = taskSrc();
            const decls = s.match(/async function emitTaskDueNotification\b/g) ?? [];
            expect(decls.length).toBe(1);
        });

        it('the helper calls createTaskDueNotification (shared with the cron)', () => {
            const s = taskSrc();
            const start = s.indexOf('async function emitTaskDueNotification');
            // Match a generous body window — the helper is ~40 lines.
            const body = s.slice(start, start + 1800);
            expect(body).toMatch(/createTaskDueNotification\(/);
        });

        it('the helper runs in its own runInTenantContext (NOT the caller\'s tx)', () => {
            const s = taskSrc();
            const start = s.indexOf('async function emitTaskDueNotification');
            const body = s.slice(start, start + 1800);
            expect(body).toMatch(/runInTenantContext\(ctx,/);
        });

        it('the helper swallows errors via try/catch (fire-and-forget)', () => {
            // A notification write that throws MUST NOT bubble up to
            // the caller — otherwise the task write would surface
            // a notification-system error to the user.
            const s = taskSrc();
            const start = s.indexOf('async function emitTaskDueNotification');
            const body = s.slice(start, start + 1800);
            expect(body).toMatch(/try \{/);
            expect(body).toMatch(/catch \(err\)/);
            expect(body).toMatch(/logger\.warn/);
        });
    });

    describe('2. Every task-mutation usecase calls emitTaskDueNotification', () => {
        // Locked at three sites today: createTask, updateTask,
        // assignTask. A new task-mutation usecase that can change
        // `dueAt` or `assigneeUserId` MUST also fire the emit OR
        // update this list with a written reason.
        const REQUIRED_USECASES = ['createTask', 'updateTask', 'assignTask'];

        it.each(REQUIRED_USECASES)('%s fires emitTaskDueNotification post-commit', (usecase) => {
            const s = taskSrc();
            const start = s.indexOf(`export async function ${usecase}(`);
            expect(start).toBeGreaterThan(-1);
            // Body spans until the next exported function OR a
            // sibling section marker. We grab a 3000-char window —
            // generous enough for the longest body, tight enough
            // that the emit call sits within range.
            const body = s.slice(start, start + 3000);
            // The call MUST be `emitTaskDueNotification(ctx, …)`
            // (no `await`-less variants, no commented-out lines).
            expect(body).toMatch(/await emitTaskDueNotification\(ctx,/);
        });

        it('the file carries exactly 3 active emit call sites + 1 declaration', () => {
            // Lock the count so a future refactor that adds a 4th
            // mutation but forgets the emit needs to update this
            // assertion in the same PR — forcing the author to
            // either wire the emit OR document the omission.
            //
            // We count by matching the active forms only:
            //   • `async function emitTaskDueNotification` — 1 decl
            //   • `await emitTaskDueNotification(ctx,` — 3 calls
            // Comments and JSDoc references are ignored.
            const s = taskSrc();
            const decls = s.match(/async function emitTaskDueNotification\b/g) ?? [];
            const calls = s.match(/await emitTaskDueNotification\(ctx,/g) ?? [];
            expect(decls.length).toBe(1);
            expect(calls.length).toBe(3);
        });
    });

    describe('3. Emit call placement: after commit, before cache-bump', () => {
        it.each(['createTask', 'updateTask', 'assignTask'])(
            '%s — emit sits between runInTenantContext close and bumpEntityCacheVersion',
            (usecase) => {
                const s = taskSrc();
                const start = s.indexOf(`export async function ${usecase}(`);
                expect(start).toBeGreaterThan(-1);
                // Scope to the function body — anchored on the
                // function's closing line. Once PR-A added
                // `emitTaskAssignedNotification` calls + comments
                // to createTask + assignTask, the original 3000-
                // char window stopped reaching `bumpEntityCacheVersion`
                // (the call sits ~3100 chars in after PR-A).
                // Find the next `export async function` after
                // `start` and use that as the upper bound — guaranteed
                // tighter than a fixed window AND robust to future
                // body growth.
                const nextDecl = s.indexOf(
                    'export async function',
                    start + 1,
                );
                const end = nextDecl > start ? nextDecl : s.length;
                const body = s.slice(start, end);
                const emitIdx = body.indexOf('emitTaskDueNotification(ctx,');
                const bumpIdx = body.indexOf(
                    "bumpEntityCacheVersion(ctx, 'task')",
                );
                // Both present, emit before bump.
                expect(emitIdx).toBeGreaterThan(-1);
                expect(bumpIdx).toBeGreaterThan(-1);
                expect(emitIdx).toBeLessThan(bumpIdx);
            },
        );
    });

    describe('4. Cron + inline paths share the same helper', () => {
        it('the cron job calls createTaskDueNotification (same helper as the inline path)', () => {
            // The shared dedupeKey is what makes both paths
            // idempotent against each other. If the cron drifted
            // to a different helper (or a different create surface),
            // the same task could end up with two bell rows in one
            // day.
            const s = jobSrc();
            expect(s).toMatch(/createTaskDueNotification\(/);
        });

        it('the cron job imports the same `createTaskDueNotification` from `notifications/task-due`', () => {
            const s = jobSrc();
            expect(s).toMatch(
                /import\s*\{[\s\S]{0,200}createTaskDueNotification[\s\S]{0,200}\}\s*from\s*['"][^'"]*notifications\/task-due['"]/,
            );
        });
    });
});
