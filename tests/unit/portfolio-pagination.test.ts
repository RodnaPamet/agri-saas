/**
 * Portfolio drill-down cursor pagination — unit contract.
 *
 * Mocks Prisma + PortfolioRepository at module boundaries so the
 * test exercises the cursor encode/decode + per-tenant query
 * predicate logic without touching a live DB. Integration coverage
 * (real RLS, real merge across multiple seeded tenants) lives in
 * `tests/integration/portfolio-drilldown-pagination.test.ts`.
 *
 * Coverage:
 *   - First page returns rows + nextCursor when there are more
 *   - Last page returns rows + nextCursor: null
 *   - Cursor decode is opaque (round-trips through encode)
 *   - Invalid cursor falls back to first page (lenient on read)
 *   - limit parameter clamps to [1, MAX_DRILLDOWN_PAGE_LIMIT]
 *   - Per-tenant cursor predicate is shaped correctly for each entity
 *   - Tenant attribution survives the merge across pages
 */

const getOrgTenantIdsMock = jest.fn();
const withTenantDbMock = jest.fn();
const controlFindManyMock = jest.fn();
const riskFindManyMock = jest.fn();
const evidenceFindManyMock = jest.fn();

jest.mock('@/app-layer/repositories/PortfolioRepository', () => ({
    __esModule: true,
    PortfolioRepository: {
        getOrgTenantIds: (...a: unknown[]) => getOrgTenantIdsMock(...a),
    },
}));

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    withTenantDb: (...a: unknown[]) => withTenantDbMock(...a),
}));

import {
    listNonPerformingControls,
    listOverdueEvidenceAcrossOrg,
} from '@/app-layer/usecases/portfolio';
import type { OrgContext } from '@/app-layer/types';

function ctxFor(): OrgContext {
    return {
        requestId: 'req-test',
        userId: 'caller-1',
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

interface CapturedQuery {
    where: Record<string, unknown>;
    take: number;
    orderBy: unknown;
}

beforeEach(() => {
    getOrgTenantIdsMock.mockReset();
    controlFindManyMock.mockReset();
    riskFindManyMock.mockReset();
    evidenceFindManyMock.mockReset();
    withTenantDbMock.mockReset();
    // Default tenant fixture: two tenants under the org.
    getOrgTenantIdsMock.mockResolvedValue([
        { id: 't-1', slug: 'alpha', name: 'Alpha' },
        { id: 't-2', slug: 'beta', name: 'Beta' },
    ]);
    // withTenantDb invokes the callback with a stub `db` whose
    // findMany methods route to per-entity mocks. The test then
    // asserts on the captured WHERE/orderBy/take.
    withTenantDbMock.mockImplementation(async (_tenantId: string, fn: (db: unknown) => Promise<unknown>) => {
        const db = {
            control: { findMany: controlFindManyMock },
            risk: { findMany: riskFindManyMock },
            evidence: { findMany: evidenceFindManyMock },
        };
        return fn(db);
    });
});

// ── Controls ───────────────────────────────────────────────────────────

describe('listNonPerformingControls — cursor pagination', () => {
    it('first page (no cursor) does not apply a cursor predicate', async () => {
        controlFindManyMock.mockResolvedValue([]);

        await listNonPerformingControls(ctxFor());

        // Both tenants queried.
        expect(controlFindManyMock).toHaveBeenCalledTimes(2);
        // No `OR` cursor clause merged in.
        const where = (controlFindManyMock.mock.calls[0][0] as CapturedQuery).where;
        expect(where).not.toHaveProperty('OR');
        // Base filters intact.
        expect(where).toMatchObject({
            applicability: 'APPLICABLE',
            deletedAt: null,
        });
    });

    it('returns rows + nextCursor when there are more rows than the limit', async () => {
        // Each tenant returns one row. limit=1 → page = 1 row + 1 leftover.
        controlFindManyMock
            .mockResolvedValueOnce([
                {
                    id: 'c-1',
                    name: 'High priority alpha',
                    code: 'A-1',
                    status: 'NEEDS_REVIEW',
                    updatedAt: new Date('2026-04-25T00:00:00Z'),
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'c-2',
                    name: 'High priority beta',
                    code: 'B-1',
                    status: 'NEEDS_REVIEW',
                    updatedAt: new Date('2026-04-24T00:00:00Z'),
                },
            ]);

        const result = await listNonPerformingControls(ctxFor(), { limit: 1 });

        expect(result.rows).toHaveLength(1);
        // Sort prefers higher priority first; both NEEDS_REVIEW (5),
        // so updatedAt DESC tiebreaker → alpha (newer) wins.
        expect(result.rows[0].controlId).toBe('c-1');
        expect(result.rows[0].tenantSlug).toBe('alpha');
        expect(result.nextCursor).not.toBeNull();
        expect(typeof result.nextCursor).toBe('string');
    });

    it('cursor encodes priority + updatedAt + id; second page decodes and applies predicate', async () => {
        // Build a cursor for the alpha row we'd have returned on page 1.
        const cursor = Buffer.from(
            JSON.stringify({
                p: 5, // NEEDS_REVIEW priority
                d: '2026-04-25T00:00:00.000Z',
                i: 'c-1',
            }),
        ).toString('base64url');

        controlFindManyMock.mockResolvedValue([]);
        await listNonPerformingControls(ctxFor(), { cursor, limit: 50 });

        // Per-tenant where now carries the cursor compound predicate.
        const where = (controlFindManyMock.mock.calls[0][0] as CapturedQuery).where;
        expect(where).toHaveProperty('OR');
        const orClauses = (where.OR as Array<Record<string, unknown>>);
        // Exactly three branches: lower priority statuses; same priority
        // older updatedAt; same priority same updatedAt larger id.
        expect(orClauses).toHaveLength(3);
        // First: status IN [lower priorities]. Cursor.p == 5 means
        // statuses 4,3,2,1 → 4 statuses below.
        const lowerBranch = orClauses[0] as { status: { in: string[] } };
        expect(lowerBranch.status.in).toEqual([
            'NOT_STARTED',
            'PLANNED',
            'IN_PROGRESS',
            'IMPLEMENTING',
        ]);
    });

    it('last page returns nextCursor: null', async () => {
        controlFindManyMock.mockResolvedValue([]);
        const result = await listNonPerformingControls(ctxFor(), { limit: 50 });
        expect(result.rows).toEqual([]);
        expect(result.nextCursor).toBeNull();
    });

    it('limit is clamped to [1, 200]', async () => {
        controlFindManyMock.mockResolvedValue([]);
        // Negative + zero clamp to 1.
        await listNonPerformingControls(ctxFor(), { limit: -5 });
        let take = (controlFindManyMock.mock.calls[0][0] as CapturedQuery).take;
        // Per-tenant take is `max(25, limit*2) + 1` → for limit=1, that's 26.
        expect(take).toBe(26);

        controlFindManyMock.mockClear();
        // Large limit clamps to 200; per-tenant take = 200*2 + 1 = 401.
        await listNonPerformingControls(ctxFor(), { limit: 5000 });
        take = (controlFindManyMock.mock.calls[0][0] as CapturedQuery).take;
        expect(take).toBe(401);
    });

    it('invalid cursor (garbage string) falls back to first-page behaviour', async () => {
        controlFindManyMock.mockResolvedValue([]);
        await listNonPerformingControls(ctxFor(), {
            cursor: 'not-base64-json-at-all',
        });
        const where = (controlFindManyMock.mock.calls[0][0] as CapturedQuery).where;
        expect(where).not.toHaveProperty('OR');
    });

    it('preserves tenant attribution on every returned row', async () => {
        controlFindManyMock
            .mockResolvedValueOnce([
                {
                    id: 'c-1',
                    name: 'A',
                    code: null,
                    status: 'NOT_STARTED',
                    updatedAt: new Date('2026-04-20T00:00:00Z'),
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'c-2',
                    name: 'B',
                    code: null,
                    status: 'NOT_STARTED',
                    updatedAt: new Date('2026-04-21T00:00:00Z'),
                },
            ]);

        const result = await listNonPerformingControls(ctxFor());

        const byId = new Map(result.rows.map((r) => [r.controlId, r]));
        expect(byId.get('c-1')?.tenantSlug).toBe('alpha');
        expect(byId.get('c-1')?.tenantName).toBe('Alpha');
        expect(byId.get('c-1')?.tenantId).toBe('t-1');
        expect(byId.get('c-2')?.tenantSlug).toBe('beta');
        expect(byId.get('c-2')?.tenantName).toBe('Beta');
    });
});

// ── Risks ──────────────────────────────────────────────────────────────


// ── Evidence ───────────────────────────────────────────────────────────

describe('listOverdueEvidenceAcrossOrg — cursor pagination', () => {
    it('cursor encodes nextReviewDate + id (single-dim sort)', async () => {
        const cursor = Buffer.from(
            JSON.stringify({
                d: '2026-04-20T00:00:00.000Z',
                i: 'e-99',
            }),
        ).toString('base64url');

        evidenceFindManyMock.mockResolvedValue([]);
        await listOverdueEvidenceAcrossOrg(ctxFor(), { cursor });

        const where = (evidenceFindManyMock.mock.calls[0][0] as CapturedQuery).where;
        const orClauses = where.OR as Array<Record<string, unknown>>;
        // Only 2 branches for single-dim cursor.
        expect(orClauses).toHaveLength(2);
        // gt because evidence sorts ASC by nextReviewDate (most-overdue first).
        expect(orClauses[0]).toMatchObject({
            nextReviewDate: { gt: expect.any(Date) },
        });
    });

    it('orderBy is [nextReviewDate asc, id asc]', async () => {
        evidenceFindManyMock.mockResolvedValue([]);
        await listOverdueEvidenceAcrossOrg(ctxFor());
        const orderBy = (evidenceFindManyMock.mock.calls[0][0] as CapturedQuery).orderBy;
        expect(orderBy).toEqual([{ nextReviewDate: 'asc' }, { id: 'asc' }]);
    });
});

// ── Permission gate (shared) ──────────────────────────────────────────

