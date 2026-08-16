/**
 * Audit Coherence S10 (2026-05-24) — entity-specific restore
 * validators.
 *
 * Pre-S10 `restoreEntity` only checked (a) the row exists in the
 * tenant and (b) the row is currently soft-deleted. Every other
 * precondition was left implicit. That left a route for the admin
 * restore button to undo a soft-delete into an inconsistent state:
 *
 *   - Evidence restored whose ownerUserId points at a removed
 *     membership.
 *
 * S10 shipped two further validators that the GRC teardown
 * (phase 3, 2026-08) removed along with their subjects: the Task
 * validator refused a restore whose `Task.practiceId` pointed at a
 * deleted Practice (column and model both dropped), and the
 * AuditPack validator refused a restore under a deleted or
 * COMPLETE parent AuditCycle (both models dropped). Neither
 * precondition has anything left to check — `AuditPack` left the
 * union with its model, and `Task` (which survives) now falls
 * through to the no-op.
 *
 * This module defines a per-model validator table the restore
 * usecase consults BEFORE clearing `deletedAt`. Validators are
 * pure (caller passes the snapshot row + a DB handle for parent
 * lookups); they throw `badRequest` with a specific message on
 * any precondition failure.
 *
 * Models without a custom validator fall through to
 * `NOOP_VALIDATOR`. Adding a new validator is intentional
 * narrowing — open one with a written precondition + a test row.
 */
import type { PrismaTx } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import type { RequestContext } from '../types';

export type RestorableModel =
    | 'Asset'
    | 'Evidence'
    | 'FileRecord'
    | 'Task';

/**
 * Validator signature. Receives the soft-deleted row + a tenant-
 * bound transaction handle. Throws a typed error on precondition
 * failure; returning successfully means restore is allowed.
 *
 * The row is typed `unknown` because each model has a different
 * shape; validators narrow with a structural cast.
 */
export type RestoreValidator = (
    ctx: RequestContext,
    db: PrismaTx,
    record: unknown,
) => Promise<void>;

const NOOP_VALIDATOR: RestoreValidator = async () => {
    // Models without specific preconditions allow restore as long
    // as the soft-deleted row + tenant gates have passed.
};

// ─── Per-Model Validators ────────────────────────────────────────────

/**
 * `Evidence` restore — refuse if the owning user has been removed
 * from the tenant. The owner's membership is the actor of record
 * for re-submission; restoring orphan-owned evidence would leave
 * the row in a "pending review by nobody" limbo.
 */
const EVIDENCE_VALIDATOR: RestoreValidator = async (ctx, db, record) => {
    const row = record as { ownerUserId: string | null };
    if (!row.ownerUserId) return;
    const membership = await db.tenantMembership.findFirst({
        where: {
            tenantId: ctx.tenantId,
            userId: row.ownerUserId,
            status: 'ACTIVE',
        },
        select: { id: true },
    });
    if (!membership) {
        throw badRequest(
            'Cannot restore: the evidence owner is no longer an active member of this tenant. Reassign ownership first, then retry.',
        );
    }
};

// ─── Registry ────────────────────────────────────────────────────────

export const RESTORE_VALIDATORS: Record<RestorableModel, RestoreValidator> = {
    Asset: NOOP_VALIDATOR,
    Evidence: EVIDENCE_VALIDATOR,
    FileRecord: NOOP_VALIDATOR,
    Task: NOOP_VALIDATOR,
};

/**
 * Look up the validator for a model. The registry is keyed on the
 * `RestorableModel` union, so the lookup is total — callers don't
 * need a fallback.
 */
export function getRestoreValidator(model: RestorableModel): RestoreValidator {
    return RESTORE_VALIDATORS[model];
}
