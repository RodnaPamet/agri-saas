/**
 * `includeDeleted` is a FILTER that really reaches the extension (#3272).
 *
 * This file exists because the unit tests CANNOT prove it.
 * `asset-usecase.test.ts` and `evidence-usecase.test.ts` both
 * `jest.mock('@/lib/soft-delete')` with a stub that stamps its own marker, so
 * they verify that the repository was asked for deleted rows and nothing
 * about whether the real extension honours the request. The same mocks would
 * pass if `withDeleted({})` spread into the argument object did nothing at
 * all — which is exactly the shape the refactor below put it in.
 *
 * It is spread rather than wrapped for a reason worth knowing, because the
 * obvious form is the one that breaks a guard: hoisting the whole argument
 * object into a variable and passing `withDeleted(args)` hides `take:` from
 * `query-shape-guardrails` Layer D2, which scans the findMany call site as
 * TEXT. A capped read then counts as unbounded. So the key is spread in and
 * `take:` stays on the call — and that form needs a test that executes it,
 * since a spread that silently contributed nothing would read as success.
 *
 * Both directions are asserted on every case. "The deleted row is returned"
 * alone is satisfied by a read that lost its soft-delete filtering
 * altogether, which would be a disclosure rather than a feature.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withSoftDeleteExtension } from '@/lib/soft-delete';
import { withPiiEncryptionExtension } from '@/lib/security/pii-middleware';
import { AssetRepository } from '@/app-layer/repositories/AssetRepository';
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import type { RequestContext } from '@/app-layer/types';

const prisma = withPiiEncryptionExtension(
    withSoftDeleteExtension(
        new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) }),
    ),
);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const stamp = Date.now();
const tenantId = `incdel-tenant-${stamp}`;
const liveAssetId = `incdel-asset-live-${stamp}`;
const deadAssetId = `incdel-asset-dead-${stamp}`;
const liveEvidenceId = `incdel-ev-live-${stamp}`;
const deadEvidenceId = `incdel-ev-dead-${stamp}`;

const ctx = { tenantId, userId: `incdel-user-${stamp}` } as unknown as RequestContext;

if (DB_AVAILABLE) {
    beforeAll(async () => {
        await prisma.tenant.create({
            data: { id: tenantId, name: `IncDel ${stamp}`, slug: `incdel-${stamp}` },
        });

        // One live and one soft-deleted row per model. The deleted ones are
        // created with `deletedAt` already set, through the EXTENDED client —
        // which is the production shape.
        await prisma.asset.create({
            data: { id: liveAssetId, tenantId, name: 'Fendt 936', type: 'TRACTOR' },
        });
        await prisma.asset.create({
            data: {
                id: deadAssetId,
                tenantId,
                name: 'Retired Claas',
                type: 'HARVESTER',
                deletedAt: new Date(),
            },
        });
        await prisma.evidence.create({
            data: { id: liveEvidenceId, tenantId, title: 'Service invoice', type: 'LINK' },
        });
        await prisma.evidence.create({
            data: {
                id: deadEvidenceId,
                tenantId,
                title: 'Mistaken upload',
                type: 'LINK',
                deletedAt: new Date(),
            },
        });
    });

    afterAll(async () => {
        await prisma
            .$executeRawUnsafe('DELETE FROM "Asset" WHERE "tenantId" = $1', tenantId)
            .catch(() => {});
        await prisma
            .$executeRawUnsafe('DELETE FROM "Evidence" WHERE "tenantId" = $1', tenantId)
            .catch(() => {});
        await prisma
            .$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', tenantId)
            .catch(() => {});
        await prisma.$disconnect();
    });
}

describeFn('includeDeleted reaches the soft-delete extension (#3272)', () => {
    describe('AssetRepository.list', () => {
        it('WITHOUT the flag: the deleted asset is hidden, the live one is not', async () => {
            const rows = await AssetRepository.list(prisma as never, ctx);
            const ids = rows.map((r: { id: string }) => r.id);
            expect(ids).toContain(liveAssetId);
            expect(ids).not.toContain(deadAssetId);
        });

        it('WITH the flag: BOTH come back — so the spread really arrived', async () => {
            const rows = await AssetRepository.list(prisma as never, ctx, {
                includeDeleted: true,
            });
            const ids = rows.map((r: { id: string }) => r.id);
            expect(ids).toContain(deadAssetId);
            expect(ids).toContain(liveAssetId);
        });

        it('the flag COMPOSES with a filter — the #3272 defect, directly', async () => {
            // Before the fix the route discarded this filter entirely and
            // answered with every asset on the farm. Both rows are HARVESTER
            // / TRACTOR, so a type filter that is honoured returns exactly one.
            const rows = await AssetRepository.list(prisma as never, ctx, {
                includeDeleted: true,
                type: ['HARVESTER'],
            });
            const ids = rows.map((r: { id: string }) => r.id);
            expect(ids).toEqual([deadAssetId]);
        });

        it('the flag composes with the SEARCH term too', async () => {
            const rows = await AssetRepository.list(prisma as never, ctx, {
                includeDeleted: true,
                q: 'claas',
            });
            expect(rows.map((r: { id: string }) => r.id)).toEqual([deadAssetId]);
        });

        it('a filter that matches only the LIVE row still excludes the deleted one', async () => {
            // The control for the case above: the flag widens what is
            // visible, it does not override the filter in either direction.
            const rows = await AssetRepository.list(prisma as never, ctx, {
                includeDeleted: true,
                type: ['TRACTOR'],
            });
            expect(rows.map((r: { id: string }) => r.id)).toEqual([liveAssetId]);
        });
    });

    describe('AssetRepository.listPaginated', () => {
        it('WITHOUT the flag the deleted asset is hidden; WITH it, it is not', async () => {
            const hidden = await AssetRepository.listPaginated(prisma as never, ctx, {
                limit: 50,
            });
            const shown = await AssetRepository.listPaginated(prisma as never, ctx, {
                limit: 50,
                filters: { includeDeleted: true },
            });
            const idsOf = (p: { items: unknown[] }) =>
                (p.items as { id: string }[]).map((r) => r.id);
            expect(idsOf(hidden)).not.toContain(deadAssetId);
            expect(idsOf(shown)).toContain(deadAssetId);
        });

        it('resolves ownerUser on the paginated branch (#3272 added it)', async () => {
            const page = await AssetRepository.listPaginated(prisma as never, ctx, {
                limit: 50,
            });
            // The column is nullable and unset here, so the ASSERTION is that
            // the key is present — a missing `include` omits it entirely,
            // which is what the paginated branch used to do.
            expect(page.items.length).toBeGreaterThan(0);
            expect(page.items[0] as object).toHaveProperty('ownerUser');
        });
    });

    describe('EvidenceRepository', () => {
        it('WITHOUT the flag: the deleted evidence row is hidden', async () => {
            const rows = await EvidenceRepository.list(prisma as never, ctx);
            const ids = rows.map((r: { id: string }) => r.id);
            expect(ids).toContain(liveEvidenceId);
            expect(ids).not.toContain(deadEvidenceId);
        });

        it('WITH the flag: BOTH come back', async () => {
            const rows = await EvidenceRepository.list(prisma as never, ctx, {
                includeDeleted: true,
            });
            const ids = rows.map((r: { id: string }) => r.id);
            expect(ids).toContain(deadEvidenceId);
            expect(ids).toContain(liveEvidenceId);
        });

        it('the flag COMPOSES with a search term', async () => {
            const rows = await EvidenceRepository.list(prisma as never, ctx, {
                includeDeleted: true,
                q: 'mistaken',
            });
            expect(rows.map((r: { id: string }) => r.id)).toEqual([deadEvidenceId]);
        });

        it('the caller cap is honoured, so the trash read is bounded', async () => {
            const rows = await EvidenceRepository.list(
                prisma as never,
                ctx,
                { includeDeleted: true },
                { take: 1 },
            );
            expect(rows).toHaveLength(1);
        });

        it('paginated: hidden without the flag, visible with it', async () => {
            const hidden = await EvidenceRepository.listPaginated(prisma as never, ctx, {
                limit: 50,
            });
            const shown = await EvidenceRepository.listPaginated(prisma as never, ctx, {
                limit: 50,
                filters: { includeDeleted: true },
            });
            const idsOf = (p: { items: unknown[] }) =>
                (p.items as { id: string }[]).map((r) => r.id);
            expect(idsOf(hidden)).not.toContain(deadEvidenceId);
            expect(idsOf(shown)).toContain(deadEvidenceId);
        });
    });
});
