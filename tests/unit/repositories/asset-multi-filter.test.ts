/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Multi-select facets on /assets must reach Prisma as `{ in: [...] }`.
 *
 * `filter-defs.ts` declares `multiple: true` on type / status /
 * criticality, and `toApiSearchParams` comma-joins a multi-select into
 * ONE query param. The repository used to cast that joined string
 * straight into a Prisma enum:
 *
 *     if (filters?.type) where.type = filters.type as AssetType;
 *
 * so `?type=TRACTOR,HARVESTER` reached the database as the literal
 * enum value "TRACTOR,HARVESTER" → PrismaClientValidationError → 500.
 * The `as AssetType` cast is what hid it from tsc.
 *
 * These execute the where-builder rather than asserting on its source,
 * because the guard at tests/guards/multi-select-facet-route-parity.ts
 * already covers the structural half and contributes no runtime
 * coverage.
 */

const captured: any[] = [];
const mockDb = {
    asset: {
        findMany: jest.fn(async (args: any) => {
            captured.push(args);
            return [];
        }),
    },
} as any;

import { AssetRepository } from '@/app-layer/repositories/AssetRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('READER');
const whereOf = () => captured[captured.length - 1].where;

beforeEach(() => {
    captured.length = 0;
    jest.clearAllMocks();
});

describe('AssetRepository multi-select filters', () => {
    it('emits { in: [...] } for several selected types', async () => {
        await AssetRepository.list(mockDb, ctx, { type: ['TRACTOR', 'HARVESTER'] } as any);
        expect(whereOf().type).toEqual({ in: ['TRACTOR', 'HARVESTER'] });
    });

    it('emits { in: [...] } even for a single selection', async () => {
        // Uniform shape: a one-member array must not silently become an
        // equality, or the two paths drift and only one gets tested.
        await AssetRepository.list(mockDb, ctx, { status: ['ACTIVE'] } as any);
        expect(whereOf().status).toEqual({ in: ['ACTIVE'] });
    });

    it('OMITS a cleared facet rather than emitting { in: [] }', async () => {
        // The subtle one. `{ in: [] }` matches NOTHING, so a user who
        // clears a facet would see an empty table — the opposite of what
        // clearing a filter means.
        await AssetRepository.list(mockDb, ctx, {
            type: [],
            status: [],
            criticality: [],
        } as any);
        const where = whereOf();
        expect(where).not.toHaveProperty('type');
        expect(where).not.toHaveProperty('status');
        expect(where).not.toHaveProperty('criticality');
    });

    it('omits facets that are absent entirely', async () => {
        await AssetRepository.list(mockDb, ctx, {} as any);
        const where = whereOf();
        expect(where).toEqual({ tenantId: ctx.tenantId });
    });

    it('combines all three facets plus the search term', async () => {
        await AssetRepository.list(mockDb, ctx, {
            type: ['TRACTOR'],
            status: ['ACTIVE', 'IN_MAINTENANCE'],
            criticality: ['HIGH'],
            q: 'deere',
        } as any);
        const where = whereOf();
        expect(where.type).toEqual({ in: ['TRACTOR'] });
        expect(where.status).toEqual({ in: ['ACTIVE', 'IN_MAINTENANCE'] });
        expect(where.criticality).toEqual({ in: ['HIGH'] });
        expect(Array.isArray(where.OR)).toBe(true);
        expect(where.tenantId).toBe(ctx.tenantId);
    });

    it('never lets a joined string reach Prisma as a scalar enum', async () => {
        // The exact shipped defect, pinned: the pre-fix code produced
        // `where.type === 'TRACTOR,HARVESTER'`.
        await AssetRepository.list(mockDb, ctx, { type: ['TRACTOR', 'HARVESTER'] } as any);
        expect(typeof whereOf().type).not.toBe('string');
    });

    it('applies the same shape on the paginated path', async () => {
        // listPaginated shares _buildWhere — but that is exactly the kind
        // of sharing a refactor breaks, so assert it rather than assume.
        await AssetRepository.listPaginated(mockDb, ctx, {
            filters: { type: ['VEHICLE', 'TOOL'] } as any,
        });
        expect(whereOf().type).toEqual({ in: ['VEHICLE', 'TOOL'] });
    });
});
