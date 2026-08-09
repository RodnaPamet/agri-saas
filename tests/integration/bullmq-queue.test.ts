/**
 * BullMQ Queue — Contract Tests
 *
 * Validates job names, payload contracts, queue option defaults, and worker
 * processing behaviour WITHOUT requiring a live Redis instance.
 *
 * Architecture note: BullMQ v5 relies on Lua scripts that are incompatible with
 * in-process Redis mocks. These tests mock the BullMQ layer itself, keeping
 * infrastructure out of the unit/integration contract assertions.
 */
import { QUEUE_NAME, JOB_DEFAULTS, JobPayloadMap } from '../../src/app-layer/jobs/types';
import type { HealthCheckPayload, SyncPullPayload } from '../../src/app-layer/jobs/types';

// ─── In-memory Queue Mock ─────────────────────────────────────────────────────

interface MockJob<T = unknown> {
    id: string;
    name: string;
    data: T;
    opts: Record<string, unknown>;
    returnvalue?: unknown;
    _state: 'waiting' | 'completed' | 'failed';
    failedReason?: string;
}

let _nextId = 1;

class MockQueue {
    readonly name: string;
    private jobs: MockJob[] = [];

    constructor(name: string) {
        this.name = name;
    }

    async add<T>(name: string, data: T, opts: Record<string, unknown> = {}): Promise<MockJob<T>> {
        const job: MockJob<T> = {
            id: String(_nextId++),
            name,
            data,
            opts,
            _state: 'waiting',
        };
        this.jobs.push(job as MockJob);
        return job;
    }

    async getJob(id: string): Promise<MockJob | undefined> {
        return this.jobs.find(j => j.id === id);
    }

    async getJobs(types: string[]): Promise<MockJob[]> {
        return this.jobs.filter(j => types.includes(j._state));
    }

    async close(): Promise<void> { /* noop */ }
    async obliterate(): Promise<void> { this.jobs = []; }

    _processJob(id: string, result: unknown): void {
        const job = this.jobs.find(j => j.id === id);
        if (job) { job._state = 'completed'; job.returnvalue = result; }
    }
}

class MockWorker {
    readonly queueName: string;
    private handler: (job: MockJob) => Promise<unknown>;

    constructor(queueName: string, handler: (job: MockJob) => Promise<unknown>) {
        this.queueName = queueName;
        this.handler = handler;
    }

    async process(job: MockJob): Promise<unknown> {
        return this.handler(job);
    }

    async close(): Promise<void> { /* noop */ }
    async waitUntilReady(): Promise<void> { /* noop */ }
}

jest.mock('bullmq', () => ({
    Queue: MockQueue,
    Worker: MockWorker,
    Job: class {},
    QueueEvents: class { on() {} close() {} },
}));

// ─── Re-import after mock ─────────────────────────────────────────────────────
import { Queue, Worker } from 'bullmq';

// ─────────────────────────────────────────────────────────────────────────────

describe('BullMQ Queue — Constants', () => {
    test('QUEUE_NAME is a non-empty string', () => {
        expect(typeof QUEUE_NAME).toBe('string');
        expect(QUEUE_NAME.length).toBeGreaterThan(0);
    });

    test('JOB_DEFAULTS covers all job names', () => {
        const expectedJobs: Array<keyof JobPayloadMap> = [
            'health-check',
            'automation-runner',
            'daily-evidence-expiry',
            'data-lifecycle',
            'policy-review-reminder',
            'retention-sweep',
            'sync-pull',
        ];
        for (const name of expectedJobs) {
            expect(JOB_DEFAULTS[name]).toBeDefined();
            expect(JOB_DEFAULTS[name].attempts).toBeGreaterThan(0);
            expect(JOB_DEFAULTS[name].backoff).toMatchObject({ type: expect.any(String), delay: expect.any(Number) });
        }
    });
});

describe('BullMQ Queue — Enqueue contract', () => {
    let queue: InstanceType<typeof MockQueue>;

    beforeEach(() => {
        queue = new (Queue as unknown as typeof MockQueue)(QUEUE_NAME);
    });

    afterEach(async () => {
        await (queue as MockQueue).obliterate();
        await queue.close();
    });

    test('enqueue creates a job with correct name and data', async () => {
        const payload: HealthCheckPayload = { enqueuedAt: new Date().toISOString(), message: 'test' };
        const job = await queue.add('health-check', payload, JOB_DEFAULTS['health-check'] as never);

        expect(job.id).toBeDefined();
        expect(job.name).toBe('health-check');
        expect(job.data).toEqual(payload);
    });

    test('job defaults are applied correctly', async () => {
        const job = await queue.add('health-check', { enqueuedAt: new Date().toISOString() }, JOB_DEFAULTS['health-check'] as never);

        expect((job.opts as typeof JOB_DEFAULTS['health-check']).attempts).toBe(JOB_DEFAULTS['health-check'].attempts);
        expect((job.opts as typeof JOB_DEFAULTS['health-check']).backoff).toEqual(JOB_DEFAULTS['health-check'].backoff);
    });

    test('multiple job types can coexist in the queue', async () => {
        const j1 = await queue.add('health-check', { enqueuedAt: new Date().toISOString() });
        const j2 = await queue.add('automation-runner', { tenantId: 'tenant-1' });

        expect(j1.name).toBe('health-check');
        expect(j2.name).toBe('automation-runner');
        expect(j1.id).not.toBe(j2.id);
    });

    test('getJob retrieves an enqueued job by id', async () => {
        const payload: HealthCheckPayload = { enqueuedAt: new Date().toISOString(), message: 'get-test' };
        const job = await queue.add('health-check', payload);

        const fetched = await queue.getJob(job.id);
        expect(fetched).toBeDefined();
        expect(fetched!.data).toMatchObject({ message: 'get-test' });
    });

    test('sync-pull payload contract is satisfied', async () => {
        const payload: SyncPullPayload = {
            ctx: {
                tenantId: 'tenant-1',
                userId: 'system',
                requestId: 'req-1',
                role: 'ADMIN',
                permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
            },
            mappingKey: {
                tenantId: 'tenant-1',
                provider: 'github',
                localEntityType: 'practice',
                localEntityId: 'ctrl-1',
                remoteEntityType: 'branch_protection',
                remoteEntityId: 'main',
            },
            remoteData: { enabled: true },
            remoteUpdatedAtIso: new Date().toISOString(),
        };

        const job = await queue.add('sync-pull', payload, JOB_DEFAULTS['sync-pull'] as never);
        expect(job.data.ctx.tenantId).toBe('tenant-1');
        expect(job.data.mappingKey.provider).toBe('github');
        expect(job.data.remoteData).toEqual({ enabled: true });
    });
});

describe('BullMQ Worker — Round-trip contract', () => {
    test('worker receives and processes an enqueued job', async () => {
        const queue = new (Queue as unknown as typeof MockQueue)(QUEUE_NAME);

        const processed: unknown[] = [];
        const worker = new (Worker as unknown as typeof MockWorker)(
            QUEUE_NAME,
            async (job: MockJob) => {
                processed.push(job.data);
                return { status: 'ok', message: (job.data as HealthCheckPayload).message };
            },
        );

        await worker.waitUntilReady();

        const payload: HealthCheckPayload = { enqueuedAt: new Date().toISOString(), message: 'round-trip' };
        const job = await queue.add('health-check', payload);

        // Simulate worker picking up and processing the job
        const result = await (worker as MockWorker).process(job as unknown as MockJob);

        expect(processed).toHaveLength(1);
        expect(processed[0]).toMatchObject({ message: 'round-trip' });
        expect(result).toMatchObject({ status: 'ok', message: 'round-trip' });

        await worker.close();
        await queue.close();
    });
});
