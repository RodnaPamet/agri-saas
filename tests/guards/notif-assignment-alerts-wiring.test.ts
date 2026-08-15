/**
 * 2026-05-27 — PR-A: in-app assignment-notification wiring ratchet.
 *
 * Locks the surfaces this feature crosses:
 *
 *   1. Schema enum carries the surviving assignment values.
 *   2. Migrations exist that added them.
 *   3. `task.ts` calls `emitTaskAssignedNotification` after
 *      EVERY task write that may have set the assignee
 *      (createTask + assignTask). Pre-PR-A the email path
 *      fired but the in-app bell stayed silent.
 *   4. `asset.ts` emits ASSET_ASSIGNED on an actual owner change.
 *
 * Each surface anchored on a verifiable substring so a future
 * refactor that silently drops one trips CI with the per-PR
 * rationale visible in the test docstring.
 *
 * GRC teardown phase 3 dropped PRACTICE_ASSIGNED and RISK_ASSIGNED
 * from `NotificationType`. Neither had a `src/` emission site left —
 * `setPracticeOwner` went in phase 2 with the Practice model, and
 * `updateRisk` went with the earlier risk uproot — and both COPY
 * entries deep-linked to `/practices` and `/risks`, routes that no
 * longer exist. The two migrations that ADDED them are asserted
 * verbatim below as applied history; the migration that removes them
 * is asserted alongside.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf-8');

describe('PR-A notification-assignment alert wiring', () => {
    describe('1. Schema + migration', () => {
        const notifTypeBlock = () => {
            const enums = read('prisma/schema/enums.prisma');
            // Anchored inside the NotificationType enum block to
            // distinguish from any other enum that might reuse a name.
            const block = enums.slice(
                enums.indexOf('enum NotificationType'),
                enums.indexOf('enum EmailNotificationType'),
            );
            // Comments stripped before matching. The block carries a note
            // explaining WHICH values phase 3 removed, and a bare
            // `not.toMatch(/PRACTICE_ASSIGNED/)` matched that note rather
            // than a declaration — the guard failed on its own
            // documentation. Only declared members are of interest here.
            return block
                .split('\n')
                .filter((l) => !l.trim().startsWith('//'))
                .join('\n');
        };

        it('TASK_ASSIGNED + ASSET_ASSIGNED stay in the enum', () => {
            expect(notifTypeBlock()).toMatch(/TASK_ASSIGNED/);
            expect(notifTypeBlock()).toMatch(/ASSET_ASSIGNED/);
        });

        it('PRACTICE_ASSIGNED and RISK_ASSIGNED are gone', () => {
            // The other direction, and the load-bearing one now: a
            // re-add would restore a value whose only COPY entry points
            // at a deleted route, so the bell would deep-link to a 404.
            expect(notifTypeBlock()).not.toMatch(/PRACTICE_ASSIGNED/);
            expect(notifTypeBlock()).not.toMatch(/RISK_ASSIGNED/);
        });

        it('the applied migrations that added them are left untouched', () => {
            // Applied history, asserted verbatim. Rewriting an applied
            // migration changes its checksum and breaks `migrate deploy`
            // on every existing database — so the ADDs stay on disk
            // exactly as they shipped, and phase 3 removes the values
            // with a NEW migration rather than by editing these.
            expect(
                readFileSync(
                    path.join(ROOT, 'prisma/migrations/20260527160000_notif_control_assigned/migration.sql'),
                    'utf-8',
                ),
            ).toMatch(/ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CONTROL_ASSIGNED'/);
            expect(
                readFileSync(
                    path.join(ROOT, 'prisma/migrations/20260530120000_notif_risk_asset_assigned/migration.sql'),
                    'utf-8',
                ),
            ).toMatch(/ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RISK_ASSIGNED'/);
        });

        it('the ASSET_ASSIGNED add migration exists', () => {
            const dir = path.join(ROOT, 'prisma/migrations/20260530120000_notif_risk_asset_assigned');
            expect(existsSync(dir)).toBe(true);
            expect(
                readFileSync(path.join(dir, 'migration.sql'), 'utf-8'),
            ).toMatch(/ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSET_ASSIGNED'/);
        });
    });

    describe('2. Assignment notifications module', () => {
        const src = () =>
            read('src/app-layer/notifications/assignment.ts');

        it('exports createAssignmentNotification + the KIND union', () => {
            const s = src();
            expect(s).toMatch(/export async function createAssignmentNotification/);
            // Both surviving kinds must be present (order-independent)
            // so a future drop trips CI. The union was four members
            // until GRC teardown phase 3 removed PRACTICE_ASSIGNED and
            // RISK_ASSIGNED along with the routes they linked to.
            for (const kind of [
                'TASK_ASSIGNED',
                'ASSET_ASSIGNED',
            ]) {
                expect(s).toMatch(
                    new RegExp(`AssignmentNotificationKind[\\s\\S]{0,200}${kind}`),
                );
                // Each kind also needs a COPY entry (title/body/link).
                expect(s).toMatch(new RegExp(`${kind}:\\s*\\{`));
            }
        });

        it('uses createMany with skipDuplicates (NOT raw create — P2002 would poison the tx)', () => {
            const s = src();
            expect(s).toMatch(/notification\.createMany\(/);
            expect(s).toMatch(/skipDuplicates:\s*true/);
            // Anti-regression: a future refactor MUST NOT switch to
            // raw `db.notification.create({ data: …, dedupeKey: … })`.
            // Inside an interactive PG transaction, a thrown P2002
            // poisons the whole tx — even after JS catches it the PG
            // state is aborted. createMany returns count=0 instead.
            expect(s).not.toMatch(/notification\.create\(\{/);
        });

        it('exports buildAssignmentDedupeKey with the canonical format', () => {
            const s = src();
            expect(s).toMatch(/export function buildAssignmentDedupeKey/);
            // The dedupeKey shape MUST include the day (so per-day
            // collapse works) and the KIND (so the same id under
            // TASK + PRACTICE doesn't collide).
            expect(s).toMatch(
                /\$\{tenantId\}:\$\{kind\}:\$\{entityId\}:\$\{userId\}:\$\{ymd\}/,
            );
        });

        it('publishes to the SSE bus on a fresh insert (2026-05-28 follow-up)', () => {
            // After PR-C #761 landed the in-process bus + SSE route,
            // the assignment helper SHOULD fan a fresh insert out
            // to subscribed bell clients — the same posture
            // `createTaskDueNotification` already has. Locked here
            // so a future "tidy up" can't silently drop the path
            // and leave the bell stuck on the 60s fallback poll
            // for assignment events.
            const s = src();
            expect(s).toMatch(
                /import\s*\{\s*publishNotificationEvent\s*\}\s*from\s+['"]@\/lib\/notifications\/notification-bus['"]/,
            );
            // Publish ONLY when result.count > 0 (duplicates skip
            // the fanout — the original publish already pushed
            // when the row was first inserted).
            expect(s).toMatch(
                /if \(result\.count > 0\) \{[\s\S]{0,400}publishNotificationEvent\(\s*target\.tenantId,\s*target\.assigneeUserId,/,
            );
        });
    });

    describe('3. task.ts wires emitTaskAssignedNotification', () => {
        const src = () => read('src/app-layer/usecases/task.ts');

        it('imports createAssignmentNotification', () => {
            expect(src()).toMatch(
                /import\s*\{\s*createAssignmentNotification\s*\}\s*from\s*['"]\.\.\/notifications\/assignment['"]/,
            );
        });

        it('defines emitTaskAssignedNotification helper', () => {
            expect(src()).toMatch(
                /async function emitTaskAssignedNotification/,
            );
        });

        it('createTask + assignTask both fire emitTaskAssignedNotification', () => {
            const s = src();
            // Count the call sites — should be at least TWO: one
            // post-`createTask` commit, one post-`assignTask` commit.
            // (A future PR can add updateTask if assignee mutations
            // become routable through patch().)
            const calls = s.match(/emitTaskAssignedNotification\(/g) ?? [];
            expect(calls.length).toBeGreaterThanOrEqual(3); // 1 decl + 2 calls
        });

        it('helper guards on assigneeUserId + tenantSlug before firing', () => {
            const s = src();
            // Locate the helper body.
            const start = s.indexOf('async function emitTaskAssignedNotification');
            expect(start).toBeGreaterThan(-1);
            const end = s.indexOf('// ─── Links ───', start);
            const body = s.slice(start, end > start ? end : start + 2000);
            expect(body).toMatch(/if \(!task\.assigneeUserId \|\| !ctx\.tenantSlug\) return/);
        });
    });

    // Block 4 (practice/mutations.ts wiring PRACTICE_ASSIGNED in
    // setPracticeOwner) was removed in GRC teardown phase 2 with the
    // Practice model; phase 3 removed the enum member itself. Block 1
    // above now asserts its ABSENCE.

    describe('5. asset.ts wires ASSET_ASSIGNED on owner change', () => {
        it('updateAsset imports + emits ASSET_ASSIGNED only on an actual change', () => {
            const s = read('src/app-layer/usecases/asset.ts');
            expect(s).toMatch(
                /import\s*\{\s*createAssignmentNotification\s*\}\s*from\s*['"]\.\.\/notifications\/assignment['"]/,
            );
            expect(s).toMatch(
                /createAssignmentNotification\(\s*db,\s*['"]ASSET_ASSIGNED['"]/,
            );
            expect(s).toMatch(
                /newOwnerId && newOwnerId !== previousOwnerId && ctx\.tenantSlug/,
            );
        });

        it('UpdateAssetSchema accepts ownerUserId', () => {
            const s = read('src/lib/schemas/index.ts');
            // The update schema must carry ownerUserId or the PUT
            // would strip the "Assigned to" value before it reaches
            // the usecase. (The paired UpdateRiskSchema assertion went
            // with the risk register.)
            const assetBlock = s.slice(
                s.indexOf('export const UpdateAssetSchema'),
                s.indexOf("}).strip().openapi('AssetUpdateRequest'"),
            );
            expect(assetBlock).toMatch(/ownerUserId:/);
        });
    });
});
