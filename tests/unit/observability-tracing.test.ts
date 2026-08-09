/**
 * Unit tests for OTel tracing utilities.
 *
 * Tests use the default noop tracer (OTel not initialized),
 * which verifies that all tracing code works without a real backend.
 *
 * RUN: npx jest tests/unit/observability-tracing.test.ts --verbose
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { traceUsecase, traceOperation, getTracer } from '@/lib/observability/tracing';
import { runWithRequestContext } from '@/lib/observability/context';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

// We use the InMemorySpanExporter to capture spans for assertions.
// This requires setting up a real (but in-memory) tracer provider.
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
});

afterAll(async () => {
    await provider.shutdown();
});

beforeEach(() => {
    exporter.reset();
});

function makeMockCtx(overrides?: Partial<RequestContext>): RequestContext {
    return {
        requestId: 'req-test-123',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
        ...overrides,
    };
}

describe('getTracer', () => {
    it('returns a tracer instance', () => {
        const tracer = getTracer();
        expect(tracer).toBeDefined();
    });

    it('returns a tracer with custom name', () => {
        const tracer = getTracer('custom-tracer');
        expect(tracer).toBeDefined();
    });
});

describe('traceUsecase', () => {
    it('creates a span with usecase. prefix and standard context attributes', async () => {
        const ctx = makeMockCtx();
        const result = await traceUsecase('practice.list', ctx, async () => {
            return [{ id: '1' }];
        });

        expect(result).toEqual([{ id: '1' }]);

        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0].name).toBe('usecase.practice.list');
        expect(spans[0].attributes['app.requestId']).toBe('req-test-123');
        expect(spans[0].attributes['app.tenantId']).toBe('tenant-1');
        expect(spans[0].attributes['app.userId']).toBe('user-1');
        expect(spans[0].attributes['app.role']).toBe('ADMIN');
        expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    });

    it('records error status and exception on throw', async () => {
        const ctx = makeMockCtx();

        await expect(
            traceUsecase('practice.create', ctx, async () => {
                throw new Error('DB connection failed');
            }),
        ).rejects.toThrow('DB connection failed');

        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
        expect(spans[0].status.message).toBe('DB connection failed');
        expect(spans[0].events.length).toBeGreaterThan(0); // exception event
    });

    it('propagates return value correctly', async () => {
        const ctx = makeMockCtx();
        const value = await traceUsecase('report.generate', ctx, async () => {
            return { pdfUrl: '/reports/123.pdf' };
        });
        expect(value).toEqual({ pdfUrl: '/reports/123.pdf' });
    });
});

describe('traceOperation', () => {
    it('creates a span with custom attributes', async () => {
        const result = await traceOperation('pdf.render', { reportId: 'r-1', pages: 42 }, async () => {
            return Buffer.from('pdf-content');
        });

        expect(result).toBeInstanceOf(Buffer);

        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0].name).toBe('pdf.render');
        expect(spans[0].attributes['reportId']).toBe('r-1');
        expect(spans[0].attributes['pages']).toBe(42);
        expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    });

    it('auto-enriches with requestId from ALS context', async () => {
        await runWithRequestContext(
            { requestId: 'als-req-99', startTime: 0 },
            async () => {
                await traceOperation('cache.lookup', { key: 'abc' }, async () => 'hit');
            },
        );

        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0].attributes['app.requestId']).toBe('als-req-99');
    });

    it('records error status on throw', async () => {
        await expect(
            traceOperation('external.call', { service: 'stripe' }, async () => {
                throw new Error('timeout');
            }),
        ).rejects.toThrow('timeout');

        const spans = exporter.getFinishedSpans();
        expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    });
});

describe('metrics (smoke)', () => {
    // Metrics use global noop meter when provider is not set.
    // We just verify the functions don't crash.
    it('recordRequestMetrics does not throw', async () => {
        const { recordRequestMetrics } = await import('@/lib/observability/metrics');
        expect(() =>
            recordRequestMetrics({ method: 'GET', route: '/api/test', status: 200, durationMs: 10 })
        ).not.toThrow();
    });

    it('recordRequestError does not throw', async () => {
        const { recordRequestError } = await import('@/lib/observability/metrics');
        expect(() =>
            recordRequestError({ method: 'GET', route: '/api/test', errorCode: 'NOT_FOUND' })
        ).not.toThrow();
    });
});

describe('instrumentation bootstrap (smoke)', () => {
    it('initTelemetry does not throw when OTEL_ENABLED is not set', async () => {
        const { initTelemetry, _resetForTesting } = await import('@/lib/observability/instrumentation');
        _resetForTesting();
        delete process.env.OTEL_ENABLED;
        await expect(initTelemetry()).resolves.not.toThrow();
    });

    it('isTelemetryInitialized returns true after initTelemetry', async () => {
        const { initTelemetry, isTelemetryInitialized, _resetForTesting } = await import('@/lib/observability/instrumentation');
        _resetForTesting();
        delete process.env.OTEL_ENABLED;
        await initTelemetry();
        expect(isTelemetryInitialized()).toBe(true);
    });
});
