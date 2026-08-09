/**
 * Sync Orchestrator
 *
 * Abstract base class that orchestrates bidirectional sync between
 * inflect-compliance local entities and remote provider objects.
 *
 * Inspired by CISO-Assistant's BaseSyncOrchestrator pattern:
 *   - Push local changes to remote
 *   - Pull remote changes to local
 *   - Conflict detection via updated_at + data diffing
 *   - Resolution strategies: remote_wins, local_wins, manual
 *   - Webhook-triggered pull
 *   - Audit-friendly sync event logging
 *
 * ═══════════════════════════════════════════════════════════════════════
 * FLOW
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   Push (local → remote):
 *     1. getOrCreateMapping()
 *     2. checkForConflict()
 *     3. If conflict → resolveConflict()
 *     4. mapper.toRemotePartial() → client.updateRemoteObject()
 *     5. updateMapping(SYNCED, PUSH)
 *
 *   Pull (remote → local):
 *     1. getOrCreateMapping()
 *     2. checkForConflict()
 *     3. If conflict → resolveConflict()
 *     4. mapper.toLocal() → applyLocalChanges()
 *     5. updateMapping(SYNCED, PULL)
 *
 *   Webhook:
 *     1. extractRemoteId(payload) + extractRemoteData(payload)
 *     2. pull()
 *
 * @module integrations/sync-orchestrator
 */
import type { RequestContext } from '@/app-layer/types';
import type { BaseIntegrationClient } from './base-client';
import type { BaseFieldMapper } from './base-mapper';
import type {
    SyncMapping,
    SyncMappingKey,
    SyncMappingCreateData,
    SyncMappingStatusUpdate,
    PushInput,
    PullInput,
    SyncResult,
    SyncDirection,
    ConflictStrategy,
    ConflictDetails,
    ConflictCheckResult,
    WebhookPullInput,
    WebhookPullResult,
    SyncEvent,
} from './sync-types';
import { enqueue } from '../jobs/queue';

// ─── Sync Mapping Store ──────────────────────────────────────────────

/**
 * Interface for sync mapping persistence.
 * Production implementations use Prisma; tests use in-memory.
 *
 * Design: create vs update are intentionally separated.
 *   - `findOrCreate` sets identity + safe defaults only
 *   - `updateStatus` updates operational fields with a narrow typed input
 *   - Control-plane fields (e.g. `conflictStrategy`) cannot be
 *     accidentally overwritten through either path
 */
export interface SyncMappingStore {
    findByLocalEntity(
        tenantId: string,
        provider: string,
        localEntityType: string,
        localEntityId: string,
    ): Promise<SyncMapping | null>;

    findByRemoteEntity(
        tenantId: string,
        provider: string,
        remoteEntityType: string,
        remoteEntityId: string,
    ): Promise<SyncMapping | null>;

    /**
     * Find an existing mapping by key, or create one with safe defaults.
     *
     * On create: identity fields come from `key`, practice-plane fields
     * get safe defaults (conflictStrategy=REMOTE_WINS, version=1).
     * Only `syncStatus` and `errorMessage` can be set via `defaults`.
     *
     * On find: returns the existing mapping unchanged — `defaults`
     * are NOT applied to existing records.
     */
    findOrCreate(key: SyncMappingKey, defaults?: SyncMappingCreateData): Promise<SyncMapping>;

    /**
     * Update operational status of an existing mapping.
     *
     * The `extra` payload is narrowly typed to prevent accidental
     * overwrites of identity and practice-plane fields.
     */
    updateStatus(
        id: string,
        status: SyncMapping['syncStatus'],
        extra?: SyncMappingStatusUpdate,
    ): Promise<SyncMapping>;
}

// ─── Sync Event Logger ───────────────────────────────────────────────

/**
 * Interface for audit logging of sync events.
 * Implementations may write to DB, structured logs, or an event bus.
 */
export interface SyncEventLogger {
    log(event: SyncEvent): void;
}

/** Default no-op logger. */
export const noopSyncLogger: SyncEventLogger = {
    log: () => {},
};

// ─── Abstract Sync Orchestrator ──────────────────────────────────────

/**
 * Abstract base class for sync orchestration.
 *
 * Subclasses must provide:
 *   - resolveClient()      → the BaseIntegrationClient for this provider
 *   - resolveMapper()      → the BaseFieldMapper for this provider
 *   - applyLocalChanges()  → apply mapped remote data to the local entity
 *   - getLocalData()       → fetch current local entity data
 *   - extractRemoteId()    → extract remote ID from webhook payload
 *   - extractRemoteData()  → extract remote data from webhook payload
 */
export abstract class BaseSyncOrchestrator {
    protected readonly store: SyncMappingStore;
    protected readonly logger: SyncEventLogger;
    protected readonly provider: string;

    constructor(opts: {
        provider: string;
        store: SyncMappingStore;
        logger?: SyncEventLogger;
    }) {
        this.provider = opts.provider;
        this.store = opts.store;
        this.logger = opts.logger ?? noopSyncLogger;
    }

    private _clientCache: BaseIntegrationClient | null = null;
    private _mapperCache: BaseFieldMapper | null = null;

    // ── Abstract Methods ──

    /** Implement this to resolve and return the integration client */
    protected abstract resolveClient(): BaseIntegrationClient;

    /** Implement this to resolve and return the field mapper */
    protected abstract resolveMapper(): BaseFieldMapper;

    /** 
     * Return the integration client for remote interaction.
     * Caches the resolved client per-operation to prevent redundant resolution.
     */
    protected getClient(): BaseIntegrationClient {
        if (!this._clientCache) {
            this._clientCache = this.resolveClient();
        }
        return this._clientCache;
    }

    /** 
     * Return the field mapper for this integration.
     * Caches the resolved mapper per-operation to prevent redundant instantiation.
     */
    protected getMapper(): BaseFieldMapper {
        if (!this._mapperCache) {
            this._mapperCache = this.resolveMapper();
        }
        return this._mapperCache;
    }

    /**
     * Apply mapped local data to the actual local entity.
     * Called during pull operations after mapping.
     *
     * @param ctx            - The request context
     * @param localEntityType - Entity type (e.g. 'task', 'practice')
     * @param localEntityId   - Entity ID
     * @param localData       - Mapped data to apply
     * @returns Updated fields for audit
     */
    protected abstract applyLocalChanges(
        ctx: RequestContext,
        localEntityType: string,
        localEntityId: string,
        localData: Record<string, unknown>,
    ): Promise<string[]>;

    /**
     * Get the current data for a local entity.
     * Used for conflict detection during push.
     */
    protected abstract getLocalData(
        ctx: RequestContext,
        localEntityType: string,
        localEntityId: string,
    ): Promise<Record<string, unknown> | null>;

    /**
     * Extract the remote entity ID from a webhook payload.
     * Returns null if the payload is unrecognized.
     */
    protected abstract extractRemoteId(
        payload: Record<string, unknown>,
    ): string | null;

    /**
     * Extract the remote entity data from a webhook payload.
     * Returns null if the payload doesn't contain entity data.
     */
    protected abstract extractRemoteData(
        payload: Record<string, unknown>,
    ): Record<string, unknown> | null;

    // ── Push (Local → Remote) ──

    /**
     * Push local changes to the remote system.
     */
    async push(input: PushInput): Promise<SyncResult> {
        const { mappingKey, localData, changedFields, localUpdatedAt } = input;

        try {
            // 1. Get or create mapping (preserve existing status)
            const existing = await this.store.findByLocalEntity(
                mappingKey.tenantId,
                mappingKey.provider,
                mappingKey.localEntityType,
                mappingKey.localEntityId,
            );
            const mapping = existing ?? await this.store.findOrCreate(mappingKey, {
                syncStatus: 'PENDING',
            });

            // 2. Check for conflict
            const conflict = await this.checkForConflict(mapping, localData, 'PUSH');
            if (conflict.hasConflict && conflict.details) {
                const resolution = this.resolveConflict(conflict.details);
                if (resolution === 'manual') {
                    const updatedMapping = await this.store.updateStatus(mapping.id, 'CONFLICT', {
                        errorMessage: conflict.details.reason,
                    });
                    this.logEvent(mapping.id, 'PUSH', 'conflict', changedFields, false);
                    return {
                        success: false,
                        action: 'conflict',
                        direction: 'PUSH',
                        mapping: updatedMapping,
                        conflict: conflict.details,
                    };
                }
                if (resolution === 'local_wins') {
                    // Continue with push — local data overwrites remote
                } else {
                    // remote_wins — skip push, pull instead
                    const updatedMapping = await this.store.updateStatus(mapping.id, 'SYNCED', {
                        lastSyncDirection: 'PULL',
                        lastSyncedAt: new Date(),
                    });
                    this.logEvent(mapping.id, 'PUSH', 'skipped', changedFields, true);
                    return {
                        success: true,
                        action: 'skipped',
                        direction: 'PUSH',
                        mapping: updatedMapping,
                    };
                }
            }

            // 3. Map local data to remote shape
            const mapper = this.getMapper();
            const remoteChanges = changedFields.length > 0
                ? mapper.toRemotePartial(localData, changedFields)
                : mapper.toRemote(localData);

            // 4. Push to remote
            const client = this.getClient();
            if (mapping.syncStatus === 'PENDING') {
                await client.createRemoteObject(remoteChanges);
            } else {
                await client.updateRemoteObject(mapping.remoteEntityId, remoteChanges);
            }

            // 5. Update mapping
            const action = mapping.syncStatus === 'PENDING' ? 'created' as const : 'updated' as const;
            const updatedMapping = await this.store.updateStatus(mapping.id, 'SYNCED', {
                lastSyncDirection: 'PUSH',
                localUpdatedAt,
                lastSyncedAt: new Date(),
                version: mapping.version + 1,
                errorMessage: null,
            });

            this.logEvent(mapping.id, 'PUSH', action, changedFields, true);

            return {
                success: true,
                action,
                direction: 'PUSH',
                mapping: updatedMapping,
            };
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            // Try to update mapping status
            const mapping = await this.store.findByLocalEntity(
                mappingKey.tenantId,
                mappingKey.provider,
                mappingKey.localEntityType,
                mappingKey.localEntityId,
            );
            const failedMapping = mapping
                ? await this.store.updateStatus(mapping.id, 'FAILED', { errorMessage })
                : await this.store.findOrCreate(mappingKey, { syncStatus: 'FAILED', errorMessage });

            this.logEvent(failedMapping.id, 'PUSH', 'error', input.changedFields, false, errorMessage);

            return {
                success: false,
                action: 'error',
                direction: 'PUSH',
                mapping: failedMapping,
                errorMessage,
            };
        }
    }

    // ── Pull (Remote → Local) ──

    /**
     * Pull remote changes into the local system.
     */
    async pull(input: PullInput): Promise<SyncResult> {
        const { ctx, mappingKey, remoteData, remoteUpdatedAt } = input;

        try {
            // 1. Get or create mapping (preserve existing status)
            const existing = await this.store.findByLocalEntity(
                mappingKey.tenantId,
                mappingKey.provider,
                mappingKey.localEntityType,
                mappingKey.localEntityId,
            );
            const mapping = existing ?? await this.store.findOrCreate(mappingKey, {
                syncStatus: 'PENDING',
            });

            // 2. Get current local data for conflict check
            const localData = await this.getLocalData(
                ctx,
                mappingKey.localEntityType,
                mappingKey.localEntityId,
            );

            // 3. Check for conflict
            if (localData) {
                const conflict = await this.checkForConflict(mapping, localData, 'PULL', remoteData);
                if (conflict.hasConflict && conflict.details) {
                    const resolution = this.resolveConflict(conflict.details);
                    if (resolution === 'manual') {
                        const updatedMapping = await this.store.updateStatus(mapping.id, 'CONFLICT', {
                            errorMessage: conflict.details.reason,
                            remoteDataJson: remoteData,
                        });
                        this.logEvent(mapping.id, 'PULL', 'conflict', [], false);
                        return {
                            success: false,
                            action: 'conflict',
                            direction: 'PULL',
                            mapping: updatedMapping,
                            conflict: conflict.details,
                        };
                    }
                    if (resolution === 'local_wins') {
                        // Skip pull — local data wins
                        const updatedMapping = await this.store.updateStatus(mapping.id, 'SYNCED', {
                            lastSyncDirection: 'PUSH',
                            lastSyncedAt: new Date(),
                        });
                        this.logEvent(mapping.id, 'PULL', 'skipped', [], true);
                        return {
                            success: true,
                            action: 'skipped',
                            direction: 'PULL',
                            mapping: updatedMapping,
                        };
                    }
                    // remote_wins — continue with pull
                }
            }

            // 4. Map remote data to local shape
            const mapper = this.getMapper();
            const mappedLocalData = mapper.toLocal(remoteData);

            // 5. Apply to local entity
            const appliedFields = await this.applyLocalChanges(
                ctx,
                mappingKey.localEntityType,
                mappingKey.localEntityId,
                mappedLocalData,
            );

            // 6. Update mapping
            const action = mapping.syncStatus === 'PENDING' ? 'created' as const : 'updated' as const;
            const updatedMapping = await this.store.updateStatus(mapping.id, 'SYNCED', {
                lastSyncDirection: 'PULL',
                remoteUpdatedAt,
                remoteDataJson: remoteData,
                lastSyncedAt: new Date(),
                version: mapping.version + 1,
                errorMessage: null,
            });

            this.logEvent(mapping.id, 'PULL', action, appliedFields, true);

            return {
                success: true,
                action,
                direction: 'PULL',
                mapping: updatedMapping,
            };
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            // Try local-entity lookup first (matches the mapping created at the top of the
            // try block). This is the correct path when applyLocalChanges or mapper.toLocal
            // throws — the mapping is always findable by local key at that point.
            // Fall back to remote-entity lookup for webhook-triggered code paths where
            // only the remote ID is known (e.g. handleWebhookEvent → pull).
            const mappingByLocal = await this.store.findByLocalEntity(
                mappingKey.tenantId,
                mappingKey.provider,
                mappingKey.localEntityType,
                mappingKey.localEntityId,
            );
            const mappingByRemote = mappingByLocal ? null : await this.store.findByRemoteEntity(
                mappingKey.tenantId,
                mappingKey.provider,
                mappingKey.remoteEntityType,
                mappingKey.remoteEntityId,
            );
            const existingMapping = mappingByLocal ?? mappingByRemote;
            const failedMapping = existingMapping
                ? await this.store.updateStatus(existingMapping.id, 'FAILED', { errorMessage })
                : await this.store.findOrCreate(mappingKey, { syncStatus: 'FAILED', errorMessage });

            this.logEvent(failedMapping.id, 'PULL', 'error', [], false, errorMessage);

            return {
                success: false,
                action: 'error',
                direction: 'PULL',
                mapping: failedMapping,
                errorMessage,
            };
        }
    }

    // ── Webhook-Triggered Pull ──

    /**
     * Process an incoming webhook event and trigger pull sync.
     * This is the provider-facing hook that turns webhook payloads
     * into structured sync operations.
     */
    async handleWebhookEvent(input: WebhookPullInput): Promise<WebhookPullResult> {
        const { ctx, provider, eventType, payload, connectionId } = input;
        const tenantId = ctx.tenantId;

        // 1. Extract remote identity from payload
        const remoteId = this.extractRemoteId(payload);
        if (!remoteId) {
            return {
                processed: false,
                syncCount: 0,
                results: [],
                reason: `Could not extract remote ID from ${eventType} payload`,
            };
        }

        // 2. Handle deletion events
        if (eventType === 'deleted') {
            const mapping = await this.store.findByRemoteEntity(
                tenantId, provider, this.getRemoteEntityType(), remoteId,
            );
            if (mapping) {
                await this.store.updateStatus(mapping.id, 'STALE', {
                    errorMessage: 'Remote object was deleted',
                });
                this.logEvent(mapping.id, 'PULL', 'updated', [], true, undefined, 'webhook');
            }
            return {
                processed: true,
                syncCount: mapping ? 1 : 0,
                results: [],
                reason: mapping ? undefined : 'No mapping found for deleted remote object',
            };
        }

        // 3. Extract remote data for create/update
        const remoteData = this.extractRemoteData(payload);
        if (!remoteData) {
            return {
                processed: false,
                syncCount: 0,
                results: [],
                reason: `Could not extract remote data from ${eventType} payload`,
            };
        }

        // 4. Find existing mapping by remote entity
        const existingMapping = await this.store.findByRemoteEntity(
            tenantId, provider, this.getRemoteEntityType(), remoteId,
        );

        if (!existingMapping) {
            return {
                processed: false,
                syncCount: 0,
                results: [],
                reason: `No mapping found for remote ${this.getRemoteEntityType()}:${remoteId}`,
            };
        }

        // 5. Defer pull to background job
        const jobId = `sync-pull:${tenantId}:${provider}:${existingMapping.remoteEntityType}:${existingMapping.remoteEntityId}`;

        await enqueue(
            'sync-pull',
            {
                ctx: {
                    tenantId: ctx.tenantId,
                    userId: ctx.userId,
                    requestId: ctx.requestId,
                    role: ctx.role,
                    permissions: ctx.permissions,
                },
                mappingKey: {
                    tenantId,
                    provider,
                    connectionId: connectionId ?? existingMapping.connectionId ?? undefined,
                    localEntityType: existingMapping.localEntityType,
                    localEntityId: existingMapping.localEntityId,
                    remoteEntityType: existingMapping.remoteEntityType,
                    remoteEntityId: existingMapping.remoteEntityId,
                },
                remoteData,
                remoteUpdatedAtIso: new Date().toISOString(),
            },
            { jobId }
        );

        return {
            processed: true,
            syncCount: 1, // Indicates 1 sync operation was queued
            results: [],  // Empty because it evaluates asynchronously
        };
    }

    // ── Conflict Detection ──

    /**
     * Check whether a conflict exists between local and remote state.
     *
     * A conflict is detected when:
     *   1. The mapping has been synced before (not PENDING)
     *   2. The local entity was modified since last sync (localUpdatedAt > lastSyncedAt)
     *   3. The remote data differs from the cached remote data
     *
     * This is a conservative approach — any divergence is flagged.
     */
    async checkForConflict(
        mapping: SyncMapping,
        localData: Record<string, unknown>,
        direction: SyncDirection,
        incomingRemoteData?: Record<string, unknown>,
    ): Promise<ConflictCheckResult> {
        // No conflict possible on first sync
        if (mapping.syncStatus === 'PENDING' || !mapping.lastSyncedAt) {
            return { hasConflict: false };
        }

        const mapper = this.getMapper();
        const mappedLocalFields = mapper.getMappedLocalFields();

        // Check 1: Has local been modified since last sync?
        const localModifiedSinceSync = mapping.localUpdatedAt
            && mapping.lastSyncedAt
            && mapping.localUpdatedAt > mapping.lastSyncedAt;

        // Check 2: Has remote changed since last sync?
        let remoteChanged = false;
        if (incomingRemoteData && mapping.remoteDataJson) {
            const lastRemote = mapping.remoteDataJson as Record<string, unknown>;
            remoteChanged = !shallowEqual(incomingRemoteData, lastRemote);
        }

        // Conflict exists if BOTH sides changed since last sync
        if (direction === 'PULL' && localModifiedSinceSync && remoteChanged) {
            const conflictingFields = findConflictingFields(
                localData,
                incomingRemoteData ?? {},
                mapper,
                mappedLocalFields,
            );

            return {
                hasConflict: conflictingFields.length > 0,
                details: conflictingFields.length > 0 ? {
                    reason: 'Both local and remote were modified since last sync',
                    strategy: mapping.conflictStrategy,
                    localData,
                    remoteData: incomingRemoteData ?? {},
                    lastSyncedRemoteData: (mapping.remoteDataJson as Record<string, unknown>) ?? null,
                    conflictingFields,
                } : undefined,
            };
        }

        // For PUSH: check if remote was modified under us
        if (direction === 'PUSH' && mapping.lastSyncDirection === 'PULL') {
            // Remote was last pulled; local is now pushing — no conflict
            return { hasConflict: false };
        }

        return { hasConflict: false };
    }

    /**
     * Resolve a conflict using the configured strategy.
     *
     * @returns Which side wins: 'remote_wins', 'local_wins', or 'manual'
     */
    resolveConflict(conflict: ConflictDetails): Lowercase<ConflictStrategy> {
        switch (conflict.strategy) {
            case 'REMOTE_WINS': return 'remote_wins';
            case 'LOCAL_WINS': return 'local_wins';
            case 'MANUAL': return 'manual';
            default: return 'remote_wins';
        }
    }

    // ── Overridable Hooks ──

    /**
     * Get the default remote entity type for this orchestrator.
     * Override if needed. Used by handleWebhookEvent to look up mappings.
     */
    protected getRemoteEntityType(): string {
        return 'default';
    }

    // ── Internal Helpers ──

    private logEvent(
        mappingId: string,
        direction: SyncDirection,
        action: SyncResult['action'],
        changedFields: string[],
        success: boolean,
        errorDetails?: string,
        triggeredBy: 'user' | 'webhook' | 'scheduled' = 'user',
    ): void {
        this.logger.log({
            mappingId,
            direction,
            action,
            changedFields,
            triggeredBy,
            success,
            errorDetails,
            timestamp: new Date(),
        });
    }
}

// ─── Utility Functions ───────────────────────────────────────────────

/**
 * Canonical JSON serialiser — sorts object keys recursively before
 * stringifying so that { a:1, b:2 } and { b:2, a:1 } produce the
 * same string. This is the only safe approach when comparing payloads
 * returned by remote APIs, whose key ordering is not guaranteed.
 */
function canonicalJSON(val: unknown): string {
    if (val === null || typeof val !== 'object') return JSON.stringify(val);
    if (Array.isArray(val)) return `[${val.map(canonicalJSON).join(',')}]`;
    const sorted = Object.keys(val as Record<string, unknown>).sort();
    const pairs = sorted.map(k => `${JSON.stringify(k)}:${canonicalJSON((val as Record<string, unknown>)[k])}`);
    return `{${pairs.join(',')}}`;
}

/**
 * Deep equality check for two objects.
 *
 * Uses a canonical (sorted-key) JSON representation so that objects
 * with identical content but differently-ordered keys are correctly
 * considered equal. This matters for remote API payloads (e.g. GitHub)
 * whose key order is not guaranteed across API versions or endpoints.
 *
 * Previously used raw JSON.stringify, which is NOT key-order-stable
 * and produced false-positive conflicts for semantically equal objects.
 */
export function shallowEqual(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
): boolean {
    // Fast path: reference equality
    if (a === b) return true;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => {
        const va = a[key];
        const vb = b[key];
        if (va === vb) return true;
        // Deep compare for nested objects/arrays using canonical serialisation
        if (typeof va === 'object' && typeof vb === 'object' && va !== null && vb !== null) {
            return canonicalJSON(va) === canonicalJSON(vb);
        }
        return false;
    });
}

/**
 * Find fields that conflict between local data and incoming remote data.
 * Maps remote data to local shape once, then compares each mapped field.
 *
 * Uses canonical JSON comparison (key-order-stable) for nested values.
 */
export function findConflictingFields(
    localData: Record<string, unknown>,
    remoteData: Record<string, unknown>,
    mapper: BaseFieldMapper,
    mappedLocalFields: string[],
): string[] {
    const mappedRemoteData = mapper.toLocal(remoteData);
    const conflicting: string[] = [];

    for (const localField of mappedLocalFields) {
        const localValue = localData[localField];
        const remoteValue = mappedRemoteData[localField];

        if (localValue !== undefined && remoteValue !== undefined) {
            // Deep compare using canonical serialisation (key-order-stable)
            const equal = typeof localValue === 'object' && typeof remoteValue === 'object'
                && localValue !== null && remoteValue !== null
                ? canonicalJSON(localValue) === canonicalJSON(remoteValue)
                : localValue === remoteValue;
            if (!equal) {
                conflicting.push(localField);
            }
        }
    }

    return conflicting;
}
