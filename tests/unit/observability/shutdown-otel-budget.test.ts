/**
 * Stage 2's own budget, with a hung OTel exporter (#2635).
 *
 * The third of the three races. `shutdown-helpers.test.ts` could not reach it
 * and said why: "We can't call initTelemetry (requires OTEL_ENABLED=true + real
 * OTel collector)". The first half is true and the second is not — every OTel
 * dependency is loaded through a dynamic `await import(...)`, so the SDK mocks
 * cleanly and no collector is involved. That sentence is what sent the coverage
 * claim to an integration test which does not cover it either.
 *
 * What makes this stage worth its own file is that the hang is REALISTIC here.
 * `BatchSpanProcessor.shutdown()` force-flushes to an OTLP endpoint over HTTP;
 * a collector that accepts the connection and never answers is the ordinary
 * failure, and it is the one that would hold a container past SIGTERM.
 */
const hangForever = <T,>(): Promise<T> => new Promise<T>(() => {});

const tracerShutdown = jest.fn(hangForever);
const meterShutdown = jest.fn(hangForever);

jest.mock('@opentelemetry/api', () => ({
    diag: { setLogger: jest.fn() },
    DiagConsoleLogger: jest.fn(),
    DiagLogLevel: { DEBUG: 'DEBUG' },
    metrics: { setGlobalMeterProvider: jest.fn() },
}));
jest.mock('@opentelemetry/resources', () => ({
    resourceFromAttributes: jest.fn(() => ({})),
    Resource: class {},
}));
jest.mock('@opentelemetry/semantic-conventions', () => ({
    ATTR_SERVICE_NAME: 'service.name',
    ATTR_SERVICE_VERSION: 'service.version',
    SEMRESATTRS_SERVICE_NAME: 'service.name',
}));
jest.mock('@opentelemetry/sdk-trace-node', () => ({
    NodeTracerProvider: class {
        register = jest.fn();
        shutdown = tracerShutdown;
    },
    BatchSpanProcessor: class {},
}));
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
    OTLPTraceExporter: class {},
}));
jest.mock('@opentelemetry/sdk-metrics', () => ({
    MeterProvider: class {
        shutdown = meterShutdown;
    },
    PeriodicExportingMetricReader: class {},
}));
jest.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
    OTLPMetricExporter: class {},
}));

import {
    initTelemetry,
    shutdownTelemetry,
    isTelemetryInitialized,
    _resetForTesting,
} from '@/lib/observability/instrumentation';

async function microtasks(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const SAVED = { enabled: process.env.OTEL_ENABLED };

afterEach(() => {
    _resetForTesting();
    jest.clearAllMocks();
    jest.useRealTimers();
    if (SAVED.enabled === undefined) delete process.env.OTEL_ENABLED;
    else process.env.OTEL_ENABLED = SAVED.enabled;
});

describe('stage 2: a HUNG OTel exporter does not hold the shutdown (#2635)', () => {
    const BUDGET = 2_000;

    beforeEach(async () => {
        process.env.OTEL_ENABLED = 'true';
        await initTelemetry();
        jest.useFakeTimers();
    });

    it('reached the AWAITING path at all — the control', async () => {
        // The precondition the two existing suites never establish. Without
        // OTel initialised, `shutdownTelemetry` returns at `if (!_shutdown)`
        // and every assertion below would hold over code that never waited.
        expect(isTelemetryInitialized()).toBe(true);

        let settled = false;
        void shutdownTelemetry(BUDGET).then(() => {
            settled = true;
        });
        await microtasks();

        expect(tracerShutdown).toHaveBeenCalledTimes(1);
        expect(meterShutdown).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);

        jest.advanceTimersByTime(BUDGET - 1);
        await microtasks();
        expect(settled).toBe(false);
    });

    it('resolves on its own timer once the budget elapses', async () => {
        let settled = false;
        void shutdownTelemetry(BUDGET).then(() => {
            settled = true;
        });
        await microtasks();

        jest.advanceTimersByTime(BUDGET);
        await microtasks();
        expect(settled).toBe(true);
    });

    it('drains both providers in PARALLEL, not in series', async () => {
        // `Promise.all`, so one wedged exporter must not stop the other from
        // being asked. In series a hung tracer would mean the meter provider
        // is never flushed at all, and the budget would hide it — the stage
        // still resolves on time, having drained half of what it claims.
        void shutdownTelemetry(BUDGET);
        await microtasks();
        expect(tracerShutdown).toHaveBeenCalledTimes(1);
        expect(meterShutdown).toHaveBeenCalledTimes(1);
    });

    it('a second call is a noop — it does not re-wait on the wedged exporter', async () => {
        // Container runtimes escalate with a second SIGTERM. Re-entering would
        // spend another full budget on the same dead collector.
        void shutdownTelemetry(BUDGET);
        await microtasks();
        expect(isTelemetryInitialized()).toBe(false);

        tracerShutdown.mockClear();
        await shutdownTelemetry(BUDGET);
        expect(tracerShutdown).not.toHaveBeenCalled();
    });
});
