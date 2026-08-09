/**
 * Editable Lifecycle Service — Pure-logic state machine for draft/publish lifecycle.
 *
 * Provides the core lifecycle operations that any domain entity can use:
 * - Create initial draft state
 * - Update draft payload
 * - Publish (promote draft → published, snapshot prior version to history)
 * - Revert draft to a prior published version
 * - Archive (freeze entity, preserve history)
 *
 * Design:
 * ───────
 * All functions are **pure** — they take an EditableState, return a new
 * EditableState. No side effects, no database calls, no I/O.
 *
 * This service does NOT know about Prisma, tenants, or specific domain
 * entities. Domain-specific usecases (policy.ts, practice.ts, etc.) are
 * responsible for:
 * 1. Loading EditableState from their Prisma model
 * 2. Calling lifecycle functions
 * 3. Persisting the updated EditableState back
 *
 * This mirrors the design of `version-history.ts` (pure history tracking)
 * and `mapping-resolution.ts` (pure graph traversal with pluggable loader).
 *
 * Invariants:
 * ───────────
 * - Version starts at 1 (matching CISO-Assistant editing_version convention)
 * - Version increments ONLY on publish (never on draft edits)
 * - History is append-only (snapshots are never mutated or removed)
 * - First publish (v1→v2) does NOT create a history entry (no prior state)
 * - Second publish (v2→v3) snapshots v2 to history, etc.
 * - Cannot publish without a draft
 * - Cannot publish or edit when ARCHIVED
 * - Revert loads a snapshot INTO the draft (does NOT change published)
 *
 * @module app-layer/services/editable-lifecycle
 */

import type {
    EditableState,
    PublishedSnapshot,
    PublishCommand,
    RevertCommand,
    DraftOwnership,
    VisibilityScope,
} from '../domain/editable-lifecycle.types';
import { LifecycleError } from '../domain/editable-lifecycle.types';

// ─── Create ──────────────────────────────────────────────────────────

/**
 * Create the initial editable state for a new entity.
 *
 * The entity starts in DRAFT phase with version 1 (initial content version,
 * matching CISO-Assistant editing_version=1 convention). Version 1 means
 * "content exists but has never been published." The first publish will
 * increment to version 2.
 *
 * @param draft - Initial draft payload
 * @returns New EditableState in DRAFT phase
 */
export function createEditableState<TPayload>(
    draft: TPayload,
): EditableState<TPayload> {
    return {
        phase: 'DRAFT',
        currentVersion: 1,
        draft,
        published: null,
        publishedBy: null,
        publishedChangeSummary: null,
        history: [],
    };
}

// ─── Draft Mutation ──────────────────────────────────────────────────

/**
 * Update the draft payload of an editable entity.
 *
 * The draft can be updated freely while in DRAFT or PUBLISHED phase.
 * If the entity is PUBLISHED and a draft update comes in, the phase
 * transitions to DRAFT (indicating unpublished changes exist).
 *
 * @param state - Current lifecycle state
 * @param draft - New draft payload (replaces entire draft)
 * @returns Updated state with new draft
 * @throws LifecycleError if entity is ARCHIVED
 */
export function updateDraft<TPayload>(
    state: EditableState<TPayload>,
    draft: TPayload,
): EditableState<TPayload> {
    if (state.phase === 'ARCHIVED') {
        throw new LifecycleError(
            'Cannot update draft: entity is archived',
            'ALREADY_ARCHIVED',
        );
    }

    return {
        ...state,
        phase: 'DRAFT',
        draft,
    };
}

// ─── Publish ─────────────────────────────────────────────────────────

/**
 * Publish the current draft as a new version.
 *
 * This is the central lifecycle transition:
 * 1. If there is an existing published payload (version ≥ 1), snapshot it to history
 * 2. Promote the draft payload to published
 * 3. Increment the version counter
 * 4. Clear the draft (no pending changes after publish)
 * 5. Set phase to PUBLISHED
 *
 * The first publish (version 0→1) does NOT create a history entry because
 * there is no prior published state to snapshot.
 *
 * @param state - Current lifecycle state
 * @param command - Publish command with user ID and optional summary
 * @returns Updated state with new published version
 * @throws LifecycleError if no draft exists or entity is archived
 */
export function publish<TPayload>(
    state: EditableState<TPayload>,
    command: PublishCommand,
): EditableState<TPayload> {
    if (state.phase === 'ARCHIVED') {
        throw new LifecycleError(
            'Cannot publish: entity is archived',
            'ALREADY_ARCHIVED',
        );
    }

    if (state.draft === null) {
        throw new LifecycleError(
            'Cannot publish: no draft payload exists',
            'NO_DRAFT',
        );
    }

    const newVersion = state.currentVersion + 1;

    // Snapshot the current published state to history (if it exists)
    // First publish (v1→v2) has no prior published state to snapshot
    let newHistory = [...state.history];
    if (state.published !== null && state.currentVersion >= 2) {
        const snapshot: PublishedSnapshot<TPayload> = {
            version: state.currentVersion,
            payload: state.published,
            publishedAt: new Date().toISOString(),
            // CQ-3 fix: use the ORIGINAL publisher of this version, not the new publisher
            publishedBy: state.publishedBy ?? command.publishedBy,
            changeSummary: state.publishedChangeSummary ?? command.changeSummary,
        };
        newHistory = [...newHistory, snapshot];
    }

    return {
        phase: 'PUBLISHED',
        currentVersion: newVersion,
        draft: null,
        published: state.draft,
        // Store the NEW publisher's info for future snapshots
        publishedBy: command.publishedBy,
        publishedChangeSummary: command.changeSummary ?? null,
        history: newHistory,
    };
}

// ─── Revert ──────────────────────────────────────────────────────────

/**
 * Revert the draft to a previously published version from history.
 *
 * This loads the payload from a historical snapshot into the draft,
 * allowing the user to review and re-publish it. The current published
 * state is NOT changed — the revert only affects the draft.
 *
 * The phase is set to DRAFT (indicating there are unpublished changes).
 *
 * @param state - Current lifecycle state
 * @param command - Revert command with target version
 * @returns Updated state with historical payload loaded into draft
 * @throws LifecycleError if entity is archived or version not found
 */
export function revertToVersion<TPayload>(
    state: EditableState<TPayload>,
    command: RevertCommand,
): EditableState<TPayload> {
    if (state.phase === 'ARCHIVED') {
        throw new LifecycleError(
            'Cannot revert: entity is archived',
            'ALREADY_ARCHIVED',
        );
    }

    const snapshot = state.history.find(s => s.version === command.targetVersion);
    if (!snapshot) {
        throw new LifecycleError(
            `Cannot revert: version ${command.targetVersion} not found in history`,
            'VERSION_NOT_FOUND',
        );
    }

    return {
        ...state,
        phase: 'DRAFT',
        draft: snapshot.payload,
    };
}

// ─── Archive ─────────────────────────────────────────────────────────

/**
 * Archive an editable entity.
 *
 * Freezes the entity in its current state. No further drafts, publishes,
 * or reverts are allowed. Published content and history are preserved
 * for audit purposes.
 *
 * @param state - Current lifecycle state
 * @returns Updated state in ARCHIVED phase
 * @throws LifecycleError if already archived
 */
export function archive<TPayload>(
    state: EditableState<TPayload>,
): EditableState<TPayload> {
    if (state.phase === 'ARCHIVED') {
        throw new LifecycleError(
            'Cannot archive: entity is already archived',
            'ALREADY_ARCHIVED',
        );
    }

    return {
        ...state,
        phase: 'ARCHIVED',
    };
}

// ─── Query Helpers ───────────────────────────────────────────────────

/**
 * Check if the entity has unpublished changes.
 *
 * True when there is a draft payload that differs from the published state.
 * This is useful for UI indicators ("unsaved changes") and workflow guards.
 */
export function hasPendingChanges<TPayload>(
    state: EditableState<TPayload>,
): boolean {
    return state.draft !== null;
}

/**
 * Check if the entity has ever been published.
 */
export function hasBeenPublished<TPayload>(
    state: EditableState<TPayload>,
): boolean {
    return state.currentVersion >= 2;
}

/**
 * Get a specific version's snapshot from history.
 * Returns undefined if the version is not in history.
 */
export function getHistoryEntry<TPayload>(
    state: EditableState<TPayload>,
    version: number,
): PublishedSnapshot<TPayload> | undefined {
    return state.history.find(s => s.version === version);
}

/**
 * Get the most recent N history entries (most recent first).
 */
export function getRecentHistory<TPayload>(
    state: EditableState<TPayload>,
    count: number,
): ReadonlyArray<PublishedSnapshot<TPayload>> {
    return state.history.slice(-count).reverse();
}

/**
 * Get the effective payload — what a consumer should display.
 *
 * Returns the draft if one exists (showing in-progress changes),
 * otherwise returns the published payload (the live state).
 * Returns null only if the entity has never had content.
 */
export function getEffectivePayload<TPayload>(
    state: EditableState<TPayload>,
): TPayload | null {
    return state.draft ?? state.published;
}

// ─── Draft Visibility ────────────────────────────────────────────────

/**
 * Determine if a specific entity should be visible to a given user.
 *
 * Implements the CISO-Assistant `is_published` visibility convention:
 * - Published and archived entities are visible to anyone with canRead
 * - Draft entities are visible only to:
 *   (a) Users with canWrite (editors/admins who may need to review/edit), or
 *   (b) The entity's owner (who created the draft)
 *
 * This is a pure predicate — no DB access, no side effects.
 *
 * @param state - The entity's lifecycle state
 * @param ownership - Who owns/created the entity
 * @param viewerUserId - The user attempting to view
 * @param viewerCanWrite - Whether the viewer has write permission
 * @returns true if the entity should be visible to this viewer
 */
export function isDraftVisibleTo<TPayload>(
    state: EditableState<TPayload>,
    ownership: DraftOwnership,
    viewerUserId: string,
    viewerCanWrite: boolean,
): boolean {
    // Published and archived entities are always visible (to anyone with canRead)
    if (state.phase !== 'DRAFT') return true;

    // Writers/admins see all drafts (needed for editorial workflow)
    if (viewerCanWrite) return true;

    // Non-writers only see their own drafts
    return ownership.ownerUserId === viewerUserId;
}

/**
 * Determine the visibility scope for list queries.
 *
 * Returns the scope that should be applied when listing entities:
 * - Writers/admins see ALL entities (they participate in editorial workflow)
 * - Readers/auditors see only PUBLISHED_AND_OWN (published + their own drafts)
 *
 * Use this to build Prisma where clauses in list queries:
 *
 * ```typescript
 * const scope = getVisibilityScope(ctx.permissions.canWrite);
 * if (scope === 'PUBLISHED_AND_OWN') {
 *     where.OR = [
 *         { status: { not: 'DRAFT' } },
 *         { ownerUserId: ctx.userId },
 *     ];
 * }
 * ```
 *
 * @param canWrite - Whether the user has write permission
 * @returns The visibility scope to apply
 */
export function getVisibilityScope(canWrite: boolean): VisibilityScope {
    return canWrite ? 'ALL' : 'PUBLISHED_AND_OWN';
}

/**
 * Build a Prisma-compatible where clause fragment for draft visibility filtering.
 *
 * This is the bridge between the pure visibility logic and Prisma queries.
 * Returns a filter object that can be spread into a Prisma `where` clause.
 *
 * When the user has write access, returns an empty object (no filter).
 * When the user is read-only, returns an OR clause that shows:
 *   - All non-DRAFT entities, OR
 *   - DRAFT entities owned by the current user
 *
 * @param canWrite - Whether the user has write permission
 * @param userId - The current user's ID
 * @param statusField - The name of the status field (default: 'status')
 * @param ownerField - The name of the owner field (default: 'ownerUserId')
 * @returns A Prisma-compatible where clause fragment
 *
 * @example
 * ```typescript
 * const visibilityFilter = buildDraftVisibilityFilter(
 *     ctx.permissions.canWrite, ctx.userId,
 * );
 * const policies = await db.policy.findMany({
 *     where: { tenantId: ctx.tenantId, ...visibilityFilter },
 * });
 * ```
 */
export function buildDraftVisibilityFilter(
    canWrite: boolean,
    userId: string,
    statusField: string = 'status',
    ownerField: string = 'ownerUserId',
): Record<string, unknown> {
    // Writers see everything — no filter needed
    if (canWrite) return {};

    // Read-only users: show non-draft + own drafts
    return {
        OR: [
            { [statusField]: { not: 'DRAFT' } },
            { [ownerField]: userId },
        ],
    };
}
