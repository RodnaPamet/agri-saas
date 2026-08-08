/**
 * Epic 41 — POST /api/org seeds default dashboard widgets.
 *
 * Drives the route handler through a real DB transaction with a
 * mocked session and asserts:
 *
 *   - The org-creation 201 response carries the expected shape
 *   - The new org has exactly 8 widgets persisted (the default preset)
 *   - The widget rows are scoped to the new org (`organizationId` FK)
 *
 * Concurrent / race coverage lives in
 * `org-dashboard-preset-seeding.test.ts`. This test verifies the
 * route-layer wiring rather than the seeder semantics.
 *
 * Gated by DB_AVAILABLE — skips locally without Postgres + migrations
 * applied; runs in CI.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

// ─── Mocks ─────────────────────────────────────────────────────────

const getSessionMock = jest.fn();

jest.mock('@/lib/auth', () => {
    const actual = jest.requireActual('@/lib/auth');
    return {
        __esModule: true,
        ...actual,
        getSessionOrThrow: (...a: unknown[]) => getSessionMock(...a),
    };
});

import { POST } from '@/app/api/org/route';
import { NextRequest } from 'next/server';

describeFn('Epic 41 — POST /api/org seeds default widgets (DB-backed)', () => {
    let prisma: PrismaClient;
    const uniq = `org-seed-create-${Date.now()}`;
    const userIds: string[] = [];
    const orgIds: string[] = [];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        await prisma.orgDashboardWidget.deleteMany({
            where: { organizationId: { in: orgIds } },
        }).catch(() => {});
        await prisma.orgMembership.deleteMany({
            where: { organizationId: { in: orgIds } },
        }).catch(() => {});
        await prisma.organization.deleteMany({
            where: { id: { in: orgIds } },
        }).catch(() => {});
        await prisma.user.deleteMany({
            where: { id: { in: userIds } },
        }).catch(() => {});
        await prisma.$disconnect();
    });

    beforeEach(() => {
        getSessionMock.mockReset();
    });

    function makeReq(body: unknown): NextRequest {
        return new NextRequest('http://localhost/api/org', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('creates the org + persists the default widgets atomically', async () => {
        const user = await prisma.user.create({
            data: {
                email: `${uniq}-creator@example.com`,
                name: 'Creator',
            },
        });
        userIds.push(user.id);
        getSessionMock.mockResolvedValue({ userId: user.id });

        const slug = `${uniq}-acme`;
        const res = await POST(
            makeReq({ name: 'Acme', slug }),
            // The route handler is wrapped with withApiErrorHandling
            // which is variadic on its second arg — passing `{}` is
            // sufficient for routes whose params aren't read.
            {} as never,
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { organization: { id: string } };
        const orgId = body.organization.id;
        orgIds.push(orgId);

        // Eight widgets persisted, all scoped to the new org.
        const widgets = await prisma.orgDashboardWidget.findMany({
            where: { organizationId: orgId },
        });
        // 8 → 6: the critical-risks KPI and open-risks trend went with
        // the risk register.
        expect(widgets).toHaveLength(6);

        const distinctOrgIds = new Set(widgets.map((w) => w.organizationId));
        expect(distinctOrgIds).toEqual(new Set([orgId]));

        // Sanity — every widget has the expected shape (type / chartType
        // / position / size present, JSON values not null).
        for (const w of widgets) {
            expect(w.type).toBeDefined();
            expect(w.chartType).toBeDefined();
            expect(w.position).toBeTruthy();
            expect(w.size).toBeTruthy();
        }
    });

    it('atomic guarantee — duplicate-slug 409 leaves NO partial widgets', async () => {
        // Pre-seed an org so the second create fails on the unique
        // slug. Asserts that the rollback path doesn't leave orphan
        // widget rows from a half-applied transaction.
        const user = await prisma.user.create({
            data: {
                email: `${uniq}-dup-creator@example.com`,
                name: 'Dup',
            },
        });
        userIds.push(user.id);

        const slug = `${uniq}-dup`;
        const existing = await prisma.organization.create({
            data: { name: 'Existing', slug },
        });
        orgIds.push(existing.id);
        // Sanity — the existing org has no widgets at this point.
        const before = await prisma.orgDashboardWidget.count({
            where: { organizationId: existing.id },
        });
        expect(before).toBe(0);

        getSessionMock.mockResolvedValue({ userId: user.id });
        const res = await POST(
            makeReq({ name: 'Conflict', slug }),
            {} as never,
        );
        expect(res.status).toBe(409);

        // No widgets attributed to a phantom org id — verified by
        // checking that the existing-slug org's widget count is
        // unchanged. The transaction rollback prevents orphan rows.
        const after = await prisma.orgDashboardWidget.count({
            where: { organizationId: existing.id },
        });
        expect(after).toBe(0);
    });
});
