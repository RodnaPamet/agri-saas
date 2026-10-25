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
 * The PREDICATE behind `assertCanDeleteTreatment`, exported so a list payload
 * can offer «Изтрий» only where pressing it would succeed.
 *
 * It is one function rather than two spellings on purpose. A client that
 * recomputed "creator or admin" from a `createdByUserId` field would drift the
 * first time the rule moves, and an offered control that 403s is worse than an
 * absent one — the farmer has already decided to delete by the time they learn
 * they cannot.
 *
 * It answers the PERMISSION question only. Mixed authorship is a separate
 * refusal (`TREATMENT_MIXED_AUTHORSHIP`, 409) that binds admins too, so a
 * caller composing a `mayDelete` flag must AND this with "single author" — see
 * `JournalRepository`. Folding that in here would make the assert throw 403 for
 * a case the usecase answers 409.
 */
/**
 * Only a task's CREATOR or a farm admin may DELETE it (#2187).
 *
 * Owner ruling 2026-10-23, closing an asymmetry #2169 opened: editing became
 * creator-or-admin while deleting stayed any-writer, so the rule read "you may
 * not change my task, but you may delete it" — the weaker permission guarding
 * the more destructive verb.
 *
 * ## The delete is HARD, which is worse than I first recorded
 *
 * #2187 was filed saying "a soft delete is recoverable from the Trash, so a
 * lower bar is defensible". That was wrong. `deleteTask` calls
 * `db.task.delete`, and its own test is named "deletes the row (children
 * cascade)" — comments, links and the audit trail's entity go with it. Nothing
 * writes `Task.deletedAt`, even though the column exists, is indexed and the
 * repository filters on it; `src/lib/prisma.ts` describes a `softDelete`
 * extension in a comment that is not applied anywhere, and the repositories
 * that do soft-delete (Location, Parcel, CostEntry, Knowledge) each implement
 * it explicitly by name.
 *
 * So the cost of a mistaken delete is permanent, and the argument for a lower
 * bar than EDIT does not survive contact with what the code does.
 *
 * Whether the task delete SHOULD be soft is a separate question and not this
 * change's to answer.
 */
export function assertCanDeleteTask(
    ctx: RequestContext,
    task: { createdByUserId: string },
) {
    if (ctx.permissions.canAdmin) return;
    if (task.createdByUserId === ctx.userId) return;
    throw codedForbidden(
        'TASK_DELETE_NOT_PERMITTED',
        'Only the person who created this task, or a farm administrator, can delete it.',
    );
}

/**
 * The same rule for a BULK delete, which refuses the WHOLE call (#2187).
 *
 * Owner ruling: all-or-nothing, reporting how many rows were refused. A
 * partial success is the worse answer here — the farmer selected twenty rows
 * and would get an outcome they have to reconcile against their selection,
 * with no way to tell which seventeen went. #1740 is the same shape one domain
 * over, where the treatment write is atomic PER BLOCK rather than across the
 * treatment, and the lesson there was that a half-applied destructive result
 * is a state the UI cannot explain.
 *
 * The count rides in `params`, which `ErrorParams` documents as "named,
 * non-personal, for translation" — a number of rows, never whose they are.
 */
export function assertCanDeleteTasks(
    ctx: RequestContext,
    tasks: ReadonlyArray<{ createdByUserId: string }>,
) {
    if (ctx.permissions.canAdmin) return;
    const refused = tasks.filter((t) => t.createdByUserId !== ctx.userId).length;
    if (refused === 0) return;
    throw codedForbidden(
        'TASK_DELETE_NOT_PERMITTED',
        'Some of the selected tasks were created by somebody else, so none were deleted.',
        { refused, selected: tasks.length },
    );
}

export function canDeleteTreatment(
    ctx: RequestContext,
    treatment: { createdByUserId: string | null },
): boolean {
    if (ctx.permissions.canAdmin) return true;
    return treatment.createdByUserId != null && treatment.createdByUserId === ctx.userId;
}

/**
 * Only a treatment's CREATOR or a farm admin may delete it (#2175).
 *
 * Owner ruling 2026-10-22, and it REVERSES two protections that a previous
 * ruling chose deliberately. Recorded here rather than in a commit message,
 * because the next reader of `deleteDiaryTreatment` will find the old reasoning
 * in its docblock and should not have to guess which decision is current.
 *
 *   • 2026-10-15 made that endpoint **ADMIN only**, explicitly over the
 *     `canWrite` that records a treatment. This widens it to the creator, so a
 *     non-admin EDITOR can now withdraw a finished БАБХ record they wrote.
 *   • 2026-10-15 also made it **INCOMPLETE only**, on the stated grounds that
 *     letting a complete treatment through "would make this a convenience
 *     route that drops БАБХ records, which is the thing the issue was written
 *     to prevent". The new ruling permits exactly that.
 *
 * ## What makes the wider door defensible — TWO protections, not three
 *
 * As written on 2026-10-22 the justification rested on three: the delete is
 * SOFT, it is AUDITED, and it is RESTORABLE from «Кошче» by the same people —
 * "nothing is destroyed; a withdrawal is reversible by anyone who could have
 * made it".
 *
 * **The third is gone.** #2254 removed «Кошче» on the owner's ruling of
 * 2026-10-24 that deleted means deleted, and `deleteDiaryTreatment` now
 * physically deletes the `OperationParcel` lines and the `LogEntry` rows —
 * neither model is in `SOFT_DELETE_MODELS`, so those are real DELETEs — while
 * soft-deleting only the tasks. No restore path exists anywhere in `src`. So
 * "nothing is destroyed" was false in the most literal way: the register lines
 * the ДНЕВНИК prints are gone, and they are what the register was made of.
 *
 * **Owner ruling 2026-10-25 (#2280): the rule STAYS creator-or-admin**, with
 * the justification resting on the two that remain. It was put to the owner
 * with the alternative of narrowing back to ADMIN-only and they chose to keep
 * the wider door knowing the restore is gone. So this paragraph is the current
 * justification and not a pending question:
 *
 *   • **AUDITED.** `deleteDiaryTreatment` writes one `ENTITY_DELETED` event
 *     naming the handle and what it removed. The act is attributable even
 *     though its subject is not recoverable, which is what an audit is for.
 *   • **The task shell survives**, soft-deleted, so the treatment's existence
 *     and its authorship remain readable after the lines are gone.
 *
 * ## And the remedy a creator needs is no longer destructive
 *
 * Worth recording because it changes the shape of the risk rather than the
 * rule. The 2026-10-22 widening existed so the person who recorded a wrong
 * treatment could put it right; withdrawing and re-recording was then the only
 * way to do that. Since #2172 shipped it is not — a creator can CORRECT a
 * treatment in place, down to its dose, its product and its parcel set, with
 * the previous values kept on a `TreatmentCorrection` trail.
 *
 * So the wide door is now the SECOND remedy rather than the only one, and the
 * case where a creator still needs it is a treatment that should not exist at
 * all rather than one that is wrong. That is a narrower case than the one the
 * widening was argued for, and it is the reason keeping the rule costs less
 * than it did on 2026-10-22.
 *
 * Same shape as `assertCanEditTask`, and deliberately a separate function: the
 * two answer different questions about different entities, and collapsing them
 * would make a later divergence silent.
 */
export function assertCanDeleteTreatment(
    ctx: RequestContext,
    treatment: { createdByUserId: string },
) {
    if (canDeleteTreatment(ctx, treatment)) return;
    throw codedForbidden(
        'TREATMENT_DELETE_NOT_PERMITTED',
        'Only the person who recorded this treatment, or a farm administrator, can remove it.',
    );
}

export function canEditTreatment(
    ctx: RequestContext,
    treatment: { createdByUserId: string | null },
): boolean {
    if (ctx.permissions.canAdmin) return true;
    return treatment.createdByUserId != null && treatment.createdByUserId === ctx.userId;
}

/**
 * Only a treatment's CREATOR or a farm admin may correct it (#2172).
 *
 * The same rule as `assertCanDeleteTreatment`, and that is the point rather
 * than duplication: a correction must not be easier to make than a withdrawal.
 * Relayed from the owner as "creator and farm admins, same as the task rule",
 * which is also what #2169 settled for `assertCanEditTask`.
 *
 * A SEPARATE function from the delete's, for the reason that one gives for
 * being separate from `assertCanEditTask`: they answer different questions
 * about different verbs, and collapsing them would make a later divergence
 * silent. #2280 is live on exactly such a divergence — the delete's
 * justification has lost one of its three protections — so the two are more
 * likely to diverge than to converge.
 *
 * ## The caller must establish SINGLE AUTHORSHIP first
 *
 * This takes one `createdByUserId`, so it cannot see a group written by more
 * than one person. `deleteDiaryTreatment` asserts that separately and refuses a
 * mixed set with a 409 that binds admins too — a treatment nobody solely
 * authored has no creator for this rule to admit. A correction has to do the
 * same before calling this, and the definition read is where that check lives.
 */
export function assertCanEditTreatment(
    ctx: RequestContext,
    treatment: { createdByUserId: string },
) {
    if (canEditTreatment(ctx, treatment)) return;
    throw codedForbidden(
        'TREATMENT_EDIT_NOT_PERMITTED',
        // Kind-NEUTRAL wording. This same rule now guards the bare-activity
        // correction too (#2373) — reused rather than duplicated, so the code is
        // shared as well — and «това третиране» was shown to a farmer correcting
        // a резитба. The CODE keeps its `TREATMENT_` prefix: that is its name,
        // and renaming it would break every client switching on it.
        'Only the person who made this record, or a farm administrator, can correct it.',
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
