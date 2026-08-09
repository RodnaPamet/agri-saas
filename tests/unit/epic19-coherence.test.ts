/**
 * Epic 19 Coherence Guards — Observability & Operational Readiness
 *
 * End-to-end guardrails ensuring:
 * 1. All metrics referenced in dashboards/alerts are emitted by code
 * 2. Dashboard/alert/SLO naming is consistent
 * 3. Route normalization prevents cardinality explosion
 * 4. Health probes are public and correctly routed
 * 5. Barrel exports cover all observability APIs
 * 6. No stray metric name drift between code and infra
 *
 * These tests protect against:
 * - Adding a dashboard panel that references a metric the app doesn't emit
 * - Renaming a metric in code without updating dashboard queries
 * - Breaking probe auth bypass
 * - Forgetting to export new observability functions
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

// ─── 1. Metric Emission ↔ Dashboard/Alert Coherence ────────────────────

describe('Epic 19 Coherence: metric names', () => {
    // OTel dot-notation names from metrics.ts
    const metricsCode = fs.readFileSync(
        path.join(SRC, 'lib/observability/metrics.ts'), 'utf-8'
    );

    // Extract all OTel metric names (dot-notation)
    const otelNames = (metricsCode.match(/'([a-z]+\.[a-z]+\.[a-z.]+)'/g) || [])
        .map(m => m.replace(/'/g, ''))
        .filter(m => !m.startsWith('http.') && !m.startsWith('error.') && !m.startsWith('job.name')
            && !m.startsWith('job.status') && !m.startsWith('queue.'));

    const dashboardContent = fs.readFileSync(
        path.join(ROOT, 'infra/dashboards/grafana-api-slos.json'), 'utf-8'
    );
    const alertContent = fs.readFileSync(
        path.join(ROOT, 'infra/alerts/rules.yml'), 'utf-8'
    );

    it('should emit all 6 metrics referenced in infra configs', () => {
        const expectedMetrics = [
            'api.request.count',
            'api.request.duration',
            'api.request.errors',
            'job.execution.count',
            'job.execution.duration',
            'job.queue.depth',
        ];

        for (const metric of expectedMetrics) {
            expect(metricsCode).toContain(`'${metric}'`);
        }
    });

    it('should reference every SLO-relevant metric in the dashboard or alerts (Prometheus convention)', () => {
        // Metrics that are intentionally diagnostic-only and not required in dashboards/alerts.
        // - api.request.errors provides per-error-code breakdown; SLO alerts use
        //   api.request.count{status=5xx} instead, which is the business-relevant signal.
        // - repo.method.duration is per-repository-method timing emitted by the
        //   tracing layer; it shows up as span attributes in OTel traces and is
        //   used ad-hoc when chasing slow queries, not on the SLO board.
        const diagnosticOnly = new Set([
            'api.request.errors',
            'repo.method.duration',
            // EI-4 — SCIM bearer-token auth outcome counter. A diagnostic
            // signal (brute-force / stale-connector detection) alerted ad-hoc,
            // not an SLO-board metric, so it isn't on the SLO dashboard.
            'scim.auth.count',
        ]);

        // feat/observability — the ag field-workflow SLO metrics
        // (`ag.operation.*`) live on their OWN dashboard + Prometheus rules
        // (the ag operations board), not the API SLO board. They ARE
        // SLO-relevant (they back the AgFieldOperationLatencyHigh /
        // AgOperationFailureRateHigh / AgLedgerReconciliationDrift alerts),
        // so they belong in the reference corpus rather than diagnosticOnly.
        const agReferenceCorpus = [
            'docs/grafana/ag-operations.json',
            'infra/observability/prometheus/rules/recording-rules.yml',
            'infra/observability/prometheus/rules/alerting-rules.yml',
        ]
            .map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8'))
            .join('\n');

        // Dot → underscore: api.request.count → api_request_count
        for (const otelName of otelNames) {
            if (diagnosticOnly.has(otelName)) continue;

            const promName = otelName.replace(/\./g, '_');
            const referencedInDashboard = dashboardContent.includes(promName);
            const referencedInAlerts = alertContent.includes(promName);
            const referencedInAgInfra = agReferenceCorpus.includes(promName);

            if (!referencedInDashboard && !referencedInAlerts && !referencedInAgInfra) {
                fail(
                    `Metric '${otelName}' (Prometheus: '${promName}') is emitted by metrics.ts ` +
                    `but not referenced in any dashboard panel or alert rule. ` +
                    `Either add a panel/alert or add to diagnosticOnly set.`
                );
            }
        }
    });

    it('should not reference non-existent metrics in dashboard PromQL', () => {
        // Extract all metric base names from dashboard PromQL
        const promqlMetrics = new Set<string>();
        const metricPattern = /[a-z][a-z_]+(?:_count|_duration|_depth|_errors|_bucket)\b/g;
        let match;
        while ((match = metricPattern.exec(dashboardContent)) !== null) {
            // Skip Prometheus system metrics
            if (match[0].startsWith('process_') || match[0].startsWith('probe_')) continue;
            promqlMetrics.add(match[0].replace(/_bucket$/, ''));
        }

        // Convert OTel names to Prometheus for comparison
        const knownPromNames = new Set(
            otelNames.map(n => n.replace(/\./g, '_'))
        );

        for (const promMetric of promqlMetrics) {
            expect(knownPromNames).toContain(promMetric);
        }
    });
});

// ─── 2. Dashboard Structure Coherence ──────────────────────────────────

describe('Epic 19 Coherence: dashboard structure', () => {
    const dashboard = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'infra/dashboards/grafana-api-slos.json'), 'utf-8')
    );

    it('should have exactly 14 data panels (11 API/health + 3 job)', () => {
        const panels = dashboard.panels.filter((p: { type: string }) => p.type !== 'row');
        expect(panels.length).toBe(14);
    });

    it('should have 5 row dividers', () => {
        const rows = dashboard.panels.filter((p: { type: string }) => p.type === 'row');
        expect(rows.length).toBe(5);
    });

    it('should have unique panel IDs across all panels', () => {
        const ids = dashboard.panels.map((p: { id: number }) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have targets (queries) on every non-row panel', () => {
        const dataPanels = dashboard.panels.filter(
            (p: { type: string }) => p.type !== 'row'
        );
        for (const panel of dataPanels) {
            expect(panel.targets).toBeDefined();
            expect(panel.targets.length).toBeGreaterThan(0);
        }
    });
});

// ─── 3. Alert Rule Coherence ───────────────────────────────────────────

describe('Epic 19 Coherence: alert rules', () => {
    const alertContent = fs.readFileSync(
        path.join(ROOT, 'infra/alerts/rules.yml'), 'utf-8'
    );

    // The original SLO-tracking alerts (Epic OI-3 step 1). Every one
    // of these MUST link to the SLO dashboard — the dashboard is the
    // operator's first stop when one fires.
    const SLO_ALERT_NAMES = [
        'ApiErrorRateWarning',
        'ApiErrorRateCritical',
        'ApiP95LatencyWarning',
        'ApiP95LatencyCritical',
        'ReadyzProbeFailure',
        'ReadyzProbeCritical',
        'LivezProbeFailure',
        'ApiAvailabilityBurnRateHigh',
        'JobFailureRateWarning',
    ];

    // Infrastructure alerts added later. These belong on dedicated
    // dashboards (queue-depth, DB-pool, Redis-memory, cert-expiry)
    // and intentionally don't link to the SLO board, so they are
    // exempt from the SLO-dashboard invariant below.
    const INFRA_ALERT_NAMES = [
        'QueueDepthBacklogWarning',
        'QueueDepthBacklogCritical',
        'DatabaseConnectionPoolExhausted',
        'RedisMemoryHighWarning',
        'RedisMemoryHighCritical',
        'CertificateExpiryWarning',
        'CertificateExpiryCritical',
    ];

    const ALL_ALERT_NAMES = [...SLO_ALERT_NAMES, ...INFRA_ALERT_NAMES];

    it('should define exactly 16 alert rules (9 SLO + 7 infra)', () => {
        const alertCount = (alertContent.match(/- alert:/g) || []).length;
        expect(alertCount).toBe(ALL_ALERT_NAMES.length);
    });

    it('should have all known alert names', () => {
        for (const name of ALL_ALERT_NAMES) {
            expect(alertContent).toContain(name);
        }
    });

    it('should have 8 alert groups', () => {
        const groupCount = (alertContent.match(/- name: inflect\./g) || []).length;
        expect(groupCount).toBe(8);
    });

    it('every alert should have service: inflect-compliance label', () => {
        const alertCount = (alertContent.match(/- alert:/g) || []).length;
        const serviceCount = (alertContent.match(/service: inflect-compliance/g) || []).length;
        expect(serviceCount).toBe(alertCount);
    });

    it('every SLO-tracking alert references the SLO dashboard', () => {
        // Only the SLO-tier alerts must link to the SLO dashboard;
        // infra alerts have their own dashboards and would clutter
        // the SLO board if they all linked back to it.
        const dashboardRefCount = (alertContent.match(/inflect-compliance-slos/g) || []).length;
        expect(dashboardRefCount).toBe(SLO_ALERT_NAMES.length);
    });
});

// ─── 4. SLO Document Coherence ─────────────────────────────────────────

describe('Epic 19 Coherence: SLO document', () => {
    const sloContent = fs.readFileSync(
        path.join(ROOT, 'docs/slos.md'), 'utf-8'
    );
    const alertContent = fs.readFileSync(
        path.join(ROOT, 'infra/alerts/rules.yml'), 'utf-8'
    );

    it('should define all 4 SLOs', () => {
        expect(sloContent).toContain('SLO 1');
        expect(sloContent).toContain('SLO 2');
        expect(sloContent).toContain('SLO 3');
        expect(sloContent).toContain('SLO 4');
    });

    it('SLO latency threshold should match alert rules', () => {
        // SLO says < 500ms for P95
        expect(sloContent).toContain('500ms');
        // Alert fires at > 500 (warning) and > 2000 (critical)
        expect(alertContent).toContain('> 500');
        expect(alertContent).toContain('> 2000');
    });

    it('SLO availability target should match burn rate alert', () => {
        expect(sloContent).toContain('99.9%');
        // Burn rate alert uses 0.001 (100% - 99.9%)
        expect(alertContent).toContain('0.001');
    });
});

// ─── 5. Health Probe Auth Bypass ───────────────────────────────────────

describe('Epic 19 Coherence: probe auth bypass', () => {
    const { isPublicPath } = require('../../src/lib/auth/guard');

    it('livez is publicly accessible', () => {
        expect(isPublicPath('/api/livez')).toBe(true);
    });

    it('readyz is publicly accessible', () => {
        expect(isPublicPath('/api/readyz')).toBe(true);
    });

    it('health (legacy) is publicly accessible', () => {
        expect(isPublicPath('/api/health')).toBe(true);
    });

    it('livez route file exists', () => {
        expect(fs.existsSync(path.join(SRC, 'app/api/livez/route.ts'))).toBe(true);
    });

    it('readyz route file exists', () => {
        expect(fs.existsSync(path.join(SRC, 'app/api/readyz/route.ts'))).toBe(true);
    });

    it('health route file exists (legacy compat)', () => {
        expect(fs.existsSync(path.join(SRC, 'app/api/health/route.ts'))).toBe(true);
    });
});

// ─── 6. Barrel Export Completeness ─────────────────────────────────────

describe('Epic 19 Coherence: barrel exports', () => {
    const barrel = fs.readFileSync(
        path.join(SRC, 'lib/observability/index.ts'), 'utf-8'
    );

    const requiredExports = [
        // Logger
        'logger', 'createChildLogger',
        // Context
        'runWithRequestContext', 'getRequestContext',
        // Tracing
        'traceUsecase', 'traceOperation',
        // Sentry
        'captureError', 'initSentry',
        // Metrics
        'recordRequestMetrics', 'recordRequestError',
        'recordJobMetrics', 'startQueueDepthReporting', 'normalizeRoute',
        // Job runner
        'runJob',
    ];

    for (const name of requiredExports) {
        it(`should export '${name}'`, () => {
            expect(barrel).toContain(name);
        });
    }
});

// ─── 7. Observability Doc Coherence ────────────────────────────────────

describe('Epic 19 Coherence: documentation', () => {
    it('observability.md should exist', () => {
        expect(fs.existsSync(path.join(ROOT, 'docs/observability.md'))).toBe(true);
    });

    it('slos.md should exist', () => {
        expect(fs.existsSync(path.join(ROOT, 'docs/slos.md'))).toBe(true);
    });

    it('infra/README.md should exist', () => {
        expect(fs.existsSync(path.join(ROOT, 'infra/README.md'))).toBe(true);
    });

    it('observability.md should reference livez, readyz, and health probes', () => {
        const content = fs.readFileSync(path.join(ROOT, 'docs/observability.md'), 'utf-8');
        expect(content).toContain('/api/livez');
        expect(content).toContain('/api/readyz');
        expect(content).toContain('/api/health');
    });

    it('observability.md should contain a runbook section', () => {
        const content = fs.readFileSync(path.join(ROOT, 'docs/observability.md'), 'utf-8');
        expect(content).toContain('Operational Runbook');
    });

    it('observability.md should reference the correct panel count', () => {
        const content = fs.readFileSync(path.join(ROOT, 'docs/observability.md'), 'utf-8');
        expect(content).toContain('14 panels');
    });

    it('infra/README.md should reference the correct alert count', () => {
        const content = fs.readFileSync(path.join(ROOT, 'infra/README.md'), 'utf-8');
        expect(content).toContain('10)');
    });
});

// ─── 8. Route Normalization Stability ──────────────────────────────────

describe('Epic 19 Coherence: route normalization idempotency', () => {
    const { normalizeRoute } = require('../../src/lib/observability/metrics');

    it('normalizeRoute is idempotent (double application produces same result)', () => {
        const routes = [
            '/api/t/acme/practices/550e8400-e29b-41d4-a716-446655440000',
            '/api/t/tenant-123/evidence',
            '/api/livez',
        ];

        for (const route of routes) {
            const once = normalizeRoute(route);
            const twice = normalizeRoute(once);
            expect(twice).toBe(once);
        }
    });

    it('normalizeRoute handles empty/root paths gracefully', () => {
        expect(() => normalizeRoute('')).not.toThrow();
        expect(() => normalizeRoute('/')).not.toThrow();
    });
});

// ─── 9. Job Runner emits metrics (wiring guard) ───────────────────────

describe('Epic 19 Coherence: job runner metrics wiring', () => {
    it('job-runner.ts imports recordJobMetrics', () => {
        const code = fs.readFileSync(
            path.join(SRC, 'lib/observability/job-runner.ts'), 'utf-8'
        );
        expect(code).toContain("import { recordJobMetrics } from './metrics'");
    });

    it('executor-registry.ts imports recordJobMetrics', () => {
        const code = fs.readFileSync(
            path.join(SRC, 'app-layer/jobs/executor-registry.ts'), 'utf-8'
        );
        expect(code).toContain("import { recordJobMetrics } from '@/lib/observability/metrics'");
    });

    it('withApiErrorHandling uses recordRequestMetrics', () => {
        const code = fs.readFileSync(
            path.join(SRC, 'lib/errors/api.ts'), 'utf-8'
        );
        expect(code).toContain('recordRequestMetrics');
    });
});

// ─── 10. Infra Config Files Valid ─────────────────────────────────────

describe('Epic 19 Coherence: infra config integrity', () => {
    it('dashboard JSON is parseable', () => {
        const raw = fs.readFileSync(
            path.join(ROOT, 'infra/dashboards/grafana-api-slos.json'), 'utf-8'
        );
        expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('OTel collector config exists and references OTLP port', () => {
        const raw = fs.readFileSync(
            path.join(ROOT, 'infra/otel-collector/config.yml'), 'utf-8'
        );
        expect(raw).toContain('4318');
    });

    it('alert rules file exists and has groups', () => {
        const raw = fs.readFileSync(
            path.join(ROOT, 'infra/alerts/rules.yml'), 'utf-8'
        );
        expect(raw).toContain('groups:');
    });
});
