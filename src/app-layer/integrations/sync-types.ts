/**
 * Sync Orchestration — Types
 *
 * Type definitions for the sync orchestration layer.
 * All types are serialization-safe and provider-agnostic.
 *
 * @module integrations/sync-types
 */

// ─── Sync Status / Direction / Strategy (mirrors Prisma enums) ───────

import type { RequestContext } from '@/app-layer/types';

export type SyncStatus = 'PENDING' | 'SYNCED' | 'CONFLICT' | 'FAILED' | 'STALE';
export type SyncDirection = 'PUSH' | 'PULL';
export type ConflictStrategy = 'REMOTE_WINS' | 'LOCAL_WINS' | 'MANUAL';

// ─── Sync Mapping ────────────────────────────────────────────────────

/**
 * An app-layer representation of a sync mapping between a local
 * entity and its remote counterpart.
 */
export interface SyncMapping {
    id: string;
    tenantId: string;
    provider: string;
    connectionId: string | null;
    localEntityType: string;
    localEntityId: string;
    remoteEntityType: string;
    remoteEntityId: string;
    syncStatus: SyncStatus;
    lastSyncDirection: SyncDirection | null;
    conflictStrategy: ConflictStrategy;
    localUpdatedAt: Date | null;
    remoteUpdatedAt: Date | null;
    remoteDataJson: unknown;
    version: number;
    errorMessage: string | null;
    lastSyncedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Input to create or find a sync mapping.
 */
export interface SyncMappingKey {
    tenantId: string;
    provider: string;
    connectionId?: string;
    localEntityType: string;
    localEntityId: string;
    remoteEntityType: string;
    remoteEntityId: string;
}

/**
 * Narrowed data allowed when CREATING a new sync mapping.
 *
 * Only operational initial-state fields are permitted.
 * Identity fields come from SyncMappingKey.
 * Control-plane fields (conflictStrategy, version) get safe defaults.
 */
export interface SyncMappingCreateData {
    /** Initial sync status (defaults to 'PENDING' in store implementations) */
    syncStatus?: SyncStatus;
    /** Initial error message (e.g. if creation itself is a failure record) */
    errorMessage?: string | null;
}

/**
 * Narrowed data allowed when UPDATING a sync mapping's status.
 *
 * Explicitly excludes:
 *   - Identity fields (tenantId, provider, localEntityType, etc.)
 *   - conflictStrategy (configuration-level, set only by explicit admin action)
 *   - id, createdAt, updatedAt (system-managed)
 *
 * The `tenantId` field is included ONLY as an RLS routing hint for
 * the Prisma store — it is NOT persisted as a data update.
 */
export interface SyncMappingStatusUpdate {
    /** RLS routing hint for Prisma store — not persisted as data */
    tenantId?: string;
    /** Which direction the sync just completed */
    lastSyncDirection?: SyncDirection | null;
    /** When the local entity was last modified */
    localUpdatedAt?: Date | null;
    /** When the remote entity was last modified */
    remoteUpdatedAt?: Date | null;
    /** Cached remote data snapshot (for conflict detection) */
    remoteDataJson?: unknown;
    /** When the last sync completed */
    lastSyncedAt?: Date | null;
    /** Optimistic concurrency version */
    version?: number;
    /** Error message (null to clear) */
    errorMessage?: string | null;
}

// ─── Push / Pull ─────────────────────────────────────────────────────

/**
 * Input for a push operation (local → remote).
 */
export interface PushInput {
    /** The execution context for tenant isolation */
    ctx: RequestContext;
    /** Sync mapping key to find/create the mapping */
    mappingKey: SyncMappingKey;
    /** The local object data (already in local shape) */
    localData: Record<string, unknown>;
    /** Which local fields changed (for partial push) */
    changedFields: string[];
    /** When the local object was last updated */
    localUpdatedAt: Date;
}

/**
 * Input for a pull operation (remote → local).
 */
export interface PullInput {
    /** The execution context for tenant isolation */
    ctx: RequestContext;
    /** Sync mapping key to find/create the mapping */
    mappingKey: SyncMappingKey;
    /** The current remote object data (in remote shape) */
    remoteData: Record<string, unknown>;
    /** When the remote object was last updated */
    remoteUpdatedAt: Date;
}

/**
 * Result of a sync operation (push or pull).
 */
export interface SyncResult {
    /** Whether the operation succeeded */
    success: boolean;
    /** What happened */
    action: 'created' | 'updated' | 'skipped' | 'conflict' | 'error';
    /** The sync direction */
    direction: SyncDirection;
    /** Updated sync mapping */
    mapping: SyncMapping;
    /** If action is 'error', the error message */
    errorMessage?: string;
    /** If action is 'conflict', the conflict details */
    conflict?: ConflictDetails;
}

// ─── Conflict Detection ──────────────────────────────────────────────

/**
 * Details about a detected conflict.
 */
export interface ConflictDetails {
    /** Why a conflict was detected */
    reason: string;
    /** The strategy that will be used / was used */
    strategy: ConflictStrategy;
    /** Local state at the time of conflict */
    localData: Record<string, unknown>;
    /** Remote state at the time of conflict */
    remoteData: Record<string, unknown>;
    /** Last known synced remote data (for diffing) */
    lastSyncedRemoteData: Record<string, unknown> | null;
    /** The fields that differ between local and remote */
    conflictingFields: string[];
}

/**
 * Result of conflict detection.
 */
export interface ConflictCheckResult {
    /** Whether a conflict exists */
    hasConflict: boolean;
    /** Conflict details if detected */
    details?: ConflictDetails;
}

// ─── Webhook Pull ────────────────────────────────────────────────────

/**
 * Input for webhook-triggered pull.
 */
export interface WebhookPullInput {
    /** The execution context for tenant isolation */
    ctx: RequestContext;
    /** Provider key (e.g. 'jira', 'github') */
    provider: string;
    /** Webhook event type (e.g. 'issue_updated', 'created') */
    eventType: string;
    /** Raw webhook payload */
    payload: Record<string, unknown>;
    /** Connection ID (if resolvable) */
    connectionId?: string;
}

/**
 * Result of processing a webhook-triggered pull.
 */
export interface WebhookPullResult {
    /** Whether the webhook was processed */
    processed: boolean;
    /** How many sync operations were triggered */
    syncCount: number;
    /** Individual sync results */
    results: SyncResult[];
    /** If not processed, the reason */
    reason?: string;
}

// ─── Sync Event (audit log entry) ────────────────────────────────────

/**
 * Audit-friendly record of a sync event.
 */
export interface SyncEvent {
    mappingId: string;
    direction: SyncDirection;
    action: SyncResult['action'];
    changedFields: string[];
    triggeredBy: 'user' | 'webhook' | 'scheduled';
    success: boolean;
    errorDetails?: string;
    timestamp: Date;
}
