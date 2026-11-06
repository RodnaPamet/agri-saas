/**
 * A failed stage-timing write must NEVER fail the answer — #2751.
 *
 * This runs on the path that answers a farmer's question. The business
 * outcome is already produced by the time the row is written, so failing it
 * afterwards would be strictly worse than losing the measurement — the
 * #1269 bargain the audit extension strikes for the same reason.
 *
 * The cost of that bargain is the thing this file also pins: a swallowed
 * write with no signal is indistinguishable from a quiet period. #1269
 * measured 275 of 275 audit writes failing with no log, no metric and no
 * trace, which is why the catch must REPORT rather than merely return.
 */
const mockCreate = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { assistantStageTiming: { create: (...a: unknown[]) => mockCreate(...a) } },
    prisma: { assistantStageTiming: { create: (...a: unknown[]) => mockCreate(...a) } },
}));

const mockWarn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { recordStageTiming } from '@/app-layer/ai/assistant/stage-timing-store';

const TIMING = {
    totalMs: 10, providerMs: 8, providerCalls: 2, toolSelectMs: 3,
    answerMs: 5, toolPhaseMs: 1, otherMs: 1, toolCallsMade: 0, halt: null,
};

beforeEach(() => {
    mockCreate.mockReset();
    mockWarn.mockReset();
});

describe('recordStageTiming is best-effort', () => {
    it('writes the row with the tenant and every stage', async () => {
        // POSITIVE CONTROL: without this, the rejection case below passes
        // against a function that never writes anything at all.
        mockCreate.mockResolvedValue({ id: 't1' });
        await recordStageTiming('farm-1', TIMING);

        expect(mockCreate).toHaveBeenCalledTimes(1);
        const arg = mockCreate.mock.calls[0][0] as { data: Record<string, unknown> };
        expect(arg.data.tenantId).toBe('farm-1');
        expect(arg.data.totalMs).toBe(10);
        expect(arg.data.providerCalls).toBe(2);
        expect(mockWarn).not.toHaveBeenCalled();
    });

    it('does NOT throw when the insert rejects', async () => {
        // The load-bearing case. If this ever throws, a database blip stops
        // the assistant answering — a telemetry failure escalated into an
        // outage on the one surface a farmer is waiting on.
        mockCreate.mockRejectedValue(new Error('pool exhausted'));
        await expect(recordStageTiming('farm-1', TIMING)).resolves.toBeUndefined();
    });

    it('REPORTS the failure, so a dead writer is not a quiet period', async () => {
        mockCreate.mockRejectedValue(new Error('pool exhausted'));
        await recordStageTiming('farm-1', TIMING);

        expect(mockWarn).toHaveBeenCalledTimes(1);
        const [msg, fields] = mockWarn.mock.calls[0] as [string, Record<string, unknown>];
        expect(msg).toBe('assistant.stage_timing_write_failed');
        expect(fields.tenantId).toBe('farm-1');
        // The CAUSE, not just that something failed — #1269's empty catch is
        // the failure mode, and a log line with no reason is barely better.
        expect(String(fields.error)).toContain('pool exhausted');
    });

    it('swallows a non-Error rejection too', async () => {
        // A string throw is the shape that defeats `err instanceof Error`.
        mockCreate.mockRejectedValue('nope');
        await expect(recordStageTiming('farm-1', TIMING)).resolves.toBeUndefined();
        expect(String((mockWarn.mock.calls[0][1] as Record<string, unknown>).error)).toContain('nope');
    });
});
