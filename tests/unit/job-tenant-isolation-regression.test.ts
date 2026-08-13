/**
 * Background Job Tenant Isolation — Regression Guards
 *
 * This is the regression test suite for the critical tenant-scope bug
 * where background jobs silently widened from single-tenant to all-tenant
 * scans when services ignored the tenantId payload.
 *
 * WHAT THIS CATCHES:
 *   - Job executor ignores tenantId from payload (e.g. `_payload`)
 *   - Service function doesn't accept tenantId parameter
 *   - Service queries don't apply tenantId to WHERE clauses
 *   - Cross-tenant data leakage in results
 *
 * HOW TO ADD A NEW JOB TO THIS SUITE:
 *   1. Add a new describe() block below
 *   2. Mock the Prisma model(s) the job queries
 *   3. Use assertAllQueriesScoped() and assertNoTenantLeakage()
 *   4. Test both tenant-scoped and system-wide modes
 */

import {
    assertAllQueriesScoped,
    assertNoTenantLeakage,
    assertQueriesUnscoped,
    assertResultsBelongToTenant,
    assertScopeLogged,
} from '../helpers/tenant-scope-guard';

const TENANT_A = 'tenant-regression-a';
const TENANT_B = 'tenant-regression-b';

// ── Shared mocks ────────────────────────────────────────────────────

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
    jest.mock('@/lib/observability/job-runner', () => ({
        runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    }));
});

// ═════════════════════════════════════════════════════════════════════
// 1. vendor-renewal-check — REGRESSION for original bug
// ═════════════════════════════════════════════════════════════════════

// GRC teardown phase 2 (T3): the vendor-renewal-check and
// policy-review-reminder blocks went with their jobs. The
// task-due-notification block below is the surviving instance of the same
// regression class — a cross-tenant fan-out that forgot its tenant filter —
// and the two structural guards after it cover EVERY registered job, so the
// contract is still enforced for the jobs that remain.
describe('REGRESSION: task-due-notification tenant isolation', () => {
    const mockTaskFindMany = jest.fn().mockResolvedValue([]);
    // The job inserts via `createMany` + `skipDuplicates` — `{ count }`.
    const mockNotificationCreateMany = jest.fn().mockResolvedValue({ count: 1 });

    const mockPrisma = {
        task: { findMany: (...args: unknown[]) => mockTaskFindMany(...args) },
        notification: { createMany: (...args: unknown[]) => mockNotificationCreateMany(...args) },
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    // Fixed anchor so "due today" classification is deterministic.
    const NOW = new Date('2026-05-20T08:00:00.000Z');

    test('tenant-scoped: task query includes tenantId', async () => {
        const { processTaskDueNotifications } = await import(
            '../../src/app-layer/jobs/task-due-notification'
        );
        await processTaskDueNotifications(mockPrisma, { tenantId: TENANT_A, now: NOW });

        assertAllQueriesScoped(mockTaskFindMany, TENANT_A, 'task query');
    });

    test('tenant-scoped: tenant B never queried', async () => {
        const { processTaskDueNotifications } = await import(
            '../../src/app-layer/jobs/task-due-notification'
        );
        await processTaskDueNotifications(mockPrisma, { tenantId: TENANT_A, now: NOW });

        assertNoTenantLeakage(mockTaskFindMany, TENANT_B);
    });

    test('system-wide: no tenantId when omitted', async () => {
        const { processTaskDueNotifications } = await import(
            '../../src/app-layer/jobs/task-due-notification'
        );
        await processTaskDueNotifications(mockPrisma, { now: NOW });

        assertQueriesUnscoped(mockTaskFindMany);
    });

    test('notification is written to the task tenantId', async () => {
        mockTaskFindMany.mockResolvedValueOnce([
            {
                id: 'task-1',
                tenantId: TENANT_A,
                title: 'Patch servers',
                key: 'TSK-1',
                dueAt: new Date('2026-05-20T15:00:00.000Z'),
                assigneeUserId: 'user-1',
                tenant: { slug: 'tenant-a-slug' },
            },
        ]);

        const { processTaskDueNotifications } = await import(
            '../../src/app-layer/jobs/task-due-notification'
        );
        await processTaskDueNotifications(mockPrisma, { tenantId: TENANT_A, now: NOW });

        expect(mockNotificationCreateMany).toHaveBeenCalledTimes(1);
        expect(mockNotificationCreateMany.mock.calls[0][0].data[0].tenantId).toBe(TENANT_A);
    });

    test('tenant-scoped: logging shows scope', async () => {
        const { processTaskDueNotifications } = await import(
            '../../src/app-layer/jobs/task-due-notification'
        );
        await processTaskDueNotifications(mockPrisma, { tenantId: TENANT_A, now: NOW });

        assertScopeLogged(mockLogger, 'task-due notification scan starting', {
            scope: 'tenant-scoped',
            tenantId: TENANT_A,
        });
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Executor Registry — Structural Guards (source-code analysis)
// ═════════════════════════════════════════════════════════════════════

describe('Executor Registry — structural tenant-scope guards', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');
    const registryPath = resolve(__dirname, '../../src/app-layer/jobs/executor-registry.ts');
    const registrySource = readFileSync(registryPath, 'utf8');

    // Jobs that are explicitly not tenant-scoped
    // sharepoint-delta-sync-dispatch (SP-3) is a global cross-tenant fan-out —
    // it enqueues per-connection, tenant-scoped sharepoint-delta-sync jobs.
    // exchange-expiry-sweep is a GLOBAL sweep — the Exchange tables carry no
    // tenantId (cross-tenant marketplace), so its executor/payload have no
    // tenant axis; each transition's audit row is scoped by the row's own
    // sellerTenantId internally.
    // market-prices-pull writes GLOBAL, tenant-agnostic price cache tables
    // (MarketPriceSeries/Point, no tenantId — like SoilSample) and reads the
    // global Exchange listings; it has no tenant axis by design.
    // support-scheme-extraction is the WEEKLY sibling of the above: same
    // GLOBAL policy-news input, writing the GLOBAL SupportScheme table (a
    // national ДФЗ measure is the same fact for every tenant). No tenant
    // axis by design — a tenantId on this payload would be meaningless.
    // news-event-extraction (calendar roadmap PR 3) reads the GLOBAL
    // policy-news slice of MarketNewsItem and writes GLOBAL NewsDerivedEvent
    // rows (no tenantId on either model, like market-news-pull above) — a
    // subsidy deadline or regulation date is the same fact for every tenant.
    const EXEMPT_JOBS = ['health-check', 'sync-pull', 'schedule-trigger-sweep', 'sharepoint-delta-sync-dispatch', 'sharepoint-subscription-renew', 'risk-appetite-monitor', 'risk-snapshot', 'report-delivery', 'exchange-expiry-sweep', 'market-prices-pull', 'market-prices-barchart', 'market-news-pull', 'news-event-extraction', 'support-scheme-extraction',
        // PromotionLead is CROSS-tenant (inquirerTenantId, not tenantId) and is
        // swept globally in one pass — see job-scope-audit for the full reason.
        'promotion-lead-retention'];

    test('no executor uses _payload (unused parameter = ignored tenantId)', () => {
        const pattern = /executorRegistry\.register\('[^']+',\s*async\s*\(_payload\)/g;
        const matches = registrySource.match(pattern) || [];
        expect(matches).toEqual([]);
    });

    test('every non-exempt executor references tenantId', () => {
        // Walk each `executorRegistry.register('<name>', async (payload, ctx) => {`
        // opener, then count braces to find the matching close — the
        // previous regex `\}\);` was non-greedy and stopped at the
        // FIRST inner `});`, which for executors with nested closures
        // (e.g. `evidence-import` passing a progress callback to
        // `runEvidenceImport`) cut off the body before reaching the
        // outer `tenantId: r.tenantId` payload.
        const openerRe =
            /executorRegistry\.register\('([^']+)',\s*async\s*\([^)]*\)\s*=>\s*\{/g;
        const violations: string[] = [];

        let opener: RegExpExecArray | null;
        while ((opener = openerRe.exec(registrySource)) !== null) {
            const jobName = opener[1];
            // Start brace-counting at the opener's `{` (last char of match)
            const start = opener.index + opener[0].length;
            let depth = 1;
            let i = start;
            while (i < registrySource.length && depth > 0) {
                const ch = registrySource[i];
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
                i++;
            }
            const body = registrySource.slice(start, i - 1);

            if (EXEMPT_JOBS.includes(jobName)) continue;
            if (!body.includes('tenantId')) {
                violations.push(`${jobName}: body does not reference tenantId`);
            }
        }

        expect(violations).toEqual([]);
    });

    test('service files for tenant-scoped jobs contain tenantId filtering', () => {
        const serviceFiles = [
            { name: 'vendor-renewals', path: '../../src/app-layer/services/vendor-renewals.ts', pattern: /tenantFilter/ },
            { name: 'policyReviewReminder', path: '../../src/app-layer/jobs/policyReviewReminder.ts', pattern: /where\.tenantId\s*=\s*tenantId/ },
        ];

        for (const svc of serviceFiles) {
            const source = readFileSync(resolve(__dirname, svc.path), 'utf8');
            expect(source).toMatch(svc.pattern);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Payload Type Contract — tenantId must exist on all job payloads
// ═════════════════════════════════════════════════════════════════════

describe('Payload Type Contract — tenantId field audit', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');
    const typesPath = resolve(__dirname, '../../src/app-layer/jobs/types.ts');
    const typesSource = readFileSync(typesPath, 'utf8');

    // Jobs that legitimately don't need tenantId
    // SharePointDeltaSyncDispatchPayload (SP-3) is the global fan-out cron — no
    // single tenantId; it enqueues per-tenant SharePointDeltaSyncPayload jobs.
    const EXEMPT_PAYLOADS = ['HealthCheckPayload', 'SyncPullPayload', 'ScheduleTriggerSweepPayload', 'SharePointDeltaSyncDispatchPayload', 'SharePointSubscriptionRenewPayload', 'RiskAppetiteMonitorPayload', 'RiskSnapshotPayload', 'ReportDeliveryPayload', 'ExchangeExpirySweepPayload', 'MarketPricesPullPayload', 'MarketNewsPullPayload',
        // Global sweep over a cross-tenant table — no payload tenant axis.
        'PromotionLeadRetentionPayload',
        // Calendar roadmap PR 3 — same GLOBAL shape as MarketNewsPullPayload
        // above; NewsDerivedEvent/MarketNewsItem carry no tenantId.
        'NewsEventExtractionPayload',
        // Same reason as its sibling above: a GLOBAL job over a GLOBAL table
        // has no tenant axis, so a tenantId field here would be a lie the type
        // system enforced.
        'SupportSchemeExtractionPayload'];

    test('every non-exempt payload interface has tenantId field', () => {
        // Extract all payload interfaces
        const interfacePattern = /export interface (\w+Payload)\s*\{([\s\S]*?)\}/g;
        const violations: string[] = [];

        let match;
        while ((match = interfacePattern.exec(typesSource)) !== null) {
            const name = match[1];
            const body = match[2];

            if (EXEMPT_PAYLOADS.includes(name)) continue;
            if (!body.includes('tenantId')) {
                violations.push(`${name}: missing tenantId field`);
            }
        }

        expect(violations).toEqual([]);
    });
});
