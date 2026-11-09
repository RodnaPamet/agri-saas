/**
 * Next.js client instrumentation entry (runs once in the browser before the
 * app renders). The Next 16 replacement for `sentry.client.config.ts` — Next
 * auto-loads this module on the client, so no `withSentryConfig` wrapper is
 * needed.
 *
 * It wires the browser Sentry SDK (DSN-gated; a no-op without one) so that
 * `global-error.tsx`'s `captureException` and uncaught client errors actually
 * transmit. See `sentry-client.ts` for the sampling rationale.
 */
import { initClientSentry } from '@/lib/observability/sentry-client';

/*
 * READ FROM `process.env`, NOT `@/env` — #2353.
 *
 * Next auto-loads this module in the BROWSER on every route, so importing
 * `@/env` here put 944 lines of environment schema — and zod, via its first
 * import `@/lib/zod-jitless` — into the client bundle on every page, to
 * resolve two optional strings. `next build` inlines `NEXT_PUBLIC_*`, so the
 * direct read is the idiomatic client form and compiles to the same literal.
 *
 * The declarations STAY in `env.ts`'s `client` block: @t3-oss validates client
 * vars on the server too, so startup validation is unchanged, and
 * `next-public-vars-are-settable` still sees the names it checks for a
 * Dockerfile `ARG`. Both of these carry one.
 */
initClientSentry(process.env.NEXT_PUBLIC_SENTRY_DSN, {
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
});
