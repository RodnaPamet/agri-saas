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
 * What makes the wider door defensible is that the other two protections stay
 * and one is added: the delete is SOFT, it is AUDITED, and it is now
 * RESTORABLE from «Кошче» by the same people. Nothing is destroyed; a
 * withdrawal is reversible by anyone who could have made it.
 *
 * Same shape as `assertCanEditTask`, and deliberately a separate function: the
 * two answer different questions about different entities, and collapsing them
 * would make a later divergence silent.
 */
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
export function canDeleteTreatment(
    ctx: RequestContext,
    treatment: { createdByUserId: string | null },
): boolean {
    if (ctx.permissions.canAdmin) return true;
    return treatment.createdByUserId != null && treatment.createdByUserId === ctx.userId;
}

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

/**
 * ADMIN, EDITOR, and AUDITOR can add comments (broader for collaboration).
 * READER cannot comment.
 */
export function assertCanCommentOnTasks(ctx: RequestContext) {
    if (ctx.role === 'READER') {
        throw forbidden('You do not have permission to comment on tasks.');
    }
}
