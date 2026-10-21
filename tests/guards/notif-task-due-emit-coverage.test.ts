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
        // ── derived, because the enumeration could not fail (#2103) ──
        //
        // This was a hand-written `REQUIRED_USECASES = ['createTask',
        // 'updateTask', 'assignTask']` plus a lock asserting exactly three
        // call sites, under a comment telling the next author:
        //
        //   > A new task-mutation usecase that can change `dueAt` or
        //   > `assigneeUserId` MUST also fire the emit OR update this list
        //   > with a written reason.
        //
        // Two such usecases landed — `bulkAssignTasks` and
        // `bulkSetTaskDueDate` — with no emit and no reason anywhere. The
        // guard stayed green, and it stayed green BECAUSE the list is
        // enumerated: the new functions were invisible to it, so the count
        // lock held at three for the very reason it should have failed. The
        // comment was doing the work the assertion should have done.
        //
        // So the population is derived from the source. A sixth mutator now
        // fails this file until somebody either wires the emit or writes down
        // why not.

        /**
         * One function's body, from its declaration to the next one.
         *
         * Bounded by the next declaration rather than a character window: the
         * original guard used `start + 3000` and its own comment records that
         * window going stale once PR-A grew two of these bodies past it.
         */
        function bodyOf(src: string, name: string): string {
            const start = src.indexOf(`export async function ${name}(`);
            if (start < 0) return '';
            const next = src.indexOf('export async function', start + 1);
            return src.slice(start, next > start ? next : src.length);
        }

        /** A usecase whose SIGNATURE takes one of the two fields. */
        interface Mutator {
            name: string;
            fields: string[];
            emits: boolean;
        }

        /**
         * Why the signature and not the body.
         *
         * `updateTask` writes through an opaque `patch` object —
         * `WorkItemRepository.update(db, ctx, taskId, patch)` — so no
         * `dueAt:` literal appears in its body at all, and a body scan misses
         * it. The signature is where the capability is declared, and it is
         * also what the old comment pointed at.
         *
         * Read from RAW source rather than through `blankNonCode`: that helper
         * has no regex-literal state and loses a code unit per non-BMP
         * character (#2106), and this extraction is POSITION-sensitive — it
         * balances parentheses to find where a parameter list ends. A comment
         * inside a parameter list mentioning one of the fields would produce a
         * false positive, which ADDS a usecase to the required set and fails
         * loudly. The other direction — a missed mutator — is the silent one,
         * and raw text cannot produce it.
         */
        function deriveMutators(): Mutator[] {
            const raw = readFileSync(
                path.join(ROOT, 'src/app-layer/usecases/task.ts'),
                'utf-8',
            );
            const out: Mutator[] = [];
            const decl = /export async function ([A-Za-z0-9_]+)\s*\(/g;
            let m: RegExpExecArray | null;
            while ((m = decl.exec(raw)) !== null) {
                // Balance from the opening paren to find the parameter list.
                let depth = 0;
                let i = m.index + m[0].length - 1;
                for (; i < raw.length; i++) {
                    if (raw[i] === '(') depth++;
                    else if (raw[i] === ')') {
                        depth--;
                        if (depth === 0) break;
                    }
                }
                const signature = raw.slice(m.index, i + 1);
                const fields = ['assigneeUserId', 'dueAt'].filter((f) =>
                    signature.includes(f),
                );
                if (fields.length === 0) continue;

                // `emits` is read from BLANKED source, not from raw, and the
                // direction is why. A false positive on `fields` adds a
                // usecase to the required set and fails loudly; a false
                // positive on `emits` marks an unwired mutator as wired and
                // goes SILENT — which is a commented-out
                // `// await emitTaskDueNotification(ctx, result)` away. That
                // is the inverse defect this repo calls "a scar is not a
                // wound", and `guards-blank-comments-before-matching` lists it
                // as case 4. So each direction reads the source it is safe in.
                out.push({
                    name: m[1],
                    fields,
                    emits: bodyOf(taskSrc(), m[1]).includes(
                        'await emitTaskDueNotification(ctx,',
                    ),
                });
            }
            return out;
        }

        /**
         * Mutators that deliberately do not emit, each with a reason.
         *
         * An entry here is a claim somebody has to defend, which is the point.
         * The two below are KNOWN GAPS rather than decisions — they are listed
         * so the gap is visible in the code that would otherwise have hidden
         * it, not to bless it.
         */
        const NO_EMIT_REASONS: Record<string, string> = {
            bulkAssignTasks:
                'KNOWN GAP (#2103). Writes a TASK_ASSIGNED audit row per task and ' +
                'returns, so being assigned twenty tasks at once is silent while ' +
                'being assigned one is not. Blocked on a product decision rather ' +
                'than on code: N bells for one action is what digests exist to ' +
                'avoid, so the shape (one summary vs a rate-limited per-task emit) ' +
                'has to be chosen before it is wired. Zero bulk TASK_ASSIGNED rows ' +
                'in production as of 2026-10-20, so nothing has been missed yet.',
            bulkSetTaskDueDate:
                'KNOWN GAP (#2103). Same shape as bulkAssignTasks and the same ' +
                'pending decision — a bulk reschedule of twenty tasks would emit ' +
                'twenty due-date bells.',
        };

        const MUTATORS = deriveMutators();

        it('derives a real population, and finds the two fields', () => {
            // An empty or tiny derivation would pass every assertion below.
            // Five mutators are known to exist; the floor is deliberately the
            // known count rather than a round number.
            expect(MUTATORS.length).toBeGreaterThanOrEqual(5);
            const names = MUTATORS.map((x) => x.name);
            expect(names).toContain('createTask');
            expect(names).toContain('updateTask');
            expect(names).toContain('assignTask');
            expect(names).toContain('bulkAssignTasks');
            expect(names).toContain('bulkSetTaskDueDate');
        });

        it('CONTROL: the deriver excludes usecases that change neither field', () => {
            // `bulkSetTaskStatus` changes a status, `bulkDeleteTask` deletes,
            // `listTasks` reads. A deriver that swept them in would make the
            // exemption list meaningless — and `bulkSetTaskStatus` in
            // particular would look like a third omission when it is correctly
            // out of scope.
            const names = MUTATORS.map((x) => x.name);
            expect(names).not.toContain('bulkSetTaskStatus');
            expect(names).not.toContain('bulkDeleteTask');
            expect(names).not.toContain('listTasks');
            expect(names).not.toContain('setTaskStatus');
        });

        it('every derived mutator either emits or has a written reason', () => {
            const unexplained = MUTATORS.filter(
                (x) => !x.emits && !(x.name in NO_EMIT_REASONS),
            );
            if (unexplained.length > 0) {
                throw new Error(
                    `${unexplained.length} task usecase(s) can change dueAt or ` +
                        `assigneeUserId and neither emit nor explain why:\n` +
                        unexplained
                            .map((x) => `  ${x.name}  (${x.fields.join(', ')})`)
                            .join('\n') +
                        `\n\nEither call \`await emitTaskDueNotification(ctx, result)\` ` +
                        `after the commit, or add an entry to NO_EMIT_REASONS in this ` +
                        `file saying why not. This list is DERIVED from task.ts — the ` +
                        `hand-written version it replaced went green through exactly ` +
                        `this case twice (#2103).`,
                );
            }
            expect(unexplained).toEqual([]);
        });

        it('every exemption names a mutator that still exists and still lacks the emit', () => {
            // A stale exemption is worse than none: it silently stops
            // exempting, or it hides that the function was wired up and the
            // reason is now a lie.
            for (const [name, reason] of Object.entries(NO_EMIT_REASONS)) {
                const found = MUTATORS.find((x) => x.name === name);
                expect(found).toBeDefined();
                expect(found!.emits).toBe(false);
                // Long enough to be a reason rather than a shrug.
                expect(reason.length).toBeGreaterThan(80);
            }
        });

        it.each(MUTATORS.filter((x) => x.emits).map((x) => x.name))(
            '%s fires emitTaskDueNotification post-commit',
            (usecase) => {
                const s = taskSrc();
                const start = s.indexOf(`export async function ${usecase}(`);
                expect(start).toBeGreaterThan(-1);
                const nextDecl = s.indexOf('export async function', start + 1);
                const body = s.slice(start, nextDecl > start ? nextDecl : s.length);
                // The call MUST be `emitTaskDueNotification(ctx, …)`
                // (no `await`-less variants, no commented-out lines).
                expect(body).toMatch(/await emitTaskDueNotification\(ctx,/);
            },
        );

        it('the declaration stays unique, and the call count MATCHES the derivation', () => {
            // The old version locked this at the literal 3, which is the lock
            // that held while two mutators went unwired. Tying it to the
            // derived set means the number moves when the population does,
            // and cannot move on its own.
            const s = taskSrc();
            const decls = s.match(/async function emitTaskDueNotification\b/g) ?? [];
            const calls = s.match(/await emitTaskDueNotification\(ctx,/g) ?? [];
            expect(decls.length).toBe(1);
            expect(calls.length).toBe(MUTATORS.filter((x) => x.emits).length);
        });
    });

    describe('3. Emit call placement: after commit, before cache-bump', () => {
        // Derived from the emitting set rather than listed again — a second
        // hand-written copy of the same population is a second thing to forget.
        const EMITTING = (() => {
            const s = read('src/app-layer/usecases/task.ts');
            return ['createTask', 'updateTask', 'assignTask', 'bulkAssignTasks', 'bulkSetTaskDueDate'].filter(
                (name) => {
                    const start = s.indexOf(`export async function ${name}(`);
                    if (start < 0) return false;
                    const next = s.indexOf('export async function', start + 1);
                    const body = s.slice(start, next > start ? next : s.length);
                    return /await emitTaskDueNotification\(ctx,/.test(body);
                },
            );
        })();

        it.each(EMITTING)(
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
