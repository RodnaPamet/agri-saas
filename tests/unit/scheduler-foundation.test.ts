/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Scheduler Foundation — Unit Tests
 *
 * Tests the core scheduling infrastructure:
 *   1. ExecutorRegistry — registration, dispatch, fault isolation, type contracts
 *   2. Scheduler — runOnce, runAll, tick, cron matching, validation
 *   3. JobRunResult — contract compliance
 *
 * These tests run in pure memory (no Redis, no Prisma, no external deps).
 */

// ─── Mocks ──────────────────────────────────────────────────────────

// Mock the logger to avoid console noise and verify log calls
const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

jest.mock('@/lib/observability/logger', () => ({
    logger: mockLogger,
}));

// Mock runJob to pass through (no OTel/context needed in tests)
jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import type { JobRunResult } from '../../src/app-layer/jobs/types';
import { cronMatchesNow } from '../../src/app-layer/jobs/scheduler';

// ═════════════════════════════════════════════════════════════════════
// 1. Executor Registry Tests
// ═════════════════════════════════════════════════════════════════════

describe('ExecutorRegistry', () => {
    // We need a fresh registry per test to avoid cross-test pollution.
    // The real registry is a singleton with default registrations,
    // so we create isolated registry instances using the same pattern.
    let registry: typeof import('../../src/app-layer/jobs/executor-registry').executorRegistry;

    beforeEach(() => {
        // Reset modules to get a clean registry
        jest.resetModules();
        // Re-apply mocks after module reset
        jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
        jest.mock('@/lib/observability/job-runner', () => ({
            runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
        }));
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    async function getCleanRegistry() {
        const mod = await import('../../src/app-layer/jobs/executor-registry');
        // The module has default registrations — reset them for isolated tests
        mod.executorRegistry._reset();
        return mod.executorRegistry;
    }

    test('registers a job executor and can look it up', async () => {
        registry = await getCleanRegistry();

        const executor = jest.fn(async () => ({
            jobName: 'health-check',
            jobRunId: 'test-123',
            success: true,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 5,
            itemsScanned: 0,
            itemsActioned: 0,
            itemsSkipped: 0,
        } as JobRunResult));

        registry.register('health-check', executor);

        expect(registry.has('health-check')).toBe(true);
        expect(registry.getExecutor('health-check')).toBe(executor);
        expect(registry.size).toBe(1);
        expect(registry.listRegistered()).toEqual(['health-check']);
    });

    test('rejects duplicate registration', async () => {
        registry = await getCleanRegistry();
        const noop = jest.fn(async () => ({} as JobRunResult));

        registry.register('health-check', noop);
        expect(() => registry.register('health-check', noop)).toThrow(
            /Duplicate executor registration/,
        );
    });

    test('execute dispatches to the registered executor', async () => {
        registry = await getCleanRegistry();

        const mockResult: JobRunResult = {
            jobName: 'health-check',
            jobRunId: 'run-abc',
            success: true,
            startedAt: '2026-01-01T00:00:00Z',
            completedAt: '2026-01-01T00:00:01Z',
            durationMs: 10,
            itemsScanned: 42,
            itemsActioned: 3,
            itemsSkipped: 2,
        };

        registry.register('health-check', async () => mockResult);

        const result = await registry.execute('health-check', {
            enqueuedAt: new Date().toISOString(),
        });

        expect(result).toEqual(mockResult);
        expect(result.success).toBe(true);
        expect(result.itemsScanned).toBe(42);
    });

    test('execute returns failure result for unregistered job', async () => {
        registry = await getCleanRegistry();

        const result = await registry.execute('health-check', {
            enqueuedAt: new Date().toISOString(),
        });

        expect(result.success).toBe(false);
        expect(result.errorMessage).toContain('No executor registered');
        expect(result.jobName).toBe('health-check');
    });

    test('execute catches executor errors and returns failure result (fault isolation)', async () => {
        registry = await getCleanRegistry();

        registry.register('health-check', async () => {
            throw new Error('Database connection lost');
        });

        const result = await registry.execute('health-check', {
            enqueuedAt: new Date().toISOString(),
        });

        // Should NOT throw — fault isolation
        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe('Database connection lost');
        expect(result.jobName).toBe('health-check');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('execute handles non-Error thrown values', async () => {
        registry = await getCleanRegistry();

        registry.register('health-check', async () => {
            throw 'string error';  
        });

        const result = await registry.execute('health-check', {
            enqueuedAt: new Date().toISOString(),
        });

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe('string error');
    });

    test('_reset clears all registrations', async () => {
        registry = await getCleanRegistry();
        registry.register('health-check', async () => ({} as JobRunResult));
        expect(registry.size).toBe(1);

        registry._reset();
        expect(registry.size).toBe(0);
        expect(registry.has('health-check')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Cron Pattern Matching Tests
// ═════════════════════════════════════════════════════════════════════

describe('cronMatchesNow', () => {
    // Use a fixed date: 2026-04-17 06:15:00 UTC (Friday, day=5)
    const fixedDate = new Date('2026-04-17T06:15:00Z');

    test('wildcard pattern matches any time', () => {
        expect(cronMatchesNow('* * * * *', fixedDate)).toBe(true);
    });

    test('exact match on all fields', () => {
        // minute=15, hour=6, day=17, month=4, dow=5(Fri)
        expect(cronMatchesNow('15 6 17 4 5', fixedDate)).toBe(true);
    });

    test('wrong minute does not match', () => {
        expect(cronMatchesNow('30 6 17 4 5', fixedDate)).toBe(false);
    });

    test('wrong hour does not match', () => {
        expect(cronMatchesNow('15 8 17 4 5', fixedDate)).toBe(false);
    });

    test('step pattern */15 on minute 15 matches', () => {
        expect(cronMatchesNow('*/15 * * * *', fixedDate)).toBe(true);
    });

    test('step pattern */15 on minute 16 does not match', () => {
        const atMinute16 = new Date('2026-04-17T06:16:00Z');
        expect(cronMatchesNow('*/15 * * * *', atMinute16)).toBe(false);
    });

    test('daily at 06:00 does not match at 06:15', () => {
        expect(cronMatchesNow('0 6 * * *', fixedDate)).toBe(false);
    });

    test('daily at 06:00 matches at exactly 06:00', () => {
        const at0600 = new Date('2026-04-17T06:00:00Z');
        expect(cronMatchesNow('0 6 * * *', at0600)).toBe(true);
    });

    test('comma-separated list matches', () => {
        expect(cronMatchesNow('10,15,30 * * * *', fixedDate)).toBe(true);
        expect(cronMatchesNow('10,20,30 * * * *', fixedDate)).toBe(false);
    });

    test('range pattern matches', () => {
        expect(cronMatchesNow('10-20 * * * *', fixedDate)).toBe(true);
        expect(cronMatchesNow('20-30 * * * *', fixedDate)).toBe(false);
    });

    test('invalid pattern does not match', () => {
        expect(cronMatchesNow('', fixedDate)).toBe(false);
        expect(cronMatchesNow('* *', fixedDate)).toBe(false);
    });

    test('real schedule patterns from SCHEDULED_JOBS are valid', () => {
        // Import SCHEDULED_JOBS
        const { SCHEDULED_JOBS } = require('../../src/app-layer/jobs/schedules');
        for (const schedule of SCHEDULED_JOBS) {
            const parts = schedule.pattern.split(' ');
            expect(parts.length).toBeGreaterThanOrEqual(5);
            // Just verify the function doesn't throw
            const result = cronMatchesNow(schedule.pattern, fixedDate);
            expect(typeof result).toBe('boolean');
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Scheduler Integration Tests
// ═════════════════════════════════════════════════════════════════════

describe('Scheduler', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
        jest.mock('@/lib/observability/job-runner', () => ({
            runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
        }));
        jest.clearAllMocks();
    });

    test('runOnce executes a single named job', async () => {
        // Get fresh modules
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        executorRegistry._reset();

        const mockResult: JobRunResult = {
            jobName: 'health-check',
            jobRunId: 'test-run',
            success: true,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 5,
            itemsScanned: 10,
            itemsActioned: 2,
            itemsSkipped: 1,
        };

        executorRegistry.register('health-check', async () => mockResult);

        const { scheduler } = await import('../../src/app-layer/jobs/scheduler');
        const result = await scheduler.runOnce('health-check', {
            enqueuedAt: new Date().toISOString(),
        });

        expect(result).toEqual(mockResult);
        expect(result.success).toBe(true);
    });

    test('runAll executes all scheduled jobs sequentially', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        executorRegistry._reset();

        const calls: string[] = [];

        // Register mock executors for all scheduled jobs
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');
        for (const schedule of SCHEDULED_JOBS) {
            executorRegistry.register(schedule.name as any, async () => {
                calls.push(schedule.name);
                return {
                    jobName: schedule.name,
                    jobRunId: `run-${schedule.name}`,
                    success: true,
                    startedAt: new Date().toISOString(),
                    completedAt: new Date().toISOString(),
                    durationMs: 1,
                    itemsScanned: 0,
                    itemsActioned: 0,
                    itemsSkipped: 0,
                } as JobRunResult;
            });
        }

        const { scheduler } = await import('../../src/app-layer/jobs/scheduler');
        const summary = await scheduler.runAll();

        expect(summary.jobsExecuted).toBe(SCHEDULED_JOBS.length);
        expect(summary.jobsSucceeded).toBe(SCHEDULED_JOBS.length);
        expect(summary.jobsFailed).toBe(0);
        expect(calls).toEqual(SCHEDULED_JOBS.map(s => s.name));
    });

    test('runAll continues executing after a job failure (fault isolation)', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        executorRegistry._reset();

        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');

        // Register all jobs — the first one will "fail"
        for (const schedule of SCHEDULED_JOBS) {
            const isFirst = schedule === SCHEDULED_JOBS[0];
            executorRegistry.register(schedule.name as any, async () => {
                if (isFirst) {
                    // The executor itself doesn't throw (executorRegistry.execute catches)
                    // but returns a failure result
                    return {
                        jobName: schedule.name,
                        jobRunId: 'fail-run',
                        success: false,
                        startedAt: new Date().toISOString(),
                        completedAt: new Date().toISOString(),
                        durationMs: 1,
                        itemsScanned: 0,
                        itemsActioned: 0,
                        itemsSkipped: 0,
                        errorMessage: 'Intentional test failure',
                    } as JobRunResult;
                }
                return {
                    jobName: schedule.name,
                    jobRunId: `run-${schedule.name}`,
                    success: true,
                    startedAt: new Date().toISOString(),
                    completedAt: new Date().toISOString(),
                    durationMs: 1,
                    itemsScanned: 0,
                    itemsActioned: 0,
                    itemsSkipped: 0,
                } as JobRunResult;
            });
        }

        const { scheduler } = await import('../../src/app-layer/jobs/scheduler');
        const summary = await scheduler.runAll();

        // All jobs should have executed
        expect(summary.jobsExecuted).toBe(SCHEDULED_JOBS.length);
        // First job failed, rest succeeded
        expect(summary.jobsFailed).toBe(1);
        expect(summary.jobsSucceeded).toBe(SCHEDULED_JOBS.length - 1);
    });

    test('tick only executes jobs whose cron pattern matches', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        executorRegistry._reset();

        const executed: string[] = [];

        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');
        for (const schedule of SCHEDULED_JOBS) {
            executorRegistry.register(schedule.name as any, async () => {
                executed.push(schedule.name);
                return {
                    jobName: schedule.name,
                    jobRunId: `run-${schedule.name}`,
                    success: true,
                    startedAt: new Date().toISOString(),
                    completedAt: new Date().toISOString(),
                    durationMs: 1,
                    itemsScanned: 0,
                    itemsActioned: 0,
                    itemsSkipped: 0,
                } as JobRunResult;
            });
        }

        const { scheduler } = await import('../../src/app-layer/jobs/scheduler');

        // 06:00 UTC matches:
        //   - daily-evidence-expiry (0 6 * * *)
        const at0600 = new Date('2026-04-17T06:00:00Z');
        const summary = await scheduler.tick(at0600);

        expect(summary.jobsEvaluated).toBe(SCHEDULED_JOBS.length);
        // Only jobs scheduled for 06:00 should run
        expect(executed).toContain('daily-evidence-expiry');
        // Jobs at other times should NOT run
        expect(executed).not.toContain('data-lifecycle'); // 03:00
        expect(executed).not.toContain('policy-review-reminder'); // 08:00
    });

    test('tick at a time matching no jobs executes nothing', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        executorRegistry._reset();

        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');
        for (const schedule of SCHEDULED_JOBS) {
            executorRegistry.register(schedule.name as any, async () => ({
                jobName: schedule.name,
                jobRunId: 'x',
                success: true,
                startedAt: '',
                completedAt: '',
                durationMs: 0,
                itemsScanned: 0,
                itemsActioned: 0,
                itemsSkipped: 0,
            } as JobRunResult));
        }

        const { scheduler } = await import('../../src/app-layer/jobs/scheduler');

        // 02:33 UTC — no scheduled job runs at this time
        const at0233 = new Date('2026-04-17T02:33:00Z');
        const summary = await scheduler.tick(at0233);

        expect(summary.jobsEvaluated).toBe(SCHEDULED_JOBS.length);
        expect(summary.jobsExecuted).toBe(0);
        expect(summary.results).toEqual([]);
    });

    /** The single executor registered by the test below. */
    const REGISTERED_JOB = 'health-check' as const;

    test('validateRegistrations reports missing executors', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        executorRegistry._reset();

        // Register exactly one job — every OTHER scheduled job must then be
        // reported missing, and this one must not be.
        executorRegistry.register(REGISTERED_JOB, async () => ({} as JobRunResult));

        const { scheduler } = await import('../../src/app-layer/jobs/scheduler');
        const validation = scheduler.validateRegistrations();

        expect(validation.valid).toBe(false);
        expect(validation.missing.length).toBeGreaterThan(0);

        // `health-check` USED to be absent from SCHEDULED_JOBS, and this test
        // relied on that: it registered the one executor it knew could not
        // collide with the loop below. #809 schedules `health-check` every two
        // minutes to drive the worker heartbeat, so the sentinel is now a
        // scheduled job like any other.
        //
        // That is worth more than it cost. A registered-but-unscheduled job
        // proves nothing about `validateRegistrations` — it would be absent
        // from `missing` whether the function consulted the registry or not.
        // Now the registered job IS scheduled, so its absence from `missing`
        // is the discriminating observation, and it is asserted below.
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');
        const expectedMissing = SCHEDULED_JOBS.map((s) => s.name).filter((n) => n !== REGISTERED_JOB);

        // Positive control: an empty list would assert nothing at all.
        expect(expectedMissing.length).toBeGreaterThan(0);

        // Asserted as a set difference rather than a loop of `toContain`, so
        // there is no iteration to gut: a loop over an empty array passes
        // while checking nothing, which is the defect class this repo keeps
        // finding in its own guards.
        const reported = new Set(validation.missing);
        expect(expectedMissing.filter((n) => !reported.has(n))).toEqual([]);

        // The one job that HAS an executor must not be reported missing.
        // This is the discriminating assertion — without it the test passes
        // whether or not `validateRegistrations` consults the registry.
        expect(validation.missing).not.toContain(REGISTERED_JOB);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. JobRunResult Contract Tests
// ═════════════════════════════════════════════════════════════════════

describe('JobRunResult contract', () => {
    test('successful result has all required fields', () => {
        const result: JobRunResult = {
            jobName: 'retention-sweep',
            jobRunId: crypto.randomUUID(),
            success: true,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 123,
            itemsScanned: 100,
            itemsActioned: 5,
            itemsSkipped: 3,
        };

        expect(result.jobName).toBe('retention-sweep');
        expect(result.success).toBe(true);
        expect(typeof result.jobRunId).toBe('string');
        expect(typeof result.startedAt).toBe('string');
        expect(typeof result.completedAt).toBe('string');
        expect(typeof result.durationMs).toBe('number');
        expect(typeof result.itemsScanned).toBe('number');
        expect(typeof result.itemsActioned).toBe('number');
        expect(typeof result.itemsSkipped).toBe('number');
        expect(result.errorMessage).toBeUndefined();
    });

    test('failure result includes errorMessage', () => {
        const result: JobRunResult = {
            jobName: 'data-lifecycle',
            jobRunId: crypto.randomUUID(),
            success: false,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 50,
            itemsScanned: 0,
            itemsActioned: 0,
            itemsSkipped: 0,
            errorMessage: 'Connection refused',
        };

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe('Connection refused');
    });

    test('result with optional details field', () => {
        const result: JobRunResult = {
            jobName: 'vendor-renewal-check',
            jobRunId: crypto.randomUUID(),
            success: true,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 200,
            itemsScanned: 50,
            itemsActioned: 10,
            itemsSkipped: 5,
            details: {
                overdueReviews: 3,
                overdueRenewals: 7,
                tenants: ['acme-corp', 'beta-inc'],
            },
        };

        expect(result.details).toBeDefined();
        expect(result.details!.overdueReviews).toBe(3);
    });

    test('result is fully JSON-serializable', () => {
        const result: JobRunResult = {
            jobName: 'health-check',
            jobRunId: 'uuid-here',
            success: true,
            startedAt: '2026-01-01T00:00:00Z',
            completedAt: '2026-01-01T00:00:01Z',
            durationMs: 1000,
            itemsScanned: 0,
            itemsActioned: 0,
            itemsSkipped: 0,
            details: { nested: { deep: true } },
        };

        const serialized = JSON.stringify(result);
        const deserialized = JSON.parse(serialized);

        expect(deserialized).toEqual(result);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Default Executor Registrations (smoke test)
// ═════════════════════════════════════════════════════════════════════

describe('Default executor registrations', () => {
    beforeEach(() => {
        // Reset modules so executor-registry re-runs its default registrations
        jest.resetModules();
        jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
        jest.mock('@/lib/observability/job-runner', () => ({
            runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
        }));
    });

    test('all scheduled jobs have a registered executor by default', async () => {
        // Fresh import — module side-effects re-run all register() calls
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');

        for (const schedule of SCHEDULED_JOBS) {
            expect(executorRegistry.has(schedule.name)).toBe(true);
        }
    });

    test('registry has correct number of executors', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');

        // All scheduled jobs + health-check + sync-pull = 8
        expect(executorRegistry.size).toBeGreaterThanOrEqual(8);
    });
});
