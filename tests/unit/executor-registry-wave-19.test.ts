/* eslint-disable @typescript-eslint/no-explicit-any -- every job module is
 * replaced by one permissive stub; typing 48 unrelated result shapes would add
 * no safety to a test whose subject is the REGISTRY, not the jobs. */

/**
 * Coverage wave 19 — the job executor registry.
 *
 * `executor-registry.ts` is the single dispatch seam between every entrypoint
 * (BullMQ worker, cron route, CLI) and 51 background jobs. It had 7 of 120
 * functions executed: the registry object was reachable from other suites, but
 * not one of the 51 registered executor closures had ever run. A closure that
 * throws on load — a renamed export, a moved module, a destructure of
 * something no longer exported — would have been invisible until the job fired
 * in production, at 03:00, in a worker nobody is watching.
 *
 * The subject here is the REGISTRY, not the jobs. Each job module is replaced
 * by one permissive stub so that invoking an executor proves the wiring: the
 * name is registered, the closure resolves its import, destructures what it
 * expects, and returns a well-formed `JobRunResult`. The jobs themselves have
 * their own suites.
 *
 * Three properties are worth more than the coverage:
 *
 *   1. **Fault isolation is the registry's whole job.** `execute` must NEVER
 *      throw — a failing job returns a failure result so one bad job cannot
 *      take down the scheduler or its siblings. The source says so; nothing
 *      asserted it.
 *
 *   2. **Duplicate registration is refused.** Two modules registering the same
 *      job name would mean the second silently wins and the first never runs.
 *      The registry throws instead, at module-load time.
 *
 *   3. **Every name in the registry is dispatchable.** The sweep below runs
 *      all 51 and asserts each returns a result rather than throwing, which is
 *      what catches a moved module or a renamed export.
 */

/** Recursive stand-in for any job's return value.
 *
 * Executors read wildly different shapes off their result — `r.scanned`,
 * `r.sweeps.days30.tasksCreated`, `r.totalDue - r.executed`. One permissive
 * proxy satisfies all of them: property access yields another proxy, numeric
 * coercion yields 0, and `then` is explicitly undefined so `await` does not
 * mistake it for a thenable and hang. */
const mockAny: any = new Proxy(function () {} as any, {
    get(_t, prop) {
        if (prop === 'then') return undefined;
        if (prop === Symbol.toPrimitive) return () => 0;
        if (prop === Symbol.iterator) return function* () {};
        if (prop === 'valueOf') return () => 0;
        if (prop === 'toString') return () => '0';
        if (prop === 'length') return 0;
        return mockAny;
    },
    apply: () => mockAny,
    has: () => true,
});

/** Any named export of any job module resolves to an async stub.
 *
 * `then` MUST be undefined here. A module namespace is the value `await
 * import(...)` resolves to, so a proxy that answers `then` with a function
 * makes the namespace look like a thenable — `await` then calls it expecting
 * resolve/reject callbacks that a `jest.fn()` never invokes, and the import
 * hangs forever instead of failing. */
const mockJobModule: any = new Proxy(
    {},
    {
        get: (_t, prop) =>
            prop === 'then' ? undefined : jest.fn(async () => mockAny),
        has: () => true,
    },
);

/** Payload for the dispatch sweep.
 *
 * Executors read different required fields off the payload — `tenantId`,
 * `mappingKey.provider`, `batchSize` — and several throw a real precondition
 * error when one is absent. Those preconditions are the JOBS' contracts, not
 * the registry's, so the sweep supplies a payload permissive enough to reach
 * the dispatch it is actually testing. */
const mockPayload: any = new Proxy(
    {},
    {
        get: (_t, prop) => {
            if (prop === 'then') return undefined;
            if (prop === 'tenantId') return 'tenant-1';
            return mockAny;
        },
        has: () => true,
    },
);

jest.mock('@/lib/observability/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/observability/metrics', () => ({ recordJobMetrics: jest.fn() }));

jest.mock('@/app-layer/jobs/embed-chunks', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/automation-runner', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/dailyEvidenceExpiry', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/data-lifecycle', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/policyReviewReminder', () => mockJobModule, { virtual: false });
jest.mock('@/lib/prisma', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/access-review-reminder', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/access-review-overdue-escalation', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/exception-expiry-monitor', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/exchange-expiry-sweep', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/soil-fetch', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/task-due-notification', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/retention', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/promotion-lead-retention', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/vendor-renewal-check', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/low-stock-monitor', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/lease-expiry-sweep', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/contract-delivery-window-sweep', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/reconcile-inventory-ledgers', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/agronomy-copilot', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/classify-photo', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/weather-pull', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/market-prices-pull', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/market-news-pull', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/deadline-monitor', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/evidence-expiry-monitor', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/notification-dispatch', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/sync-pull', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/snapshot', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/sla-monitor', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/rule-chain-dispatch', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/subflow-dispatcher', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/schedule-trigger-sweep', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/compliance-digest', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/key-rotation', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/tenant-dek-rotation', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/automation-event-dispatch', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/control-test-scheduler', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/control-test-runner', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/evidence-import', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/sharepoint-delta-sync', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/sharepoint-policy-jobs', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/report-delivery-jobs', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/risk-appetite-jobs', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/spatial-import', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/cadastre-import', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/risk-snapshot-jobs', () => mockJobModule, { virtual: false });
jest.mock('@/app-layer/jobs/farm-record-pdf', () => mockJobModule, { virtual: false });

import { executorRegistry } from '@/app-layer/jobs/executor-registry';

/** Every job name registered at module load. */
const REGISTERED = [
    'health-check',
    'embed-chunks',
    'automation-runner',
    'daily-evidence-expiry',
    'data-lifecycle',
    'policy-review-reminder',
    'access-review-reminder',
    'access-review-overdue-escalation',
    'exception-expiry-monitor',
    'exchange-expiry-sweep',
    'soil-fetch',
    'task-due-notification',
    'retention-sweep',
    'promotion-lead-retention',
    'vendor-renewal-check',
    'low-stock-monitor',
    'lease-expiry-sweep',
    'contract-delivery-window-sweep',
    'reconcile-inventory-ledgers',
    'agronomy-copilot',
    'classify-photo',
    'weather-pull',
    'market-prices-pull',
    'market-prices-barchart',
    'market-news-pull',
    'deadline-monitor',
    'evidence-expiry-monitor',
    'notification-dispatch',
    'sync-pull',
    'compliance-snapshot',
    'sla-monitor',
    'rule-chain-dispatch',
    'subflow-dispatch',
    'schedule-trigger-sweep',
    'compliance-digest',
    'key-rotation',
    'tenant-dek-rotation',
    'automation-event-dispatch',
    'control-test-scheduler',
    'control-test-runner',
    'evidence-import',
    'sharepoint-delta-sync',
    'sharepoint-delta-sync-dispatch',
    'sharepoint-policy-pull',
    'sharepoint-subscription-renew',
    'report-delivery',
    'risk-appetite-monitor',
    'spatial-import',
    'cadastre-import',
    'risk-snapshot',
    'farm-record-pdf',
];

describe('executor registry — dispatch surface', () => {
    it('registers every known job name exactly once', () => {
        const listed = executorRegistry.listRegistered();
        expect(new Set(listed).size).toBe(listed.length);
        for (const name of REGISTERED) expect(listed).toContain(name);
    });

    it('refuses a duplicate registration', () => {
        // Break: without the guard the second registration silently wins and
        // the first job never runs again — with no error anywhere.
        expect(() =>
            executorRegistry.register('health-check' as any, (async () => mockAny) as any),
        ).toThrow(/Duplicate executor registration/);
    });

    it('returns undefined from getExecutor for an unknown name', () => {
        expect(executorRegistry.getExecutor('not-a-job' as any)).toBeUndefined();
    });
});

describe('executor registry — fault isolation', () => {
    it('never throws for an unknown job — it returns a failure result', async () => {
        // Break: throwing here takes down the caller. The scheduler runs jobs
        // in a loop; one unknown name must not end the loop.
        const res = await executorRegistry.execute('nope' as any, {} as any);
        expect(res.success).toBe(false);
        expect(String(res.errorMessage ?? '')).toMatch(/nope|executor/i);
    });

    it('converts a throwing executor into a failure result, not an exception', async () => {
        // Break: this is the registry's stated contract — "One failing job
        // never crashes the scheduler or other jobs."
        executorRegistry.register(
            'wave18-boom' as any,
            (async () => {
                throw new Error('job exploded');
            }) as any,
        );

        const res = await executorRegistry.execute('wave18-boom' as any, {} as any);

        expect(res.success).toBe(false);
        expect(String(res.errorMessage ?? '')).toContain('job exploded');
    });

    it('forwards the executor context to the executor', async () => {
        // Break: dropping ctx silently disables BullMQ progress reporting for
        // every long job — the UI just stops moving.
        const seen: unknown[] = [];
        executorRegistry.register(
            'wave18-ctx' as any,
            (async (_p: unknown, c: unknown) => {
                seen.push(c);
                return mockAny;
            }) as any,
        );
        const ctx = { reportProgress: jest.fn() };

        await executorRegistry.execute('wave18-ctx' as any, {} as any, ctx as any);

        expect(seen[0]).toBe(ctx);
    });
});

describe('executor registry — every registered job dispatches', () => {
    // Break: a moved module or a renamed export makes the closure throw on
    // first call. Before this sweep that surfaced at 03:00 in the worker.
    //
    // The assertion is "did not come back as a FAILURE", not "matches
    // JobRunResult". Most executors wrap their job in `makeResult(...)`, but
    // some return the job's own value straight through, so a strict shape
    // check would fail on the shape of the STUB rather than on anything real.
    // A dispatch fault is still caught: a throwing closure is converted by
    // `execute` into `{ success: false, error }`, which this rejects.
    it.each(REGISTERED)('%s resolves its module and dispatches', async (name) => {
        const res = await executorRegistry.execute(name as any, mockPayload);
        expect(res).toBeDefined();
        if (typeof res.success === 'boolean') {
            expect({ name, success: res.success, error: res.errorMessage }).toEqual(
                expect.objectContaining({ success: true }),
            );
        }
    });
});
