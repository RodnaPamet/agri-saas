/**
 * Editable Lifecycle Usecase — Auditable, persistence-aware publish workflow.
 *
 * This module bridges the pure lifecycle state machine (`editable-lifecycle.ts`)
 * to the application layer, adding:
 *
 * 1. **Audit integration** — Every lifecycle transition emits an audit event
 *    via the existing `logEvent()` system, matching the project's conventions.
 * 2. **Persistence protocol** — Defines the `EditableRepository<T>` contract
 *    so domain repositories can plug in their own load/store logic.
 * 3. **Validation hooks** — Optional pre-publish validation so domains can
 *    enforce their own business rules (e.g. "policy must have content").
 * 4. **Authorization** — Caller provides a `RequestContext` so audit events
 *    are correctly attributed and tenant-scoped.
 *
 * Architecture:
 * ─────────────
 *   Route Handler → Usecase (this file) → Lifecycle (pure) + Audit + Repo
 *
 *   The usecase orchestrates:
 *   1. Load EditableState from domain repository
 *   2. Apply lifecycle transition (pure function)
 *   3. Persist updated state via domain repository
 *   4. Emit audit event
 *
 * Why this layer exists:
 * ─────────────────────
 * The pure lifecycle service is deliberately side-effect-free, which makes
 * it testable and domain-agnostic. But production publish flows need:
 * - Audit trail for compliance
 * - DB transactions for consistency
 * - Authorization checks
 * - Validation before publish
 *
 * This module provides those capabilities generically, so domain usecases
 * can reuse the same publish/draft/archive workflow without duplicating the
 * audit + persistence boilerplate.
 *
 * @module app-layer/usecases/editable-lifecycle-usecase
 */

import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';
import type {
    EditableState,
    PublishCommand,
    RevertCommand,
} from '../domain/editable-lifecycle.types';
import { LifecycleError } from '../domain/editable-lifecycle.types';
import {
    updateDraft,
    publish,
    revertToVersion,
    archive,
} from '../services/editable-lifecycle';
import {
    assertCanEditDraft,
    assertCanPublish,
    assertCanRevert,
    assertCanArchive,
} from '../policies/lifecycle.policies';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';

// ─── Repository Contract ─────────────────────────────────────────────

/**
 * Contract that domain repositories implement to participate in the
 * editable lifecycle.
 *
 * Each domain (Policy, Practice, Risk) provides its own implementation
 * that maps between Prisma models and `EditableState<TPayload>`.
 *
 * The lifecycle usecase calls these methods during transitions —
 * it never touches Prisma directly.
 */
export interface EditableRepository<TPayload> {
    /**
     * Load the current lifecycle state for an entity.
     * Returns null if the entity doesn't exist.
     */
    loadState(db: PrismaTx, entityId: string): Promise<EditableState<TPayload> | null>;

    /**
     * Persist the updated lifecycle state after a transition.
     * The repository is responsible for mapping EditableState fields
     * to its domain-specific Prisma model(s).
     */
    saveState(db: PrismaTx, entityId: string, state: EditableState<TPayload>): Promise<void>;
}

// ─── Validation Contract ─────────────────────────────────────────────

/**
 * Optional pre-publish validation function.
 *
 * Domains can provide a validator that inspects the draft payload
 * before it is promoted to published. If validation fails, the
 * validator should throw a descriptive error.
 *
 * Examples:
 * - Policy: "contentText must not be empty"
 * - Practice: "description is required before publish"
 */
export type PublishValidator<TPayload> = (
    draft: TPayload,
    ctx: RequestContext,
) => void | Promise<void>;

// ─── Audit Event Builders ────────────────────────────────────────────

/**
 * Configuration for audit event generation.
 * Domain usecases provide this to customize entity-specific audit actions.
 */
export interface LifecycleAuditConfig {
    /** The entity type name for audit logs (e.g. 'Policy', 'Practice') */
    readonly entityType: string;
    /** Custom action prefix. Defaults to entity type uppercased.
     *  E.g. 'POLICY' produces actions like POLICY_DRAFT_UPDATED, POLICY_PUBLISHED */
    readonly actionPrefix?: string;
}

/** Build audit action string from config and operation */
function buildAction(config: LifecycleAuditConfig, operation: string): string {
    const prefix = config.actionPrefix ?? config.entityType.toUpperCase();
    return `${prefix}_${operation}`;
}

/**
 * Options for lifecycle usecase operations.
 */
export interface LifecycleUsecaseOptions {
    /**
     * Whether to enforce lifecycle policies (permission checks).
     *
     * Defaults to `true`. Set to `false` only in unit tests that need
     * to test non-permission lifecycle behavior without constructing
     * full RequestContext with live permissions.
     *
     * When `true`, each operation enforces its required permission:
     * - updateDraftWithAudit → assertCanEditDraft (canWrite)
     * - publishWithAudit     → assertCanPublish  (canAdmin)
     * - revertWithAudit      → assertCanRevert   (canAdmin)
     * - archiveWithAudit     → assertCanArchive  (canAdmin)
     */
    readonly enforcePolicy?: boolean;
}

// ─── Orchestrated Lifecycle Operations ───────────────────────────────

/**
 * Update the draft payload for an entity, with audit trail.
 *
 * Business rules:
 * - Draft is replaced entirely (not merged) — callers must provide complete payload
 * - If entity is PUBLISHED, phase transitions to DRAFT
 * - Audit event: {PREFIX}_DRAFT_UPDATED
 *
 * @returns The updated lifecycle state
 */
export async function updateDraftWithAudit<TPayload>(
    db: PrismaTx,
    ctx: RequestContext,
    entityId: string,
    draft: TPayload,
    repo: EditableRepository<TPayload>,
    auditConfig: LifecycleAuditConfig,
    options?: LifecycleUsecaseOptions,
): Promise<EditableState<TPayload>> {
    // Policy enforcement (defense-in-depth)
    if (options?.enforcePolicy !== false) {
        assertCanEditDraft(ctx);
    }

    const component = 'editable-lifecycle';

    const currentState = await repo.loadState(db, entityId);
    if (!currentState) {
        throw new LifecycleError(
            `Entity ${entityId} not found`,
            'INVALID_PHASE',
        );
    }

    const previousPhase = currentState.phase;
    const newState = updateDraft(currentState, draft);
    await repo.saveState(db, entityId, newState);

    await logEvent(db, ctx, {
        action: buildAction(auditConfig, 'DRAFT_UPDATED'),
        entityType: auditConfig.entityType,
        entityId,
        details: `Draft updated (phase: ${previousPhase} → ${newState.phase})`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: auditConfig.entityType,
            operation: 'draft_updated',
            previousPhase,
            newPhase: newState.phase,
            currentVersion: newState.currentVersion,
            summary: `${auditConfig.entityType} draft updated`,
        },
    });

    logger.info('Draft updated', {
        component,
        entityType: auditConfig.entityType,
        entityId,
        previousPhase,
        newPhase: newState.phase,
    });

    return newState;
}

/**
 * Publish the current draft as a new version, with audit trail.
 *
 * This is the central publish workflow:
 * 1. Load current state from repository
 * 2. Run optional pre-publish validation
 * 3. Apply publish transition (pure: snapshot prior → promote draft → bump version)
 * 4. Persist updated state
 * 5. Emit audit events
 *
 * Business rules documented:
 * ─────────────────────────
 * - **Draft is cleared after publish** — The published payload becomes the
 *   authoritative state. There are no pending changes after publish.
 *   To make further changes, the author must call updateDraft() again.
 *
 * - **Version starts at 1** — The first publish transitions version 1→2.
 *   Version 1 means "initial content, never published." Domain entities
 *   as versionNumber or equivalent.
 *
 * - **Pre-publish validation is optional** — If no validator is provided,
 *   the only validation is the lifecycle invariant (draft must exist,
 *   entity must not be archived).
 *
 * - **History snapshot is automatic** — When version ≥ 2 is published,
 *   the prior published payload is automatically appended to history.
 *   The first publish creates no history (no prior state to snapshot).
 *
 * Audit events emitted:
 * - {PREFIX}_PUBLISHED (category: status_change)
 * - {PREFIX}_VERSION_CREATED (category: entity_lifecycle) — when version ≥ 2
 *   creates a history entry
 *
 * @returns The updated lifecycle state after publish
 */
export async function publishWithAudit<TPayload>(
    db: PrismaTx,
    ctx: RequestContext,
    entityId: string,
    command: PublishCommand,
    repo: EditableRepository<TPayload>,
    auditConfig: LifecycleAuditConfig,
    validator?: PublishValidator<TPayload>,
    options?: LifecycleUsecaseOptions,
): Promise<EditableState<TPayload>> {
    // Policy enforcement (defense-in-depth)
    if (options?.enforcePolicy !== false) {
        assertCanPublish(ctx);
    }

    const component = 'editable-lifecycle';

    // 1. Load current state
    const currentState = await repo.loadState(db, entityId);
    if (!currentState) {
        throw new LifecycleError(
            `Entity ${entityId} not found`,
            'INVALID_PHASE',
        );
    }

    // 2. Pre-publish validation (domain-specific)
    if (validator && currentState.draft !== null) {
        await validator(currentState.draft, ctx);
    }

    const previousVersion = currentState.currentVersion;
    const previousPhase = currentState.phase;
    const hadPriorPublished = currentState.published !== null && previousVersion >= 1;

    // 3. Apply publish transition (pure)
    const newState = publish(currentState, command);

    // 4. Persist
    await repo.saveState(db, entityId, newState);

    // 5. Audit: publish event
    await logEvent(db, ctx, {
        action: buildAction(auditConfig, 'PUBLISHED'),
        entityType: auditConfig.entityType,
        entityId,
        details: `Published version ${newState.currentVersion}`,
        detailsJson: {
            category: 'status_change',
            entityName: auditConfig.entityType,
            fromStatus: previousPhase,
            toStatus: 'PUBLISHED',
            reason: command.changeSummary || `Published version ${newState.currentVersion}`,
        },
        metadata: {
            version: newState.currentVersion,
            previousVersion,
            changeSummary: command.changeSummary,
        },
    });

    // 6. Audit: version history event (only when a snapshot was created)
    if (hadPriorPublished) {
        await logEvent(db, ctx, {
            action: buildAction(auditConfig, 'VERSION_CREATED'),
            entityType: auditConfig.entityType,
            entityId,
            details: `Version ${previousVersion} archived to history`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: auditConfig.entityType,
                operation: 'version_snapshot',
                snapshotVersion: previousVersion,
                newVersion: newState.currentVersion,
                historyLength: newState.history.length,
                summary: `Prior version ${previousVersion} preserved in history`,
            },
            metadata: {
                snapshotVersion: previousVersion,
                historyLength: newState.history.length,
            },
        });
    }

    logger.info('Entity published', {
        component,
        entityType: auditConfig.entityType,
        entityId,
        version: newState.currentVersion,
        previousVersion,
        historyLength: newState.history.length,
        hadPriorPublished,
    });

    return newState;
}

/**
 * Revert draft to a prior published version, with audit trail.
 *
 * Business rules:
 * - Revert loads a snapshot INTO the draft (does NOT change published/live state)
 * - Phase transitions to DRAFT
 * - To actually make the reverted content live, the author must publish again
 * - Audit event: {PREFIX}_REVERTED
 *
 * @returns The updated lifecycle state with reverted draft
 */
export async function revertWithAudit<TPayload>(
    db: PrismaTx,
    ctx: RequestContext,
    entityId: string,
    command: RevertCommand,
    repo: EditableRepository<TPayload>,
    auditConfig: LifecycleAuditConfig,
    options?: LifecycleUsecaseOptions,
): Promise<EditableState<TPayload>> {
    // Policy enforcement (defense-in-depth)
    if (options?.enforcePolicy !== false) {
        assertCanRevert(ctx);
    }

    const component = 'editable-lifecycle';

    const currentState = await repo.loadState(db, entityId);
    if (!currentState) {
        throw new LifecycleError(
            `Entity ${entityId} not found`,
            'INVALID_PHASE',
        );
    }

    const newState = revertToVersion(currentState, command);
    await repo.saveState(db, entityId, newState);

    await logEvent(db, ctx, {
        action: buildAction(auditConfig, 'REVERTED'),
        entityType: auditConfig.entityType,
        entityId,
        details: `Draft reverted to version ${command.targetVersion}`,
        detailsJson: {
            category: 'status_change',
            entityName: auditConfig.entityType,
            fromStatus: currentState.phase,
            toStatus: 'DRAFT',
            reason: `Reverted to version ${command.targetVersion}`,
        },
        metadata: {
            targetVersion: command.targetVersion,
            currentVersion: newState.currentVersion,
        },
    });

    logger.info('Entity reverted to prior version', {
        component,
        entityType: auditConfig.entityType,
        entityId,
        targetVersion: command.targetVersion,
        currentVersion: newState.currentVersion,
    });

    return newState;
}

/**
 * Archive an entity, with audit trail.
 *
 * Business rules:
 * - Freezes the entity — no further edits, publishes, or reverts
 * - Published content and full version history are preserved
 * - Audit event: {PREFIX}_ARCHIVED
 *
 * @returns The updated lifecycle state in ARCHIVED phase
 */
export async function archiveWithAudit<TPayload>(
    db: PrismaTx,
    ctx: RequestContext,
    entityId: string,
    repo: EditableRepository<TPayload>,
    auditConfig: LifecycleAuditConfig,
    options?: LifecycleUsecaseOptions,
): Promise<EditableState<TPayload>> {
    // Policy enforcement (defense-in-depth)
    if (options?.enforcePolicy !== false) {
        assertCanArchive(ctx);
    }

    const component = 'editable-lifecycle';

    const currentState = await repo.loadState(db, entityId);
    if (!currentState) {
        throw new LifecycleError(
            `Entity ${entityId} not found`,
            'INVALID_PHASE',
        );
    }

    const previousPhase = currentState.phase;
    const newState = archive(currentState);
    await repo.saveState(db, entityId, newState);

    await logEvent(db, ctx, {
        action: buildAction(auditConfig, 'ARCHIVED'),
        entityType: auditConfig.entityType,
        entityId,
        details: `${auditConfig.entityType} archived`,
        detailsJson: {
            category: 'status_change',
            entityName: auditConfig.entityType,
            fromStatus: previousPhase,
            toStatus: 'ARCHIVED',
        },
        metadata: {
            finalVersion: newState.currentVersion,
            historyLength: newState.history.length,
        },
    });

    logger.info('Entity archived', {
        component,
        entityType: auditConfig.entityType,
        entityId,
        finalVersion: newState.currentVersion,
    });

    return newState;
}
