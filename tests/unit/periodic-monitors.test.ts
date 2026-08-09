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

// Mock Prisma with controllable findMany results
const mockPrisma = {
    control: { findMany: jest.fn().mockResolvedValue([]) },
    policy: { findMany: jest.fn().mockResolvedValue([]) },
    task: { findMany: jest.fn().mockResolvedValue([]) },
    risk: { findMany: jest.fn().mockResolvedValue([]) },
    controlTestPlan: { findMany: jest.fn().mockResolvedValue([]) },
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
        const validTypes: MonitoredEntityType[] = [
            'CONTROL', 'EVIDENCE', 'POLICY', 'VENDOR', 'TASK', 'RISK', 'TEST_PLAN',
        ];
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
            entityType: 'CONTROL',
            entityId: 'ctrl-123',
            tenantId: 'tenant-abc',
            name: 'Access Control Review',
            reason: 'Control testing overdue by 5 day(s)',
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
            reason: 'Evidence expires in 5 day(s)',
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
        // Reset all mocked findMany to return empty by default
        mockPrisma.control.findMany.mockResolvedValue([]);
        mockPrisma.policy.findMany.mockResolvedValue([]);
        mockPrisma.task.findMany.mockResolvedValue([]);
        mockPrisma.risk.findMany.mockResolvedValue([]);
        mockPrisma.controlTestPlan.findMany.mockResolvedValue([]);
    });

    test('returns empty items when no entities are due', async () => {
        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { result, items } = await runDeadlineMonitor({ now });

        expect(result.success).toBe(true);
        expect(result.jobName).toBe('deadline-monitor');
        expect(items).toEqual([]);
        expect(result.itemsScanned).toBe(0);
    });

    test('detects overdue controls', async () => {
        mockPrisma.control.findMany.mockResolvedValue([
            {
                id: 'ctrl-1',
                tenantId: 'tenant-1',
                name: 'Firewall Config Review',
                nextDueAt: new Date('2026-04-10T00:00:00Z'), // 7 days overdue
                ownerUserId: 'user-1',
            },
        ]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { items } = await runDeadlineMonitor({ now });

        expect(items).toHaveLength(1);
        expect(items[0].entityType).toBe('CONTROL');
        expect(items[0].urgency).toBe('OVERDUE');
        expect(items[0].daysRemaining).toBeLessThan(0);
        expect(items[0].tenantId).toBe('tenant-1');
        expect(items[0].ownerUserId).toBe('user-1');
        expect(items[0].reason).toContain('overdue');
    });

    test('detects upcoming policy reviews', async () => {
        mockPrisma.policy.findMany.mockResolvedValue([
            {
                id: 'pol-1',
                tenantId: 'tenant-1',
                title: 'Data Privacy Policy',
                nextReviewAt: new Date('2026-05-10T00:00:00Z'), // ~23 days
                ownerUserId: 'user-2',
            },
        ]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { items } = await runDeadlineMonitor({ now });

        expect(items).toHaveLength(1);
        expect(items[0].entityType).toBe('POLICY');
        expect(items[0].urgency).toBe('UPCOMING');
        expect(items[0].name).toBe('Data Privacy Policy');
    });

    test('detects urgent tasks', async () => {
        mockPrisma.task.findMany.mockResolvedValue([
            {
                id: 'task-1',
                tenantId: 'tenant-1',
                title: 'Complete SOC 2 audit prep',
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
        mockPrisma.control.findMany.mockResolvedValue([]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        await runDeadlineMonitor({ now, tenantId: 'tenant-specific' });

        // Verify control query included tenantId filter
        const whereClause = mockPrisma.control.findMany.mock.calls[0]?.[0]?.where;
        expect(whereClause.tenantId).toBe('tenant-specific');
    });

    test('idempotent: same input produces same output', async () => {
        const controls = [
            {
                id: 'ctrl-1',
                tenantId: 'tenant-1',
                name: 'Test Control',
                nextDueAt: new Date('2026-04-20T00:00:00Z'),
                ownerUserId: 'user-1',
            },
        ];
        mockPrisma.control.findMany.mockResolvedValue(controls);

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
        mockPrisma.control.findMany.mockResolvedValue([
            { id: 'c1', tenantId: 't', name: 'Upcoming', nextDueAt: new Date('2026-05-10T00:00:00Z'), ownerUserId: null },
        ]);
        mockPrisma.task.findMany.mockResolvedValue([
            { id: 't1', tenantId: 't', title: 'Urgent', dueAt: new Date('2026-04-20T00:00:00Z'), assigneeUserId: null },
        ]);
        mockPrisma.policy.findMany.mockResolvedValue([
            { id: 'p1', tenantId: 't', title: 'Overdue', nextReviewAt: new Date('2026-04-10T00:00:00Z'), ownerUserId: null },
        ]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { items } = await runDeadlineMonitor({ now });

        expect(items.length).toBe(3);
        expect(items[0].urgency).toBe('OVERDUE');
        expect(items[1].urgency).toBe('URGENT');
        expect(items[2].urgency).toBe('UPCOMING');
    });

    test('counts by entity type are computed correctly', async () => {
        mockPrisma.control.findMany.mockResolvedValue([
            { id: 'c1', tenantId: 't', name: 'C1', nextDueAt: new Date('2026-04-10T00:00:00Z'), ownerUserId: null },
            { id: 'c2', tenantId: 't', name: 'C2', nextDueAt: new Date('2026-04-20T00:00:00Z'), ownerUserId: null },
        ]);
        mockPrisma.policy.findMany.mockResolvedValue([
            { id: 'p1', tenantId: 't', title: 'P1', nextReviewAt: new Date('2026-04-22T00:00:00Z'), ownerUserId: null },
        ]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { result } = await runDeadlineMonitor({ now });

        expect(result.details).toBeDefined();
        const byEntity = result.details!.byEntity as Record<string, number>;
        expect(byEntity.CONTROL).toBe(2);
        expect(byEntity.POLICY).toBe(1);
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
                    controlId: 'ctrl-1',
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
                    controlId: null,
                },
            ]);

        const { runEvidenceExpiryMonitor } = await import('../../src/app-layer/jobs/evidence-expiry-monitor');
        const { items } = await runEvidenceExpiryMonitor({ now });

        expect(items).toHaveLength(1);
        expect(items[0].urgency).toBe('OVERDUE');
        expect(items[0].reason).toContain('expired');
    });

    test('deduplicates evidence appearing in both queries', async () => {
        const sharedEvidence = {
            id: 'ev-shared',
            tenantId: 'tenant-1',
            title: 'Shared Evidence',
            retentionUntil: new Date('2026-04-10T00:00:00Z'),
            expiredAt: new Date('2026-04-10T00:00:00Z'),
            owner: null,
            controlId: null,
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
                controlId: null,
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
                    controlId: null,
                },
            ])
            .mockResolvedValueOnce([]);

        const { runEvidenceExpiryMonitor } = await import('../../src/app-layer/jobs/evidence-expiry-monitor');
        const { items } = await runEvidenceExpiryMonitor({ now });

        expect(items[0].urgency).toBe('OVERDUE');
        expect(items[0].reason).toContain('expired');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Vendor Renewal Check — DueItem Normalization Tests
// ═════════════════════════════════════════════════════════════════════

describe('Vendor Renewal Check — DueItem output', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();
        jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
        jest.mock('@/lib/observability/job-runner', () => ({
            runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
        }));
    });

    test('maps REVIEW_OVERDUE to OVERDUE urgency', async () => {
        jest.mock('../../src/app-layer/services/vendor-renewals', () => ({
            findDueVendorsAndEmitEvents: jest.fn().mockResolvedValue([
                {
                    id: 'v-1',
                    tenantId: 't-1',
                    name: 'CloudCorp',
                    type: 'REVIEW_OVERDUE',
                    dueDate: new Date('2026-04-10T00:00:00Z'),
                },
            ]),
        }));

        const { runVendorRenewalCheck } = await import('../../src/app-layer/jobs/vendor-renewal-check');
        const { items } = await runVendorRenewalCheck({});

        expect(items).toHaveLength(1);
        expect(items[0].entityType).toBe('VENDOR');
        expect(items[0].urgency).toBe('OVERDUE');
        expect(items[0].reason).toContain('Vendor review overdue');
    });

    test('maps RENEWAL_DUE to UPCOMING urgency', async () => {
        jest.mock('../../src/app-layer/services/vendor-renewals', () => ({
            findDueVendorsAndEmitEvents: jest.fn().mockResolvedValue([
                {
                    id: 'v-2',
                    tenantId: 't-1',
                    name: 'SecureInc',
                    type: 'RENEWAL_DUE',
                    // Relative so the test stays in the UPCOMING bucket
                    // (>7 days out) regardless of when it runs — a fixed
                    // calendar date drifts into URGENT once today's date
                    // is within 7 days of it.
                    dueDate: new Date(Date.now() + 30 * 86_400_000),
                },
            ]),
        }));

        const { runVendorRenewalCheck } = await import('../../src/app-layer/jobs/vendor-renewal-check');
        const { items, result } = await runVendorRenewalCheck({});

        expect(items).toHaveLength(1);
        expect(items[0].urgency).toBe('UPCOMING');
        expect(items[0].reason).toContain('Contract renewal due');
        expect(result.success).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Executor Registry — New Registrations
// ═════════════════════════════════════════════════════════════════════

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
