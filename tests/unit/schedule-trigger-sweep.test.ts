/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * PR-E — scheduled-trigger sweep: due-window math, config validation, and the
 * sweep enqueuing a targeted dispatch per due entity.
 */
const enqueueMock = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => enqueueMock(...a) }));
jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_n: string, fn: () => any) => fn()),
}));
jest.mock('@/lib/prisma', () => ({
    prisma: {
        automationRule: { findMany: jest.fn() },
        evidence: { findMany: jest.fn() },
        controlException: { findMany: jest.fn() },
        controlTestPlan: { findMany: jest.fn() },
    },
}));

import {
    dueWindow,
    parseScheduleConfig,
    runScheduleTriggerSweep,
    SCHEDULE_TARGETS,
} from '@/app-layer/jobs/schedule-trigger-sweep';
import { prisma } from '@/lib/prisma';

const mockPrisma = prisma as any;
beforeEach(() => jest.clearAllMocks());

describe('dueWindow', () => {
    it('returns the UTC day exactly offsetDays from now', () => {
        const now = new Date('2026-06-08T13:45:00Z');
        const w = dueWindow(now, 7);
        expect(w.gte.toISOString()).toBe('2026-06-15T00:00:00.000Z');
        expect(w.lt.toISOString()).toBe('2026-06-16T00:00:00.000Z');
    });
});

describe('parseScheduleConfig', () => {
    it('accepts a valid DATE_RELATIVE config for an allowlisted target', () => {
        expect(parseScheduleConfig({ kind: 'DATE_RELATIVE', target: 'Evidence', offsetDays: 7 }))
            .toEqual({ kind: 'DATE_RELATIVE', target: 'Evidence', offsetDays: 7 });
    });
    it('rejects an unknown target, bad kind, or out-of-range offset', () => {
        expect(parseScheduleConfig({ kind: 'DATE_RELATIVE', target: 'User', offsetDays: 7 })).toBeNull();
        expect(parseScheduleConfig({ kind: 'CRON', target: 'Evidence', offsetDays: 7 })).toBeNull();
        expect(parseScheduleConfig({ kind: 'DATE_RELATIVE', target: 'Evidence', offsetDays: -1 })).toBeNull();
        expect(parseScheduleConfig(null)).toBeNull();
    });
    it('only allowlists the Evidence date target', () => {
        expect(Object.keys(SCHEDULE_TARGETS).sort()).toEqual(['Evidence']);
    });
});

describe('runScheduleTriggerSweep', () => {
    it('enqueues a targeted, idempotent dispatch per due entity', async () => {
        mockPrisma.automationRule.findMany.mockResolvedValue([
            { id: 'rule-1', tenantId: 't1', scheduleConfigJson: { kind: 'DATE_RELATIVE', target: 'Evidence', offsetDays: 7 } },
        ]);
        mockPrisma.evidence.findMany.mockResolvedValue([
            { id: 'ev-1', retentionUntil: new Date('2026-06-15T09:00:00Z') },
            { id: 'ev-2', retentionUntil: new Date('2026-06-15T10:00:00Z') },
        ]);

        const { firedCount } = await runScheduleTriggerSweep(new Date('2026-06-08T00:00:00Z'));

        expect(firedCount).toBe(2);
        expect(enqueueMock).toHaveBeenCalledTimes(2);
        const first = enqueueMock.mock.calls[0];
        expect(first[0]).toBe('automation-event-dispatch');
        expect(first[1]).toMatchObject({
            tenantId: 't1',
            targetRuleId: 'rule-1',
            triggeredBy: 'schedule',
            event: expect.objectContaining({ event: 'SCHEDULE', entityType: 'Evidence', entityId: 'ev-1' }),
        });
        // idempotency key is deterministic per (rule, entity, due-day)
        expect(first[1].event.stableKey).toBe('sched-rule-1-ev-1-2026-06-15');
    });

    it('skips a rule with an invalid schedule config (no query, no enqueue)', async () => {
        mockPrisma.automationRule.findMany.mockResolvedValue([
            { id: 'rule-bad', tenantId: 't1', scheduleConfigJson: { kind: 'CRON' } },
        ]);
        const { firedCount } = await runScheduleTriggerSweep(new Date('2026-06-08T00:00:00Z'));
        expect(firedCount).toBe(0);
        expect(mockPrisma.evidence.findMany).not.toHaveBeenCalled();
        expect(enqueueMock).not.toHaveBeenCalled();
    });
});
