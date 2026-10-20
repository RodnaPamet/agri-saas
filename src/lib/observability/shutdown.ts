import { flushAllAuditStreams } from '@/app-layer/events/audit-stream';
import { shutdownTelemetry } from './instrumentation';
import { shutdownSentry } from './sentry';
import { logger } from './logger';
import { drainOpenStreams } from '@/lib/realtime/stream-drain';
import {
    SHUTDOWN_AUDIT_FLUSH_MS,
    SHUTDOWN_OTEL_MS,
    SHUTDOWN_SENTRY_MS,
} from './shutdown-budget';

/**
 * One-shot SIGTERM / SIGINT handler.
 *
 * Two kinds of work, and the difference decides whether each one actually
 * runs:
 *
 *   0. **Open streams, synchronously** (P7.3, #1992). Closed first, with a
 *      final frame, so clients reconnect onto the next container instead of
 *      dying mid-chunk.
 *   1. audit-stream buffers — outbound SIEM forwarding, best-effort
 *   2. OTel span/metric exporters — observability-only
 *   3. Sentry transport — observability-only
 *
 * ## Stage 0 completes and stages 1-3 usually do not
 *
 * Node invokes every signal listener synchronously, in registration order,
 * within one `emit`. `next start` registers its own handler, which does its
 * work inside an `async` IIFE and ends in `process.exit(143)` — so it cannot
 * exit before yielding at its first `await`, and any SYNCHRONOUS work here
 * lands first regardless of which listener was registered first.
 *
 * Anything awaited here is racing that exit, and loses: measured in production
 * over 7 days, `graceful shutdown initiated` 58 times and
 * `graceful shutdown complete` **once** (#2091). That is why stage 0 is
 * synchronous, and why the stages below are documented as best-effort rather
 * than as a drain anybody may rely on.
 *
 * This file previously said "NEVER calls process.exit — next start owns the
 * HTTP lifecycle; we let Node exit naturally once all handlers finish and the
 * event loop drains". The first clause is still true and the rest was not:
 * Next does not let Node exit naturally, it calls `process.exit`. Deferring to
 * it means being cut off rather than waited for. Owning the signal instead
 * would mean a custom server — `NEXT_MANUAL_SIG_HANDLE` is documented for the
 * Pages Router and gives no handle on the `http.Server` either way — and Next's
 * own self-hosting guidance for the App Router is the opposite: send the signal
 * and allow a 10-30s drain period, which is what `stop_grace_period: 30s` in
 * `deploy/docker-compose.prod.yml` now does.
 *
 * Idempotent installation: guards against double registration under
 * HMR / test re-imports via a module flag.
 */

let _installed = false;

export function installShutdownHandlers(): void {
    if (_installed) return;
    _installed = true;

    const handler = async (signal: 'SIGTERM' | 'SIGINT') => {
        logger.info('graceful shutdown initiated', {
            component: 'shutdown',
            signal,
        });

        // Stage 0 — open streams, SYNCHRONOUSLY and before the first `await`.
        // Everything after this point may be truncated by Next's exit; this
        // cannot be, and it is the stage with a user-visible consequence.
        drainOpenStreams();

        // Stage 1 — audit forwarding. Best-effort from here down: see the
        // docblock for why anything awaited here is racing `process.exit`.
        await Promise.race([
            flushAllAuditStreams().catch((err) => {
                logger.warn('shutdown: audit flush failed', {
                    component: 'shutdown',
                    error: err instanceof Error ? err.message : String(err),
                });
            }),
            new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_AUDIT_FLUSH_MS)),
        ]);

        // Stage 2 — OTel (never throws by contract)
        await shutdownTelemetry(SHUTDOWN_OTEL_MS);

        // Stage 3 — Sentry (never throws by contract)
        await shutdownSentry(SHUTDOWN_SENTRY_MS);

        logger.info('graceful shutdown complete', {
            component: 'shutdown',
            signal,
        });
    };

    // Register one listener per signal. Use once() semantics so a second
    // SIGTERM (common in container runtimes as an escalation) fires the
    // Node default — ensures we don't block termination if the first
    // handler hangs despite the budgets.
    process.once('SIGTERM', () => { void handler('SIGTERM'); });
    process.once('SIGINT', () => { void handler('SIGINT'); });
}

/**
 * Test-only: resets the install flag. Does NOT remove listeners already
 * attached — use process.removeAllListeners('SIGTERM') in your afterEach
 * if the test registered real handlers.
 * @internal
 */
export function _resetShutdownInstalledForTesting(): void {
    _installed = false;
}
