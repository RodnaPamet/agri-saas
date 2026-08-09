/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `src/app-layer/usecases/framework/fixtures.ts`.
 *
 * Wave-10 / stage-3h branch coverage. Two exported functions:
 *
 *   - `upsertRequirements` — framework-bulk import/update with
 *     optional deprecation of missing rows. Branches:
 *       • policy gate (assertCanWriteCatalogue — the PLATFORM gate;
 *         this used to be assertCanInstallFrameworkPack, which admits
 *         OWNER/ADMIN of ANY tenant and let one farm deprecate a whole
 *         standard for every other farm)
 *       • framework not found
 *       • empty fixture array
 *       • duplicate codes within the fixture
 *       • existing requirement → update (un-deprecate) + sortOrder
 *         fallback to existing
 *       • new requirement → create + sortOrder default 0
 *       • deprecateMissing on → updateMany with `notIn(codes)`
 *
 *   - `computeRequirementsDiff` — produces added / removed / changed
 *     sets + unmapped-new-requirements count. Branches:
 *       • policy gate (assertCanViewFrameworks)
 *       • from-framework not found
 *       • to-framework not found
 *       • added (in to, not in from)
 *       • removed (in from, not in to)
 *       • changed — title / section / description differs
 *       • section fallback to category when section is null
 *       • unmappedNewRequirements > 0 path (calls
 *         runInTenantContext + practiceRequirementLink.findMany)
 *       • added.length === 0 → mapping check skipped
 */

const policyCalls: string[] = [];

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

jest.mock('@/app-layer/policies/framework.policies', () => ({
    assertCanWriteCatalogue: jest.fn(() => policyCalls.push('catalogue')),
    assertCanInstallFrameworkPack: jest.fn(() => policyCalls.push('install')),
    assertCanViewFrameworks: jest.fn(() => policyCalls.push('view')),
}));

const prismaMock: any = {
    framework: { findFirst: jest.fn() },
    frameworkRequirement: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
    },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: prismaMock,
    prisma: prismaMock,
}));

const tenantDb: any = {
    practiceRequirementLink: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)),
    };
});

import { upsertRequirements, computeRequirementsDiff } from '@/app-layer/usecases/framework/fixtures';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    prismaMock.framework.findFirst.mockReset();
    prismaMock.frameworkRequirement.findUnique.mockReset();
    prismaMock.frameworkRequirement.create.mockReset();
    prismaMock.frameworkRequirement.update.mockReset();
    prismaMock.frameworkRequirement.updateMany.mockReset();
    prismaMock.frameworkRequirement.findMany.mockReset();
    tenantDb.practiceRequirementLink.findMany.mockReset();
});

const ctx = makeRequestContext('ADMIN');

describe('upsertRequirements — guard rails', () => {
    it('invokes the CATALOGUE gate before any read', async () => {
        // Was `assertCanInstallFrameworkPack`, which admits the OWNER or ADMIN
        // of any tenant — this assertion required the vulnerability. The gate
        // is now the platform one; "before any read" still matters, because a
        // denial that first tells the caller whether a framework key exists is
        // an enumeration oracle over the catalogue.
        prismaMock.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'iso' });
        prismaMock.frameworkRequirement.findUnique.mockResolvedValue(null);
        prismaMock.frameworkRequirement.create.mockResolvedValue({ id: 'r-1' });
        await upsertRequirements(ctx, 'iso', [
            { code: 'A.5.1', title: 'Access Control' },
        ]);
        expect(policyCalls[0]).toBe('catalogue');
    });

    it('throws notFound when the framework key does not resolve', async () => {
        prismaMock.framework.findFirst.mockResolvedValue(null);
        await expect(
            upsertRequirements(ctx, 'missing', [{ code: 'X', title: 'Y' }]),
        ).rejects.toThrow(/Framework not found/);
    });

    it('throws badRequest when the fixture is empty', async () => {
        prismaMock.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'iso' });
        await expect(upsertRequirements(ctx, 'iso', [])).rejects.toThrow(
            /At least one requirement required/,
        );
    });

    it('throws badRequest with the duplicate code list when codes collide', async () => {
        prismaMock.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'iso' });
        await expect(
            upsertRequirements(ctx, 'iso', [
                { code: 'A.1', title: 'First' },
                { code: 'A.2', title: 'Second' },
                { code: 'A.1', title: 'Dup' },
                { code: 'A.2', title: 'Dup2' },
            ]),
        ).rejects.toThrow(/Duplicate requirement codes in fixture: A.1, A.2/);
        // The unique-set check happens BEFORE any DB write — no
        // upsert side-effects when validation rejects.
        expect(prismaMock.frameworkRequirement.create).not.toHaveBeenCalled();
        expect(prismaMock.frameworkRequirement.update).not.toHaveBeenCalled();
    });
});

describe('upsertRequirements — create/update paths', () => {
    it('creates a brand-new requirement with sortOrder default 0', async () => {
        prismaMock.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'iso' });
        prismaMock.frameworkRequirement.findUnique.mockResolvedValue(null);
        prismaMock.frameworkRequirement.create.mockResolvedValue({ id: 'r-1' });
        const result = await upsertRequirements(ctx, 'iso', [
            { code: 'A.5.1', title: 'Access Control' },
        ]);
        expect(prismaMock.frameworkRequirement.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                code: 'A.5.1',
                title: 'Access Control',
                sortOrder: 0,
            }),
        });
        expect(result).toEqual({
            frameworkKey: 'iso',
            created: 1,
            updated: 0,
            deprecated: 0,
        });
    });

    it('updates an existing requirement and un-deprecates it (deprecatedAt: null)', async () => {
        prismaMock.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'iso' });
        prismaMock.frameworkRequirement.findUnique.mockResolvedValue({
            id: 'r-existing',
            sortOrder: 42,
            deprecatedAt: new Date('2025-01-01'),
        });
        prismaMock.frameworkRequirement.update.mockResolvedValue({ id: 'r-existing' });
        const result = await upsertRequirements(ctx, 'iso', [
            { code: 'A.5.1', title: 'Access Control (revised)' },
        ]);
        expect(prismaMock.frameworkRequirement.update).toHaveBeenCalledWith({
            where: { id: 'r-existing' },
            data: expect.objectContaining({
                title: 'Access Control (revised)',
                // Falls back to existing.sortOrder when the fixture
                // omits the field.
                sortOrder: 42,
                deprecatedAt: null,
            }),
        });
        expect(result).toEqual({
            frameworkKey: 'iso',
            created: 0,
            updated: 1,
            deprecated: 0,
        });
    });

    it('uses explicit sortOrder from the fixture when provided', async () => {
        prismaMock.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'iso' });
        prismaMock.frameworkRequirement.findUnique.mockResolvedValue(null);
        prismaMock.frameworkRequirement.create.mockResolvedValue({ id: 'r-1' });
        await upsertRequirements(ctx, 'iso', [
            { code: 'A.5.1', title: 'X', sortOrder: 17 },
        ]);
        expect(prismaMock.frameworkRequirement.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ sortOrder: 17 }),
        });
    });

    it('deprecateMissing: true → updateMany sets deprecatedAt on rows not in the fixture', async () => {
        prismaMock.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'iso' });
        prismaMock.frameworkRequirement.findUnique.mockResolvedValue(null);
        prismaMock.frameworkRequirement.create.mockResolvedValue({ id: 'r-1' });
        prismaMock.frameworkRequirement.updateMany.mockResolvedValue({ count: 4 });

        const result = await upsertRequirements(
            ctx,
            'iso',
            [{ code: 'A.5.1', title: 'X' }],
            { deprecateMissing: true },
        );

        expect(prismaMock.frameworkRequirement.updateMany).toHaveBeenCalledWith({
            where: {
                frameworkId: 'fw-1',
                code: { notIn: ['A.5.1'] },
                deprecatedAt: null,
            },
            data: { deprecatedAt: expect.any(Date) },
        });
        expect(result.deprecated).toBe(4);
    });

    it('deprecateMissing default (false) → updateMany never runs', async () => {
        prismaMock.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'iso' });
        prismaMock.frameworkRequirement.findUnique.mockResolvedValue(null);
        prismaMock.frameworkRequirement.create.mockResolvedValue({ id: 'r-1' });
        const result = await upsertRequirements(ctx, 'iso', [
            { code: 'A.5.1', title: 'X' },
        ]);
        expect(prismaMock.frameworkRequirement.updateMany).not.toHaveBeenCalled();
        expect(result.deprecated).toBe(0);
    });
});

describe('computeRequirementsDiff — guard rails', () => {
    it('invokes assertCanViewFrameworks (read-only diff)', async () => {
        prismaMock.framework.findFirst
            .mockResolvedValueOnce({ id: 'fw-from', key: 'iso-2013', name: 'ISO', version: '2013' })
            .mockResolvedValueOnce({ id: 'fw-to', key: 'iso-2022', name: 'ISO', version: '2022' });
        prismaMock.frameworkRequirement.findMany.mockResolvedValue([]);
        await computeRequirementsDiff(ctx, 'iso-2013', 'iso-2022');
        expect(policyCalls[0]).toBe('view');
    });

    it('throws notFound when the FROM framework is missing', async () => {
        prismaMock.framework.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'fw-to' });
        await expect(
            computeRequirementsDiff(ctx, 'gone', 'iso'),
        ).rejects.toThrow(/Framework "gone" not found/);
    });

    it('throws notFound when the TO framework is missing', async () => {
        prismaMock.framework.findFirst
            .mockResolvedValueOnce({ id: 'fw-from' })
            .mockResolvedValueOnce(null);
        await expect(
            computeRequirementsDiff(ctx, 'iso', 'gone'),
        ).rejects.toThrow(/Framework "gone" not found/);
    });
});

describe('computeRequirementsDiff — diff computation', () => {
    function setupFrameworks() {
        prismaMock.framework.findFirst
            .mockResolvedValueOnce({ id: 'fw-from', key: 'iso-2013', name: 'ISO', version: '2013' })
            .mockResolvedValueOnce({ id: 'fw-to', key: 'iso-2022', name: 'ISO', version: '2022' });
    }

    it('identifies added / removed / changed (title) — section falls back to category', async () => {
        setupFrameworks();
        prismaMock.frameworkRequirement.findMany
            // FROM
            .mockResolvedValueOnce([
                { id: 'rf-1', code: 'A.1', title: 'Old', section: null, category: 'Cat-A', description: 'd1' },
                { id: 'rf-2', code: 'A.2', title: 'Removed', section: 'S1', category: null, description: 'd2' },
                { id: 'rf-3', code: 'A.3', title: 'Same', section: 'S3', category: null, description: 'd3' },
            ])
            // TO
            .mockResolvedValueOnce([
                { id: 'rt-1', code: 'A.1', title: 'New', section: null, category: 'Cat-A', description: 'd1' },
                { id: 'rt-3', code: 'A.3', title: 'Same', section: 'S3', category: null, description: 'd3' },
                { id: 'rt-4', code: 'A.4', title: 'Added', section: 'S4', category: null, description: 'd4' },
            ]);
        tenantDb.practiceRequirementLink.findMany.mockResolvedValue([]);

        const diff = await computeRequirementsDiff(ctx, 'iso-2013', 'iso-2022');

        expect(diff.added).toEqual([
            { code: 'A.4', title: 'Added', section: 'S4' },
        ]);
        expect(diff.removed).toEqual([
            { code: 'A.2', title: 'Removed', section: 'S1' },
        ]);
        expect(diff.changed).toEqual([
            {
                code: 'A.1',
                changes: ['title'],
                from: { title: 'Old', section: 'Cat-A' }, // section falls back to category
                to: { title: 'New', section: 'Cat-A' },
            },
        ]);
        expect(diff.summary).toEqual({
            added: 1,
            removed: 1,
            changed: 1,
            unmappedNewRequirements: 1,
        });
    });

    it('detects section + description changes', async () => {
        setupFrameworks();
        prismaMock.frameworkRequirement.findMany
            .mockResolvedValueOnce([
                { id: 'rf-1', code: 'A.1', title: 'Same', section: 'X', category: null, description: 'd1' },
            ])
            .mockResolvedValueOnce([
                { id: 'rt-1', code: 'A.1', title: 'Same', section: 'Y', category: null, description: 'd2' },
            ]);
        tenantDb.practiceRequirementLink.findMany.mockResolvedValue([]);

        const diff = await computeRequirementsDiff(ctx, 'iso-2013', 'iso-2022');
        expect(diff.changed).toHaveLength(1);
        // Both section AND description differ — both appear in the
        // changes list (title does not).
        expect(diff.changed[0].changes.sort()).toEqual(['description', 'section']);
    });

    it('skips the mapping check when nothing was added', async () => {
        setupFrameworks();
        prismaMock.frameworkRequirement.findMany
            .mockResolvedValueOnce([
                { id: 'rf-1', code: 'A.1', title: 'Same', section: null, category: null, description: 'd' },
            ])
            .mockResolvedValueOnce([
                { id: 'rt-1', code: 'A.1', title: 'Same', section: null, category: null, description: 'd' },
            ]);
        const out = await computeRequirementsDiff(ctx, 'iso-2013', 'iso-2022');
        // practiceRequirementLink lookup never runs when added.length===0.
        expect(tenantDb.practiceRequirementLink.findMany).not.toHaveBeenCalled();
        expect(out.summary.unmappedNewRequirements).toBe(0);
    });

    it('counts already-mapped new requirements as zero unmapped', async () => {
        setupFrameworks();
        prismaMock.frameworkRequirement.findMany
            .mockResolvedValueOnce([
                { id: 'rf-1', code: 'A.1', title: 'X', section: null, category: null, description: 'd' },
            ])
            .mockResolvedValueOnce([
                { id: 'rf-1', code: 'A.1', title: 'X', section: null, category: null, description: 'd' },
                { id: 'rt-2', code: 'A.2', title: 'Added', section: null, category: null, description: 'd2' },
            ]);
        // Tenant ALREADY has a practice mapped to the new requirement.
        tenantDb.practiceRequirementLink.findMany.mockResolvedValue([
            { requirementId: 'rt-2' },
        ]);
        const out = await computeRequirementsDiff(ctx, 'iso-2013', 'iso-2022');
        expect(out.summary.unmappedNewRequirements).toBe(0);
    });
});
