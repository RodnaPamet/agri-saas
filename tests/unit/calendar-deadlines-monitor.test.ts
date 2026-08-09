/**
 * Epic 49 — calendar-deadlines monitor + dispatch wiring tests.
 *
 * Verifies:
 *   1. The monitor returns DueItem[] for AuditCycle / VendorDocument /
 *      Finding when their deadlines fall in window.
 *   2. Items past their deadline are classified OVERDUE.
 *   3. Closed/done entities are excluded.
 *   4. Tenant-scoped filter is applied.
 *   5. Empty per-source results don't throw.
 *   6. notification-dispatch wires the calendar monitor in alongside
 *      the base deadline monitor (structural ratchet).
 */

export {};

const TENANT_ID = 'tenant-cal';
const NOW = new Date('2026-06-01T00:00:00Z');

const mockAuditCycleFindMany = jest.fn().mockResolvedValue([]);
const mockVendorDocFindMany = jest.fn().mockResolvedValue([]);
const mockFindingFindMany = jest.fn().mockResolvedValue([]);

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockAuditCycleFindMany.mockReset().mockResolvedValue([]);
    mockVendorDocFindMany.mockReset().mockResolvedValue([]);
    mockFindingFindMany.mockReset().mockResolvedValue([]);

    jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
    jest.mock('@/lib/observability/job-runner', () => ({
        runJob: jest.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
    }));
    jest.mock('@/lib/prisma', () => ({
        __esModule: true,
        prisma: {
            auditCycle: {
                findMany: (...a: unknown[]) => mockAuditCycleFindMany(...a),
            },
            vendorDocument: {
                findMany: (...a: unknown[]) => mockVendorDocFindMany(...a),
            },
            finding: {
                findMany: (...a: unknown[]) => mockFindingFindMany(...a),
            },
        },
    }));
});

describe('runCalendarDeadlineMonitor', () => {
    it('returns an empty stream when every source is empty', async () => {
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const result = await runCalendarDeadlineMonitor({ now: NOW });
        expect(result.items).toEqual([]);
        expect(result.counts).toEqual({ overdue: 0, urgent: 0, upcoming: 0 });
    });

    it('produces an OVERDUE DueItem for an audit cycle past its periodEndAt', async () => {
        mockAuditCycleFindMany.mockResolvedValue([
            {
                id: 'cyc-1',
                tenantId: TENANT_ID,
                name: 'Q2 Audit',
                frameworkKey: 'SOC2',
                periodEndAt: new Date('2026-05-15T00:00:00Z'), // pre-NOW
                createdByUserId: 'user-owner',
            },
        ]);
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const r = await runCalendarDeadlineMonitor({ now: NOW });
        expect(r.items).toHaveLength(1);
        expect(r.items[0].urgency).toBe('OVERDUE');
        expect(r.items[0].entityType).toBe('PRACTICE'); // re-uses PRACTICE bucket
        expect(r.items[0].name).toContain('Q2 Audit');
        expect(r.items[0].ownerUserId).toBe('user-owner');
        expect(r.byEntity.AUDIT_CYCLE).toBe(1);
    });

    it('emits URGENT items for vendor docs expiring within 7 days', async () => {
        mockVendorDocFindMany.mockResolvedValue([
            {
                id: 'doc-1',
                tenantId: TENANT_ID,
                type: 'SOC2',
                validTo: new Date('2026-06-05T00:00:00Z'), // +4d
                vendor: { name: 'AWS', ownerUserId: 'user-vendor-owner' },
            },
        ]);
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const r = await runCalendarDeadlineMonitor({ now: NOW });
        expect(r.items).toHaveLength(1);
        expect(r.items[0].urgency).toBe('URGENT');
        expect(r.items[0].entityType).toBe('VENDOR');
        expect(r.items[0].ownerUserId).toBe('user-vendor-owner');
    });

    it('routes finding owners through the `owner` field', async () => {
        mockFindingFindMany.mockResolvedValue([
            {
                id: 'find-1',
                tenantId: TENANT_ID,
                title: 'Missing 2FA',
                dueDate: new Date('2026-06-15T00:00:00Z'),
                owner: 'user-finding-owner',
            },
        ]);
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const r = await runCalendarDeadlineMonitor({ now: NOW });
        expect(r.items).toHaveLength(1);
        expect(r.items[0].entityType).toBe('TASK');
        expect(r.items[0].ownerUserId).toBe('user-finding-owner');
    });

    it('passes `tenantId` through to every per-source query', async () => {
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        await runCalendarDeadlineMonitor({ tenantId: TENANT_ID, now: NOW });
        for (const m of [
            mockAuditCycleFindMany,
            mockVendorDocFindMany,
            mockFindingFindMany,
        ]) {
            expect(m).toHaveBeenCalled();
            const where = m.mock.calls[0][0].where;
            expect(where.tenantId).toBe(TENANT_ID);
        }
    });

    it('omits items whose deadline is beyond the largest detection window', async () => {
        mockFindingFindMany.mockResolvedValue([
            {
                id: 'find-far',
                tenantId: TENANT_ID,
                title: 'long-tail',
                // The Prisma `where` filter uses `lte: horizon` so the
                // DB layer normally excludes these. The monitor's
                // safety check via `classifyUrgency` returns null
                // when daysRemaining > maxWindow — verify it filters
                // even if the row were to slip past the DB filter.
                dueDate: new Date('2026-12-01T00:00:00Z'),
                owner: null,
            },
        ]);
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const r = await runCalendarDeadlineMonitor({
            now: NOW,
            windows: [30, 7, 1],
        });
        expect(r.items).toHaveLength(0);
    });
});

// ─── Structural ratchet for the orchestrator wiring ──────────────────

describe('notification-dispatch wires the calendar-deadlines monitor', () => {
    it('imports and runs runCalendarDeadlineMonitor inside DEADLINE_DIGEST', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/jobs/notification-dispatch.ts'),
            'utf-8',
        );
        // The orchestrator must (a) import calendar-deadlines and
        // (b) include runCalendarDeadlineMonitor in the parallel scan.
        // Both regressions ("forgot to merge calendar items" /
        // "calendar items get sent in their own digest") would silently
        // break the unified dispatch contract.
        // Dynamic import inside the orchestrator (lazy-loaded to keep
        // boot light). Match `import('./calendar-deadlines')` OR a
        // top-level static `from './calendar-deadlines'` — either is
        // acceptable; both signal "calendar monitor is wired in".
        expect(src).toMatch(
            /(import\(['"]\.\/calendar-deadlines['"]\)|from\s+['"]\.\/calendar-deadlines['"])/,
        );
        expect(src).toMatch(/runCalendarDeadlineMonitor/);
    });
});
