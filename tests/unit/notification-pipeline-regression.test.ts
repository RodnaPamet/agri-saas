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
//
// GRC teardown phase 2 removed every scanner except the deadline monitor
// (practice / policy / task) and the evidence-expiry monitor: the Risk +
// PracticeTestPlan scanners, the vendor-renewal check and its
// VENDOR_RENEWAL_DIGEST, the Epic 49 calendar-deadlines monitor
// (AuditCycle / VendorDocument / Finding) and the Epic G-7 treatment-plan +
// milestone scanners all went with their models. Their spies went with
// them — a spy for a table nothing queries turns a budget into a
// tautology, which is exactly what this suite exists to prevent.
const spies = {
    practice:        jest.fn().mockResolvedValue([]),
    policy:          jest.fn().mockResolvedValue([]),
    task:            jest.fn().mockResolvedValue([]),
    evidence:        jest.fn().mockResolvedValue([]),
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
    spies.evidence.mockResolvedValue([]);
    spies.user.mockResolvedValue([]);
    spies.membership.mockResolvedValue([]);
    spies.tenant.mockResolvedValue({ slug: 'test' });
    spies.outbox.mockResolvedValue({ id: 'x' });

    jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
    jest.mock('@/lib/observability/job-runner', () => ({
        runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    }));

    const prismaMock = {
        practice:         { findMany: (...a: unknown[]) => spies.practice(...a) },
        policy:           { findMany: (...a: unknown[]) => spies.policy(...a) },
        task:             { findMany: (...a: unknown[]) => spies.task(...a) },
        evidence:         { findMany: (...a: unknown[]) => spies.evidence(...a) },
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
     *   - practice:  1 (deadline-monitor)
     *   - policy:    1 (deadline-monitor)
     *   - task:      1 (deadline-monitor)
     *   - evidence:  3 (evidence-expiry-monitor: retentionUntil + expired
     *                   + nextReviewDate). The third is a deliberate
     *                   budget raise, not drift: retention asks "may we
     *                   still keep this?" and review asks "is this still
     *                   true?" — different columns, different remedies,
     *                   and the review axis previously had NO sweep at
     *                   all, so a cadence an operator set produced
     *                   nothing. One more bounded, indexed scan.
     *
     * GRC teardown phase 2 removed the risk / practiceTestPlan /
     * vendor / auditCycle / vendorDocument / finding rows: those scanners
     * no longer exist, so a budget for them could never be exceeded.
     * The four above are the ENTIRE source-entity surface of a dispatch
     * run, and the per-table ceilings are unchanged from what they were
     * before the teardown (nothing was raised).
     *
     * If any of these double, someone reintroduced a second scan path.
     */
    const QUERY_BUDGET: Record<string, { spy: keyof typeof spies; maxCalls: number; source: string }> = {
        practice: { spy: 'practice', maxCalls: 1, source: 'deadline-monitor' },
        policy:   { spy: 'policy',   maxCalls: 1, source: 'deadline-monitor' },
        task:     { spy: 'task',     maxCalls: 1, source: 'deadline-monitor' },
        evidence: { spy: 'evidence', maxCalls: 3, source: 'evidence-expiry-monitor' },
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
        practice: { spy: 'practice' as const, maxCalls: 1 },
        policy:   { spy: 'policy' as const,   maxCalls: 1 },
        task:     { spy: 'task' as const,     maxCalls: 1 },
        evidence: { spy: 'evidence' as const, maxCalls: 3 },
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

        // `vendorItems` left with VENDOR_RENEWAL_DIGEST in GRC teardown
        // phase 2 — notification-dispatch no longer reads that key.
        await runNotificationDispatch({
            precomputed: {
                deadlineItems: [],
                evidenceItems: [],
            },
        });

        // Source entity tables must NOT be touched
        expect(spies.practice.mock.calls.length).toBe(0);
        expect(spies.policy.mock.calls.length).toBe(0);
        expect(spies.task.mock.calls.length).toBe(0);
        expect(spies.evidence.mock.calls.length).toBe(0);
    });

    test('providing partial precomputed items only scans remaining categories', async () => {
        const { runNotificationDispatch } = await import(
            '../../src/app-layer/jobs/notification-dispatch'
        );

        // Provide deadlines pre-computed, let evidence scan.
        // (The vendor leg went with VENDOR_RENEWAL_DIGEST in GRC teardown
        //  phase 2; evidence is the surviving "not precomputed → scans"
        //  half, so the mixed-mode contract is still exercised.)
        await runNotificationDispatch({
            precomputed: {
                deadlineItems: [],
                // evidenceItems NOT provided → should scan
            },
        });

        // Deadline entities NOT queried (precomputed)
        expect(spies.practice.mock.calls.length).toBe(0);
        expect(spies.policy.mock.calls.length).toBe(0);
        expect(spies.task.mock.calls.length).toBe(0);

        // Evidence IS queried (not precomputed)
        expect(spies.evidence.mock.calls.length).toBeGreaterThan(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. DISPATCH ISOLATION — digest-dispatcher never queries source tables
// ═════════════════════════════════════════════════════════════════════

describe('REGRESSION: digest-dispatcher does not query source-entity tables', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');

    // These are NEGATIVE assertions ("the dispatcher must not touch these"),
    // so GRC teardown phase 2 deliberately left the list intact: risk /
    // practiceTestPlan / vendor lost their monitors but their Prisma models
    // survive until phase 3 drops the schema, and dropping a name from a
    // never-list only ever weakens it.
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
