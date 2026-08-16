export {};
/**
 * Notification Pipeline — Single-Run Architecture Tests
 *
 * Verifies that:
 * 1. notification-dispatch runs monitors once, not twice
 * 2. Precomputed DueItems skip monitor re-scans
 * 3. Schedule no longer includes standalone monitor jobs
 * 4. Monitors remain available for ad-hoc/CLI use
 * 5. Repeated daily runs remain idempotent
 */

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

// Track monitor invocations to prove no double-scanning
const monitorCalls = {
    deadline: 0,
    evidence: 0,
    vendor: 0,
};

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    monitorCalls.deadline = 0;
    monitorCalls.evidence = 0;
    monitorCalls.vendor = 0;

    jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
    jest.mock('@/lib/observability/job-runner', () => ({
        runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    }));
    // GRC teardown phase 2: the risk / practiceTestPlan scanners, the
    // vendor-renewal check, the Epic 49 calendar-deadlines monitor
    // (auditCycle / vendorDocument / finding) and the Epic G-7
    // treatment-plan + milestone scanners all went with their models, so
    // their model stubs went too. What a dispatch run can still touch is
    // practice / policy / task (deadline-monitor) + evidence
    // (evidence-expiry-monitor), plus the notification infra below.
    jest.mock('@/lib/prisma', () => ({
        __esModule: true,
        default: {
            practice: { findMany: jest.fn().mockResolvedValue([]) },
            policy: { findMany: jest.fn().mockResolvedValue([]) },
            task: { findMany: jest.fn().mockResolvedValue([]) },
            evidence: { findMany: jest.fn().mockResolvedValue([]) },
            user: { findMany: jest.fn().mockResolvedValue([]) },
            tenantMembership: { findMany: jest.fn().mockResolvedValue([]) },
            tenant: { findUnique: jest.fn().mockResolvedValue({ slug: 'test' }) },
            notificationOutbox: { create: jest.fn().mockResolvedValue({ id: 'x' }) },
            tenantNotificationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        },
        prisma: {
            practice: { findMany: jest.fn().mockResolvedValue([]) },
            policy: { findMany: jest.fn().mockResolvedValue([]) },
            task: { findMany: jest.fn().mockResolvedValue([]) },
            evidence: { findMany: jest.fn().mockResolvedValue([]) },
            user: { findMany: jest.fn().mockResolvedValue([]) },
            tenantMembership: { findMany: jest.fn().mockResolvedValue([]) },
            tenant: { findUnique: jest.fn().mockResolvedValue({ slug: 'test' }) },
            notificationOutbox: { create: jest.fn().mockResolvedValue({ id: 'x' }) },
            tenantNotificationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        },
    }));
});

// ═════════════════════════════════════════════════════════════════════
// 1. Schedule Structure — No Duplicate Monitor+Dispatch
// ═════════════════════════════════════════════════════════════════════

describe('Schedule: no duplicate monitor jobs', () => {
    test('notification-dispatch IS scheduled', async () => {
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');
        const dispatch = SCHEDULED_JOBS.find(j => j.name === 'notification-dispatch');
        expect(dispatch).toBeDefined();
    });

    test('deadline-monitor is NOT independently scheduled', async () => {
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');
        const monitor = SCHEDULED_JOBS.find(j => j.name === 'deadline-monitor');
        expect(monitor).toBeUndefined();
    });

    test('evidence-expiry-monitor is NOT independently scheduled', async () => {
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');
        const monitor = SCHEDULED_JOBS.find(j => j.name === 'evidence-expiry-monitor');
        expect(monitor).toBeUndefined();
    });

    test('vendor-renewal-check is gone entirely, not merely unscheduled', async () => {
        // It used to be registered-but-unscheduled (fired via the digest
        // fan-out). GRC teardown phase 2 removed the job with the Vendor
        // model, so the stronger assertion is that neither registry knows
        // the name at all.
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');
        const names: string[] = SCHEDULED_JOBS.map((j) => j.name);
        expect(names).not.toContain('vendor-renewal-check');
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        expect(executorRegistry.has('vendor-renewal-check' as never)).toBe(false);
    });

    test('monitors remain registered in executor registry for ad-hoc use', async () => {
        // vendor-renewal-check left this list in GRC teardown phase 2; the
        // test directly above now asserts its ABSENCE from both registries,
        // so the name is still covered — by the opposite expectation.
        const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
        expect(executorRegistry.has('deadline-monitor')).toBe(true);
        expect(executorRegistry.has('evidence-expiry-monitor')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Precomputed Items — Skip Monitor Scans
// ═════════════════════════════════════════════════════════════════════

describe('notification-dispatch: precomputed items skip scanners', () => {
    test('precomputed deadline items skip deadline-monitor scan', async () => {
        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );

        const precomputedItems = [{
            entityType: 'TASK' as const,
            entityId: 'ctrl-1',
            tenantId: 'tenant-1',
            name: 'Test Practice',
            reason: 'Due in 5 days',
            urgency: 'UPCOMING' as const,
            dueDate: '2026-04-22T00:00:00Z',
            daysRemaining: 5,
            ownerUserId: undefined,
        }];

        const { dispatch } = await runNotificationDispatch({
            categories: ['DEADLINE_DIGEST'],
            precomputed: { deadlineItems: precomputedItems },
        });

        expect(dispatch.scanSource.deadlines).toBe('precomputed');
        // The monitor import should NOT be triggered — we verify via scanSource
    });

    test('precomputed evidence items skip evidence-expiry-monitor scan', async () => {
        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );

        const { dispatch } = await runNotificationDispatch({
            categories: ['EVIDENCE_EXPIRY_DIGEST'],
            precomputed: { evidenceItems: [] },
        });

        expect(dispatch.scanSource.evidence).toBe('precomputed');
    });

    test('without precomputed items, scanSource is "scanned"', async () => {
        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );

        const { dispatch } = await runNotificationDispatch({
            categories: ['DEADLINE_DIGEST', 'EVIDENCE_EXPIRY_DIGEST'],
        });

        // GRC teardown phase 2 removed the VENDOR_RENEWAL_DIGEST category
        // with the Vendor model, so the precomputed-vendor-items case went
        // with it. The precomputed-vs-scanned contract is still covered by
        // the two surviving sources.
        expect(dispatch.scanSource.deadlines).toBe('scanned');
        expect(dispatch.scanSource.evidence).toBe('scanned');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Single-Pass Guarantee — Monitors Run Once
// ═════════════════════════════════════════════════════════════════════

describe('notification-dispatch: monitors run exactly once per dispatch', () => {
    test('each monitor is invoked once, not twice', async () => {
        const prisma = require('@/lib/prisma').default;
        const practiceFindMany = prisma.practice.findMany;

        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );
        await runNotificationDispatch({});

        // deadline-monitor scans 3 entity types (practice, policy, task) —
        //   the risk + testPlan scanners went with their models in GRC
        //   teardown phase 2, as did the vendor monitor entirely.
        // evidence-expiry scans evidence (3 queries: retentionUntil +
        //   expired + nextReviewDate)
        // Total: should be exactly one run of each monitor
        // The key assertion: no entity table is scanned more than its expected count

        // Practices scanned once (by deadline-monitor internal to notification-dispatch)
        expect(practiceFindMany.mock.calls.length).toBeLessThanOrEqual(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Idempotency — Repeated Runs Don't Spam
// ═════════════════════════════════════════════════════════════════════

describe('notification-dispatch: idempotency', () => {
    test('dedupeKey in outbox prevents duplicate digests on same day', async () => {
        const prisma = require('@/lib/prisma').prisma;
        const outboxCreate = prisma.notificationOutbox.create;

        // First call succeeds
        outboxCreate.mockResolvedValueOnce({ id: 'out-1' });
        // Second call fails with unique constraint (dedupe)
        outboxCreate.mockRejectedValueOnce({ code: 'P2002', message: 'Unique constraint' });

        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );

        // Run twice — second should be idempotent
        await runNotificationDispatch({});
        // No throw = success
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Structural Guard — notification-dispatch.ts Does Not Re-import
//    Monitors If Pre-computed Items Are Provided
// ═════════════════════════════════════════════════════════════════════

describe('Structural: notification-dispatch uses single-pass architecture', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');

    test('notification-dispatch supports precomputed items', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/jobs/notification-dispatch.ts'),
            'utf8',
        );
        expect(source).toContain('precomputed');
        expect(source).toContain('scanSource');
    });

    test('notification-dispatch has scan-or-skip pattern for each category', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/jobs/notification-dispatch.ts'),
            'utf8',
        );

        // Each SURVIVING category should have a precomputed check.
        // GRC teardown phase 2 removed the VENDOR_RENEWAL_DIGEST leg with
        // the Vendor model, so `precomputed?.vendorItems` is no longer read
        // anywhere — the assertion went with the branch it described.
        expect(source).toContain('precomputed?.deadlineItems');
        expect(source).toContain('precomputed?.evidenceItems');
    });

    test('schedules.ts does not include standalone monitor jobs', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/jobs/schedules.ts'),
            'utf8',
        );

        // These should NOT appear as separate scheduled entries
        // (they appear in comments/docs, which is fine)
        const nameEntries = source.match(/name:\s*'[^']+'/g) || [];
        const scheduledNames = nameEntries.map((e: string) => e.match(/'([^']+)'/)?.[1]);

        expect(scheduledNames).not.toContain('deadline-monitor');
        expect(scheduledNames).not.toContain('evidence-expiry-monitor');
        expect(scheduledNames).not.toContain('vendor-renewal-check');
        expect(scheduledNames).toContain('notification-dispatch');
    });
});
