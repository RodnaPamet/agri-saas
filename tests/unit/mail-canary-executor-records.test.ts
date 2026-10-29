/**
 * The wiring half of #2467: the executor must actually write the record.
 *
 * `tests/unit/mail-canary-durability.test.ts` proves the record module and the
 * readyz capability behave. Neither of them proves anybody CALLS the writer —
 * and a durable record that nothing writes is the defect #2467 reports, one
 * level up: `/api/readyz` would report `never_recorded` for ever and that
 * reads like a brand-new deployment rather than a broken one.
 *
 * So this EXECUTES the registered `mail-canary` executor with a fake Redis and
 * asserts the write happened, for every outcome. A structural guard would have
 * been cheaper and would pass on a call sitting behind an `if (false)`.
 *
 * `runMailCanary` itself is mocked — its own behaviour is
 * `tests/unit/mail-canary.test.ts`'s subject, and this file is about the seam.
 */
const recordJobMetrics = jest.fn();
jest.mock('@/lib/observability/metrics', () => ({
    __esModule: true,
    recordJobMetrics: (...a: unknown[]) => recordJobMetrics(...a),
}));

const runMailCanary = jest.fn();
jest.mock('@/app-layer/jobs/mail-canary', () => ({
    __esModule: true,
    runMailCanary: (...a: unknown[]) => runMailCanary(...a),
}));

const getRedis = jest.fn();
jest.mock('@/lib/redis', () => ({
    __esModule: true,
    getRedis: () => getRedis(),
}));

import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import {
    MAIL_CANARY_RECORD_KEY,
    parseMailCanaryRecord,
} from '@/lib/email/mail-canary-record';

/** Captures what the real `recordMailCanaryRun` writes, through a fake client. */
function fakeRedis() {
    const store = new Map<string, string>();
    return {
        store,
        set: jest.fn((key: string, value: string): Promise<unknown> => {
            store.set(key, value);
            return Promise.resolve('OK');
        }),
        get: jest.fn((key: string): Promise<string | null> => Promise.resolve(store.get(key) ?? null)),
    };
}

/**
 * The shape this test needs off the registry. Narrowed through `unknown`
 * rather than `any` so no suppression is required — the Lint gate prices an
 * `eslint-disable` exactly like the warning it hides, and a cast in a test is
 * not worth a line of the repo's suppression budget.
 */
type MailCanaryExecutor = (
    payload: Record<string, unknown>,
) => Promise<{ jobName: string; itemsScanned: number; itemsActioned: number }>;

const runExecutor = async () => {
    const fn = executorRegistry.getExecutor('mail-canary' as never);
    // If the registration is ever renamed, fail here rather than silently
    // asserting nothing — the empty-selection failure mode.
    expect(fn).toBeDefined();
    return (fn as unknown as MailCanaryExecutor)({});
};

beforeEach(() => {
    recordJobMetrics.mockClear();
    runMailCanary.mockReset();
    getRedis.mockReset();
});

describe('the mail-canary executor writes the durable record (#2467)', () => {
    it.each(['SENT', 'SKIPPED_NO_RECIPIENT', 'NOT_CONFIGURED', 'FAILED'] as const)(
        'records a %s run',
        async (outcome) => {
            const redis = fakeRedis();
            getRedis.mockReturnValue(redis);
            runMailCanary.mockResolvedValue({ outcome, provider: 'ResendProvider' });

            await runExecutor();

            // The mock must have been reached — "the mock did not apply" is
            // silent otherwise.
            expect(runMailCanary).toHaveBeenCalledTimes(1);
            const stored = parseMailCanaryRecord(redis.store.get(MAIL_CANARY_RECORD_KEY) ?? null);
            expect(stored).not.toBeNull();
            expect(stored!.outcome).toBe(outcome);
        },
    );

    it('still returns the job result when Redis is unconfigured', async () => {
        getRedis.mockReturnValue(null);
        runMailCanary.mockResolvedValue({ outcome: 'SENT', provider: 'ResendProvider' });

        const result = await runExecutor();

        // A monitoring write must never decide whether the job succeeded.
        expect(result).toMatchObject({ jobName: 'mail-canary', itemsActioned: 1 });
    });

    it('still returns the job result when the write throws', async () => {
        getRedis.mockReturnValue({
            set: jest.fn(async () => {
                throw new Error('READONLY You cannot write against a read only replica');
            }),
        });
        runMailCanary.mockResolvedValue({ outcome: 'SENT', provider: 'ResendProvider' });

        const result = await runExecutor();

        expect(result).toMatchObject({ jobName: 'mail-canary', itemsActioned: 1 });
    });

    it('reports the send outcome and the record independently', async () => {
        // A FAILED canary is a successful RUN that recorded a failure. If the
        // record write ever started gating `itemsActioned`, the two signals
        // would collapse and "the canary did not run" would be
        // indistinguishable from "the canary ran and the transport refused" —
        // which is the confusion the whole issue is about.
        const redis = fakeRedis();
        getRedis.mockReturnValue(redis);
        runMailCanary.mockResolvedValue({
            outcome: 'FAILED',
            provider: 'ResendProvider',
            detail: 'Resend API error 403',
        });

        const result = await runExecutor();

        expect(result).toMatchObject({ jobName: 'mail-canary', itemsScanned: 1, itemsActioned: 0 });
        expect(
            parseMailCanaryRecord(redis.store.get(MAIL_CANARY_RECORD_KEY) ?? null)?.outcome,
        ).toBe('FAILED');
    });
});
