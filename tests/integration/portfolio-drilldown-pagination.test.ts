/**
 * Portfolio drill-down cursor pagination — DB-backed integration test.
 *
 * Subject is the surviving org-wide drill-down: overdue evidence
 * (`listOverdueEvidenceAcrossOrg`). The practices drill-down that this
 * file also covered was removed by the GRC teardown, so every walk here
 * now runs against evidence — the per-tenant `withTenantDb` fan-out and
 * the cursor handoff are the same machinery either way.
 *
 * Seeds an org with two tenants; in each tenant seeds enough rows
 * that `limit < total < limit*2` so the merge actually paginates
 * and the cursor handoff is non-trivial. Walks the pages at two
 * different limits (5 → four pages, 7 → three pages) and verifies:
 *
 *   - Total emitted across pages == seeded total (no row dropped, no
 *     row duplicated).
 *   - nextCursor is non-null until the final page, then null.
 *   - Tenant attribution on every row matches the seeded tenant, and
 *     the drill-down URL is scoped to that tenant's slug.
 *   - Sort order is preserved across page boundaries.
 *   - Invalid cursor lands on page 1 (lenient on read).
 *   - A single page holding every row matches the multi-page walk.
 *
 * Gated by DB_AVAILABLE — skips locally without Postgres + migrations
 * applied; runs in CI.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

import { listOverdueEvidenceAcrossOrg } from '@/app-layer/usecases/portfolio';
import type { OrgContext } from '@/app-layer/types';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Portfolio drill-down — cursor pagination (DB-backed)', () => {
    let prisma: PrismaClient;
    const uniq = `drilldown-page-${Date.now()}`;
    const orgSlug = `${uniq}-org`;
    let orgId = '';
    let cisoUserId = '';
    const tenantSlugs = [`${uniq}-t1`, `${uniq}-t2`];
    const tenantIds: string[] = [];

    function ctxFor(): OrgContext {
        return {
            requestId: 'req-test',
            userId: cisoUserId,
            organizationId: orgId,
            orgSlug,
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

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const org = await prisma.organization.create({
            data: { name: `${uniq} corp`, slug: orgSlug },
        });
        orgId = org.id;

        const ciso = await prisma.user.create({
            data: { email: `${uniq}-ciso@example.com`, name: 'CISO Test' },
        });
        cisoUserId = ciso.id;

        await prisma.orgMembership.create({
            data: { organizationId: org.id, userId: ciso.id, role: 'ORG_ADMIN' },
        });

        for (let i = 0; i < tenantSlugs.length; i++) {
            const slug = tenantSlugs[i];
            const { wrapped } = generateAndWrapDek();
            const tenant = await prisma.tenant.create({
                data: {
                    name: `${uniq} tenant ${i + 1}`,
                    slug,
                    organizationId: org.id,
                    encryptedDek: wrapped,
                },
            });
            tenantIds.push(tenant.id);

            // Auto-provisioned AUDITOR for the CISO so RLS lets the
            // per-tenant queries through.
            await prisma.tenantMembership.create({
                data: {
                    tenantId: tenant.id,
                    userId: ciso.id,
                    role: 'AUDITOR',
                    provisionedByOrgId: org.id,
                },
            });

            // Seed 8 overdue evidence per tenant. Distinct
            // nextReviewDate offsets so the merged sort is deterministic.
            for (let n = 0; n < 8; n++) {
                await prisma.evidence.create({
                    data: {
                        tenantId: tenant.id,
                        title: `t${i + 1} overdue evidence ${n}`,
                        type: 'TEXT',
                        nextReviewDate: new Date(
                            Date.now() - (5 + n) * 86400_000,
                        ),
                        status: 'SUBMITTED',
                    },
                });
            }
        }
    });

    afterAll(async () => {
        await prisma.evidence.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => {});
        await prisma.orgMembership.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
        await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
        await prisma.user.delete({ where: { id: cisoUserId } }).catch(() => {});
        await prisma.$disconnect();
    });

    // ── Evidence — page walk + tenant attribution ────────────────────

    it('evidence: pages through all 16 rows (8 per tenant) without dropping or duplicating', async () => {
        const seen = new Set<string>();
        let cursor: string | undefined = undefined;
        let pages = 0;
        const limit = 5;

        while (pages < 10) {
            // Hard cap to avoid runaway loops on a regression.
            const result = await listOverdueEvidenceAcrossOrg(ctxFor(), { cursor, limit });
            for (const row of result.rows) {
                expect(seen.has(row.evidenceId)).toBe(false);
                seen.add(row.evidenceId);
                expect(tenantSlugs).toContain(row.tenantSlug);
                expect(row.drillDownUrl).toBe(`/t/${row.tenantSlug}/evidence/${row.evidenceId}`);
            }
            pages++;
            if (!result.nextCursor) break;
            cursor = result.nextCursor;
        }

        // 8 overdue evidence per tenant × 2 tenants = 16. With limit=5 →
        // pages of 5, 5, 5, 1 — 4 pages.
        expect(seen.size).toBe(16);
        expect(pages).toBe(4);
    });

    it('evidence: invalid cursor lands on page 1 (lenient on read)', async () => {
        const result = await listOverdueEvidenceAcrossOrg(ctxFor(), {
            cursor: '!!! not a valid base64 json !!!',
            limit: 50,
        });
        // 16 rows, default-ish limit 50 → all on one page, no nextCursor.
        expect(result.rows.length).toBe(16);
        expect(result.nextCursor).toBeNull();
    });

    // ── Evidence — ordering across page boundaries ───────────────────

    it('evidence: pages through all 16 rows preserving nextReviewDate ASC ordering', async () => {
        const seen = new Map<string, { page: number; date: string }>();
        let cursor: string | undefined = undefined;
        let prevDate = '0000-00-00';
        let pages = 0;
        const limit = 7;

        while (pages < 10) {
            const result = await listOverdueEvidenceAcrossOrg(ctxFor(), { cursor, limit });
            for (const row of result.rows) {
                if (seen.has(row.evidenceId)) {
                    const prior = seen.get(row.evidenceId)!;
                    throw new Error(
                        `Duplicate evidence row across pages: id=${row.evidenceId} ` +
                            `tenantSlug=${row.tenantSlug} date=${row.nextReviewDate} ` +
                            `previously seen on page ${prior.page} (date=${prior.date}); ` +
                            `now on page ${pages}.`,
                    );
                }
                seen.set(row.evidenceId, { page: pages, date: row.nextReviewDate });
                // Older review dates come first (most overdue).
                expect(row.nextReviewDate >= prevDate).toBe(true);
                prevDate = row.nextReviewDate;
                expect(tenantSlugs).toContain(row.tenantSlug);
            }
            pages++;
            if (!result.nextCursor) break;
            cursor = result.nextCursor;
        }
        expect(seen.size).toBe(16);
    });

    // ── Page-1 parity with dashboard preview ─────────────────────────

    it('a single page holding every row matches the multi-page walk', async () => {
        // limit=16 → all rows in one page → nextCursor null.
        const paginated = await listOverdueEvidenceAcrossOrg(ctxFor(), { limit: 16 });
        expect(paginated.rows.length).toBe(16);
        expect(paginated.nextCursor).toBeNull();

        // Same 16 ids the paged walk above emitted, same order.
        const walked: string[] = [];
        let cursor: string | undefined = undefined;
        for (let page = 0; page < 10; page++) {
            const result = await listOverdueEvidenceAcrossOrg(ctxFor(), { cursor, limit: 5 });
            walked.push(...result.rows.map((r) => r.evidenceId));
            if (!result.nextCursor) break;
            cursor = result.nextCursor;
        }
        expect(walked).toEqual(paginated.rows.map((r) => r.evidenceId));
    });
});
