/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring
 * runtime contracts (a `process.once` spy, dynamic-import module factories);
 * the file-level disable is this codebase's standard pattern for these
 * surfaces (see tests/unit/mfa-gate-enforced.test.ts). */

/**
 * The graceful-shutdown drain must be INSTALLED BY STARTUP — not merely
 * exist as a function somebody could call.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `installShutdownHandlers()` is called from exactly ONE place in the whole
 * repo — `src/instrumentation.ts` (the Next.js instrumentation hook, inside
 * the `NEXT_RUNTIME === 'nodejs'` branch). And `flushAllAuditStreams()` — the
 * only thing that pushes buffered audit events to a tenant's SIEM — has
 * exactly ONE production caller: `src/lib/observability/shutdown.ts`, reached
 * only through that installed listener. So that single call is the entire
 * distance between a rolling deploy and irreversible audit loss.
 *
 * Nothing guarded it. Measured before this file was written: no test in the
 * repo imported `src/instrumentation.ts` at all, so deleting the call left
 * the whole suite green. `tsconfig.json` sets no `noUnusedLocals`, so the
 * now-dead destructure of `installShutdownHandlers` above it does not even
 * raise a tsc error. `tests/unit/observability/shutdown.test.ts` is green
 * throughout — it calls `installShutdownHandlers()` itself, which is the same
 * severed-seam shape as `token.mfaPending` before
 * `tests/unit/mfa-gate-enforced.test.ts`: the mechanism is tested, the
 * enforcement point is not.
 *
 * WHY IT MATTERS FOR THIS PRODUCT. Audit rows on this platform are the
 * regulatory record — spray applications, field operations, storage
 * movements: the trail a БАБХ inspection reads. Epic C.4 streams every
 * committed audit row to the tenant's configured `auditStreamUrl`, but it
 * buffers first, in a process-local `Map`, flushing only at 100 events or 5
 * seconds (and the periodic timer is `.unref()`d, so it never delays exit).
 * The agrent VM runs a Watchtower-driven rolling deploy: the container gets
 * SIGTERM. Without this listener the process exits with that Map in memory
 * and up to 99 events per tenant are gone — not delayed, gone, because the
 * committed row is never re-streamed. Everything else the drain covers (OTel
 * spans, Sentry) is replaceable telemetry; the audit stage is not, which is
 * why stage order is asserted below and not just stage presence.
 *
 * WHAT THIS FILE CATCHES. It EXECUTES the subject: it imports the real
 * `register()` from `src/instrumentation.ts` and the real
 * `src/lib/observability/shutdown.ts`, drives startup, and captures what gets
 * registered. It is not a source-text scan (contrast the deliberately
 * structural `tests/guards/mailer-init-wiring.test.ts` next door, which has
 * to scan because its second subject — `scripts/worker.ts` — cannot be
 * imported under jest). Two mutations, both measured:
 *
 *   A. delete the `installShutdownHandlers();` call, keep the import — i.e.
 *      the exact revert `docs/epic-e-observability.md` describes.
 *   B. wrap the call in `if (process.env.NODE_ENV === 'production')` — the
 *      plausible "optimisation" that looks wired and silently disables the
 *      drain everywhere it is not production.
 *
 * Both were run against a mutated copy of the subject, and both turn five of
 * this file's seven tests red; the two that survive are the positive control
 * and the edge-runtime scope pin, which is precisely their job. A source-text
 * guard would catch A only — B keeps the identifier AND the `()` and sails
 * straight past a regex. That asymmetry is why this file executes.
 *
 * WHAT IT CANNOT CATCH — say it out loud rather than imply coverage:
 *
 *   - The BullMQ worker. `scripts/worker.ts` never installs this drain, and
 *     its own `shutdown()` calls `process.exit(0)` without awaiting one, so
 *     every worker deploy still discards its buffered audit events. The
 *     worker runs jobs that write audit rows, so this is the same loss class
 *     in a second process. It is NOT fixed here and NOT asserted here: a
 *     green assertion against today's `scripts/worker.ts` is impossible, and
 *     an identifier-grep against a future one would certify a "fix" that
 *     still exits mid-drain (the drain is voided at the `process.once`
 *     callsite). Fixing it means the worker's own `shutdown()` AWAITS the
 *     drain before exiting; the assertion belongs in that diff.
 *   - Whether the SIEM actually received the batch. Stage 1 is mocked here;
 *     delivery is `tests/guards/audit-stream-observability.test.ts`.
 *   - Anything outside the node runtime branch, by design — the last test
 *     pins that scope rather than pretending to cover it.
 */

// ── Module doubles ────────────────────────────────────────────────────────
// Handles are declared before the `jest.mock` calls; the factories are lazy,
// so this is hoisting-safe. `register()` dynamic-imports each of these, and
// ts-jest downlevels `await import()` to `require()`, so the mock registry
// intercepts them.
//
// PARTIAL-MOCK TRAP, the `@/lib/storage` failure mode in its "factory omits
// an export" form: `@/lib/observability/instrumentation` is imported TWICE
// by two different callers — `initTelemetry` by `register()`, and
// `shutdownTelemetry` by the REAL shutdown.ts inside the drain. A factory
// carrying only what `register()` reads (the naive reading) passes every
// test here except the drain-identity one, which blows up with
// "shutdownTelemetry is not a function". Same trap, same shape, for
// `@/lib/observability/sentry`. Do not trim either factory.
const initTelemetry = jest.fn();
const shutdownTelemetry = jest.fn();
const initSentry = jest.fn();
const shutdownSentry = jest.fn();
const initMailerFromEnv = jest.fn();
const installAutomationBusDispatcher = jest.fn();
const installRlsTripwire = jest.fn();
const verifyRedisEvictionPolicy = jest.fn();
const flushAllAuditStreams = jest.fn();
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();

jest.mock('@/lib/observability/instrumentation', () => ({ initTelemetry, shutdownTelemetry }));
jest.mock('@/lib/observability/sentry', () => ({ initSentry, shutdownSentry }));
jest.mock('@/lib/mailer', () => ({ initMailerFromEnv }));
jest.mock('@/app-layer/automation/bus-bootstrap', () => ({ installAutomationBusDispatcher }));
jest.mock('@/lib/db/rls-middleware', () => ({ installRlsTripwire }));
// Not "don't do real startup work" for its own sake: the real client builds
// the Epic-B field-encryption `$extends` chain, and `@/lib/redis` constructs
// an ioredis connection whose failure is swallowed by a `.catch` at the
// callsite — it would leak an open handle and never say so.
jest.mock('@/lib/prisma', () => ({ prisma: {} }));
jest.mock('@/lib/redis', () => ({ verifyRedisEvictionPolicy }));
// Stage 1 of the drain. Mocked so the assertion observes A CALL rather than
// a live HTTP flush attempt against a tenant SIEM.
jest.mock('@/app-layer/events/audit-stream', () => ({ flushAllAuditStreams }));
// shutdown.ts imports this as `./logger`, which resolves to the SAME file as
// `@/lib/observability/logger` (there is exactly one logger.ts and no
// logger/index.ts in that directory, so the `@/lib/storage` vs
// `@/lib/storage/index` ambiguity does not exist here). One mock covers both.
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: loggerInfo, warn: loggerWarn, error: jest.fn(), debug: jest.fn() },
}));

// NOT MOCKED, deliberately:
//   `@/instrumentation`                     — the subject. NB there are three
//       files with "instrumentation" in the name; the subject is the ROOT
//       one, `src/instrumentation.ts`, not `src/lib/observability/
//       instrumentation.ts` (mocked above) and not `src/instrumentation-
//       client.ts`.
//   `@/lib/observability/shutdown`          — the whole point. Mocking it
//       would downgrade every assertion from "the drain is installed" to "a
//       function was called".
//   `@/lib/observability/shutdown-budget`   — plain constants; mocking them
//       would make the budget assertions self-fulfilling.
import { register } from '@/instrumentation';
import { _resetShutdownInstalledForTesting } from '@/lib/observability/shutdown';
import {
    SHUTDOWN_AUDIT_FLUSH_MS,
    SHUTDOWN_OTEL_MS,
    SHUTDOWN_SENTRY_MS,
} from '@/lib/observability/shutdown-budget';

/**
 * The observation harness. Signal listeners are captured through a
 * `process.once` spy rather than fired with `process.emit('SIGTERM')` —
 * emitting would synchronously run EVERY listener on the process, including
 * any the jest runner owns, and the spy has the bonus that no real handler is
 * ever attached, so this file cannot leak a signal handler into the rest of
 * the run.
 */
const captured = new Map<string, () => unknown>();
let onceSpy: jest.SpyInstance;
const ORIGINAL_RUNTIME = process.env.NEXT_RUNTIME;

beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` clears CALLS, not IMPLEMENTATIONS (CLAUDE.md, testing
    // conventions), so defaults are re-applied here rather than at declaration
    // — otherwise the one test that installs a never-resolving flush would
    // poison every test declared after it.
    initTelemetry.mockResolvedValue(undefined);
    shutdownTelemetry.mockResolvedValue(undefined);
    shutdownSentry.mockResolvedValue(undefined);
    verifyRedisEvictionPolicy.mockResolvedValue(undefined);
    flushAllAuditStreams.mockResolvedValue(undefined);

    // `_installed` is MODULE state in shutdown.ts and survives between it()
    // blocks; `clearAllMocks` does not touch it. Without this reset every
    // test after the first observes an empty `captured` and fails for a
    // reason that has nothing to do with `register()`.
    _resetShutdownInstalledForTesting();
    captured.clear();

    // `register()` reads process.env at CALL time, so mutating it here is
    // correct. Jest leaves NEXT_RUNTIME undefined, which satisfies the
    // `!process.env.NEXT_RUNTIME` half of the node-runtime guard; the delete
    // makes that a stated precondition instead of an inherited accident.
    // NODE_ENV must STAY 'test': the production branches of register() call
    // process.exit(1) on a missing REDIS_URL or a bad DATA_ENCRYPTION_KEY,
    // which kills the jest worker and reports a shard with no summary.
    delete process.env.NEXT_RUNTIME;

    onceSpy = jest.spyOn(process, 'once').mockImplementation(((sig: any, fn: any) => {
        captured.set(String(sig), fn);
        return process;
    }) as any);
});

afterEach(() => {
    onceSpy.mockRestore();
    _resetShutdownInstalledForTesting();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    if (ORIGINAL_RUNTIME === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = ORIGINAL_RUNTIME;
});

/**
 * Fire a captured listener and let the drain run to completion.
 *
 * THE VOIDED-WRAPPER TRAP: shutdown.ts registers `() => { void handler(sig) }`
 * — a SYNCHRONOUS wrapper that discards the drain promise. `await handler()`
 * therefore awaits `undefined` and returns after one microtask, with the
 * drain still inside stage 1: `flushAllAuditStreams` shows 1 call and
 * `shutdownTelemetry` shows 0. Invoke, then settle on a real `setImmediate`.
 *
 * Fake timers are required, not cosmetic: stage 1 races the flush against a
 * `setTimeout(…, SHUTDOWN_AUDIT_FLUSH_MS)` that is never cleared once the
 * flush wins, so under real timers this file holds the worker for three
 * seconds and prints "Jest did not exit". `doNotFake: ['setImmediate']` is
 * load-bearing — a plain `useFakeTimers()` fakes setImmediate too and the
 * settle below never runs.
 */
async function fireAndSettle(handler: () => unknown, advanceMs = 0): Promise<void> {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
        handler();
        await new Promise((r) => setImmediate(r));
        if (advanceMs > 0) {
            jest.advanceTimersByTime(advanceMs);
            await new Promise((r) => setImmediate(r));
        }
    } finally {
        jest.useRealTimers();
    }
}

describe('positive control — startup reaches the point where the drain is installed', () => {
    it('register() runs its node-runtime body end to end', async () => {
        // THE ANTI-VACUOUS ASSERTION. Every refusal-shaped assertion below
        // ("no listener was registered") is also satisfied by a register()
        // that did nothing at all — bailed at the NEXT_RUNTIME guard, or
        // rejected on one of the six dynamic imports that precede the call.
        // This test proves the earlier gates were passed, so a failure below
        // means "the call is gone", not "startup never got there".
        //
        // It PASSES under both mutations by design. That is what makes the
        // others diagnostic.
        await register();

        expect(initTelemetry).toHaveBeenCalledTimes(1);
        expect(initSentry).toHaveBeenCalledTimes(1);
        expect(initMailerFromEnv).toHaveBeenCalledTimes(1);
        expect(installAutomationBusDispatcher).toHaveBeenCalledTimes(1);
        expect(installRlsTripwire).toHaveBeenCalledTimes(1);
    });
});

describe('startup installs the SIGTERM/SIGINT drain', () => {
    it('registers a listener for exactly SIGTERM and SIGINT — no more, no fewer', async () => {
        await register();

        // The distinguishing signal is the SIGNAL NAMES, not "some listener
        // exists". Container runtimes send SIGTERM on a rolling deploy and
        // SIGINT on a local Ctrl-C; covering one and not the other is a real
        // regression that a bare "at least one listener" check would pass.
        expect([...captured.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    });

    it('the SIGTERM listener IS the drain — audit buffers first, then OTel, then Sentry', async () => {
        // The identity assertion. The test above would accept a listener that
        // does nothing whatsoever, so this one invokes what was actually
        // registered and watches which stages run and in which order.
        await register();
        const handler = captured.get('SIGTERM');
        expect(typeof handler).toBe('function');

        await fireAndSettle(handler!);

        expect(loggerInfo).toHaveBeenCalledWith(
            'graceful shutdown initiated',
            expect.objectContaining({ component: 'shutdown', signal: 'SIGTERM' }),
        );
        expect(flushAllAuditStreams).toHaveBeenCalledTimes(1);
        // Budgets come from the module, not literals: they are tuned
        // (3s + 2s + 2s, under the 20s ceiling that leaves room for Next's own
        // HTTP drain), and a hard-coded 2000 would turn a deliberate retune
        // into a red test instead of moving with the code.
        expect(shutdownTelemetry).toHaveBeenCalledWith(SHUTDOWN_OTEL_MS);
        expect(shutdownSentry).toHaveBeenCalledWith(SHUTDOWN_SENTRY_MS);

        // ORDER IS THE LOAD-BEARING PART of E.3 and nothing else in the repo
        // asserts it end to end from register(). Audit loss is irreversible;
        // span and error loss are not. If a future edit hoists the cheap
        // telemetry stages ahead of the flush, a budget overrun starts eating
        // the regulatory record instead of the telemetry.
        expect(flushAllAuditStreams.mock.invocationCallOrder[0]).toBeLessThan(
            shutdownTelemetry.mock.invocationCallOrder[0],
        );
        expect(shutdownTelemetry.mock.invocationCallOrder[0]).toBeLessThan(
            shutdownSentry.mock.invocationCallOrder[0],
        );
    });

    it('the SIGINT listener is the drain too, and knows its own signal', async () => {
        // Guards the half of the pair that is easy to register as a no-op or
        // as a copy bound to the wrong signal name — the assertion above
        // covers SIGTERM only, and the signal name reaches the operator's
        // logs, which is how a stuck shutdown gets diagnosed at all.
        await register();
        const handler = captured.get('SIGINT');
        expect(typeof handler).toBe('function');

        await fireAndSettle(handler!);

        expect(flushAllAuditStreams).toHaveBeenCalledTimes(1);
        expect(shutdownTelemetry).toHaveBeenCalledTimes(1);
        expect(shutdownSentry).toHaveBeenCalledTimes(1);
        expect(loggerInfo).toHaveBeenCalledWith(
            'graceful shutdown initiated',
            expect.objectContaining({ component: 'shutdown', signal: 'SIGINT' }),
        );
    });

    it('a hanging audit flush cannot hold the process past its budget', async () => {
        // The drain must be BOUNDED, or it converts "we lose the buffer" into
        // "the container is SIGKILLed at the end of the grace period", which
        // loses the buffer anyway and takes the OTel + Sentry stages with it.
        // A SIEM that has stopped answering is exactly when this fires, so it
        // is worth proving the race is live rather than trusting the shape.
        flushAllAuditStreams.mockImplementation(() => new Promise(() => {
            /* never resolves — the unreachable SIEM case */
        }));

        await register();
        const handler = captured.get('SIGTERM');
        expect(typeof handler).toBe('function');

        await fireAndSettle(handler!, SHUTDOWN_AUDIT_FLUSH_MS);

        expect(flushAllAuditStreams).toHaveBeenCalledTimes(1);
        expect(shutdownTelemetry).toHaveBeenCalledWith(SHUTDOWN_OTEL_MS);
        expect(shutdownSentry).toHaveBeenCalledWith(SHUTDOWN_SENTRY_MS);
        expect(loggerInfo).toHaveBeenCalledWith(
            'graceful shutdown complete',
            expect.objectContaining({ component: 'shutdown', signal: 'SIGTERM' }),
        );
    });

    it('is idempotent under HMR — a second register() adds no second listener pair', async () => {
        await register();
        const first = onceSpy.mock.calls.length;

        // ANCHOR, not decoration. `expect(after).toBe(before)` alone is
        // satisfied by `0 === 0`, so without this line the whole test passes
        // vacuously under a mutation that deletes the call — measured: with
        // this line removed the mutation kills four tests instead of five.
        expect(first).toBe(2);

        await register();
        expect(onceSpy.mock.calls.length).toBe(first);
    });
});

describe('the scope of the node-runtime guard', () => {
    it('does nothing on the edge runtime', async () => {
        // Pins the condition under which the positive control above would
        // evaporate, in the same file that relies on it. The edge runtime has
        // no signals, no audit buffer and no OTel SDK to drain — installing a
        // handler there would be the bug.
        process.env.NEXT_RUNTIME = 'edge';

        await register();

        expect(captured.size).toBe(0);
        expect(initTelemetry).not.toHaveBeenCalled();
    });
});
