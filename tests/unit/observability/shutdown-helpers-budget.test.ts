/**
 * The budgets INSIDE the two helpers, with a hung transport (#2635).
 *
 * There are THREE races in this mechanism, not one: stage 1's is written in
 * `shutdown.ts` and is covered by `shutdown-budget.test.ts`; stages 2 and 3
 * own theirs, inside `shutdownTelemetry` and `shutdownSentry`. Covering only
 * the first would leave two thirds of the property untested while the file
 * name said otherwise.
 *
 * `shutdown-helpers.test.ts` reaches neither, and the reason is structural
 * rather than careless: both helpers return early unless the subsystem was
 * initialised (`if (!_shutdown) return` / `if (!_initialized) return`), so
 * every existing case exercises the branch BEFORE the race. Its own comment
 * says it could not call `initTelemetry` because that needs "a real OTel
 * collector". It does not — it needs the SDK mocked, which is what this file
 * does.
 */
jest.mock('@sentry/nextjs', () => ({
    init: jest.fn(),
    close: jest.fn(),
    setUser: jest.fn(),
    captureException: jest.fn(),
    withScope: jest.fn(),
}));

import * as Sentry from '@sentry/nextjs';
import { initSentry, shutdownSentry, isSentryInitialized } from '@/lib/observability/sentry';

const mockClose = Sentry.close as jest.MockedFunction<typeof Sentry.close>;

/** Drain microtasks without advancing the fake clock. */
async function microtasks(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const ORIGINAL_DSN = process.env.SENTRY_DSN;

afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = ORIGINAL_DSN;
});

describe('stage 3: a HUNG Sentry transport does not hold the shutdown (#2635)', () => {
    const BUDGET = 2_000;
    /** `shutdownSentry` races `close(timeoutMs)` against `timeoutMs + 100`. */
    const INNER_MARGIN = 100;

    beforeEach(() => {
        jest.useFakeTimers();
        process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.example.test/0';
        initSentry();
        // A transport that accepted the event and never answers. This is the
        // case `Sentry.close()`'s own timeout is supposed to cover and which
        // the docblock says we do not rely on — "a misbehaving transport".
        mockClose.mockReturnValue(new Promise<boolean>(() => {}));
    });

    it('is genuinely BLOCKED before the budget elapses — the control', async () => {
        // Without this the assertion below passes against a helper that never
        // waited at all.
        expect(isSentryInitialized()).toBe(true);
        let settled = false;
        void shutdownSentry(BUDGET).then(() => {
            settled = true;
        });
        await microtasks();
        expect(mockClose).toHaveBeenCalledWith(BUDGET);
        expect(settled).toBe(false);

        jest.advanceTimersByTime(BUDGET + INNER_MARGIN - 1);
        await microtasks();
        expect(settled).toBe(false);
    });

    it('resolves on its own timer once the budget elapses', async () => {
        let settled = false;
        void shutdownSentry(BUDGET).then(() => {
            settled = true;
        });
        await microtasks();

        jest.advanceTimersByTime(BUDGET + INNER_MARGIN);
        await microtasks();
        expect(settled).toBe(true);
    });

    it('clears `_initialized` even when the close never answers', async () => {
        // Otherwise a second signal (container runtimes escalate) would start
        // a second 2.1s wait on the same wedged transport.
        void shutdownSentry(BUDGET);
        await microtasks();
        expect(isSentryInitialized()).toBe(false);
    });
});

describe('a DSN-less initSentry still marks itself initialised (#2635)', () => {
    it('so shutdownSentry does NOT take its early return — it calls close()', async () => {
        // Measured, not predicted, and it is why this case is here rather than
        // in a note. `initSentry()` with no DSN sets `_initialized = true` and
        // returns without constructing a client. `shutdownSentry` guards on
        // that same flag, so it proceeds and calls `Sentry.close()` on an SDK
        // that was never initialised.
        //
        // The flag conflates "init was attempted" with "a client exists".
        // Harmless today — the real SDK's `close()` resolves immediately with
        // no client, so the stage costs nothing — and asserted so that a
        // future SDK whose `close()` blocks without a client cannot silently
        // spend the whole 2.1s budget on a deployment that never configured
        // Sentry at all.
        jest.useFakeTimers();
        delete process.env.SENTRY_DSN;
        initSentry();
        expect(isSentryInitialized()).toBe(true);

        mockClose.mockResolvedValue(true);
        await shutdownSentry(2_000);
        expect(mockClose).toHaveBeenCalledTimes(1);
    });
});
