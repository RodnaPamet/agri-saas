/**
 * Portfolio drill-down cursor pagination — unit contract.
 *
 * Mocks Prisma + PortfolioRepository at module boundaries so the
 * test exercises the cursor encode/decode + per-tenant query
 * predicate logic without touching a live DB. Integration coverage
 * (real RLS, real merge across multiple seeded tenants) lives in
 * `tests/integration/portfolio-drilldown-pagination.test.ts`.
 *
 * The GRC teardown removed the practices and risks drill-downs, so
 * OVERDUE EVIDENCE is the one surviving paginated drill-down and
 * every contract below is asserted against it. The security
 * property is unchanged and is the reason this file exists: each
 * per-tenant page runs inside `withTenantDb(tenantId)`, so RLS —
 * not application code — governs what the fan-out can read.
 *
 * Coverage:
 *   - Every per-tenant page is issued inside withTenantDb(tenantId)
 *   - First page returns rows + nextCursor when there are more
 *   - Last page returns rows + nextCursor: null
 *   - Cursor round-trips: page 1's nextCursor decodes into page 2's
 *     per-tenant predicate
 *   - Invalid cursor falls back to first page (lenient on read)
 *   - limit parameter clamps to [1, MAX_DRILLDOWN_PAGE_LIMIT]
 *   - Per-tenant cursor predicate is shaped correctly (single-dim)
 *   - Tenant attribution survives the merge across pages
 *   - canViewPortfolio gates the paginated path
 */

const getOrgTenantIdsMock = jest.fn();
const withTenantDbMock = jest.fn();
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

import { listOverdueEvidenceAcrossOrg } from '@/app-layer/usecases/portfolio';
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
            evidence: { findMany: evidenceFindManyMock },
        };
        return fn(db);
    });
});

// ── Evidence ───────────────────────────────────────────────────────────

describe('listOverdueEvidenceAcrossOrg — cursor pagination', () => {
    it('issues one query per tenant, each inside withTenantDb(tenantId)', async () => {
        evidenceFindManyMock.mockResolvedValue([]);

        await listOverdueEvidenceAcrossOrg(ctxFor());

        // Both tenants queried, each in its own RLS-bound transaction.
        expect(evidenceFindManyMock).toHaveBeenCalledTimes(2);
        expect(withTenantDbMock.mock.calls.map((c) => c[0])).toEqual(['t-1', 't-2']);
    });

    it('first page (no cursor) does not apply a cursor predicate', async () => {
        evidenceFindManyMock.mockResolvedValue([]);

        await listOverdueEvidenceAcrossOrg(ctxFor());

        // No `OR` cursor clause merged in.
        const where = (evidenceFindManyMock.mock.calls[0][0] as CapturedQuery).where;
        expect(where).not.toHaveProperty('OR');
        // Base filters intact, and the query is pinned to one tenant.
        expect(where).toMatchObject({
            tenantId: 't-1',
            status: { not: 'APPROVED' },
            deletedAt: null,
        });
    });

    it('returns rows + nextCursor when there are more rows than the limit', async () => {
        // Each tenant returns one row. limit=1 → page = 1 row + 1 leftover.
        evidenceFindManyMock
            .mockResolvedValueOnce([
                {
                    id: 'e-1',
                    title: 'Soil test alpha',
                    nextReviewDate: new Date('2026-04-20T09:30:00Z'),
                    status: 'SUBMITTED',
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'e-2',
                    title: 'Soil test beta',
                    nextReviewDate: new Date('2026-04-24T00:00:00Z'),
                    status: 'SUBMITTED',
                },
            ]);

        const result = await listOverdueEvidenceAcrossOrg(ctxFor(), { limit: 1 });

        expect(result.rows).toHaveLength(1);
        // Sort is nextReviewDate ASC (== most overdue first), so the
        // older alpha row wins the merge.
        expect(result.rows[0].evidenceId).toBe('e-1');
        expect(result.rows[0].tenantSlug).toBe('alpha');
        expect(result.nextCursor).not.toBeNull();
        expect(typeof result.nextCursor).toBe('string');
    });

    // Re-pointed from the deleted practices/risks cursor tests: the
    // "page 1's cursor is the page 2 predicate" round-trip is a
    // property of every paginated drill-down, and evidence is the one
    // that survives. What genuinely has NO subject any more is the
    // MULTI-DIMENSIONAL variant those two proved — the three-branch
    // compound predicate (lower priority / same priority + older
    // updatedAt / same priority + larger id) and the
    // CONTROL_STATUS_PRIORITY ladder that fed its `status IN [...]`
    // branch. Both the practices status ladder and the risks
    // inherentScore ladder were deleted with their usecases, and the
    // evidence cursor is single-dimension (date + id), so there is no
    // surviving surface that sorts on more than one non-id key.
    it('cursor round-trips: page 1 nextCursor decodes into the page 2 predicate', async () => {
        evidenceFindManyMock
            .mockResolvedValueOnce([
                {
                    id: 'e-1',
                    title: 'Soil test alpha',
                    // Non-midnight time-of-day: the cursor must carry
                    // full precision, not the date-only DTO string.
                    nextReviewDate: new Date('2026-04-20T09:30:00Z'),
                    status: 'SUBMITTED',
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'e-2',
                    title: 'Soil test beta',
                    nextReviewDate: new Date('2026-04-24T00:00:00Z'),
                    status: 'SUBMITTED',
                },
            ]);

        const page1 = await listOverdueEvidenceAcrossOrg(ctxFor(), { limit: 1 });
        expect(page1.nextCursor).not.toBeNull();

        // The cursor points at the last row page 1 actually emitted.
        const decoded = JSON.parse(
            Buffer.from(page1.nextCursor!, 'base64url').toString('utf-8'),
        );
        expect(decoded.d).toBe('2026-04-20T09:30:00.000Z');
        expect(decoded.i).toBe('e-1');

        // Feeding it back turns into the after-cursor predicate.
        evidenceFindManyMock.mockReset();
        evidenceFindManyMock.mockResolvedValue([]);
        await listOverdueEvidenceAcrossOrg(ctxFor(), {
            cursor: page1.nextCursor!,
            limit: 1,
        });

        const where = (evidenceFindManyMock.mock.calls[0][0] as CapturedQuery).where;
        const orClauses = where.OR as Array<Record<string, unknown>>;
        expect(orClauses).toHaveLength(2);
        expect(orClauses[0]).toEqual({
            nextReviewDate: { gt: new Date('2026-04-20T09:30:00.000Z') },
        });
        expect(orClauses[1]).toEqual({
            AND: [
                { nextReviewDate: new Date('2026-04-20T09:30:00.000Z') },
                { id: { gt: 'e-1' } },
            ],
        });
    });

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

    it('last page returns nextCursor: null', async () => {
        evidenceFindManyMock.mockResolvedValue([]);
        const result = await listOverdueEvidenceAcrossOrg(ctxFor(), { limit: 50 });
        expect(result.rows).toEqual([]);
        expect(result.nextCursor).toBeNull();
    });

    it('limit is clamped to [1, 200]', async () => {
        evidenceFindManyMock.mockResolvedValue([]);
        // Negative + zero clamp to 1.
        await listOverdueEvidenceAcrossOrg(ctxFor(), { limit: -5 });
        let take = (evidenceFindManyMock.mock.calls[0][0] as CapturedQuery).take;
        // Per-tenant take is `max(25, limit*2) + 1` → for limit=1, that's 26.
        expect(take).toBe(26);

        evidenceFindManyMock.mockClear();
        // Large limit clamps to 200; per-tenant take = 200*2 + 1 = 401.
        await listOverdueEvidenceAcrossOrg(ctxFor(), { limit: 5000 });
        take = (evidenceFindManyMock.mock.calls[0][0] as CapturedQuery).take;
        expect(take).toBe(401);
    });

    it('invalid cursor (garbage string) falls back to first-page behaviour', async () => {
        evidenceFindManyMock.mockResolvedValue([]);
        await listOverdueEvidenceAcrossOrg(ctxFor(), {
            cursor: 'not-base64-json-at-all',
        });
        const where = (evidenceFindManyMock.mock.calls[0][0] as CapturedQuery).where;
        expect(where).not.toHaveProperty('OR');
    });

    it('preserves tenant attribution on every returned row', async () => {
        evidenceFindManyMock
            .mockResolvedValueOnce([
                {
                    id: 'e-1',
                    title: 'A',
                    nextReviewDate: new Date('2026-04-20T00:00:00Z'),
                    status: 'SUBMITTED',
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'e-2',
                    title: 'B',
                    nextReviewDate: new Date('2026-04-21T00:00:00Z'),
                    status: 'SUBMITTED',
                },
            ]);

        const result = await listOverdueEvidenceAcrossOrg(ctxFor());

        const byId = new Map(result.rows.map((r) => [r.evidenceId, r]));
        expect(byId.get('e-1')?.tenantSlug).toBe('alpha');
        expect(byId.get('e-1')?.tenantName).toBe('Alpha');
        expect(byId.get('e-1')?.tenantId).toBe('t-1');
        expect(byId.get('e-2')?.tenantSlug).toBe('beta');
        expect(byId.get('e-2')?.tenantName).toBe('Beta');
    });
});

// ── Permission gate (shared) ──────────────────────────────────────────

describe('paginated drill-down — permission gate', () => {
    it('throws forbidden when canViewPortfolio is false', async () => {
        const denied = ctxFor();
        denied.permissions.canViewPortfolio = false;

        await expect(listOverdueEvidenceAcrossOrg(denied)).rejects.toMatchObject({
            status: 403,
        });
    });
});
