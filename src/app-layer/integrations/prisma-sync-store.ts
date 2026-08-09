/**
 * Prisma-Backed Sync Mapping Store
 *
 * Production implementation of `SyncMappingStore` using the
 * `IntegrationSyncMapping` Prisma model.
 *
 * All operations run through `withTenantDb` to enforce RLS,
 * ensuring strict tenant isolation for sync mapping data.
 *
 * @module integrations/prisma-sync-store
 */
import type { SyncMappingStore } from './sync-orchestrator';
import type { SyncMapping, SyncMappingKey, SyncMappingCreateData, SyncMappingStatusUpdate } from './sync-types';
import { withTenantDb, type PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';

// ─── Type Helpers ────────────────────────────────────────────────────

/**
 * Convert Prisma model result to app-layer SyncMapping.
 * Prisma returns string enums; our app-layer uses the same literals.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSyncMapping(row: any): SyncMapping {
    return {
        id: row.id,
        tenantId: row.tenantId,
        provider: row.provider,
        connectionId: row.connectionId,
        localEntityType: row.localEntityType,
        localEntityId: row.localEntityId,
        remoteEntityType: row.remoteEntityType,
        remoteEntityId: row.remoteEntityId,
        syncStatus: row.syncStatus,
        lastSyncDirection: row.lastSyncDirection,
        conflictStrategy: row.conflictStrategy,
        localUpdatedAt: row.localUpdatedAt,
        remoteUpdatedAt: row.remoteUpdatedAt,
        remoteDataJson: row.remoteDataJson,
        version: row.version,
        errorMessage: row.errorMessage,
        lastSyncedAt: row.lastSyncedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

// ─── Implementation ──────────────────────────────────────────────────

export class PrismaSyncMappingStore implements SyncMappingStore {
    /**
     * Find a sync mapping by its local entity identity.
     */
    async findByLocalEntity(
        tenantId: string,
        provider: string,
        localEntityType: string,
        localEntityId: string,
    ): Promise<SyncMapping | null> {
        return withTenantDb(tenantId, async (db: PrismaTx) => {

            const row = await db.integrationSyncMapping.findUnique({
                where: {
                    tenantId_provider_localEntityType_localEntityId: {
                        tenantId,
                        provider,
                        localEntityType,
                        localEntityId,
                    },
                },
            });
            return row ? toSyncMapping(row) : null;
        });
    }

    /**
     * Find a sync mapping by its remote entity identity.
     */
    async findByRemoteEntity(
        tenantId: string,
        provider: string,
        remoteEntityType: string,
        remoteEntityId: string,
    ): Promise<SyncMapping | null> {
        return withTenantDb(tenantId, async (db: PrismaTx) => {

            const row = await db.integrationSyncMapping.findUnique({
                where: {
                    tenantId_provider_remoteEntityType_remoteEntityId: {
                        tenantId,
                        provider,
                        remoteEntityType,
                        remoteEntityId,
                    },
                },
            });
            return row ? toSyncMapping(row) : null;
        });
    }

    /**
     * Find an existing sync mapping by its composite key, or create
     * one with safe defaults. Only `syncStatus` and `errorMessage`
     * can be set via `defaults` — identity fields come from `key`,
     * and control-plane fields get safe defaults.
     *
     * On find: returns the existing mapping unchanged.
     */
    async findOrCreate(key: SyncMappingKey, defaults?: SyncMappingCreateData): Promise<SyncMapping> {
        return withTenantDb(key.tenantId, async (db: PrismaTx) => {
            // Build narrowed create payload from safe defaults only
            const createPayload: Record<string, unknown> = {};
            if (defaults?.syncStatus !== undefined) createPayload.syncStatus = defaults.syncStatus;
            if (defaults?.errorMessage !== undefined) createPayload.errorMessage = defaults.errorMessage;


            const row = await db.integrationSyncMapping.upsert({
                where: {
                    tenantId_provider_localEntityType_localEntityId: {
                        tenantId: key.tenantId,
                        provider: key.provider,
                        localEntityType: key.localEntityType,
                        localEntityId: key.localEntityId,
                    },
                },
                create: {
                    tenantId: key.tenantId,
                    provider: key.provider,
                    connectionId: key.connectionId ?? null,
                    localEntityType: key.localEntityType,
                    localEntityId: key.localEntityId,
                    remoteEntityType: key.remoteEntityType,
                    remoteEntityId: key.remoteEntityId,
                    // Safe defaults for control-plane fields
                    // conflictStrategy defaults to REMOTE_WINS in Prisma schema
                    // version defaults to 1 in Prisma schema
                    ...createPayload,
                },
                // On find: return existing record unchanged
                update: {},
            });

            logger.debug('Sync mapping findOrCreate', {
                component: 'integrations',
                mappingId: row.id,
                provider: key.provider,
                status: row.syncStatus,
            });

            return toSyncMapping(row);
        });
    }

    /**
     * Update the status of an existing mapping by ID.
     * Uses narrowly-typed SyncMappingStatusUpdate to prevent
     * accidental overwrites of identity or control-plane fields.
     */
    async updateStatus(
        id: string,
        status: SyncMapping['syncStatus'],
        extra?: SyncMappingStatusUpdate,
    ): Promise<SyncMapping> {
        // Build update payload from narrow typed input only
        const payload: Record<string, unknown> = { syncStatus: status };
        if (extra?.lastSyncDirection !== undefined) payload.lastSyncDirection = extra.lastSyncDirection;
        if (extra?.localUpdatedAt !== undefined) payload.localUpdatedAt = extra.localUpdatedAt;
        if (extra?.remoteUpdatedAt !== undefined) payload.remoteUpdatedAt = extra.remoteUpdatedAt;
        if (extra?.remoteDataJson !== undefined) payload.remoteDataJson = extra.remoteDataJson;
        if (extra?.version !== undefined) payload.version = extra.version;
        if (extra?.errorMessage !== undefined) payload.errorMessage = extra.errorMessage;
        if (extra?.lastSyncedAt !== undefined) payload.lastSyncedAt = extra.lastSyncedAt;
        // NOTE: conflictStrategy is intentionally excluded — it cannot
        // be changed through status updates, only through explicit admin action.

        const tenantId = extra?.tenantId;

        if (tenantId) {
            return withTenantDb(tenantId, async (db: PrismaTx) => {

                const row = await db.integrationSyncMapping.update({
                    where: { id },
                    data: payload,
                });
                return toSyncMapping(row);
            });
        }

        // Fallback: import prisma directly for ID-based update
        // This is safe because the mapping was already found within a tenant context
        const { prisma } = await import('@/lib/prisma');

        const row = await prisma.integrationSyncMapping.update({
            where: { id },
            data: payload,
        });
        return toSyncMapping(row);
    }
}
