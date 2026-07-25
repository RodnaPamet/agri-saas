/**
 * Next.js Instrumentation Hook — called once on server startup.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
    // Only initialize on the server (Node.js runtime), not Edge.
    if (process.env.NEXT_RUNTIME === 'nodejs' || !process.env.NEXT_RUNTIME) {
        // ── GAP-13: Redis is required in production ──
        // Defense-in-depth alongside the env-schema check (`src/env.ts`):
        // schema validation catches missing REDIS_URL at module load,
        // this hook catches the case where SKIP_ENV_VALIDATION=1 leaks
        // into the runtime container.
        //
        // The previous incarnation of this check had a `RATE_LIMIT_ENABLED=0`
        // escape hatch — that's been removed because Redis underpins more
        // than the rate limiter. Login brute-force throttle (Epic A.3),
        // invite-redemption limit, email-dispatch limit, and BullMQ jobs
        // all break silently when Redis is absent. Toggling rate limits
        // off doesn't make Redis optional in production.
        if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL) {

            console.error(
                '[startup] FATAL: REDIS_URL is required in production. ' +
                'Rate limits, queues, and session coordination depend on it. ' +
                'Set REDIS_URL to your Redis / ElastiCache connection string.',
            );
            process.exit(1);
        }

        // ── GAP-03: DATA_ENCRYPTION_KEY is required in production ──
        // Defense-in-depth alongside the env-schema check (`src/env.ts`):
        // schema validation catches missing/wrong-fallback configs at
        // module load, this hook catches the case where
        // SKIP_ENV_VALIDATION=1 leaks into the runtime container, and
        // the sentinel pre-flight catches structurally-valid keys that
        // happen to fail HKDF/AES (e.g. binary garbage written to env).
        //
        // The check + sentinel logic lives in
        // `@/lib/security/startup-encryption-check` so it's unit-testable
        // without spawning a child process that calls process.exit(1).
        if (process.env.NODE_ENV === 'production') {
            const { checkProductionEncryptionKey, runEncryptionSentinel } =
                await import('@/lib/security/startup-encryption-check');

            const config = checkProductionEncryptionKey(process.env);
            if (!config.ok) {

                console.error('[startup] FATAL: ' + config.reason);
                process.exit(1);
            }

            const sentinel = await runEncryptionSentinel();
            if (!sentinel.ok) {

                console.error('[startup] FATAL: ' + sentinel.reason);
                process.exit(1);
            }
        }

        // GAP-05 — Next 15's bundler resolves `await import('node:events')`
        // to a Module namespace where `EventEmitter` lives at .default
        // rather than as a named export, so the previous destructure
        // here threw `Cannot read properties of undefined (reading
        // 'defaultMaxListeners')` and the entire instrumentation hook
        // unhandled-rejected on every request. The EventEmitter cap is
        // already raised at config-load time in next.config.js (top-
        // level require, no bundler involved); this duplicate raise was
        // belt-and-suspenders for very early bootstrap, redundant once
        // next.config.js runs. Removed entirely.

        const { initTelemetry } = await import('@/lib/observability/instrumentation');
        const { initSentry } = await import('@/lib/observability/sentry');
        // Swap the mailer to SMTP when SMTP_HOST is configured. Without
        // this the mailer stays on the dev console sink and NO email
        // (verification, password reset, notifications, invites) is ever
        // delivered in production. No-op (console sink) when SMTP is unset.
        const { initMailerFromEnv } = await import('@/lib/mailer');
        const { installAutomationBusDispatcher } = await import(
            '@/app-layer/automation/bus-bootstrap'
        );
        const { installRlsTripwire } = await import('@/lib/db/rls-middleware');
        const { prisma } = await import('@/lib/prisma');
        const { installShutdownHandlers } = await import('@/lib/observability/shutdown');
        await initTelemetry();
        initSentry();
        initMailerFromEnv();
        // Wire the automation bus to the BullMQ queue so domain
        // events emitted from usecases enqueue dispatch jobs.
        installAutomationBusDispatcher();
        // Install the RLS observability tripwire. Idempotent — safe
        // under HMR. Installed here (not in `prisma.ts`) to avoid a
        // circular import with `db/rls-middleware.ts`.
        installRlsTripwire(prisma);
        // Register SIGTERM/SIGINT handlers that drain audit-stream
        // buffers, OTel exporters, and Sentry transport before the
        // process exits. Idempotent under HMR.
        installShutdownHandlers();

        // ── Satellite capability signal (NOT fail-fast) ──
        // Google Earth Engine is OPTIONAL by design: with no credentials
        // /farm-risk reports "no data" levels and the field briefing runs
        // without satellite input — the product degrades honestly. But a prod
        // deploy whose GEE keys were never set (or were dropped) goes dark
        // SILENTLY: no error, no empty state an operator would notice, just
        // permanently blank readings. Log it once at startup so "satellite is
        // off" is discoverable in the logs, and report it in `/api/readyz`
        // under `capabilities.satellite` for dashboards. Deliberately a WARN,
        // not an exit — mirrors the DEK dev-fallback warning.
        if (process.env.NODE_ENV === 'production') {
            const { geeConfigStatus } = await import('@/lib/agro/gee-config');
            const satellite = geeConfigStatus();
            if (!satellite.configured) {
                const { logger } = await import('@/lib/observability/logger');
                logger.warn(
                    'satellite (Google Earth Engine) is not configured — /farm-risk and the field briefing will run without imagery',
                    { component: 'startup', missing: satellite.missing },
                );
            }
        }

        // Verify Redis is not configured to EVICT keys — BullMQ job
        // state lives in Redis, so an eviction `maxmemory-policy`
        // would silently drop queued jobs. Best-effort + non-blocking:
        // it logs loudly on a violation but never crash-loops the
        // process (a drifted deployment must stay up). The fail-fast
        // gate is the structural guard at PR time
        // (tests/guards/redis-eviction-policy.test.ts).
        const { verifyRedisEvictionPolicy } = await import('@/lib/redis');
        void verifyRedisEvictionPolicy().catch(() => {
            // A diagnostic check must never break startup.
        });
    }
}

