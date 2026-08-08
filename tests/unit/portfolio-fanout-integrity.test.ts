/**
 * Cross-tenant drill-down auditor fan-out integrity check.
 *
 * Mocks the repository + Prisma at module boundaries to verify that
 * the drill-down usecases (`getNonPerformingControls`,
 * `getOverdueEvidenceAcrossOrg`) both call the integrity check before
 * iterating, that the structured drift warning fires only when
 * memberships are missing, and that the iteration filters down to the
 * accessible subset rather than silently masking missing memberships
 * as empty results.
 *
 * A third path, `getCriticalRisksAcrossOrg`, was covered here until the
 * risk register was removed; the two remaining paths exercise the same
 * shared `assertAuditorFanoutIntegrity` helper.
 */

const getOrgTenantIdsMock = jest.fn();
const tenantMembershipFindManyMock = jest.fn();
const withTenantDbMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerInfoMock = jest.fn();

jest.mock('@/app-layer/repositories/PortfolioRepository', () => ({
    __esModule: true,
    PortfolioRepository: {
        getOrgTenantIds: (...a: unknown[]) => getOrgTenantIdsMock(...a),
        getLatestSnapshots: () => Promise.resolve([]),
        getSnapshotTrends: () => Promise.resolve([]),
    },
}));

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantMembership: {
            findMany: (...a: unknown[]) => tenantMembershipFindManyMock(...a),
        },
    },
}));

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    withTenantDb: (...a: unknown[]) => withTenantDbMock(...a),
}));

jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        warn: (...a: unknown[]) => loggerWarnMock(...a),
        info: (...a: unknown[]) => loggerInfoMock(...a),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import {
    getNonPerformingControls,
    getOverdueEvidenceAcrossOrg,
} from '@/app-layer/usecases/portfolio';
import type { OrgContext } from '@/app-layer/types';

function ctxFor(): OrgContext {
    return {
        requestId: 'req-test',
        userId: 'ciso-1',
        organizationId: 'org-1',
        orgSlug: 'acme-org',
        orgRole: 'ORG_ADMIN',
        permissions: {
            canViewPortfolio: true,
            canDrillDown: true,
            canExportReports: true,
            canManageTenants: true,
            canManageMembers: true,
            canConfigureDashboard: true,
        },
    };
}

const TENANTS = [
    { id: 't-1', slug: 'alpha', name: 'Alpha' },
    { id: 't-2', slug: 'beta', name: 'Beta' },
    { id: 't-3', slug: 'gamma', name: 'Gamma' },
];

beforeEach(() => {
    getOrgTenantIdsMock.mockReset();
    tenantMembershipFindManyMock.mockReset();
    withTenantDbMock.mockReset();
    loggerWarnMock.mockReset();
    loggerInfoMock.mockReset();
    // Default: every per-tenant fan-out invocation returns no rows.
    withTenantDbMock.mockImplementation(async (_tenantId: string, fn: (db: unknown) => Promise<unknown>) => {
        const db = {
            control: { findMany: () => Promise.resolve([]) },
            evidence: { findMany: () => Promise.resolve([]) },
        };
        return fn(db);
    });
});

// ── Healthy fan-out — no warning, all tenants iterated ────────────────

describe('drill-down integrity check — healthy fan-out (all tenants accessible)', () => {
    it('queries TenantMembership scoped to (userId, orgTenants) and emits no warning', async () => {
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        tenantMembershipFindManyMock.mockResolvedValue([
            { tenantId: 't-1' },
            { tenantId: 't-2' },
            { tenantId: 't-3' },
        ]);

        await getNonPerformingControls(ctxFor());

        // Single integrity query.
        expect(tenantMembershipFindManyMock).toHaveBeenCalledTimes(1);
        const arg = tenantMembershipFindManyMock.mock.calls[0][0];
        expect(arg.where).toEqual({
            userId: 'ciso-1',
            tenantId: { in: ['t-1', 't-2', 't-3'] },
        });

        // No drift → no warning emitted.
        expect(loggerWarnMock).not.toHaveBeenCalled();

        // All three tenants iterated.
        expect(withTenantDbMock).toHaveBeenCalledTimes(3);
    });

    it('manual non-AUDITOR rows (e.g. CISO is also OWNER somewhere) count as accessible', async () => {
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        // Only the row's existence matters — we don't filter on role.
        tenantMembershipFindManyMock.mockResolvedValue([
            { tenantId: 't-1' },
            { tenantId: 't-2' },
            { tenantId: 't-3' },
        ]);
        await getOverdueEvidenceAcrossOrg(ctxFor());
        expect(loggerWarnMock).not.toHaveBeenCalled();
        expect(withTenantDbMock).toHaveBeenCalledTimes(3);
    });

    it('empty org → no integrity query, no warning', async () => {
        getOrgTenantIdsMock.mockResolvedValue([]);

        await getOverdueEvidenceAcrossOrg(ctxFor());

        // Short-circuit — no DB calls when there are no tenants.
        expect(tenantMembershipFindManyMock).not.toHaveBeenCalled();
        expect(loggerWarnMock).not.toHaveBeenCalled();
        expect(withTenantDbMock).not.toHaveBeenCalled();
    });
});

// ── Drift detection — warning fires + accessible-only iteration ───────

describe('drill-down integrity check — fan-out drift detected', () => {
    it('emits portfolio.auditor_fanout_drift with the missing tenant ids', async () => {
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        // CISO has memberships in only 2 of 3 tenants — t-3 is missing.
        tenantMembershipFindManyMock.mockResolvedValue([
            { tenantId: 't-1' },
            { tenantId: 't-2' },
        ]);

        await getNonPerformingControls(ctxFor());

        expect(loggerWarnMock).toHaveBeenCalledTimes(1);
        const [event, payload] = loggerWarnMock.mock.calls[0] as [
            string,
            Record<string, unknown>,
        ];
        expect(event).toBe('portfolio.auditor_fanout_drift');
        expect(payload).toMatchObject({
            component: 'portfolio',
            organizationId: 'org-1',
            orgSlug: 'acme-org',
            userId: 'ciso-1',
            requestId: 'req-test',
            totalTenants: 3,
            accessibleTenants: 2,
            missingTenantIds: ['t-3'],
        });
        // Operator-facing hint must be present so on-call can act.
        expect(typeof payload.hint).toBe('string');
        expect((payload.hint as string).length).toBeGreaterThan(20);
    });

    it('iterates ONLY the accessible tenant subset (skips the missing tenants)', async () => {
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        tenantMembershipFindManyMock.mockResolvedValue([
            { tenantId: 't-1' },
            { tenantId: 't-3' },
        ]);

        await getNonPerformingControls(ctxFor());

        // The fan-out only touches t-1 and t-3 — t-2 is skipped.
        const tenantIdsIterated = withTenantDbMock.mock.calls.map((c) => c[0]);
        expect(tenantIdsIterated.sort()).toEqual(['t-1', 't-3']);
    });

    it('totally-empty fan-out (zero memberships) → warning fires + zero iterations', async () => {
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        // Worst case: provisioning never ran for this user at all.
        tenantMembershipFindManyMock.mockResolvedValue([]);

        const result = await getOverdueEvidenceAcrossOrg(ctxFor());
        expect(result).toEqual([]);

        // Warning identifies the full org tenant set as missing.
        const payload = loggerWarnMock.mock.calls[0][1] as Record<string, unknown>;
        expect(payload.missingTenantIds).toEqual(['t-1', 't-2', 't-3']);
        expect(payload.accessibleTenants).toBe(0);

        // Critical: NO per-tenant queries fire — the silent-empty
        // failure mode is replaced by an explicit warning.
        expect(withTenantDbMock).not.toHaveBeenCalled();
    });
});

// ── Reuse across the drill-down paths ────────────────────────────────

describe('drill-down integrity check — reused consistently across usecases', () => {
    it.each([
        ['getNonPerformingControls', getNonPerformingControls],
        ['getOverdueEvidenceAcrossOrg', getOverdueEvidenceAcrossOrg],
    ])('%s runs the integrity check before fan-out', async (_label, fn) => {
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        tenantMembershipFindManyMock.mockResolvedValue([
            { tenantId: 't-1' },
            { tenantId: 't-2' },
            { tenantId: 't-3' },
        ]);

        await fn(ctxFor());

        expect(tenantMembershipFindManyMock).toHaveBeenCalledTimes(1);
        // Integrity query fires BEFORE the per-tenant fan-out.
        const integrityOrder =
            tenantMembershipFindManyMock.mock.invocationCallOrder[0] ?? 0;
        const firstWithTenantDbOrder =
            withTenantDbMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
        expect(integrityOrder).toBeLessThan(firstWithTenantDbOrder);
    });
});
