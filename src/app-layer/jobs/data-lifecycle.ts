/**
 * Data Lifecycle Jobs — Purge & Retention Enforcement
 *
 * Provides:
 *   1. purgeSoftDeletedOlderThan  — bulk purge soft-deleted records across all models
 *   2. purgeExpiredEvidenceOlderThan — hard-delete archived evidence past grace period
 *   3. runRetentionSweep — cross-model sweep that marks expired records
 *
 * All operations are:
 *   - Tenant-scoped (never cross-tenant in one pass)
 *   - Auditable (emit audit events)
 *   - Idempotent (safe to re-run)
 *   - Conservative defaults (90-day soft-delete grace, 365-day evidence purge)
 *
 * Usage:
 *   import { purgeSoftDeletedOlderThan, purgeExpiredEvidenceOlderThan, runRetentionSweep }
 *       from '@/app-layer/jobs/data-lifecycle';
 */
import { Prisma } from '@prisma/client';
import { purgeEvidenceBytes } from '@/app-layer/usecases/evidence-bytes';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { SOFT_DELETE_MODELS, withDeleted } from '@/lib/soft-delete';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';

/** Minimal delegate interface for dynamic model access by string key */
interface ModelDelegate {
    findMany(args: object): Promise<Array<{ id: string; tenantId: string }>>;
    update(args: object): Promise<unknown>;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Default: soft-deleted records older than 90 days are eligible for purge */
export const DEFAULT_SOFT_DELETE_GRACE_DAYS = 90;

/** Default: archived evidence older than 365 days is eligible for hard purge */
export const DEFAULT_EVIDENCE_PURGE_DAYS = 365;

/** Models that support retentionUntil-based sweep.
 * Asset dropped its `retentionUntil` column in the agricultural-assets
 * rework (data-retention is an information-asset concept, not a machine
 * one), so it is no longer swept. */
const RETENTION_MODELS = [
    'Risk', 'Practice', 'Evidence', 'Policy',
    'Vendor', 'FileRecord', 'Task',
    // Grain marketing contracts hold commercial terms (encrypted) and a
    // counterparty name, so they are exactly the kind of row a retention
    // policy exists for. The column was already there; nothing swept it.
    'Contract',
] as const;

// ─── Types ──────────────────────────────────────────────────────────

export interface PurgeOptions {
    tenantId?: string;
    dryRun?: boolean;
    now?: Date;
    db?: typeof defaultPrisma; // injectable PrismaClient for testing
}

export interface PurgeSoftDeletedOptions extends PurgeOptions {
    /** Records soft-deleted more than this many days ago are eligible. Default: 90 */
    graceDays?: number;
}

export interface PurgeExpiredEvidenceOptions extends PurgeOptions {
    /** Archived evidence older than this many days is eligible. Default: 365 */
    graceDays?: number;
}

export interface PurgeResult {
    model: string;
    scanned: number;
    purged: number;
    dryRun: boolean;
}

export interface RetentionSweepResult {
    model: string;
    scanned: number;
    expired: number;
}

// ═══════════════════════════════════════════════════════════════════
// 1. Purge Soft-Deleted Records (across all models)
// ═══════════════════════════════════════════════════════════════════

/**
 * Permanently removes soft-deleted records older than graceDays.
 *
 * Safety:
 *   - Only records with deletedAt < (now - graceDays) are purged
 *   - Hard-deletes via raw SQL to bypass soft-delete middleware
 *   - Emits DATA_PURGED audit event per record
 *   - Tenant-scoped
 */
export async function purgeSoftDeletedOlderThan(
    options: PurgeSoftDeletedOptions = {},
): Promise<PurgeResult[]> {
    return runJob('purge-soft-deleted', async () => {
        const now = options.now ?? new Date();
        const graceDays = options.graceDays ?? DEFAULT_SOFT_DELETE_GRACE_DAYS;
        const dryRun = options.dryRun ?? false;
        const db = options.db ?? defaultPrisma;
        const cutoff = new Date(now.getTime() - graceDays * 86_400_000);

        const results: PurgeResult[] = [];

        for (const model of SOFT_DELETE_MODELS) {
            const key = model.charAt(0).toLowerCase() + model.slice(1);
            const delegate = (db as unknown as Record<string, ModelDelegate>)[key];
            if (!delegate) continue;

            // Find eligible records: soft-deleted before cutoff
            const whereClause: Record<string, unknown> = {
                deletedAt: { not: null, lt: cutoff },
            };
            if (options.tenantId) {
                whereClause.tenantId = options.tenantId;
            }

            const candidates = await delegate.findMany(withDeleted({
                where: whereClause,
                select: { id: true, tenantId: true },
            }));

            const scanned = candidates.length;
            let purged = 0;

            if (!dryRun) {
                // Evidence carries BYTES — release the stored objects before
                // the rows go. Batched per tenant so the reference count is
                // one pair of queries per tenant rather than per record.
                if (model === 'Evidence') {
                    const byTenant = new Map<string, string[]>();
                    for (const record of candidates) {
                        const list = byTenant.get(record.tenantId);
                        if (list) list.push(record.id);
                        else byTenant.set(record.tenantId, [record.id]);
                    }
                    for (const [tenantId, ids] of byTenant) {
                        await purgeEvidenceBytes(db, tenantId, ids);
                    }
                }

                for (const record of candidates) {
                    await db.$executeRawUnsafe(
                        `DELETE FROM "${model}" WHERE "id" = $1`,
                        record.id,
                    );

                    // Emit audit event
                    await db.auditLog.create({
                        data: {
                            tenantId: record.tenantId,
                            action: 'DATA_PURGED',
                            entity: model,
                            entityId: record.id,
                            details: JSON.stringify({
                                reason: 'soft_delete_grace_expired',
                                graceDays,
                                purgedAt: now.toISOString(),
                            }),
                        },
                    });

                    purged++;
                }
            }

            results.push({ model, scanned, purged, dryRun });

            if (scanned > 0) {
                logger.info('purge-soft-deleted', {
                    component: 'job',
                    model, scanned, purged, dryRun, graceDays,
                });
            }
        }

        return results;
    }, { tenantId: options.tenantId });
}

// ═══════════════════════════════════════════════════════════════════
// 2. Purge Expired (Archived) Evidence
// ═══════════════════════════════════════════════════════════════════

/**
 * Permanently removes archived evidence that has been expired for longer
 * than the grace period. This is the final lifecycle step:
 *
 *   Evidence → expired → archived (by retention sweep) → purged (by this job)
 *
 * Safety:
 *   - Only evidence with isArchived=true AND expiredAt < (now - graceDays)
 *   - Must be soft-deleted OR archived (double-guard)
 *   - Emits DATA_PURGED audit event per record
 */
export async function purgeExpiredEvidenceOlderThan(
    options: PurgeExpiredEvidenceOptions = {},
): Promise<PurgeResult> {
    return runJob('purge-expired-evidence', async () => {
        const now = options.now ?? new Date();
        const graceDays = options.graceDays ?? DEFAULT_EVIDENCE_PURGE_DAYS;
        const dryRun = options.dryRun ?? false;
        const db = options.db ?? defaultPrisma;
        const cutoff = new Date(now.getTime() - graceDays * 86_400_000);

        const where: Prisma.EvidenceWhereInput = {
            isArchived: true,
            expiredAt: { not: null, lt: cutoff },
        };
        if (options.tenantId) {
            where.tenantId = options.tenantId;
        }

        const candidates = await db.evidence.findMany(withDeleted({
            where,
            select: { id: true, tenantId: true, title: true, fileRecordId: true },
        }));

        const scanned = candidates.length;
        let purged = 0;

        if (!dryRun) {
            // Release the BYTES before the rows. This purge used to delete the
            // Evidence row and leave the stored object on disk forever — while
            // emitting a DATA_PURGED audit entry saying the evidence was gone.
            // Grouped per tenant so the reference count is one query per
            // tenant, not one per row.
            const byTenant = new Map<string, string[]>();
            for (const ev of candidates) {
                const list = byTenant.get(ev.tenantId);
                if (list) list.push(ev.id);
                else byTenant.set(ev.tenantId, [ev.id]);
            }
            for (const [tenantId, ids] of byTenant) {
                await purgeEvidenceBytes(db, tenantId, ids);
            }

            for (const ev of candidates) {
                await db.$executeRawUnsafe(
                    'DELETE FROM "Evidence" WHERE "id" = $1',
                    ev.id,
                );

                await db.auditLog.create({
                    data: {
                        tenantId: ev.tenantId,
                        action: 'DATA_PURGED',
                        entity: 'Evidence',
                        entityId: ev.id,
                        details: JSON.stringify({
                            title: ev.title,
                            reason: 'expired_evidence_grace_exceeded',
                            graceDays,
                            purgedAt: now.toISOString(),
                        }),
                    },
                });

                purged++;
            }
        }

        logger.info('purge-expired-evidence', {
            component: 'job', scanned, purged, dryRun, graceDays,
        });

        return { model: 'Evidence', scanned, purged, dryRun };
    }, { tenantId: options.tenantId });
}

// ═══════════════════════════════════════════════════════════════════
// 3. Cross-Model Retention Sweep
// ═══════════════════════════════════════════════════════════════════

/**
 * Scans all models with retentionUntil and soft-deletes records
 * whose retention period has elapsed. Does NOT hard-delete.
 *
 * Lifecycle: active → retention expired → soft-deleted (by this job) → purged (by purge job)
 *
 * For Evidence specifically, this delegates to the existing
 * runEvidenceRetentionSweep which handles archival.
 */
export async function runRetentionSweep(
    options: PurgeOptions = {},
): Promise<RetentionSweepResult[]> {
    return runJob('retention-sweep-all', async () => {
        const now = options.now ?? new Date();
        const dryRun = options.dryRun ?? false;
        const db = options.db ?? defaultPrisma;
        const results: RetentionSweepResult[] = [];

        for (const model of RETENTION_MODELS) {
            // Evidence has its own specialized sweep (handles archival)
            if (model === 'Evidence') continue;

            const key = model.charAt(0).toLowerCase() + model.slice(1);
            const delegate = (db as unknown as Record<string, ModelDelegate>)[key];
            if (!delegate) continue;

            // Find records with retentionUntil < now AND not already soft-deleted
            const where: Record<string, unknown> = {
                retentionUntil: { not: null, lt: now },
                deletedAt: null,
            };
            if (options.tenantId) {
                where.tenantId = options.tenantId;
            }

            const candidates = await delegate.findMany({
                where,
                select: { id: true, tenantId: true },
            });

            const scanned = candidates.length;
            let expired = 0;

            if (!dryRun && scanned > 0) {
                for (const record of candidates) {
                    // Soft-delete the expired record
                    await delegate.update({
                        where: { id: record.id },
                        data: {
                            deletedAt: now,
                            deletedByUserId: null, // system action
                        },
                    });

                    // Emit audit event
                    await db.auditLog.create({
                        data: {
                            tenantId: record.tenantId,
                            action: 'DATA_EXPIRED',
                            entity: model,
                            entityId: record.id,
                            details: JSON.stringify({
                                reason: 'retention_period_elapsed',
                                expiredAt: now.toISOString(),
                            }),
                        },
                    });

                    expired++;
                }
            }

            results.push({ model, scanned, expired: dryRun ? scanned : expired });

            if (scanned > 0) {
                logger.info('retention-sweep', {
                    component: 'job', model, scanned, expired: dryRun ? scanned : expired, dryRun,
                });
            }
        }

        return results;
    }, { tenantId: options.tenantId });
}
