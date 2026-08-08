/**
 * Cross-tenant drill-down auditor fan-out integrity check.
 *
 * Mocks the repository + Prisma at module boundaries to verify that
 * the three drill-down usecases (`getNonPerformingControls`,
 * `getCriticalRisksAcrossOrg`, `getOverdueEvidenceAcrossOrg`) all
 * consistently call the integrity check before iterating, that the
 * structured drift warning fires only when memberships are missing,
 * and that the iteration filters down to the accessible subset
 * rather than silently masking missing memberships as empty results.
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
            risk: { findMany: () => Promise.resolve([]) },
            evidence: { findMany: () => Promise.resolve([]) },
        };
        return fn(db);
    });
});

// ── Healthy fan-out — no warning, all tenants iterated ────────────────


// ── Drift detection — warning fires + accessible-only iteration ───────


// ── Reuse across all three drill-down paths ────────────────────────

