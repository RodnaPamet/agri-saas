/**
 * Coverage wave 19 — the BullMQ executor registry.
 *
 * `executor-registry.ts` carries 113 uncovered functions (5.83%), the
 * largest single concentration in the repo. Most of those are the ~100
 * registered executor callbacks; this suite deliberately does NOT chase
 * all of them (see the note at the bottom of the file).
 *
 * What it does cover is the registry's own contract, which is what the
 * whole job system rests on:
 *
 *   - a duplicate registration is refused loudly at module load,
 *   - an unknown job name fails as DATA, not as an exception,
 *   - a throwing executor cannot take the worker down with it.
 *
 * That last one is the reason this file exists at all. The scheduler
 * runs every job through `execute`, so if fault isolation regresses,
 * one bad job stops every other job on the worker.
 */

const recordJobMetrics = jest.fn();
jest.mock('@/lib/observability/metrics', () => ({
    __esModule: true,
    recordJobMetrics: (...a: unknown[]) => recordJobMetrics(...a),
}));

import { executorRegistry } from '@/app-layer/jobs/executor-registry';

/** Unique name per test — the registry is a module-level singleton. */
let seq = 0;
const uniqueName = () => `__test-job-${++seq}` as never;

beforeEach(() => {
    recordJobMetrics.mockClear();
});

describe('executorRegistry — registration', () => {
    it('makes a registered executor discoverable', () => {
        const name = uniqueName();
        const fn = jest.fn();

        executorRegistry.register(name, fn as never);

        expect(executorRegistry.has(name)).toBe(true);
        expect(executorRegistry.getExecutor(name)).toBe(fn);
        expect(executorRegistry.listRegistered()).toContain(name);
    });

    it('refuses a duplicate registration, naming the job', () => {
        // Break: silently overwriting. Two modules registering the same
        // job name would leave whichever loaded last in charge, and the
        // other job would simply never run — with no error anywhere.
        const name = uniqueName();
        executorRegistry.register(name, jest.fn() as never);

        expect(() => executorRegistry.register(name, jest.fn() as never)).toThrow(
            new RegExp(`Duplicate executor registration for job "${name}"`),
        );
    });

    it('reports an unregistered name as absent', () => {
        expect(executorRegistry.has('__never-registered')).toBe(false);
        expect(executorRegistry.getExecutor('__never-registered' as never)).toBeUndefined();
    });
});

describe('executorRegistry — fault isolation', () => {
    it('returns a structured failure for an unknown job instead of throwing', () => {
        // Break: throwing here would crash the scheduler tick on a
        // stale queue entry for a job that no longer exists.
        return expect(
            executorRegistry.execute('__no-such-job' as never, {} as never),
        ).resolves.toMatchObject({
            success: false,
            errorMessage: 'No executor registered for job "__no-such-job"',
            itemsScanned: 0,
            itemsActioned: 0,
            itemsSkipped: 0,
        });
    });

    it('converts a throwing executor into a failed result, not an exception', async () => {
        // THE contract of this module. Break: one failing job takes
        // down the worker and every other job with it.
        const name = uniqueName();
        executorRegistry.register(name, (async () => {
            throw new Error('boom');
        }) as never);

        const result = await executorRegistry.execute(name, {} as never);

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe('boom');
        expect(result.jobName).toBe(name);
    });

    it('stringifies a non-Error throw rather than reporting undefined', async () => {
        // Break: `error.message` on a thrown string yields undefined,
        // so the failure reaches the logs with no cause attached.
        const name = uniqueName();
        executorRegistry.register(name, (async () => {
            throw 'plain string failure';
        }) as never);

        const result = await executorRegistry.execute(name, {} as never);

        expect(result.errorMessage).toBe('plain string failure');
    });

    it('stamps a distinct run id on each execution', async () => {
        // Break: a shared or missing jobRunId makes two concurrent runs
        // of the same job indistinguishable in the logs.
        const name = uniqueName();
        executorRegistry.register(name, (async () => {
            throw new Error('x');
        }) as never);

        const a = await executorRegistry.execute(name, {} as never);
        const b = await executorRegistry.execute(name, {} as never);

        expect(a.jobRunId).toBeTruthy();
        expect(a.jobRunId).not.toBe(b.jobRunId);
    });
});

describe('executorRegistry — success path and metrics', () => {
    const okResult = (jobName: string) => ({
        jobName,
        jobRunId: 'r-1',
        success: true,
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        durationMs: 42,
        itemsScanned: 3,
        itemsActioned: 2,
        itemsSkipped: 1,
    });

    it('returns the executor result untouched', async () => {
        // Break: rewrapping would drop the per-job counters the
        // scheduler reports on.
        const name = uniqueName();
        executorRegistry.register(name, (async () => okResult(name)) as never);

        const result = await executorRegistry.execute(name, {} as never);

        expect(result).toEqual(okResult(name));
    });

    it('records a metric on the success path using the reported duration', async () => {
        // Break: losing job metrics blinds the only dashboard that
        // shows whether scheduled work is running at all.
        const name = uniqueName();
        executorRegistry.register(name, (async () => okResult(name)) as never);

        await executorRegistry.execute(name, {} as never);

        expect(recordJobMetrics).toHaveBeenCalledWith({
            jobName: name,
            success: true,
            durationMs: 42,
        });
    });

    it('records a FAILURE metric when the executor throws', async () => {
        // Break: only instrumenting the happy path means a job that
        // fails every run looks identical to one that never ran.
        const name = uniqueName();
        executorRegistry.register(name, (async () => {
            throw new Error('boom');
        }) as never);

        await executorRegistry.execute(name, {} as never);

        expect(recordJobMetrics).toHaveBeenCalledWith(
            expect.objectContaining({ jobName: name, success: false }),
        );
    });

    it('records success:false when the executor RESOLVES with a failure', async () => {
        // Subtle: a job can complete normally and still report failure.
        // Break: hardcoding success:true on the resolve path would hide
        // every soft failure from metrics.
        const name = uniqueName();
        executorRegistry.register(name, (async () => ({
            ...okResult(name),
            success: false,
        })) as never);

        await executorRegistry.execute(name, {} as never);

        expect(recordJobMetrics).toHaveBeenCalledWith(
            expect.objectContaining({ success: false }),
        );
    });

    it('forwards the worker context so executors can report progress', async () => {
        // Break: dropping ctx silently disables BullMQ progress
        // reporting for every long-running job.
        const name = uniqueName();
        const seen: unknown[] = [];
        executorRegistry.register(name, (async (payload: unknown, ctx: unknown) => {
            seen.push(payload, ctx);
            return okResult(name);
        }) as never);

        const ctx = { updateProgress: jest.fn() };
        await executorRegistry.execute(name, { a: 1 } as never, ctx as never);

        expect(seen[0]).toEqual({ a: 1 });
        expect(seen[1]).toBe(ctx);
    });
});

describe('executorRegistry — real registrations', () => {
    it('registers every job name exactly once', () => {
        // The duplicate guard throws at module load, so reaching this
        // point already proves no collisions. This pins the observable
        // consequence: no name appears twice in the registry.
        const names = executorRegistry
            .listRegistered()
            .filter((n) => !n.startsWith('__test-job-'));

        expect(names.length).toBeGreaterThan(0);
        expect(new Set(names).size).toBe(names.length);
    });

    it('runs the self-contained health-check executor end to end', async () => {
        // health-check is the one executor with no external dependency,
        // so it can be exercised for real. Break: a health probe that
        // reports failure would page an on-call engineer for nothing.
        const result = await executorRegistry.execute('health-check', {
            enqueuedAt: new Date(0).toISOString(),
        } as never);

        expect(result.success).toBe(true);
        expect(result.jobName).toBe('health-check');
    });

    it('defaults the health-check message when none is supplied', async () => {
        const result = await executorRegistry.execute('health-check', {
            enqueuedAt: new Date(0).toISOString(),
        } as never);

        expect((result as { details?: { message?: string } }).details?.message).toBe('pong');
    });

    it('rejects embed-chunks without a tenant, as a failure not a crash', async () => {
        // The GLOBAL catalogue is embedded by an ingestion script, not
        // this job. Break: dropping the guard would run a tenantless
        // embed and, without RLS context, touch the wrong rows.
        const result = await executorRegistry.execute('embed-chunks', {} as never);

        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/requires a tenantId/);
    });
});

/**
 * Deliberately NOT covered here: the remaining ~95 registered executor
 * callbacks.
 *
 * They are not uniform shims — several do real work (payload guards,
 * and result aggregation such as `daily-evidence-expiry` summing the
 * 30/7/1-day sweep counters). But each reaches its job module through a
 * dynamic `await import(...)`, so exercising them means a per-module
 * mock apiece, and their domain logic already has its own tests in the
 * job modules.
 *
 * Executing them unmocked to inflate coverage was considered and
 * rejected: the bodies reach for the database, e-mail, storage and AI
 * providers, so a "fault isolation sweep" over all of them would be a
 * network-touching test whose real assertion is only "it didn't throw".
 * That is a coverage-shaped test wearing an invariant as a disguise.
 */
