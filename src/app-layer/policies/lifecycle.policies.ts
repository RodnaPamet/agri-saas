/**
 * Editable Lifecycle Authorization Policies
 *
 * Defines permission checks for lifecycle operations. These follow the
 * project's established authorization pattern:
 *
 *   - Accept `RequestContext` (and optional entity data)
 *   - Throw typed errors (`forbidden()`)
 *   - Called by domain usecases, never by routes
 *
 * Permission Matrix:
 * ──────────────────
 * | Action               | Required Permission | Typical Roles           |
 * |----------------------|--------------------|-----------------------|
 * | Edit draft           | canWrite           | ADMIN, EDITOR          |
 * | Publish / Deploy     | canAdmin           | ADMIN only             |
 * | View history         | canRead + canAudit | ADMIN, AUDITOR         |
 * | Archive              | canAdmin           | ADMIN only             |
 * | Revert to version    | canAdmin           | ADMIN only             |
 *
 * Design rationale:
 * ─────────────────
 * - **Draft editing requires canWrite** — EDITOR and ADMIN roles can create
 *   and modify draft content. This matches the existing policy: EDITOR can
 *   create versions, ADMIN can create versions.
 *
 * - **Publishing requires canAdmin** — Only admins can promote drafts to
 *   live/published state. This is a deliberate escalation from draft editing:
 *   publishing makes content authoritative across the organization.
 *   This matches the existing policy.ts pattern where publishPolicy() calls
 *   assertCanAdmin(ctx).
 *
 * - **History/version access requires canRead + canAudit** — Version history
 *   contains prior authoritative states. canAudit ensures only users with
 *   audit permissions can access historical snapshots, matching the
 *   audit trail access pattern used by `getPracticeActivity` and `getPolicyActivity`.
 *
 * - **Archive requires canAdmin** — Archiving is an irreversible operation
 *   that freezes the entity. Only admins can perform this action.
 *   This matches archivePolicy() → assertCanAdmin(ctx).
 *
 * - **Revert requires canAdmin** — Reverting loads a prior version into the
 *   draft. While it doesn't change the live state, it's a significant
 *   action that should be admin-controlled to prevent accidental content loss.
 *
 * @module app-layer/policies/lifecycle.policies
 */

import type { RequestContext } from '../types';
import type { EditablePhase } from '../domain/editable-lifecycle.types';
import { forbidden } from '@/lib/errors/types';

/**
 * Asserts the user can edit a draft.
 * Required: canWrite permission (ADMIN or EDITOR).
 */
export function assertCanEditDraft(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to edit drafts. Write permission is required.');
    }
}

/**
 * Asserts the user can publish/deploy a draft to live state.
 * Required: canAdmin permission (ADMIN only).
 *
 * Publishing makes content authoritative across the organization.
 * This deliberately requires a higher permission than draft editing.
 */
export function assertCanPublish(ctx: RequestContext) {
    if (!ctx.permissions.canAdmin) {
        throw forbidden('You do not have permission to publish. Admin permission is required.');
    }
}

/**
 * Asserts the user can view version history.
 * Required: canRead + canAudit permissions (ADMIN or AUDITOR).
 *
 * Version history contains prior authoritative states and is
 * part of the audit trail.
 */
export function assertCanViewHistory(ctx: RequestContext) {
    if (!ctx.permissions.canRead) {
        throw forbidden('You do not have permission to view records.');
    }
    if (!ctx.permissions.canAudit) {
        throw forbidden('You do not have permission to view version history. Audit permission is required.');
    }
}

/**
 * Asserts the user can archive an entity.
 * Required: canAdmin permission (ADMIN only).
 *
 * Archiving is irreversible — the entity is frozen for audit preservation.
 */
export function assertCanArchive(ctx: RequestContext) {
    if (!ctx.permissions.canAdmin) {
        throw forbidden('You do not have permission to archive. Admin permission is required.');
    }
}

/**
 * Asserts the user can revert to a prior version.
 * Required: canAdmin permission (ADMIN only).
 *
 * Reverting loads historical content into the draft. While it doesn't
 * change the live state, it's a significant action that replaces
 * the current draft with prior content.
 */
export function assertCanRevert(ctx: RequestContext) {
    if (!ctx.permissions.canAdmin) {
        throw forbidden('You do not have permission to revert versions. Admin permission is required.');
    }
}

/**
 * Asserts the user can view a specific draft entity.
 * Required: canWrite OR ownership OR entity is not draft.
 *
 * Implements the CISO-Assistant `is_published` visibility convention:
 * - Published/archived entities are visible to anyone with canRead
 * - Draft entities require either canWrite (editorial workflow) or ownership
 *
 * This policy should be called when accessing a SINGLE entity by ID,
 * as opposed to list queries which use buildDraftVisibilityFilter().
 *
 * @param ctx - Request context with user and permissions
 * @param entityPhase - The entity's current lifecycle phase
 * @param ownerUserId - The entity's owner/creator user ID (null if unowned)
 */
export function assertCanViewDraftEntity(
    ctx: RequestContext,
    entityPhase: EditablePhase,
    ownerUserId: string | null,
) {
    // Non-draft entities are always visible (to anyone with canRead)
    if (entityPhase !== 'DRAFT') return;

    // Writers/admins can see all drafts (editorial workflow)
    if (ctx.permissions.canWrite) return;

    // Non-writers can only see their own drafts
    if (ownerUserId === ctx.userId) return;

    throw forbidden(
        'This item is in draft and is not visible to you. '
        + 'Only the owner or users with write permission can view draft items.',
    );
}
