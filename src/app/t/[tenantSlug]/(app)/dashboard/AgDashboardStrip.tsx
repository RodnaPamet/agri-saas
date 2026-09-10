'use client';

import { AsyncState } from '@/components/ui/async-state';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { AgDashboardPayload } from '@/app-layer/usecases/ag-dashboard';

import FirstRunCard from './FirstRunCard';
import FieldBriefingCard from './FieldBriefingCard';
import RecentJournalCard from './RecentJournalCard';
import MyFarmTasksCard from './MyFarmTasksCard';

/**
 * Agriculture dashboard strip — a small "your farm today" row of cards
 * rendered ABOVE the fixed GRC executive cards on the tenant dashboard.
 *
 * Gating is module-driven, read from the `enabledModules` the
 * `/dashboard/ag` payload carries (the tenant's enabled set isn't on the
 * client `TenantContext`, so the data source threads it through):
 *
 *   - Journal card  → only when the JOURNAL module is enabled.
 *   - Low-stock card → only when the INVENTORY module is enabled.
 *   - My-tasks card → always (Tasks is not module-gated).
 *
 * If NEITHER ag module is enabled the whole strip renders nothing — a
 * pure-GRC tenant sees no farm row at all. While the first request is in
 * flight (no `data` yet) the strip also renders nothing, so it never
 * flashes empty chrome on a GRC tenant.
 */
export default function AgDashboardStrip() {
    const href = useTenantHref();
    const { data, error, isLoading, mutate } = useTenantSWR<AgDashboardPayload>(CACHE_KEYS.dashboard.ag());

    // `return null` here meant the whole strip vanished offline, byte-identical
    // to the legitimate "tenant has no ag modules" case below — so an operator
    // could not tell "no signal" from "my account never had this" (#862).
    // A failed load now says so; a genuinely module-less tenant still renders
    // nothing, which is the distinction that was missing.
    if (!data) {
        if (isLoading && !error) return null;
        return (
            <AsyncState
                data={data}
                error={error}
                isLoading={isLoading}
                onRetry={() => void mutate()}
                skeleton={null}
            >
                {() => null}
            </AsyncState>
        );
    }

    // Defensive: a malformed / partial cache payload (e.g. an SWR key
    // collision in tests, or a future error-shape from the endpoint) can
    // leave `enabledModules` undefined even when `data` is truthy. Treat a
    // missing list as "no ag modules" → the strip renders nothing, the same
    // safe default as the no-data branch above.
    const journalOn = data.enabledModules?.includes('JOURNAL') ?? false;
    const inventoryOn = data.enabledModules?.includes('INVENTORY') ?? false;

    // The strip exists only for ag tenants. With no core ag module enabled
    // (journal / inventory), render nothing — the farm row is invisible for
    // pure-GRC.
    if (!journalOn && !inventoryOn) return null;

    return (
        <div className="space-y-default">
            {/* Guided first-run ring — self-hides once the farm is set up
                or the operator dismisses it (see FirstRunCard). */}
            <FirstRunCard payload={data} onChanged={() => { void mutate(); }} />
            {/* AI field briefing — today's satellite (NDVI/NDMI) + farm-record
                context summarised by Claude Haiku into "what to do today".
                Self-hides until there's a briefing to show. */}
            <FieldBriefingCard />
            <div
                id="ag-dashboard-strip"
                className="grid grid-cols-1 gap-default md:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0"
            >
            {journalOn && (
                <RecentJournalCard href={href('/journal')} items={data.recentJournal} />
            )}
            <MyFarmTasksCard href={href('/farm-tasks')} items={data.myTasks} />
            </div>
        </div>
    );
}
