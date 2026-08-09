export {};
/**
 * Notification Pipeline — Performance & Regression Guards
 *
 * PURPOSE: Prevent the "duplicate daily DB scan" bug class from recurring.
 *
 * The original bug: standalone monitors (deadline-monitor, evidence-expiry-monitor,
 * vendor-renewal-check) were scheduled at 06:00/07:00 UTC AND notification-dispatch
 * at 07:30 re-ran all three. This doubled every source-entity query daily.
 *
 * WHAT THESE TESTS GUARD:
 *
 * 1. QUERY BUDGET — Each entity table is queried at most N times during a single
 *    notification-dispatch run, where N is the expected count for that monitor.
 *    Doubling means someone re-introduced a second scan path.
 *
 * 2. DISPATCH ISOLATION — The digest-dispatcher (the notification layer) must
 *    NEVER directly import or call source-entity monitors/repositories. It only
 *    consumes pre-built DueItem[] from the orchestrator.
 *
 * 3. SCHEDULE CONSTRAINT — The schedule must not contain both standalone monitors
 *    and notification-dispatch. Only one should scan.
 *
 * 4. ORCHESTRATOR CONTRACT — notification-dispatch must be the single entry point
 *    that owns the scan-once-dispatch-once lifecycle.
 *
 * HOW TO READ FAILURES:
 *   - Query budget exceeded    → A new code path is scanning source entities again
 *   - Dispatch isolation fail  → Someone made the dispatcher query source tables
 *   - Schedule constraint fail → Someone re-added a standalone monitor to cron
 */

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

// ── Prisma spies for query counting ─────────────────────────────────
const spies = {
    practice:         jest.fn().mockResolvedValue([]),
    policy:          jest.fn().mockResolvedValue([]),
    task:            jest.fn().mockResolvedValue([]),
    risk:            jest.fn().mockResolvedValue([]),
    practiceTestPlan: jest.fn().mockResolvedValue([]),
    evidence:        jest.fn().mockResolvedValue([]),
    vendor:          jest.fn().mockResolvedValue([]),
    // Epic 49 — calendar-deadlines monitor adds three entity sources
    // that the original deadline-monitor doesn't cover. They merge
    // into DEADLINE_DIGEST inside notification-dispatch.
    auditCycle:      jest.fn().mockResolvedValue([]),
    vendorDocument:  jest.fn().mockResolvedValue([]),
    finding:         jest.fn().mockResolvedValue([]),
    // Epic G-7 — risk-treatment-plan scanner + Phase 0 transition,
    // plus the milestone scanner. updateMany returns a row-count.
    riskTreatmentPlan:           jest.fn().mockResolvedValue([]),
    riskTreatmentPlanUpdateMany: jest.fn().mockResolvedValue({ count: 0 }),
    treatmentMilestone:          jest.fn().mockResolvedValue([]),
    // Notification infra — NOT source entities
    user:            jest.fn().mockResolvedValue([]),
    membership:      jest.fn().mockResolvedValue([]),
    tenant:          jest.fn().mockResolvedValue({ slug: 'test' }),
    outbox:          jest.fn().mockResolvedValue({ id: 'x' }),
};

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.values(spies).forEach(s => s.mockClear());

    // Reset return values
    spies.practice.mockResolvedValue([]);
    spies.policy.mockResolvedValue([]);
    spies.task.mockResolvedValue([]);
    spies.risk.mockResolvedValue([]);
    spies.practiceTestPlan.mockResolvedValue([]);
    spies.evidence.mockResolvedValue([]);
    spies.vendor.mockResolvedValue([]);
    spies.auditCycle.mockResolvedValue([]);
    spies.vendorDocument.mockResolvedValue([]);
    spies.finding.mockResolvedValue([]);
    spies.riskTreatmentPlan.mockResolvedValue([]);
    spies.riskTreatmentPlanUpdateMany.mockResolvedValue({ count: 0 });
    spies.treatmentMilestone.mockResolvedValue([]);
    spies.user.mockResolvedValue([]);
    spies.membership.mockResolvedValue([]);
    spies.tenant.mockResolvedValue({ slug: 'test' });
    spies.outbox.mockResolvedValue({ id: 'x' });

    jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
    jest.mock('@/lib/observability/job-runner', () => ({
        runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    }));

    const prismaMock = {
        practice:          { findMany: (...a: unknown[]) => spies.practice(...a) },
        policy:           { findMany: (...a: unknown[]) => spies.policy(...a) },
        task:             { findMany: (...a: unknown[]) => spies.task(...a) },
        risk:             { findMany: (...a: unknown[]) => spies.risk(...a) },
        practiceTestPlan:  { findMany: (...a: unknown[]) => spies.practiceTestPlan(...a) },
        evidence:         { findMany: (...a: unknown[]) => spies.evidence(...a) },
        vendor:           { findMany: (...a: unknown[]) => spies.vendor(...a) },
        // Epic 49 calendar-deadlines monitor sources.
        auditCycle:       { findMany: (...a: unknown[]) => spies.auditCycle(...a) },
        vendorDocument:   { findMany: (...a: unknown[]) => spies.vendorDocument(...a) },
        finding:          { findMany: (...a: unknown[]) => spies.finding(...a) },
        riskTreatmentPlan: {
            findMany:   (...a: unknown[]) => spies.riskTreatmentPlan(...a),
            updateMany: (...a: unknown[]) => spies.riskTreatmentPlanUpdateMany(...a),
        },
        treatmentMilestone: { findMany: (...a: unknown[]) => spies.treatmentMilestone(...a) },
        user:             { findMany: (...a: unknown[]) => spies.user(...a) },
        tenantMembership: { findMany: (...a: unknown[]) => spies.membership(...a) },
        tenant:           { findUnique: (...a: unknown[]) => spies.tenant(...a) },
        notificationOutbox: { create: (...a: unknown[]) => spies.outbox(...a) },
        tenantNotificationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    jest.mock('@/lib/prisma', () => ({
        __esModule: true,
        default: prismaMock,
        prisma: prismaMock,
    }));
});

// ═════════════════════════════════════════════════════════════════════
// 1. QUERY BUDGET — Entity tables per single dispatch run
// ═════════════════════════════════════════════════════════════════════

describe('REGRESSION: query budget per notification-dispatch run', () => {
    /**
     * Expected query counts per entity table for ONE full dispatch:
     *   - practice:         1 (deadline-monitor)
     *   - policy:          1 (deadline-monitor)
     *   - task:            1 (deadline-monitor)
     *   - risk:            1 (deadline-monitor)
     *   - practiceTestPlan: 1 (deadline-monitor)
     *   - evidence:        3 (evidence-expiry-monitor: retentionUntil + expired
     *                          + nextReviewDate). The third is a deliberate
     *                          budget raise, not drift: retention asks "may we
     *                          still keep this?" and review asks "is this still
     *                          true?" — different columns, different remedies,
     *                          and the review axis previously had NO sweep at
     *                          all, so a cadence an operator set produced
     *                          nothing. One more bounded, indexed scan.
     *   - vendor:          4 (vendor-renewal: overdue reviews, due reviews, overdue renewals, due renewals)
     *   - auditCycle:      1 (Epic 49 calendar-deadlines monitor — periodEndAt scan)
     *   - vendorDocument:  1 (Epic 49 calendar-deadlines monitor — validTo scan)
     *   - finding:         1 (Epic 49 calendar-deadlines monitor — dueDate scan)
     *
     * If any of these double, someone reintroduced a second scan path.
     */
    const QUERY_BUDGET: Record<string, { spy: keyof typeof spies; maxCalls: number; source: string }> = {
        practice:         { spy: 'practice',         maxCalls: 1, source: 'deadline-monitor' },
        policy:          { spy: 'policy',          maxCalls: 1, source: 'deadline-monitor' },
        task:            { spy: 'task',            maxCalls: 1, source: 'deadline-monitor' },
        risk:            { spy: 'risk',            maxCalls: 1, source: 'deadline-monitor' },
        practiceTestPlan: { spy: 'practiceTestPlan', maxCalls: 1, source: 'deadline-monitor' },
        evidence:        { spy: 'evidence',        maxCalls: 3, source: 'evidence-expiry-monitor' },
        vendor:          { spy: 'vendor',          maxCalls: 4, source: 'vendor-renewal-check' },
        auditCycle:      { spy: 'auditCycle',      maxCalls: 1, source: 'calendar-deadlines' },
        vendorDocument:  { spy: 'vendorDocument',  maxCalls: 1, source: 'calendar-deadlines' },
        finding:         { spy: 'finding',         maxCalls: 1, source: 'calendar-deadlines' },
    };

    test('full dispatch run stays within query budget for ALL entity tables', async () => {
        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );
        await runNotificationDispatch({});

        const violations: string[] = [];

        for (const [table, budget] of Object.entries(QUERY_BUDGET)) {
            const actual = spies[budget.spy].mock.calls.length;
            if (actual > budget.maxCalls) {
                violations.push(
                    `${table}: ${actual} queries (budget: ${budget.maxCalls}, source: ${budget.source}). ` +
                    `Likely a second scan was introduced.`
                );
            }
        }

        expect(violations).toEqual([]);
    });

    test.each(Object.entries({
        practice:         { spy: 'practice' as const,         maxCalls: 1 },
        policy:          { spy: 'policy' as const,          maxCalls: 1 },
        task:            { spy: 'task' as const,            maxCalls: 1 },
        risk:            { spy: 'risk' as const,            maxCalls: 1 },
        practiceTestPlan: { spy: 'practiceTestPlan' as const, maxCalls: 1 },
        evidence:        { spy: 'evidence' as const,        maxCalls: 3 },
        vendor:          { spy: 'vendor' as const,          maxCalls: 4 },
        auditCycle:      { spy: 'auditCycle' as const,      maxCalls: 1 },
        vendorDocument:  { spy: 'vendorDocument' as const,  maxCalls: 1 },
        finding:         { spy: 'finding' as const,         maxCalls: 1 },
    }))(
        '%s: at most %j queries per dispatch',
        async (table, { spy, maxCalls }) => {
            const { runNotificationDispatch } = await import(
                '../../src/app-layer/jobs/notification-dispatch'
            );
            await runNotificationDispatch({});
            expect(spies[spy].mock.calls.length).toBeLessThanOrEqual(maxCalls);
        },
    );
});

// ═════════════════════════════════════════════════════════════════════
// 2. QUERY BUDGET WITH PRECOMPUTED — Zero source queries
// ═════════════════════════════════════════════════════════════════════

describe('REGRESSION: precomputed items produce zero source-entity queries', () => {
    test('providing all precomputed items results in zero source queries', async () => {
        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );

        await runNotificationDispatch({
            precomputed: {
                deadlineItems: [],
                evidenceItems: [],
                vendorItems: [],
            },
        });

        // Source entity tables must NOT be touched
        expect(spies.practice.mock.calls.length).toBe(0);
        expect(spies.policy.mock.calls.length).toBe(0);
        expect(spies.task.mock.calls.length).toBe(0);
        expect(spies.risk.mock.calls.length).toBe(0);
        expect(spies.practiceTestPlan.mock.calls.length).toBe(0);
        expect(spies.evidence.mock.calls.length).toBe(0);
        expect(spies.vendor.mock.calls.length).toBe(0);
    });

    test('providing partial precomputed items only scans remaining categories', async () => {
        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );

        // Provide deadlines pre-computed, let evidence and vendor scan
        await runNotificationDispatch({
            precomputed: {
                deadlineItems: [],
                // evidenceItems NOT provided → should scan
                // vendorItems NOT provided → should scan
            },
        });

        // Deadline entities NOT queried (precomputed)
        expect(spies.practice.mock.calls.length).toBe(0);
        expect(spies.policy.mock.calls.length).toBe(0);
        expect(spies.task.mock.calls.length).toBe(0);
        expect(spies.risk.mock.calls.length).toBe(0);
        expect(spies.practiceTestPlan.mock.calls.length).toBe(0);

        // Evidence and vendor ARE queried (not precomputed)
        expect(spies.evidence.mock.calls.length).toBeGreaterThan(0);
        expect(spies.vendor.mock.calls.length).toBeGreaterThan(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. DISPATCH ISOLATION — digest-dispatcher never queries source tables
// ═════════════════════════════════════════════════════════════════════

describe('REGRESSION: digest-dispatcher does not query source-entity tables', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');

    const SOURCE_ENTITY_MODELS = [
        'practice', 'policy', 'task', 'risk',
        'practiceTestPlan', 'evidence', 'vendor',
    ];

    test('dispatcher source code does not reference source entity models', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        );

        const violations: string[] = [];
        for (const model of SOURCE_ENTITY_MODELS) {
            // Match prisma.model patterns (but not type imports or DueItem references)
            const queryPattern = new RegExp(`prisma\\.${model}\\b`, 'g');
            if (queryPattern.test(source)) {
                violations.push(
                    `digest-dispatcher.ts directly accesses prisma.${model}. ` +
                    `The dispatcher must consume DueItem[], not query source tables.`
                );
            }
        }

        expect(violations).toEqual([]);
    });

    test('dispatcher does not import monitor modules', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        );

        const monitorImports = [
            'deadline-monitor',
            'evidence-expiry-monitor',
            'vendor-renewal-check',
            'vendor-renewals',
        ];

        for (const mod of monitorImports) {
            expect(source).not.toContain(mod);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. SCHEDULE CONSTRAINT — Cannot schedule both monitor + dispatch
// ═════════════════════════════════════════════════════════════════════

describe('REGRESSION: schedule cannot contain duplicate scan paths', () => {
    const MONITOR_JOB_NAMES = [
        'deadline-monitor',
        'evidence-expiry-monitor',
        'vendor-renewal-check',
    ];

    test('SCHEDULED_JOBS does not contain standalone monitors alongside notification-dispatch', async () => {
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');
        const scheduledNames = SCHEDULED_JOBS.map(j => j.name);

        const hasDispatch = scheduledNames.includes('notification-dispatch');
        const hasMonitors = MONITOR_JOB_NAMES.some(m => (scheduledNames as string[]).includes(m));

        // Either dispatch exists alone, or monitors exist alone. Never both.
        if (hasDispatch && hasMonitors) {
            const duplicates = MONITOR_JOB_NAMES.filter(m => (scheduledNames as string[]).includes(m));
            fail(
                `Schedule contains both notification-dispatch AND standalone monitors: [${duplicates.join(', ')}]. ` +
                `This will cause duplicate DB scans. Remove the standalone monitors or notification-dispatch.`
            );
        }

        // Currently: dispatch runs, monitors do not
        expect(hasDispatch).toBe(true);
        expect(hasMonitors).toBe(false);
    });

    test('notification-dispatch schedule runs at most once daily', async () => {
        const { SCHEDULED_JOBS } = await import('../../src/app-layer/jobs/schedules');
        const dispatch = SCHEDULED_JOBS.filter(j => j.name === 'notification-dispatch');

        // Exactly one schedule entry
        expect(dispatch.length).toBe(1);

        // Cron should be daily (not more frequent)
        const cron = dispatch[0].pattern;
        // Daily cron format: "M H * * *" — minute/hour specific, day/month/dow wildcard
        expect(cron).toMatch(/^\d+ \d+ \* \* \*$/);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. ORCHESTRATOR CONTRACT — scanSource always reported
// ═════════════════════════════════════════════════════════════════════

describe('REGRESSION: notification-dispatch reports scan source for observability', () => {
    test('scanSource is always present in dispatch result', async () => {
        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );

        const { dispatch } = await runNotificationDispatch({});

        expect(dispatch.scanSource).toBeDefined();
        expect(dispatch.scanSource.deadlines).toBeDefined();
        expect(dispatch.scanSource.evidence).toBeDefined();
        expect(dispatch.scanSource.vendors).toBeDefined();
    });

    test('scanSource values are valid enum members', async () => {
        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );

        const { dispatch } = await runNotificationDispatch({});

        const validValues = ['precomputed', 'scanned', 'skipped'];
        expect(validValues).toContain(dispatch.scanSource.deadlines);
        expect(validValues).toContain(dispatch.scanSource.evidence);
        expect(validValues).toContain(dispatch.scanSource.vendors);
    });

    test('scanSource appears in JobRunResult details for operational visibility', async () => {
        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );

        const { result } = await runNotificationDispatch({});

        expect(result.details).toBeDefined();
        expect((result.details as Record<string, unknown>).scanSource).toBeDefined();
    });
});
