/**
 * Generic typed API hook for React components.
 *
 * Provides SWR-like interface (data/error/loading) with optional Zod
 * validation in dev/test mode. Uses the api-client module for typed fetching.
 *
 * Usage:
 *   const { data, error, loading, refetch } = useApi<PracticeListItemDTO[]>(url, schema);
 */
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ZodSchema } from 'zod';
import { apiGet, ApiClientError } from '@/lib/api-client';

export interface UseApiResult<T> {
    data: T | null;
    error: ApiClientError | Error | null;
    loading: boolean;
    refetch: () => Promise<void>;
}

export interface UseMutationResult<TInput, TOutput> {
    mutate: (input: TInput) => Promise<TOutput>;
    loading: boolean;
    error: ApiClientError | Error | null;
}

/**
 * Typed GET hook — fetches data on mount and provides refetch.
 *
 * @param url - API URL (pass null/undefined to skip fetching)
 * @param schema - Optional Zod schema for dev-mode validation
 */
export function useApi<T>(
    url: string | null | undefined,
    schema?: ZodSchema<T>,
): UseApiResult<T> {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<UseApiResult<T>['error']>(null);
    const [loading, setLoading] = useState(!!url);
    const urlRef = useRef(url);
    // "ref-as-mailbox" — keeps fetchData reading the latest url without re-binding the listener.
    // eslint-disable-next-line react-hooks/refs
    urlRef.current = url;

    const fetchData = useCallback(async () => {
        const currentUrl = urlRef.current;
        if (!currentUrl) return;
        setLoading(true);
        setError(null);
        try {
            const result = await apiGet<T>(currentUrl, schema);
            setData(result);
        } catch (e) {
            setError(e instanceof Error ? e : new Error(String(e)));
        } finally {
            setLoading(false);
        }
    }, [schema]);

    useEffect(() => {
        if (url) {
            fetchData();
        }
    }, [url, fetchData]);

    return { data, error, loading, refetch: fetchData };
}

/**
 * Typed mutation hook — wraps POST/PATCH/DELETE with loading/error state.
 *
 * @param mutationFn - Async function performing the mutation
 */
export function useMutation<TInput, TOutput>(
    mutationFn: (input: TInput) => Promise<TOutput>,
): UseMutationResult<TInput, TOutput> {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<UseMutationResult<TInput, TOutput>['error']>(null);

    const mutate = useCallback(async (input: TInput): Promise<TOutput> => {
        setLoading(true);
        setError(null);
        try {
            const result = await mutationFn(input);
            return result;
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            setError(err);
            throw err;
        } finally {
            setLoading(false);
        }
    }, [mutationFn]);

    return { mutate, loading, error };
}
