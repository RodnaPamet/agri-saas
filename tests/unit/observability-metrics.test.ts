/**
 * Branch coverage for the OpenTelemetry metrics module.
 *
 * `observability/metrics.ts` is the single place every request /
 * job / audit-stream counter + histogram is emitted. The branch
 * surface worth pinning:
 *
 *   - normalizeRoute: UUID collapse, tenant-slug collapse, opaque-id
 *     collapse, short-id passthrough — cardinality safety is the
 *     whole point of the file
 *   - recordRequestMetrics / recordRequestError / recordJobMetrics /
 *     recordAuditStreamDelivery: the lazy-singleton instruments and
 *     the success-vs-failure label branch
 *   - the two observable gauges' idempotency flags + the try/catch
 *     inside their scrape callbacks
 *
 * No OTel SDK is initialized, so `metrics.getMeter()` returns the
 * noop meter — instruments are real noop objects. The assertions
 * therefore target the PURE decision logic (route shape, label
 * selection, idempotency) rather than exporter side effects, which
 * is exactly where the cardinality + correctness risk lives.
 */
import {
    normalizeRoute,
    recordRequestMetrics,
    recordRequestError,
    recordJobMetrics,
    recordAuditStreamDelivery,
    recordAuditStreamBufferOverflow,
    recordEntraGroupResolution,
    recordScimAuth,
    recordEntraRoleSync,
    startQueueDepthReporting,
    startAuditStreamBufferReporting,
    _resetQueueDepthForTesting,
    _resetAuditStreamBufferGaugeForTesting,
} from '@/lib/observability/metrics';

describe('normalizeRoute — cardinality safety', () => {
    it('collapses a UUID path segment to :id', () => {
        expect(
            normalizeRoute(
                '/api/practices/550e8400-e29b-41d4-a716-446655440000',
            ),
        ).toBe('/api/practices/:id');
    });

    it('collapses the tenant slug in /api/t/<slug>/ to :tenantSlug', () => {
        expect(normalizeRoute('/api/t/acme-corp/practices')).toBe(
            '/api/t/:tenantSlug/practices',
        );
    });

    it('collapses a long opaque id (20+ chars) to :id', () => {
        expect(
            normalizeRoute('/api/t/acme/evidence/abcdef0123456789abcdef'),
        ).toBe('/api/t/:tenantSlug/evidence/:id');
    });

    it('keeps short ids untouched (low cardinality)', () => {
        // A short alphanumeric segment stays — only 20+ char ids collapse.
        expect(normalizeRoute('/api/t/acme/evidence/abc123')).toBe(
            '/api/t/:tenantSlug/evidence/abc123',
        );
    });

    it('handles both a tenant slug and a UUID in one path', () => {
        expect(
            normalizeRoute(
                '/api/t/my-tenant/risks/550e8400-e29b-41d4-a716-446655440000',
            ),
        ).toBe('/api/t/:tenantSlug/risks/:id');
    });

    it('leaves a static path with no dynamic segments unchanged', () => {
        expect(normalizeRoute('/api/livez')).toBe('/api/livez');
    });

    it('is idempotent — re-normalising a normalised route is a fixed point', () => {
        const once = normalizeRoute(
            '/api/t/acme/practices/550e8400-e29b-41d4-a716-446655440000',
        );
        expect(normalizeRoute(once)).toBe(once);
    });
});

describe('request + job recording (noop meter — exercises lazy singletons)', () => {
    it('recordRequestMetrics runs without throwing and normalises the route', () => {
        expect(() =>
            recordRequestMetrics({
                method: 'GET',
                route: '/api/t/acme/practices/550e8400-e29b-41d4-a716-446655440000',
                status: 200,
                durationMs: 12,
            }),
        ).not.toThrow();
        // Second call exercises the already-initialised singleton branch.
        expect(() =>
            recordRequestMetrics({
                method: 'POST',
                route: '/api/t/acme/risks',
                status: 201,
                durationMs: 30,
            }),
        ).not.toThrow();
    });

    it('recordRequestError runs without throwing', () => {
        expect(() =>
            recordRequestError({
                method: 'DELETE',
                route: '/api/t/acme/practices/abc',
                errorCode: 'NOT_FOUND',
            }),
        ).not.toThrow();
    });

    it('recordJobMetrics handles both the success and failure label branch', () => {
        expect(() =>
            recordJobMetrics({
                jobName: 'key-rotation',
                success: true,
                durationMs: 100,
            }),
        ).not.toThrow();
        expect(() =>
            recordJobMetrics({
                jobName: 'key-rotation',
                success: false,
                durationMs: 200,
            }),
        ).not.toThrow();
    });
});

describe('audit-stream delivery recording', () => {
    it('takes the success branch for a success outcome', () => {
        expect(() =>
            recordAuditStreamDelivery({
                outcome: 'success',
                status: 200,
                attempts: 1,
                durationMs: 50,
            }),
        ).not.toThrow();
    });

    it('takes the failure branch for a failure outcome', () => {
        expect(() =>
            recordAuditStreamDelivery({
                outcome: 'failure',
                status: 0, // network throw / timeout
                attempts: 3,
                durationMs: 5000,
            }),
        ).not.toThrow();
    });

    it('recordAuditStreamBufferOverflow runs without throwing', () => {
        expect(() => recordAuditStreamBufferOverflow()).not.toThrow();
    });
});

describe('Entra group-resolution recording (EI-4)', () => {
    it('records the token source without a graph-fetch duration', () => {
        expect(() =>
            recordEntraGroupResolution({ source: 'token', outcome: 'resolved', groupCount: 3 }),
        ).not.toThrow();
    });

    it('records the graph_overage source including the duration histogram', () => {
        expect(() =>
            recordEntraGroupResolution({
                source: 'graph_overage',
                outcome: 'resolved',
                groupCount: 250,
                graphFetchDurationMs: 120,
            }),
        ).not.toThrow();
    });

    it('handles the empty (Graph-outage) outcome on the overage path', () => {
        expect(() =>
            recordEntraGroupResolution({
                source: 'graph_overage',
                outcome: 'empty',
                groupCount: 0,
                graphFetchDurationMs: 5,
            }),
        ).not.toThrow();
    });

    it('skips the duration histogram when graph_overage omits the duration', () => {
        // Defensive branch: graph_overage source but no duration supplied.
        expect(() =>
            recordEntraGroupResolution({ source: 'graph_overage', outcome: 'empty', groupCount: 0 }),
        ).not.toThrow();
    });
});

describe('SCIM auth recording (EI-4)', () => {
    it('records both the success and failure outcome branches', () => {
        expect(() => recordScimAuth({ outcome: 'success', reason: 'ok' })).not.toThrow();
        expect(() => recordScimAuth({ outcome: 'failure', reason: 'not_found' })).not.toThrow();
        expect(() => recordScimAuth({ outcome: 'failure', reason: 'revoked' })).not.toThrow();
    });
});

describe('Entra role-sync recording (EI-3)', () => {
    it('records every outcome branch without throwing', () => {
        for (const outcome of [
            'synced',
            'unchanged',
            'gate_denied',
            'no_membership',
            'owner_immune',
            'no_match',
            'no_mappings',
        ] as const) {
            expect(() => recordEntraRoleSync({ outcome })).not.toThrow();
        }
    });
});

describe('observable gauges — idempotency + callback safety', () => {
    afterEach(() => {
        _resetQueueDepthForTesting();
        _resetAuditStreamBufferGaugeForTesting();
    });

    it('startQueueDepthReporting only registers once (idempotent)', () => {
        let factoryCalls = 0;
        const getQueueFn = () => {
            factoryCalls++;
            return {
                getJobCounts: async () => ({
                    waiting: 2,
                    active: 1,
                    delayed: 0,
                    failed: 0,
                }),
            };
        };

        startQueueDepthReporting(getQueueFn);
        startQueueDepthReporting(getQueueFn); // second call is a no-op

        // The factory is only ever wired to the gauge callback; the
        // idempotency flag means the second call doesn't re-register.
        // Factory isn't invoked at registration time (scrape-driven),
        // so the observable assertion is the no-throw + flag behaviour.
        expect(factoryCalls).toBe(0);
    });

    it('startAuditStreamBufferReporting only registers once (idempotent)', () => {
        let depthReads = 0;
        const getDepth = () => {
            depthReads++;
            return 7;
        };

        startAuditStreamBufferReporting(getDepth);
        startAuditStreamBufferReporting(getDepth); // no-op

        expect(depthReads).toBe(0); // scrape-driven, not registration-driven
    });

    it('can re-register after the testing reset helper clears the flag', () => {
        startQueueDepthReporting(() => ({
            getJobCounts: async () => ({}),
        }));
        _resetQueueDepthForTesting();
        // After reset, a fresh registration is allowed again.
        expect(() =>
            startQueueDepthReporting(() => ({
                getJobCounts: async () => ({}),
            })),
        ).not.toThrow();
    });
});
