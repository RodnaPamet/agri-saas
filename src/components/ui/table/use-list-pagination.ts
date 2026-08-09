"use client";

/**
 * Epic 52 — adapter that bridges flat-list APIs to `<DataTable>` paginated mode.
 *
 * The Inflect list APIs currently return a full array per tenant (no server
 * cursor navigation). TanStack's `Table` runs in `manualPagination: true`
 * mode, expecting the consumer to slice `data` per page and report
 * `rowCount`. `useListPagination` owns that slicing, syncs the active page
 * to the `?page=` URL param, and resets to page 1 whenever the filter /
 * search state changes — all while staying compatible with the
 * `useFilterContext` URL-sync already in place on the page.
 *
 * Shape:
 *
 *   const pg = useListPagination({
 *     pageSize: 25,
 *     resetKey: fetchParams.toString(), // filter URL signature
 *   });
 *
 *   <DataTable
 *     data={pg.slice(practices)}
 *     pagination={pg.pagination}
 *     onPaginationChange={pg.setPagination}
 *     rowCount={practices.length}
 *     ...
 *   />
 *
 * `PaginationPractices` renders automatically in the DataTable footer when
 * those three props are set.
 */

import { type PaginationState } from "@tanstack/react-table";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PAGE_SIZE } from "./pagination-utils";

export interface UseListPaginationOptions {
    /** Items per page. Defaults to the shared DEFAULT_PAGE_SIZE (25). */
    pageSize?: number;
    /**
     * Opaque signature of "everything that should invalidate the current page".
     * When this value changes between renders, pageIndex resets to 0 and the
     * `?page=` URL param is cleared. Typical callers pass the API query string
     * (`toApiSearchParams(...).toString()`) so any filter/search edit returns
     * the user to page 1.
     */
    resetKey?: string;
    /** Disable URL sync (rare — used for embedded widgets / tests). */
    syncUrl?: boolean;
}

export interface UseListPagination {
    /** PaginationState compatible with `<DataTable pagination>`. */
    pagination: PaginationState;
    /** Setter compatible with `<DataTable onPaginationChange>`. */
    setPagination: (
        updater: PaginationState | ((prev: PaginationState) => PaginationState),
    ) => void;
    /** 1-based page number for display / telemetry. */
    page: number;
    /** Items per page. */
    pageSize: number;
    /**
     * Slice a full array to the current page. Identity-stable when the page
     * and data are unchanged, so React's memo checks behave.
     */
    slice: <T>(data: ReadonlyArray<T>) => T[];
}

export function useListPagination(
    options: UseListPaginationOptions = {},
): UseListPagination {
    const { pageSize = DEFAULT_PAGE_SIZE, resetKey, syncUrl = true } = options;

    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    // Read initial page from the URL on first render only — subsequent reads
    // go through state to avoid re-render loops when we write back.
    const initialPage = useMemo(() => {
        if (typeof window === "undefined") return 1;
        const raw = searchParams?.get("page");
        const parsed = raw ? parseInt(raw, 10) : 1;
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [pagination, setPaginationState] = useState<PaginationState>({
        pageIndex: initialPage - 1,
        pageSize,
    });

    // Keep a stable ref to the resetKey so our "reset to page 1" effect fires
    // only when it *changes*, not on every render.
    const lastResetKey = useRef(resetKey);
    useEffect(() => {
        if (lastResetKey.current === resetKey) return;
        lastResetKey.current = resetKey;
        setPaginationState((p) => ({ ...p, pageIndex: 0 }));
    }, [resetKey]);

    // Push pageIndex to the URL. Page 1 means "no param" so URLs stay clean.
    const pushPageToUrl = useCallback(
        (pageIndex: number) => {
            if (!syncUrl || typeof window === "undefined") return;
            const params = new URLSearchParams(window.location.search);
            if (pageIndex <= 0) {
                params.delete("page");
            } else {
                params.set("page", String(pageIndex + 1));
            }
            const qs = params.toString();
            router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
        },
        [router, pathname, syncUrl],
    );

    const setPagination = useCallback(
        (
            updater:
                | PaginationState
                | ((prev: PaginationState) => PaginationState),
        ) => {
            setPaginationState((prev) => {
                const next = typeof updater === "function" ? updater(prev) : updater;
                if (next.pageIndex !== prev.pageIndex) pushPageToUrl(next.pageIndex);
                return next;
            });
        },
        [pushPageToUrl],
    );

    // Honour browser back/forward: re-read `page` from the URL on popstate.
    useEffect(() => {
        if (!syncUrl) return;
        const handler = () => {
            const raw = new URLSearchParams(window.location.search).get("page");
            const parsed = raw ? parseInt(raw, 10) : 1;
            const nextIndex =
                Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
            setPaginationState((p) =>
                p.pageIndex === nextIndex ? p : { ...p, pageIndex: nextIndex },
            );
        };
        window.addEventListener("popstate", handler);
        return () => window.removeEventListener("popstate", handler);
    }, [syncUrl]);

    const slice = useCallback(
        <T,>(data: ReadonlyArray<T>): T[] => {
            const start = pagination.pageIndex * pagination.pageSize;
            return data.slice(start, start + pagination.pageSize) as T[];
        },
        [pagination.pageIndex, pagination.pageSize],
    );

    return {
        pagination,
        setPagination,
        page: pagination.pageIndex + 1,
        pageSize: pagination.pageSize,
        slice,
    };
}
