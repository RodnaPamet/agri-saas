'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { ErrorState } from '@/components/ui/error-state';
import { Card } from '@/components/ui/card';
import { useChunkErrorRecovery } from '@/lib/pwa/use-chunk-error-recovery';

/**
 * Error boundary for the tenant-scoped app shell.
 *
 * Catches errors that occur inside any page within (app)/ — e.g. tasks,
 * practices, policies — and renders a recovery UI *inside* the sidebar layout.
 * Without this, errors bubble up to the root error.tsx, which unmounts
 * the entire app shell (leaving users on a blank page with no navigation).
 *
 * Architecture:
 *   root layout → [tenantSlug]/layout (server) → (app)/layout (client)
 *                                                  ↳ error.tsx  ← THIS FILE
 *   This sits below the sidebar / navbar but above page content.
 *
 * R11-PR3 — routes the page-level error chrome through the shared
 * `<ErrorState>` primitive so failures read consistently with in-card
 * error fallbacks (e.g. failed list fetches).
 */
export default function AppSectionError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    // Stale-chunk recovery: a lazy chunk that 404s after a deploy (client on an
    // old SW bundle) throws a ChunkLoadError into this boundary. Reload once onto
    // the fresh assets instead of stranding the operator — see the hook.
    const recovering = useChunkErrorRecovery(error);

    useEffect(() => {
        console.error('[AppSectionError]', error);
        // Report to Sentry — the root boundary did, but this sub-route boundary
        // (which catches every /(app) page error) did NOT, so page-level crashes
        // were invisible in Sentry. try/catch so the boundary never re-throws.
        try {
            Sentry.captureException(error, {
                tags: { digest: error.digest || 'none', boundary: 'app-section' },
            });
        } catch {
            /* Sentry unavailable — the console.error above still records it */
        }
    }, [error]);

    // While a chunk-error reload is imminent, render nothing (no error flash).
    if (recovering) return null;

    return (
        <div className="space-y-section animate-fadeIn">
            <Card className="max-w-xl mx-auto mt-12">
                <ErrorState
                    title="Something went wrong"
                    description={
                        <>
                            This page encountered an error. You can try again or
                            navigate to another section using the sidebar.
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
                            window.location.href = '/dashboard';
                        },
                    }}
                    data-testid="app-section-error"
                />
            </Card>
        </div>
    );
}
