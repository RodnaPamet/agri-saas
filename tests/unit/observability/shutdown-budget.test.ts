/**
 * The per-stage shutdown BUDGET, with a hung closure (#2635).
 *
 * CLAUDE.md states the property: `installShutdownHandlers()` drains audit
 * buffers, then OTel, then Sentry, "each `Promise.race`d against a per-stage
 * budget so a slow exporter never outlives the container grace period". That
 * race is what stops a wedged exporter holding the container past SIGTERM,
 * which in a one-container deployment is a deploy that does not finish.
 *
 * ## Nothing populated a hung closure
 *
 * `shutdown.test.ts` covers the ORDERING (audit → OTel → Sentry), that each
 * helper runs exactly once, and that OTel and Sentry still run when the flush
 * THROWS. A throw is not a hang: it settles, so the race is never the thing
 * that unblocks.
 *
 * `shutdown-helpers.test.ts` covers the NOOP path — "schedules no timer when
 * OTel was never initialised", "settles with the clock frozen". Those exercise
 * the early return, i.e. the branch BEFORE the race.
 *
 * And the test named for the budget conceded in its own body that it did not
 * test it, pointing at an integration test "where the whole pipeline is wired".
 * That test is `shutdown.test.ts`, which is the first paragraph above. **The
 * alibi named a test that does not cover it** — so the property had no test at
 * all, in either file, while one of them carried its name.
 *
 * So these cases hang the work and let the budget be the only thing that can
 * resolve them.
 */
import {
    SHUTDOWN_AUDIT_FLUSH_MS,
    SHUTDOWN_OTEL_MS,
    SHUTDOWN_SENTRY_MS,
    SHUTDOWN_TOTAL_CEILING_MS,
} from '@/lib/observability/shutdown-budget';

jest.mock('@/app-layer/events/audit-stream', () => ({
    flushAllAuditStreams: jest.fn(),
}));
jest.mock('@/lib/observability/instrumentation', () => ({
    shutdownTelemetry: jest.fn(),
}));
jest.mock('@/lib/observability/sentry', () => ({
    shutdownSentry: jest.fn(),
}));
jest.mock('@/lib/realtime/stream-drain', () => ({
    drainOpenStreams: jest.fn(),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn() },
}));

import { flushAllAuditStreams } from '@/app-layer/events/audit-stream';
import { shutdownTelemetry } from '@/lib/observability/instrumentation';
import { shutdownSentry } from '@/lib/observability/sentry';
import { drainOpenStreams } from '@/lib/realtime/stream-drain';
import { logger } from '@/lib/observability/logger';
import {
    installShutdownHandlers,
    _resetShutdownInstalledForTesting,
} from '@/lib/observability/shutdown';

const mockFlush = flushAllAuditStreams as jest.MockedFunction<typeof flushAllAuditStreams>;
const mockOtel = shutdownTelemetry as jest.MockedFunction<typeof shutdownTelemetry>;
const mockSentry = shutdownSentry as jest.MockedFunction<typeof shutdownSentry>;
const mockDrain = drainOpenStreams as jest.MockedFunction<typeof drainOpenStreams>;

/** Drain the microtask queue without advancing the fake clock. */
async function microtasks(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    _resetShutdownInstalledForTesting();
    jest.clearAllMocks();
    jest.useRealTimers();
});

describe('stage 1: a HUNG audit flush does not hold the shutdown (#2635)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        // Never settles. Only the budget's timer can resolve the race.
        mockFlush.mockReturnValue(new Promise<void>(() => {}));
        mockOtel.mockResolvedValue(undefined);
        mockSentry.mockResolvedValue(undefined);
    });

    it('is genuinely BLOCKED before the budget elapses — the control', async () => {
        // Without this, the case below passes against an implementation with no
        // race at all: "OTel ran after I advanced the clock" is also true of
        // code that never waited. This asserts the hang is real, so that the
        // next assertion is about the BUDGET and not about the mock.
        installShutdownHandlers();
        process.emit('SIGTERM');
        await microtasks();

        expect(mockDrain).toHaveBeenCalledTimes(1); // stage 0 is synchronous
        expect(mockOtel).not.toHaveBeenCalled();
        expect(mockSentry).not.toHaveBeenCalled();

        jest.advanceTimersByTime(SHUTDOWN_AUDIT_FLUSH_MS - 1);
        await microtasks();
        expect(mockOtel).not.toHaveBeenCalled();
    });

    it('proceeds to OTel and Sentry once the budget elapses', async () => {
        installShutdownHandlers();
        process.emit('SIGTERM');
        await microtasks();

        jest.advanceTimersByTime(SHUTDOWN_AUDIT_FLUSH_MS);
        await microtasks();

        expect(mockOtel).toHaveBeenCalledTimes(1);
        expect(mockOtel).toHaveBeenCalledWith(SHUTDOWN_OTEL_MS);
        expect(mockSentry).toHaveBeenCalledTimes(1);
        expect(mockSentry).toHaveBeenCalledWith(SHUTDOWN_SENTRY_MS);
    });

    it('still logs `graceful shutdown complete` — the handler RETURNS', async () => {
        // The stage resolving is not the same as the handler finishing. #2091
        // measured 58 `initiated` against one `complete` in production, so the
        // completion line is the one that distinguishes "the budget released
        // the stage" from "the handler is still parked somewhere later".
        installShutdownHandlers();
        process.emit('SIGTERM');
        await microtasks();
        jest.advanceTimersByTime(SHUTDOWN_AUDIT_FLUSH_MS);
        await microtasks();

        const lines = (logger.info as jest.Mock).mock.calls.map((c) => c[0]);
        expect(lines).toContain('graceful shutdown initiated');
        expect(lines).toContain('graceful shutdown complete');
    });

    it('a hung OTel stage does not stop Sentry either', async () => {
        // Each stage is awaited in turn, so the SECOND stage hanging is a
        // distinct failure from the first: it is the one that would strand
        // shutdown after the audit flush had already succeeded. The helper
        // owns its own race, so here it is mocked as already-bounded — what
        // this asserts is that `shutdown.ts` does not add an unbounded await
        // of its own around it.
        mockFlush.mockResolvedValue(undefined);
        mockOtel.mockImplementation(
            () => new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_OTEL_MS)),
        );
        installShutdownHandlers();
        process.emit('SIGTERM');
        await microtasks();

        expect(mockSentry).not.toHaveBeenCalled();
        jest.advanceTimersByTime(SHUTDOWN_OTEL_MS);
        await microtasks();
        expect(mockSentry).toHaveBeenCalledTimes(1);
    });
});

describe('the budget invariant the constants file states (#2635)', () => {
    it('the WORST CASE fits under the ceiling, counting Sentry’s extra 100ms', () => {
        // `shutdownSentry` races `Sentry.close(timeoutMs)` against a timer of
        // `timeoutMs + 100`, so stage 3's real bound is 2100ms, not
        // SHUTDOWN_SENTRY_MS. Summing the three constants understates the
        // worst case by that margin — small today, and the reason to assert
        // the real figure is that a future stage could be added with a
        // similar internal margin and the sum would stay reassuring.
        const SENTRY_INNER_MARGIN_MS = 100;
        const worstCase =
            SHUTDOWN_AUDIT_FLUSH_MS + SHUTDOWN_OTEL_MS + SHUTDOWN_SENTRY_MS + SENTRY_INNER_MARGIN_MS;

        expect(worstCase).toBeLessThanOrEqual(SHUTDOWN_TOTAL_CEILING_MS);
        // And the ceiling must leave room for Next's parallel HTTP drain,
        // which is what the constants file says it is for. 30s grace period.
        expect(SHUTDOWN_TOTAL_CEILING_MS).toBeLessThan(30_000);
    });

    it('every stage budget is positive — a zero would disable its stage', () => {
        // A zero budget resolves the race immediately, which reads as "bounded"
        // and means "never runs". Asserted because it is the one edit to this
        // file that would pass the ceiling check above while silently removing
        // all three drains.
        for (const ms of [SHUTDOWN_AUDIT_FLUSH_MS, SHUTDOWN_OTEL_MS, SHUTDOWN_SENTRY_MS]) {
            expect(ms).toBeGreaterThan(0);
        }
    });
});
