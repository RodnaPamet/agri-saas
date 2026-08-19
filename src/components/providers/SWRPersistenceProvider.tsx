'use client';

/**
 * Roadmap-6 P3 — mounts the per-tenant persistent SWR cache.
 *
 * Wraps the app in a single `<SWRConfig>` whose `provider` is a
 * disk-backed Map (see `@/lib/swr/persistent-cache`). Net effect: a PWA
 * relaunch paints every list from the on-device cache instantly and
 * only revalidates in the background — no more cold-start full-farm
 * refetch over rural LTE.
 *
 * Isolation — the bucket is namespaced by USER **and** tenant.
 *
 * Tenant alone was not enough, and the gap was a live cross-user leak
 * rather than a theoretical one. A shared farm device signs in operator
 * A (ADMIN), who opens a list; the rows land in `agrent-swr:v*:<slug>`.
 * A signs out, operator B (READER) signs into the SAME tenant — same
 * slug, same bucket — and SWR paints A's rows from disk before any
 * request leaves the device. If the API then refuses B, the app's own
 * error convention (`isError && rows.length === 0`) keeps the stale rows
 * on screen, because there ARE rows. No TTL and no sign-out purge closes
 * that; only the namespace does.
 *
 * `SWRConfig` is KEYED by the namespace, so a change of either user or
 * tenant remounts it with a fresh Map hydrated from the right bucket.
 * Routes with no tenant (`/login`, `/tenants`, …) use a `global`
 * bucket; signed-out visitors use `anon`.
 *
 * The provider factory is fully feature-detected and never throws, so
 * SSR and browsers without localStorage / IndexedDB degrade to a plain
 * in-memory cache (exactly today's behaviour) rather than crashing.
 */

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { SWRConfig } from 'swr';
import { createPersistentCacheProvider } from '@/lib/swr/persistent-cache';

/** Extract the tenant slug from a `/t/<slug>/…` path, else `global`. */
export function tenantNamespaceFromPath(pathname: string | null): string {
    if (!pathname) return 'global';
    const match = /^\/t\/([^/]+)/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : 'global';
}

/**
 * Build the bucket namespace from the signed-in user and the tenant.
 *
 * Exported so the behaviour can be tested directly rather than through a
 * mounted provider. `anon` for a signed-out visitor: their bucket is
 * separate from every real user's, which is the safe default.
 */
export function cacheNamespace(userId: string | null | undefined, tenant: string): string {
    return `${userId || 'anon'}::${tenant}`;
}

export function SWRPersistenceProvider({
    children,
    userId,
}: {
    children: React.ReactNode;
    /**
     * The signed-in user's id, resolved SERVER-side and passed down.
     * Null on public routes. It only namespaces a cache key — it is
     * never a credential and grants nothing.
     */
    userId?: string | null;
}) {
    const pathname = usePathname();
    const namespace = cacheNamespace(userId, tenantNamespaceFromPath(pathname));

    // Recreate the provider (and thus re-hydrate from the correct
    // bucket) only when the tenant namespace changes — never on ordinary
    // in-tenant navigation. SWR calls this factory once per SWRConfig
    // mount; the `key` below forces that remount on a tenant switch.
    const provider = useMemo(
        () => () => createPersistentCacheProvider({ namespace }),
        [namespace],
    );

    return (
        <SWRConfig key={namespace} value={{ provider }}>
            {children}
        </SWRConfig>
    );
}
