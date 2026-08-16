/**
 * SP-5 — SharePoint sync-health aggregation for the admin dashboard.
 *
 * @module integrations/providers/sharepoint/health
 */
import type { RequestContext } from '../../../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanAdmin } from '../../../policies/common';

export interface SharePointHealth {
    connections: Array<{ id: string; name: string; lastTestedAt: string | null; lastTestStatus: string | null }>;
    executions: Array<{
        id: string;
        automationKey: string;
        status: string;
        triggeredBy: string;
        executedAt: string;
        durationMs: number | null;
    }>;
    evidenceCoverage: { synced: number; stale: number; failed: number; total: number };
}

/** Aggregate connection health, recent executions and sync coverage. */
export async function getSharePointHealth(ctx: RequestContext): Promise<SharePointHealth> {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        const connections = await db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId, provider: 'sharepoint' },
            select: { id: true, name: true, lastTestedAt: true, lastTestStatus: true },
            take: 50,
        });

        const executions = await db.integrationExecution.findMany({
            where: { tenantId: ctx.tenantId, provider: 'sharepoint' },
            select: { id: true, automationKey: true, status: true, triggeredBy: true, executedAt: true, durationMs: true },
            orderBy: { executedAt: 'desc' },
            take: 100,
        });

        const mappings = await db.integrationSyncMapping.findMany({
            where: { tenantId: ctx.tenantId, provider: 'sharepoint' },
            select: { syncStatus: true },
            take: 2000,
        });
        const evidenceCoverage = {
            synced: mappings.filter((m) => m.syncStatus === 'SYNCED').length,
            stale: mappings.filter((m) => m.syncStatus === 'STALE').length,
            failed: mappings.filter((m) => m.syncStatus === 'FAILED').length,
            total: mappings.length,
        };

        return {
            connections: connections.map((c) => ({
                id: c.id,
                name: c.name,
                lastTestedAt: c.lastTestedAt ? c.lastTestedAt.toISOString() : null,
                lastTestStatus: c.lastTestStatus,
            })),
            executions: executions.map((e) => ({
                id: e.id,
                automationKey: e.automationKey,
                status: e.status,
                triggeredBy: e.triggeredBy,
                executedAt: e.executedAt.toISOString(),
                durationMs: e.durationMs,
            })),
            evidenceCoverage,
        };
    });
}
