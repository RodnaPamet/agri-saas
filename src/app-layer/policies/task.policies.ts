import { RequestContext } from '../types';
import { codedForbidden, forbidden } from '@/lib/errors/types';

/**
 * All authenticated roles can read tasks.
 */
export function assertCanReadTasks(ctx: RequestContext) {
    if (!ctx.permissions.canRead) {
        throw forbidden('You do not have permission to view tasks.');
    }
}

/**
 * ADMIN and EDITOR can create/update/assign/link tasks.
 */
export function assertCanWriteTasks(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to modify tasks.');
    }
}

/**
 * Only a task's CREATOR or a farm admin may edit it (#2169).
 *
 * Owner ruling 2026-10-22. `assertCanWriteTasks` is still the first gate — this
 * NARROWS it, and never widens: a caller without `canWrite` is refused before
 * this is reached.
 *
 * ## Why this exists at all
 *
 * The phone has offered «Редактирай» on exactly this rule since agrent-ios
 * #382, enforced CLIENT-SIDE only, while the web and this API allowed anyone
 * with `canWrite`. Three surfaces, two answers, and no server rule for either
 * to be right about — the shape `docs/billing.md` names in its own
 * what-not-to-do list as "no UI-only gating".
 *
 * ## It REMOVES behaviour that worked
 *
 * A colleague can no longer fix a teammate's task unless they are an admin. On
 * a farm with one admin and several field staff that may be the common case
 * rather than the exception, which is why it was put to the owner as a
 * behaviour removal rather than a tidy-up, and chosen knowingly.
 *
 * ## Every task HAS a creator, so this is total
 *
 * `Task.createdByUserId` is `String` and NOT NULL, with a required
 * `createdBy` relation. Automation cannot produce an exception either:
 * `action-executor.ts`'s `createTask` resolves
 * `event.actorUserId ?? rule.createdByUserId` and REFUSES with "No actor to
 * own the created task" rather than writing a creatorless row. So there is no
 * orphan case to decide, and an earlier note of mine on #2169 claiming
 * automation-created tasks have no creator was wrong — it read the DTO, whose
 * field is optional in the OUTPUT shape, rather than the column.
 *
 * A coded refusal rather than a prose one, per the #1388 / #1405 convention:
 * the phone renders `TASK_EDIT_NOT_PERMITTED` in Bulgarian, and a client
 * cannot branch on a sentence.
 */
export function assertCanEditTask(
    ctx: RequestContext,
    task: { createdByUserId: string },
) {
    if (ctx.permissions.canAdmin) return;
    if (task.createdByUserId === ctx.userId) return;
    throw codedForbidden(
        'TASK_EDIT_NOT_PERMITTED',
        'Only the person who created this task, or a farm administrator, can edit it.',
    );
}

/**
 * ADMIN, EDITOR, and AUDITOR can add comments (broader for collaboration).
 * READER cannot comment.
 */
export function assertCanCommentOnTasks(ctx: RequestContext) {
    if (ctx.role === 'READER') {
        throw forbidden('You do not have permission to comment on tasks.');
    }
}
