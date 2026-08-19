'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/query-client';
import { OnboardingTourProvider } from '@/components/ui/OnboardingTour';
import SWRDevTools from '@/components/dev/swr-devtools';
import { UnsyncedWorkBanner } from '@/components/offline/UnsyncedWorkBanner';

/**
 * Client-only providers for the tenant app.
 *
 * This wrapper isolates all client-runtime providers from server-rendered
 * layouts, making the server/client boundary explicit and clean.
 *
 * Currently wraps:
 *   - QueryClientProvider (react-query) — required by pages that use
 *     useQuery/useMutation for data fetching
 *   - OnboardingTourProvider (Driver.js-based product tour) — owns the
 *     auto-trigger gate + completion persistence; <StartTourButton>
 *     in the sidebar consumes it via useOnboardingTour()
 *
 * NOT included here (and why):
 *   - SessionProvider — lives in root layout (src/app/providers.tsx) because
 *     it's needed app-wide, including non-tenant routes like /login
 *   - NextIntlClientProvider — lives in root layout, driven by server-resolved
 *     locale/messages
 *   - TenantProvider — lives in tenant layout (src/app/t/[tenantSlug]/layout.tsx),
 *     driven by server-resolved tenant context
 *
 * @example
 * ```tsx
 * // In a server layout:
 * <ClientProviders userId={session.user.id}>
 *   {children}
 * </ClientProviders>
 * ```
 */
export function ClientProviders({
    children,
    userId,
}: {
    children: React.ReactNode;
    /** Authenticated user id — passed in from the server layout so the
     *  Driver.js tour can persist completion per-user. Null on routes
     *  rendered before authentication completes; the provider stays
     *  inert in that case. */
    userId?: string | null;
}) {
    // Suppress the Driver.js auto-trigger in E2E test runs. Without
    // this, every freshly-seeded test user counts as a first-login
    // candidate (no completion record in localStorage) and the tour
    // overlay covers the page mid-test, blocking Playwright's
    // selector-visibility checks. The manual "Take the tour" button
    // in the sidebar still works regardless.
    //
    // `NEXT_PUBLIC_TEST_MODE` is set by `scripts/e2e-local.mjs` and the
    // playwright.config.ts webServer command. Reading via `process.env`
    // is safe here: Next.js inlines `NEXT_PUBLIC_*` at build time, so
    // the value the client sees is the value the server was built with.
    const autoTrigger =
        process.env.NEXT_PUBLIC_TEST_MODE !== '1' &&
        process.env.NODE_ENV !== 'test';
    return (
        <QueryClientProvider client={getQueryClient()}>
            <OnboardingTourProvider
                userId={userId ?? null}
                autoTriggerOnFirstLogin={autoTrigger}
            >
                {/*
                  App-wide unsynced-work truth (Roadmap: outbox durability).
                  Renders NOTHING when the queue is empty and no work has been
                  lost, so it costs a subscription and no layout on the normal
                  path. It is mounted here rather than per-page because a
                  pending count that disappears when the operator navigates is
                  not a pending count — and because mounting the offline hook
                  app-wide puts the foreground flush on every tenant page.
                */}
                <UnsyncedWorkBanner />
                {children}
                {/*
                  Epic 69 — dev-only floating SWR cache inspector.
                  Self-gated against NODE_ENV !== 'development' AND
                  NEXT_PUBLIC_TEST_MODE === '1'; renders nothing in
                  prod / E2E runs. Tree-shaken from prod bundles.
                */}
                <SWRDevTools />
            </OnboardingTourProvider>
        </QueryClientProvider>
    );
}
