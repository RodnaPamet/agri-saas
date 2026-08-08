/**
 * 2026-05-27 — PR-A: in-app TASK_ASSIGNED + CONTROL_ASSIGNED
 * notification wiring ratchet.
 *
 * Locks the four surfaces this feature crosses:
 *
 *   1. Schema enum has CONTROL_ASSIGNED (the new value).
 *   2. Migration exists that adds the enum value.
 *   3. `task.ts` calls `emitTaskAssignedNotification` after
 *      EVERY task write that may have set the assignee
 *      (createTask + assignTask). Pre-PR-A the email path
 *      fired but the in-app bell stayed silent.
 *   4. `control/mutations.ts::setControlOwner` calls
 *      `createAssignmentNotification('CONTROL_ASSIGNED', …)`
 *      after committing the ownership change. Pre-PR-A
 *      control owner changes wrote only the audit row.
 *
 * Each surface anchored on a verifiable substring so a future
 * refactor that silently drops one of the four trips CI with
 * the per-PR rationale visible in the test docstring.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf-8');

describe('PR-A notification-assignment alert wiring', () => {
    describe('1. Schema + migration', () => {
        it('NotificationType enum includes CONTROL_ASSIGNED', () => {
            const enums = read('prisma/schema/enums.prisma');
            // Anchored inside the NotificationType enum block to
            // distinguish from any other enum that might reuse the
            // name.
            const block = enums.slice(
                enums.indexOf('enum NotificationType'),
                enums.indexOf('enum EmailNotificationType'),
            );
            expect(block).toMatch(/CONTROL_ASSIGNED/);
        });

        it('TASK_ASSIGNED stays in the enum (we did not regress it)', () => {
            const enums = read('prisma/schema/enums.prisma');
            const block = enums.slice(
                enums.indexOf('enum NotificationType'),
                enums.indexOf('enum EmailNotificationType'),
            );
            expect(block).toMatch(/TASK_ASSIGNED/);
        });

        it('migration directory exists for CONTROL_ASSIGNED enum add', () => {
            const migrationDir = path.join(
                ROOT,
                'prisma/migrations/20260527160000_notif_control_assigned',
            );
            expect(existsSync(migrationDir)).toBe(true);
            const sql = readFileSync(
                path.join(migrationDir, 'migration.sql'),
                'utf-8',
            );
            expect(sql).toMatch(
                /ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CONTROL_ASSIGNED'/,
            );
        });

        it('NotificationType enum includes RISK_ASSIGNED + ASSET_ASSIGNED', () => {
            const enums = read('prisma/schema/enums.prisma');
            const block = enums.slice(
                enums.indexOf('enum NotificationType'),
                enums.indexOf('enum EmailNotificationType'),
            );
            expect(block).toMatch(/RISK_ASSIGNED/);
            expect(block).toMatch(/ASSET_ASSIGNED/);
        });

        it('migration exists adding RISK_ASSIGNED + ASSET_ASSIGNED', () => {
            const migrationDir = path.join(
                ROOT,
                'prisma/migrations/20260530120000_notif_risk_asset_assigned',
            );
            expect(existsSync(migrationDir)).toBe(true);
            const sql = readFileSync(
                path.join(migrationDir, 'migration.sql'),
                'utf-8',
            );
            expect(sql).toMatch(
                /ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RISK_ASSIGNED'/,
            );
            expect(sql).toMatch(
                /ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSET_ASSIGNED'/,
            );
        });
    });

    describe('2. Assignment notifications module', () => {
        const src = () =>
            read('src/app-layer/notifications/assignment.ts');

        it('exports createAssignmentNotification + the four-value KIND union', () => {
            const s = src();
            expect(s).toMatch(/export async function createAssignmentNotification/);
            // 2026-05-30 — union widened to cover risk + asset
            // assignment alongside task + control. Assert all four are
            // present (order-independent) so a future drop trips CI.
            for (const kind of [
                'TASK_ASSIGNED',
                'CONTROL_ASSIGNED',
                'RISK_ASSIGNED',
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
            // TASK + CONTROL doesn't collide).
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

    describe('4. control/mutations.ts wires CONTROL_ASSIGNED in setControlOwner', () => {
        const src = () =>
            read('src/app-layer/usecases/control/mutations.ts');

        it('imports createAssignmentNotification', () => {
            expect(src()).toMatch(
                /import\s*\{\s*createAssignmentNotification\s*\}\s*from\s*['"]\.\.\/\.\.\/notifications\/assignment['"]/,
            );
        });

        it('setControlOwner calls createAssignmentNotification with CONTROL_ASSIGNED', () => {
            const s = src();
            const start = s.indexOf('export async function setControlOwner');
            expect(start).toBeGreaterThan(-1);
            const end = s.indexOf('// ─── Cadence', start);
            expect(end).toBeGreaterThan(start);
            const body = s.slice(start, end);
            expect(body).toMatch(
                /createAssignmentNotification\(\s*db,\s*['"]CONTROL_ASSIGNED['"]/,
            );
        });

        it('the CONTROL_ASSIGNED write runs AFTER the parent transaction commits', () => {
            // The notification write MUST be outside the
            // `runInTenantContext(...)` that does the ownership
            // update — a notification failure should never roll back
            // the assign. We anchor on the closing `await
            // bumpEntityCacheVersion(...)` (post-tx) appearing BEFORE
            // the createAssignmentNotification call.
            const s = src();
            const start = s.indexOf('export async function setControlOwner');
            const end = s.indexOf('// ─── Cadence', start);
            const body = s.slice(start, end);
            const bumpIdx = body.indexOf("bumpEntityCacheVersion(ctx, 'control')");
            const callIdx = body.indexOf('createAssignmentNotification(');
            expect(bumpIdx).toBeGreaterThan(-1);
            expect(callIdx).toBeGreaterThan(bumpIdx);
        });

        it('only fires when ownerUserId is non-null (no notification on unassign)', () => {
            // Unassigning (`ownerUserId === null`) shouldn't spam
            // the deassigned user with "you were assigned" — the
            // guard at the top of the if-block prevents it.
            const s = src();
            const start = s.indexOf('export async function setControlOwner');
            const end = s.indexOf('// ─── Cadence', start);
            const body = s.slice(start, end);
            expect(body).toMatch(/if \(ownerUserId && ctx\.tenantSlug\)/);
        });
    });

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
