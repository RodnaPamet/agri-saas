/**
 * Periodic Monitoring Jobs — Unit Tests
 *
 * Tests the monitoring infrastructure:
 *   1. classifyUrgency — urgency classification logic
 *   2. DueItem contract — structure, JSON-serializable
 *   3. Deadline monitor — entity detection, tenant isolation, idempotency
 *   4. Evidence expiry monitor — expiry detection, eligibility filters
 *   5. Vendor renewal check — DueItem normalization
 *   6. Executor registry — new registrations
 *
 * These tests mock Prisma to run in pure memory (no database required).
 */

// ─── Mocks ──────────────────────────────────────────────────────────

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

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock Prisma with practicelable findMany results
const mockPrisma = {
    practice: { findMany: jest.fn().mockResolvedValue([]) },
    policy: { findMany: jest.fn().mockResolvedValue([]) },
    task: { findMany: jest.fn().mockResolvedValue([]) },
    risk: { findMany: jest.fn().mockResolvedValue([]) },
    practiceTestPlan: { findMany: jest.fn().mockResolvedValue([]) },
    evidence: { findMany: jest.fn().mockResolvedValue([]) },
    // Epic G-7: Phase 0 transition + scanners.
    riskTreatmentPlan: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    treatmentMilestone: { findMany: jest.fn().mockResolvedValue([]) },
};

jest.mock('@/lib/prisma', () => ({
    prisma: mockPrisma,
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import { classifyUrgency } from '../../src/app-layer/jobs/deadline-monitor';
import type { DueItem, DueItemUrgency, MonitoredEntityType } from '../../src/app-layer/jobs/types';

// ═════════════════════════════════════════════════════════════════════
// 1. classifyUrgency Tests
// ═════════════════════════════════════════════════════════════════════

describe('classifyUrgency', () => {
    const now = new Date('2026-04-17T08:00:00Z');

    test('returns OVERDUE for dates in the past', () => {
        const yesterday = new Date('2026-04-16T08:00:00Z');
        const result = classifyUrgency(yesterday, now);
        expect(result).not.toBeNull();
        expect(result!.urgency).toBe('OVERDUE');
        expect(result!.daysRemaining).toBeLessThan(0);
    });

    test('returns OVERDUE with correct negative days', () => {
        const fiveDaysAgo = new Date('2026-04-12T08:00:00Z');
        const result = classifyUrgency(fiveDaysAgo, now);
        expect(result!.urgency).toBe('OVERDUE');
        expect(result!.daysRemaining).toBe(-5);
    });

    test('returns URGENT for dates within 7 days', () => {
        const in3Days = new Date('2026-04-20T08:00:00Z');
        const result = classifyUrgency(in3Days, now);
        expect(result).not.toBeNull();
        expect(result!.urgency).toBe('URGENT');
        expect(result!.daysRemaining).toBe(3);
    });

    test('returns UPCOMING for dates within 30 days but beyond 7', () => {
        const in15Days = new Date('2026-05-02T08:00:00Z');
        const result = classifyUrgency(in15Days, now);
        expect(result).not.toBeNull();
        expect(result!.urgency).toBe('UPCOMING');
        expect(result!.daysRemaining).toBe(15);
    });

    test('returns null for dates beyond the max window', () => {
        const in60Days = new Date('2026-06-16T08:00:00Z');
        const result = classifyUrgency(in60Days, now);
        expect(result).toBeNull();
    });

    test('respects custom windows', () => {
        const in10Days = new Date('2026-04-27T08:00:00Z');
        // With window [14, 3], 10 days remaining is UPCOMING (within 14 but beyond 3)
        const result = classifyUrgency(in10Days, now, [14, 3]);
        expect(result).not.toBeNull();
        expect(result!.urgency).toBe('UPCOMING');
    });

    test('returns null when beyond custom max window', () => {
        const in20Days = new Date('2026-05-07T08:00:00Z');
        // With window [14, 3], 20 days is beyond max (14)
        const result = classifyUrgency(in20Days, now, [14, 3]);
        expect(result).toBeNull();
    });

    test('date exactly at now is OVERDUE (daysRemaining = 0)', () => {
        const result = classifyUrgency(now, now);
        // ceil(0) = 0, which is not < 0, so it should be URGENT (within 7)
        expect(result).not.toBeNull();
        expect(result!.daysRemaining).toBe(0);
        expect(result!.urgency).toBe('URGENT');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. DueItem Contract Tests
// ═════════════════════════════════════════════════════════════════════

describe('DueItem contract', () => {
    test('all entity types are valid', () => {
        // Two members since GRC teardown phase 3 — one per surviving
        // producer. This test only checks the names are usable as the
        // type; the producer↔type correspondence is asserted in
        // due-item-ownership-guard.test.ts.
        const validTypes: MonitoredEntityType[] = ['EVIDENCE', 'TASK'];
        for (const type of validTypes) {
            expect(type).toBeTruthy();
        }
    });

    test('all urgency levels are valid', () => {
        const validUrgencies: DueItemUrgency[] = ['OVERDUE', 'URGENT', 'UPCOMING'];
        for (const urgency of validUrgencies) {
            expect(urgency).toBeTruthy();
        }
    });

    test('DueItem is fully JSON-serializable', () => {
        const item: DueItem = {
            entityType: 'TASK',
            entityId: 'task-123',
            tenantId: 'tenant-abc',
            name: 'Spray north field',
            reason: { key: 'taskOverdue', params: { days: 5 } },
            urgency: 'OVERDUE',
            dueDate: '2026-04-12T00:00:00Z',
            daysRemaining: -5,
            ownerUserId: 'user-xyz',
        };

        const serialized = JSON.stringify(item);
        const deserialized = JSON.parse(serialized);
        expect(deserialized).toEqual(item);
    });

    test('DueItem without ownerUserId is valid', () => {
        const item: DueItem = {
            entityType: 'EVIDENCE',
            entityId: 'ev-456',
            tenantId: 'tenant-abc',
            name: 'SOC 2 Report',
            reason: { key: 'evidenceExpires', params: { days: 5 } },
            urgency: 'URGENT',
            dueDate: '2026-04-22T00:00:00Z',
            daysRemaining: 5,
        };

        expect(item.ownerUserId).toBeUndefined();
        const serialized = JSON.stringify(item);
        expect(serialized).not.toContain('ownerUserId');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Deadline Monitor Tests
// ═════════════════════════════════════════════════════════════════════

describe('Deadline Monitor', () => {
    const now = new Date('2026-04-17T08:00:00Z');

    beforeEach(() => {
        jest.clearAllMocks();
        // `scanTasks` is the only scanner left — GRC teardown phase 2
        // took the Risk + PracticeTestPlan scanners and phase 3 took
        // Practice (nextDueAt) and Policy (nextReviewAt) with their
        // models. Every case below therefore drives `task.findMany`;
        // the urgency / sorting / counting logic under test is scanner-
        // agnostic, so nothing was lost by collapsing the fixtures onto
        // one entity type.
        mockPrisma.task.findMany.mockResolvedValue([]);
    });

    test('returns empty items when no entities are due', async () => {
        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { result, items } = await runDeadlineMonitor({ now });

        expect(result.success).toBe(true);
        expect(result.jobName).toBe('deadline-monitor');
        expect(items).toEqual([]);
        expect(result.itemsScanned).toBe(0);
    });

    test('detects overdue tasks', async () => {
        mockPrisma.task.findMany.mockResolvedValue([
            {
                id: 'task-1',
                tenantId: 'tenant-1',
                title: 'Spray north field',
                dueAt: new Date('2026-04-10T00:00:00Z'), // 7 days overdue
                assigneeUserId: 'user-1',
            },
        ]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { items } = await runDeadlineMonitor({ now });

        expect(items).toHaveLength(1);
        expect(items[0].entityType).toBe('TASK');
        expect(items[0].urgency).toBe('OVERDUE');
        expect(items[0].daysRemaining).toBeLessThan(0);
        expect(items[0].tenantId).toBe('tenant-1');
        expect(items[0].ownerUserId).toBe('user-1');
        // `reason` is a translation DESCRIPTOR now, not a sentence (#694) —
        // the monitor cannot know the reader's language. The key is what
        // carries the meaning, and it is the thing a digest looks up.
        expect(items[0].reason.key).toBe('taskOverdue');
        expect(items[0].reason.params).toMatchObject({ days: expect.any(Number) });
    });

    test('detects upcoming tasks', async () => {
        mockPrisma.task.findMany.mockResolvedValue([
            {
                id: 'task-2',
                tenantId: 'tenant-1',
                title: 'Soil sampling round',
                dueAt: new Date('2026-05-10T00:00:00Z'), // ~23 days
                assigneeUserId: 'user-2',
            },
        ]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { items } = await runDeadlineMonitor({ now });

        expect(items).toHaveLength(1);
        expect(items[0].urgency).toBe('UPCOMING');
        expect(items[0].name).toBe('Soil sampling round');
    });

    test('detects urgent tasks', async () => {
        mockPrisma.task.findMany.mockResolvedValue([
            {
                id: 'task-3',
                tenantId: 'tenant-1',
                title: 'Harvest readiness check',
                dueAt: new Date('2026-04-20T00:00:00Z'), // 3 days
                assigneeUserId: 'user-3',
            },
        ]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { items } = await runDeadlineMonitor({ now });

        expect(items).toHaveLength(1);
        expect(items[0].entityType).toBe('TASK');
        expect(items[0].urgency).toBe('URGENT');
        expect(items[0].ownerUserId).toBe('user-3');
    });

    test('tenant isolation: filters by tenantId when provided', async () => {
        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        await runDeadlineMonitor({ now, tenantId: 'tenant-specific' });

        const whereClause = mockPrisma.task.findMany.mock.calls[0]?.[0]?.where;
        expect(whereClause.tenantId).toBe('tenant-specific');
    });

    test('idempotent: same input produces same output', async () => {
        mockPrisma.task.findMany.mockResolvedValue([
            {
                id: 'task-1',
                tenantId: 'tenant-1',
                title: 'Test Task',
                dueAt: new Date('2026-04-20T00:00:00Z'),
                assigneeUserId: 'user-1',
            },
        ]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');

        const run1 = await runDeadlineMonitor({ now });
        const run2 = await runDeadlineMonitor({ now });

        // Items should be structurally identical (same detection, same urgency)
        expect(run1.items.length).toBe(run2.items.length);
        expect(run1.items[0].entityId).toBe(run2.items[0].entityId);
        expect(run1.items[0].urgency).toBe(run2.items[0].urgency);
        expect(run1.items[0].daysRemaining).toBe(run2.items[0].daysRemaining);
    });

    test('sorts OVERDUE before URGENT before UPCOMING', async () => {
        // Deliberately supplied out of order so the assertion is about
        // the sort, not about the order they were mocked in.
        mockPrisma.task.findMany.mockResolvedValue([
            { id: 't1', tenantId: 't', title: 'Upcoming', dueAt: new Date('2026-05-10T00:00:00Z'), assigneeUserId: null },
            { id: 't2', tenantId: 't', title: 'Urgent', dueAt: new Date('2026-04-20T00:00:00Z'), assigneeUserId: null },
            { id: 't3', tenantId: 't', title: 'Overdue', dueAt: new Date('2026-04-10T00:00:00Z'), assigneeUserId: null },
        ]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { items } = await runDeadlineMonitor({ now });

        expect(items.length).toBe(3);
        expect(items[0].urgency).toBe('OVERDUE');
        expect(items[1].urgency).toBe('URGENT');
        expect(items[2].urgency).toBe('UPCOMING');
    });

    test('counts by entity type are computed correctly', async () => {
        mockPrisma.task.findMany.mockResolvedValue([
            { id: 't1', tenantId: 't', title: 'T1', dueAt: new Date('2026-04-10T00:00:00Z'), assigneeUserId: null },
            { id: 't2', tenantId: 't', title: 'T2', dueAt: new Date('2026-04-20T00:00:00Z'), assigneeUserId: null },
            { id: 't3', tenantId: 't', title: 'T3', dueAt: new Date('2026-04-22T00:00:00Z'), assigneeUserId: null },
        ]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { result } = await runDeadlineMonitor({ now });

        expect(result.details).toBeDefined();
        const byEntity = result.details!.byEntity as Record<string, number>;
        expect(byEntity.TASK).toBe(3);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Evidence Expiry Monitor Tests
// ═════════════════════════════════════════════════════════════════════

describe('Evidence Expiry Monitor', () => {
    const now = new Date('2026-04-17T08:00:00Z');

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.evidence.findMany.mockResolvedValue([]);
    });

    test('returns empty items when no evidence is expiring', async () => {
        const { runEvidenceExpiryMonitor } = await import('../../src/app-layer/jobs/evidence-expiry-monitor');
        const { result, items } = await runEvidenceExpiryMonitor({ now });

        expect(result.success).toBe(true);
        expect(result.jobName).toBe('evidence-expiry-monitor');
        expect(items).toEqual([]);
    });

    test('detects evidence expiring within window (retentionUntil)', async () => {
        // First call is for expiring evidence, second for already-expired
        mockPrisma.evidence.findMany
            .mockResolvedValueOnce([
                {
                    id: 'ev-1',
                    tenantId: 'tenant-1',
                    title: 'SOC 2 Report 2025',
                    retentionUntil: new Date('2026-04-22T00:00:00Z'), // 5 days
                    owner: 'John Doe',
                    practiceId: 'ctrl-1',
                },
            ])
            .mockResolvedValueOnce([]); // no already-expired

        const { runEvidenceExpiryMonitor } = await import('../../src/app-layer/jobs/evidence-expiry-monitor');
        const { items } = await runEvidenceExpiryMonitor({ now });

        expect(items).toHaveLength(1);
        expect(items[0].entityType).toBe('EVIDENCE');
        expect(items[0].urgency).toBe('URGENT');
        expect(items[0].daysRemaining).toBe(5);
        expect(items[0].name).toBe('SOC 2 Report 2025');
    });

    test('detects already-expired evidence (expiredAt set)', async () => {
        mockPrisma.evidence.findMany
            .mockResolvedValueOnce([]) // no expiring
            .mockResolvedValueOnce([
                {
                    id: 'ev-2',
                    tenantId: 'tenant-1',
                    title: 'Old Pentest Report',
                    expiredAt: new Date('2026-04-10T00:00:00Z'), // 7 days ago
                    owner: null,
                    practiceId: null,
                },
            ]);

        const { runEvidenceExpiryMonitor } = await import('../../src/app-layer/jobs/evidence-expiry-monitor');
        const { items } = await runEvidenceExpiryMonitor({ now });

        expect(items).toHaveLength(1);
        expect(items[0].urgency).toBe('OVERDUE');
        expect(items[0].reason.key).toMatch(/expired|Expired/);
    });

    test('deduplicates evidence appearing in both queries', async () => {
        const sharedEvidence = {
            id: 'ev-shared',
            tenantId: 'tenant-1',
            title: 'Shared Evidence',
            retentionUntil: new Date('2026-04-10T00:00:00Z'),
            expiredAt: new Date('2026-04-10T00:00:00Z'),
            owner: null,
            practiceId: null,
        };

        mockPrisma.evidence.findMany
            .mockResolvedValueOnce([sharedEvidence])
            .mockResolvedValueOnce([sharedEvidence]);

        const { runEvidenceExpiryMonitor } = await import('../../src/app-layer/jobs/evidence-expiry-monitor');
        const { items } = await runEvidenceExpiryMonitor({ now });

        // Should only appear once despite being in both queries
        expect(items).toHaveLength(1);
        expect(items[0].entityId).toBe('ev-shared');
    });

    test('tenant isolation: filters by tenantId when provided', async () => {
        const { runEvidenceExpiryMonitor } = await import('../../src/app-layer/jobs/evidence-expiry-monitor');
        await runEvidenceExpiryMonitor({ now, tenantId: 'specific-tenant' });

        // Both queries should have tenantId filter
        for (const call of mockPrisma.evidence.findMany.mock.calls) {
            expect(call[0].where.tenantId).toBe('specific-tenant');
        }
    });

    test('idempotent: same data produces same output', async () => {
        const evData = [
            {
                id: 'ev-1',
                tenantId: 't',
                title: 'Evidence',
                retentionUntil: new Date('2026-04-20T00:00:00Z'),
                owner: null,
                practiceId: null,
            },
        ];
        // Three reads per run since the monitor gained a review-due scan
        // alongside the two retention ones: expiring, already-expired,
        // due-for-review.
        mockPrisma.evidence.findMany
            .mockResolvedValueOnce(evData).mockResolvedValueOnce([]).mockResolvedValueOnce([])
            .mockResolvedValueOnce(evData).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

        const { runEvidenceExpiryMonitor } = await import('../../src/app-layer/jobs/evidence-expiry-monitor');

        const run1 = await runEvidenceExpiryMonitor({ now });
        const run2 = await runEvidenceExpiryMonitor({ now });

        expect(run1.items.length).toBe(run2.items.length);
        expect(run1.items[0].entityId).toBe(run2.items[0].entityId);
        expect(run1.items[0].urgency).toBe(run2.items[0].urgency);
    });

    test('classifies retention-expired as OVERDUE', async () => {
        mockPrisma.evidence.findMany
            .mockResolvedValueOnce([
                {
                    id: 'ev-old',
                    tenantId: 't',
                    title: 'Expired Evidence',
                    retentionUntil: new Date('2026-04-05T00:00:00Z'), // 12 days ago
                    owner: null,
                    practiceId: null,
                },
            ])
            .mockResolvedValueOnce([]);

        const { runEvidenceExpiryMonitor } = await import('../../src/app-layer/jobs/evidence-expiry-monitor');
        const { items } = await runEvidenceExpiryMonitor({ now });

        expect(items[0].urgency).toBe('OVERDUE');
        expect(items[0].reason.key).toMatch(/expired|Expired/);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Vendor Renewal Check — DueItem Normalization Tests
// ═════════════════════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════════════════════
// 6. Executor Registry — New Registrations
// ═════════════════════════════════════════════════════════════════════

// GRC teardown phase 2 (T3): the Vendor Renewal Check block went with
// its job. Deadline + Evidence Expiry are the surviving monitors and
// the registration block below still covers every registered one.
describe('Monitor executor registrations', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
        jest.mock('@/lib/observability/job-runner', () => ({
            runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
        }));
    });

    test('deadline-monitor is registered', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        expect(executorRegistry.has('deadline-monitor')).toBe(true);
    });

    test('evidence-expiry-monitor is registered', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        expect(executorRegistry.has('evidence-expiry-monitor')).toBe(true);
    });

    test('all scheduled jobs still have registered executors', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');

        for (const schedule of SCHEDULED_JOBS) {
            expect(executorRegistry.has(schedule.name)).toBe(true);
        }
    });

    test('total executor count includes new monitors', async () => {
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        // At least 10: 8 previous + 2 new monitors
        expect(executorRegistry.size).toBeGreaterThanOrEqual(10);
    });
});
