'use client'; // Error boundaries must be Client Components

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { ErrorState } from '@/components/ui/error-state';
import { Card } from '@/components/ui/card';
import { useChunkErrorRecovery } from '@/lib/pwa/use-chunk-error-recovery';

/**
 * Global Error Boundary for the Next.js App Router.
 * Automatically catches unhandled errors in server and client components
 * within the `/app` directory, preventing the app from crashing entirely.
 *
 * R11-PR3 — routes the root error chrome through the shared
 * `<ErrorState>` primitive so failures read consistently with in-card
 * error fallbacks (e.g. failed list fetches) and with the (app)/error.tsx
 * sub-route boundary.
 */
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    // Stale-chunk recovery (same as the (app) boundary) for errors that escape
    // the app shell — reload once onto fresh assets instead of a dead-end.
    const recovering = useChunkErrorRecovery(error);

    useEffect(() => {
        // Report to Sentry — wrapped in try/catch so the error boundary
        // itself never crashes (which causes "missing required error components")
        try {
            Sentry.captureException(error, {
                tags: { digest: error.digest || 'none' },
            });
        } catch {
            console.error('[error.tsx] Failed to report to Sentry:', error);
        }
    }, [error]);

    if (recovering) return null;

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-bg-page p-6">
            <Card elevation="floating" className="max-w-md w-full">
                <ErrorState
                    title="Something went wrong"
                    description={
                        <>
                            We&apos;re sorry, an unexpected error has occurred.
                            Our team has been notified.
                            {error.digest && (
                                <span className="block mt-2 text-xs font-mono text-content-subtle">
                                    Error ID: {error.digest}
                                </span>
                            )}
                        </>
                    }
                    onRetry={() => reset()}
                    secondaryAction={{
                        label: 'Go to Dashboard',
                        onClick: () => {
                            window.location.href = new URL('/dashboard', window.location.origin).href;
                        },
                    }}
                    data-testid="global-error"
                />
            </Card>
        </div>
    );
}
