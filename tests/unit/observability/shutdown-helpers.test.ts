/**
 * Unit tests for the paired shutdown helpers added alongside initTelemetry
 * and initSentry. PR 6 (installShutdownHandlers) calls both on SIGTERM.
 *
 * Contract both must satisfy:
 *   - Noop + resolve when init was never called (or ran with guards off).
 *   - Bounded by timeoutMs — shutdown NEVER hangs the process.
 *   - Idempotent — calling twice is safe.
 *   - Never throws.
 */

import { shutdownTelemetry, _resetForTesting as resetTelemetry, isTelemetryInitialized } from '@/lib/observability/instrumentation';
import { shutdownSentry, _resetForTesting as resetSentry, isSentryInitialized } from '@/lib/observability/sentry';

describe('shutdownTelemetry', () => {
    beforeEach(() => {
        resetTelemetry();
    });

    /**
     * The noop path is asserted on the MECHANISM, not on a wall clock (#2619).
     *
     * These two read `expect(Date.now() - start).toBeLessThan(50)` until
     * 2026-11-01, and a 50 ms budget cannot tell "the function returned
     * promptly" from "this runner's event loop was busy for 51 ms". It failed
     * shard 6/6 on PR #2611 — a mobile-card change touching nothing in this
     * import graph — and passed on a plain re-run of the same commit. A test
     * about the machine, arriving attributed to whoever had a PR open.
     *
     * What the contract actually says is "noop + resolve when init was never
     * called", and the implementation makes that observable without timing
     * anything:
     *
     *     if (!_shutdown) return;                      // before any await
     *     await Promise.race([ shutdown(),
     *         new Promise((r) => setTimeout(r, timeoutMs)) ]);
     *
     * So on the noop path **no timer is scheduled**. Spying on `setTimeout`
     * asserts exactly that, and is load-independent: a busy runner cannot
     * schedule a timer the code did not ask for.
     */
    it('schedules no timer when OTel was never initialised', async () => {
        expect(isTelemetryInitialized()).toBe(false);
        const timer = jest.spyOn(global, 'setTimeout');
        try {
            await shutdownTelemetry(5_000);
            expect(timer).not.toHaveBeenCalled();
        } finally {
            timer.mockRestore();
        }
    });

    it('is idempotent — the second call schedules no timer either', async () => {
        await shutdownTelemetry(5_000);
        const timer = jest.spyOn(global, 'setTimeout');
        try {
            await shutdownTelemetry(5_000);
            expect(timer).not.toHaveBeenCalled();
        } finally {
            timer.mockRestore();
        }
    });

    /**
     * The same property from the other side, and the control that gives the
     * two above their teeth: with the clock FROZEN the promise still settles.
     *
     * If the noop path ever started awaiting its timeout race, this would hang
     * rather than resolve — which a `setTimeout` spy alone cannot distinguish
     * from a timer scheduled and ignored.
     */
    it('settles with the clock frozen — nothing is awaited', async () => {
        jest.useFakeTimers();
        try {
            let settled = false;
            const p = shutdownTelemetry(5_000).then(() => {
                settled = true;
            });
            // Drain microtasks WITHOUT advancing timers.
            await Promise.resolve();
            await p;
            expect(settled).toBe(true);
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    /**
     * RENAMED to what it does, and the gap it was covering for is now stated
     * rather than claimed away (#2619).
     *
     * It read `respects the timeout budget — hung shutdown closure unblocks at
     * timeoutMs`, and its own comment conceded it tests no such thing:
     * "calling shutdown with no init + very short budget — this covers the fast
     * path. The hung-closure case is covered at the integration level in PR 6
     * (installShutdownHandlers)."
     *
     * **That alibi is false.** `tests/unit/observability/shutdown.test.ts`
     * covers `installShutdownHandlers`' ORDERING (audit flush → OTel → Sentry)
     * and that OTel and Sentry still run when the flush throws. Nothing in it,
     * or in `shutdown-init-wiring` / `sigterm-drain-is-synchronous`, populates
     * a hung closure and watches the race unblock. So the `Promise.race`
     * against a per-stage budget — which Epic E.3 documents as what stops a
     * slow exporter outliving the container grace period — has no test at all,
     * and the test named for it exercised the noop path with a 200 ms wall
     * clock.
     *
     * Reaching the race needs a seam: both helpers gate on a module-private
     * flag (`_shutdown` / `_initialized`) with no setter, and
     * `_resetForTesting` only clears them. Adding that seam is a source change
     * and is filed separately rather than smuggled into a test rename.
     *
     * What survives is the one property this body actually establishes, now on
     * the mechanism rather than a clock: a SHORT budget does not change the
     * noop path.
     */
    it('a short budget does not change the noop path — still no timer', async () => {
        const timer = jest.spyOn(global, 'setTimeout');
        try {
            await shutdownTelemetry(100);
            expect(timer).not.toHaveBeenCalled();
        } finally {
            timer.mockRestore();
        }
    });
});

describe('shutdownSentry', () => {
    beforeEach(() => {
        resetSentry();
    });

    /**
     * The same treatment as `shutdownTelemetry` above, for the same reason
     * (#2619).
     *
     * `shutdownSentry` has the identical shape — `if (!_initialized) return;`
     * before a `Promise.race` against `setTimeout(timeoutMs + 100)` — so the
     * noop path schedules no timer here either, and timing it on a wall clock
     * had the same flake. #2619 named only the telemetry pair; this half was
     * two functions away with the same defect, and fixing one of two identical
     * bugs is not a fix.
     */
    it('schedules no timer when Sentry was never initialised (no SENTRY_DSN)', async () => {
        expect(isSentryInitialized()).toBe(false);
        const timer = jest.spyOn(global, 'setTimeout');
        try {
            await shutdownSentry(5_000);
            expect(timer).not.toHaveBeenCalled();
        } finally {
            timer.mockRestore();
        }
    });

    it('is idempotent — the second call schedules no timer either', async () => {
        await shutdownSentry(5_000);
        const timer = jest.spyOn(global, 'setTimeout');
        try {
            await shutdownSentry(5_000);
            expect(timer).not.toHaveBeenCalled();
        } finally {
            timer.mockRestore();
        }
    });

    it('settles with the clock frozen — nothing is awaited', async () => {
        jest.useFakeTimers();
        try {
            let settled = false;
            const p = shutdownSentry(5_000).then(() => {
                settled = true;
            });
            await Promise.resolve();
            await p;
            expect(settled).toBe(true);
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});
