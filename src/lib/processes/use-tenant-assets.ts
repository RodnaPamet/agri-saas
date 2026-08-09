"use client";

/**
 * Epic P2-PR-B — `useTenantAssets(tenantSlug)`.
 *
 * Sibling of `useTenantPractices` (P2-PR-A) and `useTenantRisks`
 * (P2-PR-B) for the inspector's asset-node picker. Assets carry a
 * `key` (short code) + `name` so the label format is "<key> · <name>"
 * when key is present, otherwise bare name.
 */
import { useEffect, useState } from "react";

export interface TenantAssetOption {
    id: string;
    key: string | null;
    name: string;
    /**
     * PR-D polish — live status surface (parity with Practices +
     * Risks). The API ships `Asset.status` on each row; we carry
     * it through so the inspector can render a tone-coloured chip.
     */
    status: string | null;
}

interface TenantAssetsState {
    options: TenantAssetOption[];
    loading: boolean;
    error: string | null;
}

interface UseTenantAssetsOptions {
    /**
     * PR-D polish — periodic revalidation cadence in milliseconds.
     * See `use-tenant-practices` for the full contract.
     */
    pollMs?: number;
}

const CACHE = new Map<string, TenantAssetOption[]>();

async function fetchTenantAssets(
    tenantSlug: string,
): Promise<TenantAssetOption[]> {
    const res = await fetch(`/api/t/${tenantSlug}/assets`);
    if (!res.ok) {
        throw new Error(`Could not load assets (${res.status})`);
    }
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body)
        ? (body as unknown[])
        : Array.isArray((body as { assets?: unknown[] })?.assets)
          ? (body as { assets: unknown[] }).assets
          : Array.isArray((body as { data?: unknown[] })?.data)
            ? (body as { data: unknown[] }).data
            : [];
    return rows
        .map((r) => {
            const row = r as {
                id?: unknown;
                key?: unknown;
                name?: unknown;
                status?: unknown;
            };
            if (typeof row.id !== "string") return null;
            return {
                id: row.id,
                key: typeof row.key === "string" ? row.key : null,
                name:
                    typeof row.name === "string"
                        ? row.name
                        : "(unnamed)",
                status: typeof row.status === "string" ? row.status : null,
            };
        })
        .filter((r): r is TenantAssetOption => r !== null);
}

export function useTenantAssets(
    tenantSlug: string,
    options?: UseTenantAssetsOptions,
): TenantAssetsState {
    const cached = CACHE.get(tenantSlug);
    const [state, setState] = useState<TenantAssetsState>(() => ({
        options: cached ?? [],
        loading: cached === undefined && tenantSlug !== "",
        error: null,
    }));
    const pollMs = options?.pollMs ?? 0;

    useEffect(() => {
        if (tenantSlug === "") {
            setState({ options: [], loading: false, error: null });
            return;
        }
        let cancelled = false;
        const initialCached = CACHE.has(tenantSlug);
        if (initialCached) {
            setState({
                options: CACHE.get(tenantSlug) ?? [],
                loading: false,
                error: null,
            });
        } else {
            setState({ options: [], loading: true, error: null });
        }
        const runFetch = async (isRevalidation: boolean) => {
            try {
                const opts = await fetchTenantAssets(tenantSlug);
                CACHE.set(tenantSlug, opts);
                if (!cancelled) {
                    setState({ options: opts, loading: false, error: null });
                }
            } catch (err) {
                if (cancelled) return;
                if (isRevalidation) return;
                setState({
                    options: [],
                    loading: false,
                    error:
                        err instanceof Error
                            ? err.message
                            : "Could not load assets",
                });
            }
        };
        if (!initialCached) {
            void runFetch(false);
        }
        let timer: ReturnType<typeof setInterval> | null = null;
        if (pollMs > 0) {
            timer = setInterval(() => {
                void runFetch(true);
            }, pollMs);
        }
        return () => {
            cancelled = true;
            if (timer !== null) clearInterval(timer);
        };
    }, [tenantSlug, pollMs]);

    return state;
}

export function formatAssetLabel(opt: TenantAssetOption): string {
    return opt.key ? `${opt.key} · ${opt.name}` : opt.name;
}

/**
 * PR-D polish — locate one asset by id (parity with the
 * practices + risks `find*` helpers).
 */
export function findTenantAsset(
    state: TenantAssetsState,
    id: string | null,
): TenantAssetOption | null {
    if (!id) return null;
    return state.options.find((o) => o.id === id) ?? null;
}

export function __resetTenantAssetsCacheForTests(): void {
    CACHE.clear();
}
