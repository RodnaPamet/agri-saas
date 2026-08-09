/**
 * Practice detail — page-data orchestrator.
 *
 * Single-call data contract for the practice detail page. Replaces
 * the previous client-side waterfall:
 *
 *   1. `GET /practices/:id`           — main practice payload
 *   2. (after step 1 lands)
 *      `GET /practices/:id/sync`      — sync status, conditional on
 *                                      `practice.automationKey`
 *
 * Step 2 is gated on step 1's response, so the two requests are
 * SERIAL on the WAN — ~2 RTT in the best case. Worse, the sync
 * endpoint re-reads the practice row to derive the provider, which
 * the page already has.
 *
 * This orchestrator runs both reads server-side, sequenced in one
 * tenant transaction:
 *
 *   • The practice fetch is `getPracticeHeader(ctx, id)` — header
 *     scalars + user refs + relation `_count`s,
 *     without the heavy tabbed arrays (#102 item 1 tab-lazy split).
 *   • The sync-mapping lookup runs only if `automationKey` is
 *     present, mirroring the GET /sync endpoint's branch — but
 *     reusing the already-loaded practice row instead of re-reading.
 *
 * Wire-level effect: 1 client→server round-trip instead of 2,
 * and one fewer DB read on the sync branch.
 *
 * Failure-mode contract:
 *   • If the practice isn't found, throws `notFound` (same as
 *     `getPractice`). The page surfaces a 404.
 *   • If the sync-mapping lookup fails, the orchestrator returns
 *     `syncStatus: null` for that field rather than failing the
 *     whole call — the conflict badge degrades gracefully.
 */
import { RequestContext } from '../../types';
import { getPracticeHeader } from './queries';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';

export interface SyncStatusPayload {
    syncStatus: string | null;
    lastSyncedAt: Date | string | null;
    lastSyncDirection: string | null;
    errorMessage: string | null;
    provider: string | null;
}

export interface PracticePageDataPayload {
    practice: Awaited<ReturnType<typeof getPracticeHeader>>;
    /**
     * Sync status for the practice's automation provider. Null when
     * the practice has no automationKey, or when the lookup failed.
     * The caller can render the conflict badge unconditionally
     * against this field.
     */
    syncStatus: SyncStatusPayload | null;
}

export async function getPracticePageData(
    ctx: RequestContext,
    practiceId: string,
): Promise<PracticePageDataPayload> {
    const practice = await getPracticeHeader(ctx, practiceId);

    // Branch on the already-loaded practice row. The previous flow
    // had the GET /sync endpoint re-read this same column from the DB.
    const automationKey = (practice as { automationKey?: string | null }).automationKey;
    if (!automationKey) {
        return { practice, syncStatus: null };
    }

    const [provider] = automationKey.split('.');

    try {
        // Lazy-loaded so the orchestrator's import graph doesn't drag
        // in PrismaSyncMappingStore for every practice fetch — only
        // practices with automationKey actually need it. Mirrors the
        // pattern in the existing GET /sync route.
        const { PrismaSyncMappingStore } = await import(
            '@/app-layer/integrations/prisma-sync-store'
        );
        const store = new PrismaSyncMappingStore();
        const mapping = await runInTenantContext(ctx, () =>
            store.findByLocalEntity(ctx.tenantId, provider, 'practice', practiceId),
        );

        return {
            practice,
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
        // Page still loads with a working practice payload.
        logger.warn('practice page-data: sync lookup failed', {
            component: 'practice-page-data',
            practiceId,
            error: err instanceof Error ? err.message : String(err),
        });
        return { practice, syncStatus: null };
    }
}
