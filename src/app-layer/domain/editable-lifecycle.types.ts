/**
 * Editable Lifecycle Domain Types
 *
 * Typed contracts for a reusable draft/publish lifecycle pattern.
 * Any domain entity (policies, practices, risk treatments, assessments)
 * can adopt this lifecycle by defining its own TPayload shape.
 *
 * Architecture:
 * ─────────────
 *   DRAFT ──publish──▶ PUBLISHED ──archive──▶ ARCHIVED
 *     ▲                    │
 *     │              (snapshot to history)
 *     │                    │
 *     └──revert────── HISTORY[]
 *
 * The lifecycle is a pure state machine with no database coupling.
 * Persistence is handled by domain-specific repositories that map
 * EditableState to their Prisma models.
 *
 * Design Principles:
 * ──────────────────
 * 1. **Generic payload** — TPayload is domain-specific (Policy content,
 *    Practice description, Risk treatment plan, etc.)
 * 2. **Explicit phases** — No ambiguous "status" enums; phase is one of
 *    DRAFT, PUBLISHED, or ARCHIVED.
 * 3. **Version = publish count** — Version only increments on publish,
 *    never on draft edits. This matches semantic versioning semantics.
 * 4. **Immutable history** — Published snapshots are append-only. Prior
 *    versions are never mutated.
 * 5. **Conservative transitions** — Cannot publish without a draft,
 *    cannot edit when archived.
 *
 * @module app-layer/domain/editable-lifecycle.types
 */

// ─── Lifecycle Phases ────────────────────────────────────────────────

/**
 * The three lifecycle phases an editable entity can be in.
 *
 * DRAFT     — Entity has unpublished changes. May or may not have a
 *             published version. This is the initial phase.
 * PUBLISHED — Entity has been published. The live payload is the
 *             authoritative state. Draft is cleared on publish.
 * ARCHIVED  — Entity is frozen. No further edits or publishes allowed.
 *             History and published state are preserved for audit.
 */
export const EDITABLE_PHASES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type EditablePhase = typeof EDITABLE_PHASES[number];

// ─── Published Snapshot ──────────────────────────────────────────────

/**
 * An immutable snapshot of a published payload, stored in version history.
 *
 * Created automatically when a new version is published, capturing the
 * PRIOR published state before it is replaced. This enables full
 * version traceability and rollback.
 */
export interface PublishedSnapshot<TPayload> {
    /** The version number this snapshot represents */
    readonly version: number;
    /** The frozen payload at the time of this version */
    readonly payload: TPayload;
    /** ISO 8601 timestamp of when this version was published */
    readonly publishedAt: string;
    /** User ID of who published this version */
    readonly publishedBy: string;
    /** Optional human-readable summary of what changed */
    readonly changeSummary?: string;
}

// ─── Editable State ──────────────────────────────────────────────────

/**
 * The full lifecycle state for a domain entity.
 *
 * This is the core data structure that the lifecycle service operates on.
 * Domain repositories are responsible for persisting/loading this shape.
 *
 * Type parameter TPayload defines the domain-specific content:
 * - Policy: { contentType, contentText, externalUrl }
 * - Practice: { description, intent, effectiveness }
 * - Risk treatment: { plan, notes, targetDate }
 */
export interface EditableState<TPayload> {
    /** Current lifecycle phase */
    readonly phase: EditablePhase;

    /**
     * Current version number.
     * - 1 = initial content version (never published)
     * - 2+ = number of times published + 1
     * Starts at 1 (matching CISO-Assistant editing_version convention).
     * Increments only on publish, never on draft edits.
     */
    readonly currentVersion: number;

    /**
     * The in-progress draft payload, or null if no pending changes.
     * Cleared to null on publish. Set by updateDraft().
     */
    readonly draft: TPayload | null;

    /**
     * The live/published payload, or null if never published.
     * Replaced on each publish. Read-only between publishes.
     */
    readonly published: TPayload | null;

    /**
     * Who published the current live version (userId).
     * Set on publish, preserved through draft edits.
     * Used for correct history attribution: when a new version is published,
     * the prior version's snapshot records this user, not the new publisher.
     * Null if never published.
     */
    readonly publishedBy: string | null;

    /**
     * Change summary from the current live publish.
     * Used for correct history attribution alongside publishedBy.
     * Null if never published.
     */
    readonly publishedChangeSummary: string | null;

    /**
     * Ordered history of prior published versions (oldest first).
     * Append-only: a new snapshot is added each time a new version
     * is published (capturing the PRIOR published state).
     * The first publish (v1→v2) creates no history entry because
     * there is no prior published state to snapshot.
     */
    readonly history: ReadonlyArray<PublishedSnapshot<TPayload>>;
}

// ─── Commands ────────────────────────────────────────────────────────

/**
 * Command to publish the current draft as a new version.
 */
export interface PublishCommand {
    /** User ID performing the publish */
    readonly publishedBy: string;
    /** Optional summary of changes for audit trail */
    readonly changeSummary?: string;
}

/**
 * Command to revert the draft to a previously published version.
 */
export interface RevertCommand {
    /** The version number to revert to */
    readonly targetVersion: number;
}

// ─── Draft Visibility ────────────────────────────────────────────────

/**
 * Ownership metadata needed for draft visibility decisions.
 *
 * CISO-Assistant convention: draft objects are hidden from non-owners.
 * `is_published` on AbstractBaseModel practices read-access visibility.
 *
 * This type captures the minimum ownership data needed to evaluate
 * visibility without coupling to any specific Prisma model.
 */
export interface DraftOwnership {
    /** The user who created/owns this entity */
    readonly ownerUserId: string | null;
}

/**
 * What scope of entities a user should see in list queries.
 *
 * - `ALL`                — See all entities regardless of phase (writers/admins)
 * - `PUBLISHED_AND_OWN`  — See published/archived + own drafts (readers)
 *
 * CISO-Assistant equivalent: `is_published=True OR owner=request.user`
 */
export type VisibilityScope = 'ALL' | 'PUBLISHED_AND_OWN';

// ─── Lifecycle Errors ────────────────────────────────────────────────

/**
 * Error thrown when a lifecycle operation is invalid given the current state.
 * Examples: publishing with no draft, editing when archived, reverting to
 * a non-existent version.
 */
export class LifecycleError extends Error {
    constructor(
        message: string,
        public readonly code: LifecycleErrorCode,
    ) {
        super(message);
        this.name = 'LifecycleError';
    }
}

export const LIFECYCLE_ERROR_CODES = [
    'NO_DRAFT',
    'ALREADY_ARCHIVED',
    'VERSION_NOT_FOUND',
    'INVALID_PHASE',
] as const;

export type LifecycleErrorCode = typeof LIFECYCLE_ERROR_CODES[number];
