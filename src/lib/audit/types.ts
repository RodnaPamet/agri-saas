/**
 * Audit Trail — Types & Enums
 *
 * Canonical type definitions for the immutable audit trail.
 * These are the source of truth for actorType, event categories,
 * and the typed input shape for audit entry construction.
 *
 * @module audit/types
 */

// ─── Actor Types ────────────────────────────────────────────────────

/**
 * Who initiated the action.
 * - USER:   authenticated human via UI/API
 * - SYSTEM: automated middleware (e.g., Prisma audit middleware, soft-delete)
 * - JOB:    background job or scheduled task (purge, retention sweep)
 */
export type ActorType = 'USER' | 'SYSTEM' | 'JOB';

// ─── Audit Event Categories ────────────────────────────────────────

/**
 * Discriminant for structured detailsJson payloads.
 * Each category has a different set of required/optional fields.
 */
export type AuditDetailCategory =
    | 'entity_lifecycle'
    | 'status_change'
    | 'relationship'
    | 'access'
    | 'data_lifecycle'
    | 'custom';

// ─── Structured Detail Payloads ────────────────────────────────────

export interface EntityLifecycleDetails {
    category: 'entity_lifecycle';
    entityName: string;
    operation: 'created' | 'updated' | 'deleted' | 'restored' | 'purged';
    changedFields?: string[];
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    summary?: string;
}

export interface StatusChangeDetails {
    category: 'status_change';
    entityName: string;
    fromStatus: string | null;
    toStatus: string;
    reason?: string;
}

export interface RelationshipDetails {
    category: 'relationship';
    operation: 'linked' | 'unlinked';
    sourceEntity: string;
    sourceId: string;
    targetEntity: string;
    targetId: string;
    relation?: string;
}

export interface AccessDetails {
    category: 'access';
    /**
     * `file_downloaded` added by #3285, and the reason is worth keeping.
     *
     * `downloadEvidenceFile` was emitting `operation: 'login'` for an
     * evidence file download. It typechecked because this union offered four
     * values and none of them described a download — so the author had four
     * wrong answers and no right one, and took the first. The compiler was
     * satisfied and the record was false.
     *
     * That matters on this type in particular: Epic C.4 streams audit events
     * HMAC-signed to a SIEM, and `action` plus this field are what a consumer
     * filters on. A rule counting authentication events was counting file
     * downloads, while a rule looking for file access found nothing under any
     * operation it would have thought to query.
     *
     * Owner ruling 2026-11-27 chose widening this union over reclassifying
     * the event as `data_lifecycle: 'exported'` — the category was always
     * right (a download IS an access event) and only the vocabulary was short
     * a member. Safe to add because nothing emitted the new value before this
     * change, so no existing consumer rule changes meaning.
     */
    operation:
        | 'login'
        | 'logout'
        | 'session_revoked'
        | 'permission_changed'
        | 'file_downloaded';
    /**
     * The user an access change was made ABOUT — not the actor, who is
     * already on the audit row.
     *
     * Leave it UNSET when the event is about a thing rather than a person.
     * `downloadEvidenceFile` set it to the downloader until #3285, which made
     * the entry say somebody performed an access change on themselves.
     */
    targetUserId?: string;
    ipAddress?: string;
    detail?: string;
}

export interface DataLifecycleDetails {
    category: 'data_lifecycle';
    operation: 'purged' | 'archived' | 'retention_expired' | 'exported';
    recordCount?: number;
    model?: string;
    reason?: string;
    graceDays?: number;
}

export interface CustomDetails {
    category: 'custom';
    [key: string]: unknown;
}

/**
 * Union of all structured detail payloads.
 */
export type AuditDetails =
    | EntityLifecycleDetails
    | StatusChangeDetails
    | RelationshipDetails
    | AccessDetails
    | DataLifecycleDetails
    | CustomDetails;

// ─── Audit Entry Input ─────────────────────────────────────────────

/**
 * Input shape for constructing an audit entry via the event builder.
 * All fields needed for hash computation must be present.
 */
export interface AuditEntryInput {
    /** Tenant scope */
    tenantId: string;

    /** Actor performing the action */
    actorUserId: string | null;
    actorType: ActorType;

    /** What happened */
    eventType: string;     // e.g., 'VENDOR_CREATED', 'CONTROL_UPDATED'
    entityType: string;    // e.g., 'Vendor', 'Practice'
    entityId: string | null;

    /** When it happened (ISO-8601 UTC) */
    occurredAt: string;    // Canonical: YYYY-MM-DDTHH:mm:ss.SSSZ

    /** Structured detail payload */
    detailsJson: AuditDetails;

    /** Hash of the previous entry in this tenant's chain (null for first entry) */
    previousHash: string | null;

    /** Optional correlation */
    requestId?: string | null;

    /** Schema version (default 1) */
    version?: number;
}

// ─── Computed Output ────────────────────────────────────────────────

/**
 * The result of building an audit entry: Prisma-ready data + computed hash.
 */
export interface AuditEntryOutput {
    /** Data ready for db.auditLog.create({ data: ... }) */
    data: {
        tenantId: string;
        userId: string | null;
        actorType: string;
        entity: string;
        entityId: string;
        action: string;
        details: null;           // legacy field — null for v1+ entries
        detailsJson: unknown;    // validated structured payload
        requestId: string | null;
        previousHash: string | null;
        entryHash: string;
        version: number;
    };
    /** The computed SHA-256 hash for this entry */
    entryHash: string;
}
