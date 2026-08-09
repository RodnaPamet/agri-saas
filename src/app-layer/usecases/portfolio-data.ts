/**
 * Epic E.3 — shared upstream portfolio data helper.
 *
 * Single source of truth for the two reads every portfolio usecase
 * depends on:
 *
 *   1. `PortfolioRepository.getOrgTenantIds(orgId)`     — tenant list
 *   2. `PortfolioRepository.getLatestSnapshots(ids)`    — snapshot per tenant
 *
 * **Request-scoped memoization.** Within a single HTTP request,
 * multiple usecase calls (e.g. CSV export composes summary + health
 * + 3 drill-downs) ALL share the same fetch. The cache is keyed on
 * the AsyncLocalStorage `RequestContext` object via a WeakMap, so:
 *
 *   - Different requests get independent caches (no cross-request
 *     bleed).
 *   - The cache is auto-GC'd when the request ends — no manual
 *     teardown.
 *   - Outside a request scope (background jobs, scripts, tests
 *     that don't run inside `runWithRequestContext`), every call
 *     does a fresh fetch — same behaviour as the unmemoized direct
 *     repo calls.
 *
 * Concurrency: tenants and snapshots are stored as Promises, not
 * resolved values. A second concurrent caller for the same orgId
 * awaits the in-flight promise instead of issuing a duplicate query.
 *
 * Cross-org safety: the cache entry remembers its `orgId`. A
 * different orgId in the same request scope (rare — one request maps
 * to one OrgContext) falls through to a fresh fetch.
 *
 * `includeSnapshots: false`: drill-down callers that only need the
 * tenant list opt out so we don't pull a snapshot batch they'll
 * never read. The tenant fetch is still memoized.
 */

import type { ComplianceSnapshot } from '@prisma/client';

import { getRequestContext } from '@/lib/observability/context';
import {
    PortfolioRepository,
    type OrgTenantMeta,
} from '@/app-layer/repositories/PortfolioRepository';

export interface PortfolioBaseData {
    /** Every tenant linked to the org, ordered by name. */
    tenants: OrgTenantMeta[];
    /** Latest snapshot per tenant within the 14-day staleness window.
     *  Empty array when `includeSnapshots: false` was requested. */
    snapshots: ComplianceSnapshot[];
    /** tenantId → snapshot lookup. Empty when snapshots weren't fetched. */
    snapshotsByTenant: Map<string, ComplianceSnapshot>;
}

export interface GetPortfolioDataOptions {
    /**
     * When false, skip the latest-snapshots fetch. Drill-down
     * usecases (practices / risks / evidence list) only need the
     * tenant list and should pass this to avoid unnecessary
     * snapshot reads. Default true (the summary + health path).
     */
    includeSnapshots?: boolean;
}

interface CachedEntry {
    /**
     * Tracks the org this cache entry was populated for. A
     * subsequent call for a different orgId in the same request
     * scope (uncommon but possible — e.g. a tool that lists data
     * across orgs) bypasses the cache.
     */
    orgId: string;
    tenantsPromise: Promise<OrgTenantMeta[]>;
    /** Lazily populated. `undefined` if no caller has asked for snapshots yet. */
    snapshotsPromise?: Promise<ComplianceSnapshot[]>;
}

/**
 * Cache keyed on the AsyncLocalStorage RequestContext object. WeakMap
 * means we don't pin the context once the request ends — Node's GC
 * cleans up automatically.
 */
const requestCache = new WeakMap<object, CachedEntry>();

/**
 * Internal-only — inspect the cache state for tests. Returns a
 * stable snapshot (orgId + which promises are populated). Not
 * exported through the barrel; tests import this path directly.
 */
export function _peekRequestCache(): { orgId: string; hasSnapshots: boolean } | null {
    const ctx = getRequestContext();
    if (!ctx) return null;
    const entry = requestCache.get(ctx);
    if (!entry) return null;
    return { orgId: entry.orgId, hasSnapshots: entry.snapshotsPromise !== undefined };
}

export async function getPortfolioData(
    orgId: string,
    options: GetPortfolioDataOptions = {},
): Promise<PortfolioBaseData> {
    const includeSnapshots = options.includeSnapshots ?? true;
    const ctx = getRequestContext();

    let entry: CachedEntry | undefined;
    if (ctx) {
        const cached = requestCache.get(ctx);
        // Same-request, same-org reuse. Cross-org in one request is
        // rare; we don't try to merge — fresh fetch instead.
        if (cached && cached.orgId === orgId) {
            entry = cached;
        }
    }

    if (!entry) {
        entry = {
            orgId,
            tenantsPromise: PortfolioRepository.getOrgTenantIds(orgId),
        };
        if (ctx) requestCache.set(ctx, entry);
    }

    const tenants = await entry.tenantsPromise;
    const tenantIds = tenants.map((t) => t.id);

    let snapshots: ComplianceSnapshot[] = [];
    if (includeSnapshots) {
        if (!entry.snapshotsPromise) {
            entry.snapshotsPromise =
                PortfolioRepository.getLatestSnapshots(tenantIds);
        }
        snapshots = await entry.snapshotsPromise;
    }

    return {
        tenants,
        snapshots,
        snapshotsByTenant: new Map(snapshots.map((s) => [s.tenantId, s])),
    };
}
