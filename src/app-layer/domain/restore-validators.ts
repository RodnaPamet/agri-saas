/**
 * Audit Coherence S10 (2026-05-24) — entity-specific restore
 * validators.
 *
 * Pre-S10 `restoreEntity` only checked (a) the row exists in the
 * tenant and (b) the row is currently soft-deleted. Every other
 * precondition was left implicit. That left several routes for
 * the admin restore button to undo a soft-delete into an
 * inconsistent state:
 *
 *   - AuditPack restored under a CLOSED AuditCycle → the pack is
 *     now "open" again but its parent is frozen for audit, which
 *     contradicts the cycle-immutable contract.
 *   - AuditPack restored under a deleted AuditCycle → orphan.
 *   - Task restored whose practiceId points at a deleted Practice.
 *   - Evidence restored whose ownerUserId points at a removed
 *     membership.
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
    | 'Risk'
    | 'Practice'
    | 'Evidence'
    | 'Policy'
    | 'Vendor'
    | 'FileRecord'
    | 'Task'
    | 'Finding'
    | 'Audit'
    | 'AuditCycle'
    | 'AuditPack';

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
 * `Task` restore — refuse if the parent practice was deleted.
 *
 * Rationale: restoring a task under a deleted practice creates an
 * "orphan" that the user can no longer navigate to (the practice
 * page hides the row); the only escape is restoring the practice,
 * which is itself a privileged operation. Better to surface this
 * blocker explicitly at restore time.
 */
const TASK_VALIDATOR: RestoreValidator = async (ctx, db, record) => {
    const row = record as { practiceId: string | null };
    if (!row.practiceId) return;
    const practice = await db.practice.findFirst({
        where: { id: row.practiceId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true },
    });
    if (!practice) {
        throw badRequest(
            'Cannot restore: the parent practice has been deleted. Restore the practice first, then retry.',
        );
    }
};

/**
 * `AuditPack` restore — refuse when:
 *   - parent AuditCycle is deleted, OR
 *   - parent AuditCycle is COMPLETE (cycle-immutable contract).
 *
 * Restoring a pack under a frozen / vanished cycle would
 * silently violate the audit-cycle integrity invariant the
 * closeout flow relies on. The terminal status on `AuditCycleStatus`
 * is `COMPLETE` (the enum has PLANNING / IN_PROGRESS / READY /
 * COMPLETE — there is no CLOSED value); this is the
 * audit-cycle equivalent of CLOSED on other lifecycles.
 */
const AUDIT_PACK_VALIDATOR: RestoreValidator = async (ctx, db, record) => {
    const row = record as { auditCycleId: string };
    const cycle = await db.auditCycle.findFirst({
        where: { id: row.auditCycleId, tenantId: ctx.tenantId },
        select: { id: true, status: true, deletedAt: true },
    });
    if (!cycle || cycle.deletedAt) {
        throw badRequest(
            'Cannot restore: the parent audit cycle has been deleted. Restore the cycle first, then retry.',
        );
    }
    if (cycle.status === 'COMPLETE') {
        throw badRequest(
            'Cannot restore: the parent audit cycle is COMPLETE. Reopen the cycle (or restore into a new pack) before restoring this artifact.',
        );
    }
};

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
    Risk: NOOP_VALIDATOR,
    Practice: NOOP_VALIDATOR,
    Evidence: EVIDENCE_VALIDATOR,
    Policy: NOOP_VALIDATOR,
    Vendor: NOOP_VALIDATOR,
    FileRecord: NOOP_VALIDATOR,
    Task: TASK_VALIDATOR,
    Finding: NOOP_VALIDATOR,
    Audit: NOOP_VALIDATOR,
    AuditCycle: NOOP_VALIDATOR,
    AuditPack: AUDIT_PACK_VALIDATOR,
};

/**
 * Look up the validator for a model. The registry is keyed on the
 * `RestorableModel` union, so the lookup is total — callers don't
 * need a fallback.
 */
export function getRestoreValidator(model: RestorableModel): RestoreValidator {
    return RESTORE_VALIDATORS[model];
}
