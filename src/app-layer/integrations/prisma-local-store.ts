/**
 * Prisma-Backed Local Entity Store
 *
 * Production implementation of the `GitHubLocalStore` (and future provider
 * local-store interfaces) that reads/writes local entities via Prisma.
 *
 * Used by sync orchestrators to apply remote changes to local entities
 * and to fetch local data for conflict detection and push operations.
 *
 * All operations run through `withTenantDb` for RLS enforcement.
 *
 * @module integrations/prisma-local-store
 */
import type { GitHubLocalStore } from './providers/github/sync';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';
import { logger } from '@/lib/observability/logger';

// ─── Implementation ──────────────────────────────────────────────────

/**
 * Production local entity store backed by Prisma.
 *
 * Currently supports 'practice' entities (the primary sync target for
 * branch protection rules). Extend the switch in applyChanges/getData
 * as additional entity types are synced.
 */
export class PrismaLocalStore implements GitHubLocalStore {
    /**
     * Apply mapped remote data to a local entity.
     * Returns the list of field names that were updated.
     */
    async applyChanges(
        ctx: RequestContext,
        entityType: string,
        entityId: string,
        data: Record<string, unknown>,
    ): Promise<string[]> {
        return runInTenantContext(ctx, async (db: PrismaTx) => {
            const updatableFields = buildUpdatePayload(entityType, data);
            if (Object.keys(updatableFields).length === 0) {
                logger.debug('No updatable fields for local entity', {
                    component: 'integrations',
                    entityType,
                    entityId,
                });
                return [];
            }

            switch (entityType) {
                case 'practice': {

                    await db.practice.update({
                        where: { id: entityId },
                        data: updatableFields,
                    });
                    break;
                }
                default:
                    logger.warn('Unsupported entity type for local store', {
                        component: 'integrations',
                        entityType,
                        entityId,
                    });
                    return [];
            }

            logger.debug('Local entity updated from sync', {
                component: 'integrations',
                entityType,
                entityId,
                fields: Object.keys(updatableFields),
            });

            return Object.keys(updatableFields);
        });
    }

    /**
     * Get current local entity data for conflict detection.
     * Returns null if the entity doesn't exist.
     */
    async getData(
        ctx: RequestContext,
        entityType: string,
        entityId: string,
    ): Promise<Record<string, unknown> | null> {
        return runInTenantContext(ctx, async (db: PrismaTx) => {
            switch (entityType) {
                case 'practice': {

                    const practice = await db.practice.findUnique({
                        where: { id: entityId },
                        select: {
                            id: true,
                            name: true,
                            status: true,
                            description: true,
                            automationKey: true,
                            updatedAt: true,
                        },
                    });
                    if (!practice) return null;
                    return practice as Record<string, unknown>;
                }
                default:
                    return null;
            }
        });
    }
}

// ─── Field Mapping Helpers ───────────────────────────────────────────

/**
 * Maps sync-layer field names to Prisma-safe update fields.
 * Filters out fields that don't correspond to writable DB columns.
 * This prevents arbitrary data from being written to the database.
 */
function buildUpdatePayload(
    entityType: string,
    data: Record<string, unknown>,
): Record<string, unknown> {
    switch (entityType) {
        case 'practice': {
            // Allowlist of fields that can be updated from sync
            const ALLOWED_CONTROL_FIELDS: Record<string, string> = {
                // sync field → Prisma column
                'status': 'status',
                'protectionEnabled': 'automationResultJson',
                'requiredReviewCount': 'automationResultJson',
                'dismissStaleReviews': 'automationResultJson',
                'requireCodeOwnerReviews': 'automationResultJson',
                'enforceAdmins': 'automationResultJson',
            };

            const payload: Record<string, unknown> = {};
            const automationResult: Record<string, unknown> = {};

            for (const [field, value] of Object.entries(data)) {
                if (value === undefined) continue;
                const target = ALLOWED_CONTROL_FIELDS[field];
                if (!target) continue;

                if (target === 'automationResultJson') {
                    automationResult[field] = value;
                } else {
                    // Map sync status values to Prisma PracticeStatus enum
                    if (field === 'status' && typeof value === 'string') {
                        payload[target] = mapPracticeStatus(value);
                    } else {
                        payload[target] = value;
                    }
                }
            }

            // If we have automation result fields, store as JSON
            if (Object.keys(automationResult).length > 0) {
                payload['automationResultJson'] = automationResult;
            }

            return payload;
        }
        default:
            return {};
    }
}

/**
 * Map sync-layer status strings to Prisma PracticeStatus enum values.
 */
function mapPracticeStatus(syncStatus: string): string {
    const STATUS_MAP: Record<string, string> = {
        'IMPLEMENTED': 'IMPLEMENTED',
        'NOT_STARTED': 'NOT_STARTED',
        'IN_PROGRESS': 'IN_PROGRESS',
        'PLANNED': 'PLANNED',
        'NEEDS_REVIEW': 'NEEDS_REVIEW',
    };
    return STATUS_MAP[syncStatus] ?? 'NEEDS_REVIEW';
}
