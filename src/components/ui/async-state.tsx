'use client';

/**
 * <AsyncState> — one place that decides what a client-fetched region shows.
 *
 * ## Why this exists
 *
 * `useTenantSWR` returns `{ data, error, isLoading }`. Nothing obliged a caller
 * to render `error`, and across the app most did not — they wrote
 * `{!data ? <Skeleton/> : <content/>}` and stopped. That is fine online, where
 * a fetch resolves in a moment. It is wrong in a product whose users are
 * defined by NOT having signal.
 *
 * Measured on a physical iPhone in airplane mode, 2026-09-10 (#862):
 *
 *   - two dashboard cards showed a loading skeleton FOREVER
 *   - the "your farm today" strip vanished entirely, identical to a tenant
 *     that never had those modules
 *   - and My work told an operator with queued jobs that they had **no
 *     records**, because SWR gave up after two retries, set `isLoading` false
 *     with `data` still undefined, and the render fell through to the
 *     `rows.length === 0` branch
 *
 * Each is the same defect: an observable produced identically by the healthy
 * and the broken path. "No records" means both *empty* and *unreachable*; a
 * skeleton means both *loading* and *will never load*.
 *
 * ## The rule this encodes
 *
 * **No data and not loading is a FAILURE, never an empty state.** That branch
 * is the one that produced the worst of the three, and it is the one a hand-
 * written ternary always forgets, because it does not look like it exists.
 *
 * Offline gets its own copy: "no signal, it will load when you are back" is a
 * different instruction to a person in a field than "something went wrong".
 *
 * ## Not for
 *
 * Server-rendered data (there is no fetch to fail), or mutations (those get a
 * toast with rollback).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Cloud } from '@/components/ui/icons/nucleo/cloud';
import { ErrorState } from './error-state';

/**
 * Live online/offline flag.
 *
 * Starts `true` and syncs after mount: `navigator` does not exist during SSR,
 * and assuming offline would flash a failure state on every first paint.
 */
export function useIsOnline(): boolean {
    const [online, setOnline] = useState(true);

    useEffect(() => {
        const sync = () => {
            setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
        };
        sync();
        window.addEventListener('online', sync);
        window.addEventListener('offline', sync);
        return () => {
            window.removeEventListener('online', sync);
            window.removeEventListener('offline', sync);
        };
    }, []);

    return online;
}

export interface AsyncStateProps<T> {
    /** `data` from the SWR result. */
    data: T | undefined;
    /** `error` from the SWR result. Pass it — that is the entire point. */
    error?: unknown;
    /** `isLoading` from the SWR result. */
    isLoading?: boolean;
    /** What to show while the FIRST load is genuinely in flight. */
    skeleton: ReactNode;
    /** Usually SWR's `mutate`. Omit only when a retry cannot help. */
    onRetry?: () => void;
    /** Rendered with the resolved data. */
    children: (data: T) => ReactNode;
    className?: string;
    'data-testid'?: string;
}

export function AsyncState<T>({
    data,
    error,
    isLoading,
    skeleton,
    onRetry,
    children,
    className,
    'data-testid': dataTestId,
}: AsyncStateProps<T>): ReactNode {
    const t = useTranslations('offline');
    const online = useIsOnline();

    if (data !== undefined) return children(data);

    // Loading is only loading while there is no error. SWR keeps `isLoading`
    // true across its retry window, so checking it first would hide a failure
    // behind a skeleton for as long as the retries last.
    if (isLoading && !error) return skeleton;

    // Everything else is a failure — INCLUDING "not loading, no error, no
    // data", which is what SWR leaves behind after it gives up. Rendering
    // nothing here is the "no records" lie.
    return online ? (
        <ErrorState
            title={t('loadFailedTitle')}
            description={t('loadFailedBody')}
            onRetry={onRetry}
            retryLabel={t('retry')}
            className={className}
            data-testid={dataTestId ?? 'async-state-error'}
        />
    ) : (
        <ErrorState
            icon={Cloud}
            title={t('needsConnectionTitle')}
            description={t('needsConnectionBody')}
            onRetry={onRetry}
            retryLabel={t('retry')}
            className={className}
            data-testid={dataTestId ?? 'async-state-offline'}
        />
    );
}
