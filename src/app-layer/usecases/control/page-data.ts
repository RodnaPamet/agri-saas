/**
 * Control detail — page-data orchestrator.
 *
 * Single-call data contract for the control detail page. Replaces
 * the previous client-side waterfall:
 *
 *   1. `GET /controls/:id`           — main control payload
 *   2. (after step 1 lands)
 *      `GET /controls/:id/sync`      — sync status, conditional on
 *                                      `control.automationKey`
 *
 * Step 2 is gated on step 1's response, so the two requests are
 * SERIAL on the WAN — ~2 RTT in the best case. Worse, the sync
 * endpoint re-reads the control row to derive the provider, which
 * the page already has.
 *
 * This orchestrator runs both reads server-side, sequenced in one
 * tenant transaction:
 *
 *   • The control fetch is `getControlHeader(ctx, id)` — header
 *     scalars + user refs + relation `_count`s,
 *     without the heavy tabbed arrays (#102 item 1 tab-lazy split).
 *   • The sync-mapping lookup runs only if `automationKey` is
 *     present, mirroring the GET /sync endpoint's branch — but
 *     reusing the already-loaded control row instead of re-reading.
 *
 * Wire-level effect: 1 client→server round-trip instead of 2,
 * and one fewer DB read on the sync branch.
 *
 * Failure-mode contract:
 *   • If the control isn't found, throws `notFound` (same as
 *     `getControl`). The page surfaces a 404.
 *   • If the sync-mapping lookup fails, the orchestrator returns
 *     `syncStatus: null` for that field rather than failing the
 *     whole call — the conflict badge degrades gracefully.
 */
import { RequestContext } from '../../types';
import { getControlHeader } from './queries';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';

export interface SyncStatusPayload {
    syncStatus: string | null;
    lastSyncedAt: Date | string | null;
    lastSyncDirection: string | null;
    errorMessage: string | null;
    provider: string | null;
}

export interface ControlPageDataPayload {
    control: Awaited<ReturnType<typeof getControlHeader>>;
    /**
     * Sync status for the control's automation provider. Null when
     * the control has no automationKey, or when the lookup failed.
     * The caller can render the conflict badge unconditionally
     * against this field.
     */
    syncStatus: SyncStatusPayload | null;
}

export async function getControlPageData(
    ctx: RequestContext,
    controlId: string,
): Promise<ControlPageDataPayload> {
    const control = await getControlHeader(ctx, controlId);

    // Branch on the already-loaded control row. The previous flow
    // had the GET /sync endpoint re-read this same column from the DB.
    const automationKey = (control as { automationKey?: string | null }).automationKey;
    if (!automationKey) {
        return { control, syncStatus: null };
    }

    const [provider] = automationKey.split('.');

    try {
        // Lazy-loaded so the orchestrator's import graph doesn't drag
        // in PrismaSyncMappingStore for every control fetch — only
        // controls with automationKey actually need it. Mirrors the
        // pattern in the existing GET /sync route.
        const { PrismaSyncMappingStore } = await import(
            '@/app-layer/integrations/prisma-sync-store'
        );
        const store = new PrismaSyncMappingStore();
        const mapping = await runInTenantContext(ctx, () =>
            store.findByLocalEntity(ctx.tenantId, provider, 'control', controlId),
        );

        return {
            control,
            syncStatus: {
                syncStatus: mapping?.syncStatus ?? null,
                lastSyncedAt: mapping?.lastSyncedAt ?? null,
                lastSyncDirection: mapping?.lastSyncDirection ?? null,
                errorMessage: mapping?.errorMessage ?? null,
                provider,
            },
        };
    } catch (err) {
        // Graceful degrade — the conflict badge is informational.
        // Page still loads with a working control payload.
        logger.warn('control page-data: sync lookup failed', {
            component: 'control-page-data',
            controlId,
            error: err instanceof Error ? err.message : String(err),
        });
        return { control, syncStatus: null };
    }
}
