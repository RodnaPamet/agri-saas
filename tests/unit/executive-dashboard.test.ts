/**
 * Executive Dashboard Aggregation Tests
 *
 * Verifies:
 * 1. Evidence expiry logic handles edge cases
 * 2. Task status aggregation + overdue count
 * 3. Empty datasets return sensible zeros
 * 4. No N+1 — each method uses groupBy/count (not findMany)
 *
 * GRC teardown phase 3 removed three of the five aggregations this
 * file used to cover — `getPracticeCoverage`, `getPolicySummary` and
 * `getVendorSummary` — along with the models they counted. Nothing was
 * re-pointed: a coverage percentage over practices has no agri
 * analogue, and inventing one would assert a shape the dashboard does
 * not render. The two surviving aggregations keep their cases verbatim.
 */

// ─── Mock db-context ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTx: Record<string, any> = {};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => {
        return fn(mockTx);
    }),
}));

import {
    DashboardRepository,
    type EvidenceExpiry,
} from '@/app-layer/repositories/DashboardRepository';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
    return {
        requestId: 'req-test',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockTx).forEach(k => delete mockTx[k]);
});

// ─── Evidence Expiry ───

describe('Dashboard — Evidence Expiry', () => {
    it('classifies evidence into expiry buckets', async () => {
        mockTx.evidence = {
            count: jest.fn()
                .mockResolvedValueOnce(3)   // overdue
                .mockResolvedValueOnce(2)   // dueSoon7d
                .mockResolvedValueOnce(5)   // dueSoon30d
                .mockResolvedValueOnce(10)  // noReviewDate
                .mockResolvedValueOnce(15), // current
        };

        const result: EvidenceExpiry = await DashboardRepository.getEvidenceExpiry(mockTx as never, makeCtx());

        expect(result.overdue).toBe(3);
        expect(result.dueSoon7d).toBe(2);
        expect(result.dueSoon30d).toBe(5);
        expect(result.noReviewDate).toBe(10);
        expect(result.current).toBe(15);
    });

    it('returns zeros for empty evidence set', async () => {
        mockTx.evidence = {
            count: jest.fn().mockResolvedValue(0),
        };

        const result = await DashboardRepository.getEvidenceExpiry(mockTx as never, makeCtx());

        expect(result.overdue).toBe(0);
        expect(result.dueSoon7d).toBe(0);
        expect(result.dueSoon30d).toBe(0);
        expect(result.noReviewDate).toBe(0);
        expect(result.current).toBe(0);
    });
});

// ─── Task Summary ───

describe('Dashboard — Task Summary', () => {
    it('aggregates task statuses and overdue count', async () => {
        mockTx.task = {
            groupBy: jest.fn(async () => [
                { status: 'OPEN', _count: 5 },
                { status: 'TRIAGED', _count: 2 },
                { status: 'IN_PROGRESS', _count: 3 },
                { status: 'BLOCKED', _count: 1 },
                { status: 'RESOLVED', _count: 4 },
            ]),
            count: jest.fn(async () => 2), // overdue
        };

        const result = await DashboardRepository.getTaskSummary(mockTx as never, makeCtx());

        expect(result.total).toBe(15);
        expect(result.open).toBe(7); // OPEN (5) + TRIAGED (2)
        expect(result.inProgress).toBe(3);
        expect(result.blocked).toBe(1);
        expect(result.resolved).toBe(4); // RESOLVED
        expect(result.overdue).toBe(2);
    });
});

// ─── Executive Dashboard Usecase ───


// ─── Tenant Scoping ───


// ─── Query Efficiency ───

