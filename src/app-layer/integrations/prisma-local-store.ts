/**
 * Prisma-Backed Local Entity Store
 *
 * Production implementation of the `GitHubLocalStore` (and future provider
 * local-store interfaces) that reads/writes local entities via Prisma.
 *
 * The GRC teardown removed `Practice`, which was the ONLY local entity this
 * store ever synced, so nothing is writable through it today — every call
 * falls through to the unsupported branch and is logged. The class stays
 * because `GitHubSyncOrchestrator` requires a local store at construction
 * (`sync-pull` and the webhook processor both build one); the first agri sync
 * target plugs into `applyChanges` / `getData` here.
 *
 * @module integrations/prisma-local-store
 */
import type { GitHubLocalStore } from './providers/github/sync';
import type { RequestContext } from '@/app-layer/types';
import { logger } from '@/lib/observability/logger';

// ─── Implementation ──────────────────────────────────────────────────

/**
 * Production local entity store backed by Prisma.
 *
 * Supports no entity types since the practice teardown — reinstate a
 * `switch (entityType)` in both methods (plus the field allowlist that
 * guarded which columns a remote sync may write) when an agri entity
 * becomes a sync target.
 */
export class PrismaLocalStore implements GitHubLocalStore {
    /**
     * Apply mapped remote data to a local entity.
     * Returns the list of field names that were updated.
     */
    async applyChanges(
        _ctx: RequestContext,
        entityType: string,
        entityId: string,
        _data: Record<string, unknown>,
    ): Promise<string[]> {
        logger.warn('Unsupported entity type for local store', {
            component: 'integrations',
            entityType,
            entityId,
        });
        return [];
    }

    /**
     * Get current local entity data for conflict detection.
     * Returns null — no entity type has a local representation today.
     */
    async getData(
        _ctx: RequestContext,
        _entityType: string,
        _entityId: string,
    ): Promise<Record<string, unknown> | null> {
        return null;
    }
}
