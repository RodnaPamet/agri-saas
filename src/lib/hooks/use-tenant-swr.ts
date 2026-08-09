/**
 * Epic 69 — canonical tenant-aware client-side read hook.
 *
 * `useTenantSWR<T>(path, options?)` is the single entry point for
 * reading tenant-scoped API data from a client component. It wraps
 * `useSWR` with three project-specific concerns baked in:
 *
 *   1. **Tenant prefixing.** Callers pass a tenant-relative path
 *      (e.g. `'/practices'`) — the hook prepends `/api/t/{slug}`
 *      using the active `TenantContext`. Components stop hand-rolling
 *      `/api/t/${slug}/...` strings; the SWR key is the resolved
 *      absolute URL so cross-tenant cache entries stay isolated.
 *
 *   2. **Repo-consistent fetch + error mapping.** The default fetcher
 *      is `apiGet` from `@/lib/api-client`, which already returns
 *      typed JSON and throws `ApiClientError` for non-2xx responses
 *      (parsing the standard `{ error: { code, message, requestId } }`
 *      envelope). SWR therefore surfaces typed errors without each
 *      call site reinventing JSON-error parsing.
 *
 *   3. **Sane defaults for compliance UI.** `revalidateOnFocus`,
 *      `revalidateOnReconnect`, and `keepPreviousData` are all
 *      enabled — list pages stay snappy on tab switch / network
 *      blip and `data` doesn't flash to `undefined` between
 *      revalidations. `dedupingInterval` is 5 s to avoid hammering
 *      the API when multiple components mount together.
 *
 * Usage:
 *
 *   const { data, error, isLoading, mutate } =
 *       useTenantSWR<PracticeListItemDTO[]>('/practices', {
 *           schema: PracticeListSchema,
 *       });
 *
 * Conditional fetching mirrors SWR's null-key idiom — pass `null` (or
 * `undefined`) for `path` to skip:
 *
 *   const { data } = useTenantSWR<RiskDetailDTO>(
 *       riskId ? `/risks/${riskId}` : null,
 *   );
 *
 * What this hook deliberately does NOT do (yet):
 *
 *   - Optimistic mutations. Use `mutate(...)` directly OR the
 *     forthcoming `useTenantSWRMutation` helper (next prompt in
 *     this PR series). The base hook stays focused on reads so the
 *     migration can land incrementally.
 *   - Cursor pagination. A higher-level wrapper will live alongside
 *     this hook once a page or two have migrated.
 *   - Operating without tenant context. Reaching for an org-level or
 *     unscoped endpoint should use `useSWR` directly with
 *     `apiGet` as the fetcher — calling this hook outside a
 *     `TenantProvider` throws.
 */
'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { preload, type SWRConfiguration, type SWRResponse } from 'swr';
import type { ZodSchema } from 'zod';

import { apiGet, ApiClientError } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

/**
 * Sane defaults for typical compliance-product reads. Each chosen
 * deliberately — not just SWR's library defaults.
 *
 *   - `revalidateOnFocus`: ON. Compliance dashboards are reviewed
 *     across multiple tabs/windows; the small extra request cost
 *     beats showing 10-minute-stale data on a tab the user just
 *     left and came back to.
 *
 *   - `revalidateOnReconnect`: ON. Cheap insurance for flaky
 *     office Wi-Fi.
 *
 *   - `keepPreviousData`: ON. When a list page re-fetches on focus,
 *     `data` stays populated through the revalidation instead of
 *     bouncing to `undefined` and re-rendering the loading skeleton.
 *     This is the "instant-feeling" half of the Epic 69 brief.
 *
 *   - `dedupingInterval`: 5_000 ms. Many list pages mount three or
 *     four cards (KPI / chart / table) that all want the same
 *     endpoint — a 5 s window collapses them to one HTTP call without
 *     making intentionally re-mounted views feel stale.
 *
 *   - `errorRetryCount`: 2. SWR defaults to ~5 with exponential
 *     backoff; for an internal app, two is plenty before surfacing
 *     the failure to the user.
 *
 *   - `errorRetryInterval`: 2_000 ms. Pair with `errorRetryCount: 2`
 *     so a transient blip resolves in <5 s without spamming.
 *
 * Callers can override any of these by passing the same key in the
 * options object — the merge is a shallow override (consumer wins).
 */
const DEFAULT_SWR_CONFIG: SWRConfiguration = {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    keepPreviousData: true,
    dedupingInterval: 5_000,
    errorRetryCount: 2,
    errorRetryInterval: 2_000,
    // Back off to the server's `Retry-After` on a 429/503 instead of the flat
    // 2s interval — the outbox already honors it; the foreground fetch should
    // too, so a rate-limited page doesn't keep hammering a closed window.
    onErrorRetry: (error, _key, config, revalidate, { retryCount }) => {
        const max = config.errorRetryCount ?? 2;
        if (retryCount > max) return;
        const raSec = (error as ApiClientError | undefined)?.retryAfterSeconds;
        const delayMs =
            typeof raSec === 'number' && raSec >= 0
                ? raSec * 1000
                : config.errorRetryInterval ?? 2_000;
        setTimeout(() => void revalidate({ retryCount }), delayMs);
    },
};

export interface UseTenantSWROptions<T>
    extends Omit<SWRConfiguration<T, ApiClientError | Error>, 'fetcher'> {
    /**
     * Optional Zod schema for response validation (dev/test only —
     * matches the `apiGet` validation contract: warns on mismatch,
     * never throws). Useful while migrating a page so a bad backend
     * change shows up as a console warning instead of a silent
     * runtime cast.
     */
    schema?: ZodSchema<T>;
}

/**
 * Return type for `useTenantSWR`. Identical surface to `useSWR`
 * except the error type is narrowed to `ApiClientError | Error` so
 * downstream consumers can do `error?.status === 404` checks
 * without re-narrowing.
 */
export type UseTenantSWRResult<T> = SWRResponse<T, ApiClientError | Error>;

/**
 * Tenant-aware SWR read hook. See module docstring for the
 * positioning, defaults, and intentional non-features.
 *
 * @param path  Tenant-relative endpoint path. Leading `/` optional.
 *              Pass `null` or `undefined` to skip fetching (SWR
 *              null-key idiom).
 * @param options Optional SWR overrides + an optional Zod schema for
 *                dev-mode response validation.
 */
export function useTenantSWR<T>(
    path: string | null | undefined,
    options: UseTenantSWROptions<T> = {},
): UseTenantSWRResult<T> {
    const { schema, ...swrOverrides } = options;
    const buildApiUrl = useTenantApiUrl();

    // The SWR key MUST be the resolved absolute URL — that way:
    //   1. Two hooks pointing at the same endpoint dedupe naturally.
    //   2. `mutate('/api/t/<slug>/practices')` from anywhere in the
    //      app hits the same cache entry without recomputing the
    //      tenant prefix.
    //   3. Cache entries from different tenants never collide.
    const key = path == null ? null : buildApiUrl(path);

    const fetcher = useCallback(
        (url: string) => apiGet<T>(url, schema),
        [schema],
    );

    // The override object is consumer-provided; deps follow its
    // identity. Consumers that pass a fresh literal each render accept
    // the cost of re-merging — they almost never matter for SWR (the
    // merged object is read once per call). Extract the JSON key into
    // a const so the deps array is "simple expressions" only.
    const swrOverridesKey = JSON.stringify(swrOverrides);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const config = useMemo<SWRConfiguration<T, ApiClientError | Error>>(() => ({ ...DEFAULT_SWR_CONFIG, ...swrOverrides }), [swrOverridesKey]);

    return useSWR<T, ApiClientError | Error>(key, fetcher, config);
}

/**
 * Imperatively warm the SWR cache for a tenant-relative path — the prefetch
 * companion to `useTenantSWR`. Returns a stable callback you fire from a
 * hover/intent handler (e.g. `<DataTable onRowPrefetch>`); a detail page that
 * reads the same `useTenantSWR(path)` then renders INSTANTLY from cache on
 * click instead of spinning while it fetches. The cache key is the resolved
 * absolute URL — identical to what `useTenantSWR` computes — so the warmed
 * entry is the exact one the detail page reads. No-op for empty paths.
 */
export function usePrefetchTenant() {
    const buildApiUrl = useTenantApiUrl();
    return useCallback(
        (path: string | null | undefined) => {
            if (!path) return;
            void preload(buildApiUrl(path), (url: string) => apiGet(url));
        },
        [buildApiUrl],
    );
}
