/**
 * Integration tests: server-side search & filtering.
 *
 * Tests that:
 * 1. normalizeQ trims, clamps, and handles edge cases
 * 2. ControlRepository._buildWhere constructs correct Prisma where clauses
 * 3. EvidenceRepository._buildWhere handles type/controlId/archived/expiring/q filters
 * 4. RiskRepository._buildWhere searches title + description + category
 * 5. AssetRepository._buildWhere searches name + classification + owner
 * 6. WorkItemRepository._buildWhere handles status/type/severity/priority/due/q
 * 7. VendorRepository._buildWhere handles status/criticality/reviewDue/q
 * 8. PolicyRepository._buildWhere handles status/category/q
 * 9. Zod schemas strip unknown fields and normalize q
 */

import { normalizeQ } from '@/lib/filters/query-helpers';
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';

// ─── 1. normalizeQ ───

describe('normalizeQ', () => {
    it('returns undefined for empty/null input', () => {
        expect(normalizeQ(undefined)).toBeUndefined();
        expect(normalizeQ('')).toBeUndefined();
        expect(normalizeQ('   ')).toBeUndefined();
    });

    it('trims whitespace', () => {
        expect(normalizeQ('  hello  ')).toBe('hello');
    });

    it('clamps to 200 characters', () => {
        const long = 'a'.repeat(300);
        const result = normalizeQ(long);
        expect(result!.length).toBe(200);
    });

    it('preserves case (normalization is trim+clamp only)', () => {
        expect(normalizeQ('Hello World')).toBe('Hello World');
    });
});

// ─── 2-8. _buildWhere tests for each repository ───

// We test the static _buildWhere methods by exercising the public list/listPaginated
// methods with a mock DB. Since _buildWhere is private, we verify the where clause
// through the mock's received arguments.

describe('ControlRepository._buildWhere', () => {
    it('builds where with q using OR on name, code, description', async () => {
        const { ControlRepository } = await import('@/app-layer/repositories/ControlRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { control: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await ControlRepository.list(mockDb, ctx, { q: 'firewall' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.AND).toBeDefined();
        expect(where.AND[0].OR).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: { contains: 'firewall', mode: 'insensitive' } }),
                expect.objectContaining({ code: { contains: 'firewall', mode: 'insensitive' } }),
                expect.objectContaining({ description: { contains: 'firewall', mode: 'insensitive' } }),
            ])
        );
    });

    it('builds where with status filter', async () => {
        const { ControlRepository } = await import('@/app-layer/repositories/ControlRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { control: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await ControlRepository.list(mockDb, ctx, { status: 'IMPLEMENTED' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.status).toBe('IMPLEMENTED');
    });

    it('combines q + status + applicability', async () => {
        const { ControlRepository } = await import('@/app-layer/repositories/ControlRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { control: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await ControlRepository.list(mockDb, ctx, { q: 'access', status: 'IN_PROGRESS', applicability: 'APPLICABLE' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.status).toBe('IN_PROGRESS');
        expect(where.applicability).toBe('APPLICABLE');
        expect(where.AND[0].OR).toBeDefined();
    });

    it('enforces tenant boundary', async () => {
        const { ControlRepository } = await import('@/app-layer/repositories/ControlRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { control: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await ControlRepository.list(mockDb, ctx);

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([{ tenantId: 'tenant-1' }, { tenantId: null }]);
    });
});


describe('AssetRepository._buildWhere', () => {
    it('searches name + manufacturer + model + serialNumber + owner with q', async () => {
        const { AssetRepository } = await import('@/app-layer/repositories/AssetRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { asset: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await AssetRepository.list(mockDb, ctx, { q: 'deere' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.OR).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: { contains: 'deere', mode: 'insensitive' } }),
                expect.objectContaining({ manufacturer: { contains: 'deere', mode: 'insensitive' } }),
                expect.objectContaining({ model: { contains: 'deere', mode: 'insensitive' } }),
                expect.objectContaining({ serialNumber: { contains: 'deere', mode: 'insensitive' } }),
                expect.objectContaining({ owner: { contains: 'deere', mode: 'insensitive' } }),
            ])
        );
    });

    it('combines type + status + q', async () => {
        const { AssetRepository } = await import('@/app-layer/repositories/AssetRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { asset: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await AssetRepository.list(mockDb, ctx, { type: 'APPLICATION', status: 'ACTIVE', q: 'prod' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.type).toBe('APPLICATION');
        expect(where.status).toBe('ACTIVE');
        expect(where.OR).toBeDefined();
    });
});

describe('EvidenceRepository._buildWhere', () => {
    it('searches title + content + fileName with q', async () => {
        const { EvidenceRepository } = await import('@/app-layer/repositories/EvidenceRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { evidence: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await EvidenceRepository.list(mockDb, ctx, { q: 'audit-report' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.AND).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    OR: expect.arrayContaining([
                        expect.objectContaining({ title: { contains: 'audit-report', mode: 'insensitive' } }),
                    ]),
                }),
            ])
        );
    });

    it('filters by type', async () => {
        const { EvidenceRepository } = await import('@/app-layer/repositories/EvidenceRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { evidence: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await EvidenceRepository.list(mockDb, ctx, { type: ['FILE'] });

        const where = mockFindMany.mock.calls[0][0].where;
        // `{ in: [...] }`, not equality — the facet is multi-select, so the
        // URL carries a comma-joined list and the where-clause has to accept
        // more than one member. A scalar equality here is what made selecting
        // two types match nothing.
        expect(where.type).toEqual({ in: ['FILE'] });
    });

    it('filters by SEVERAL types at once', async () => {
        const { EvidenceRepository } = await import('@/app-layer/repositories/EvidenceRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { evidence: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await EvidenceRepository.list(mockDb, ctx, { type: ['FILE', 'LINK'] });

        expect(mockFindMany.mock.calls[0][0].where.type).toEqual({ in: ['FILE', 'LINK'] });
    });

    it('OMITS the filter for a cleared facet rather than emitting an empty IN', async () => {
        // `{ in: [] }` matches nothing, so clearing a filter would empty the
        // table — the opposite of what clearing a filter means.
        const { EvidenceRepository } = await import('@/app-layer/repositories/EvidenceRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { evidence: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await EvidenceRepository.list(mockDb, ctx, { type: [] });

        expect(mockFindMany.mock.calls[0][0].where.type).toBeUndefined();
    });

    it('filters by controlId', async () => {
        const { EvidenceRepository } = await import('@/app-layer/repositories/EvidenceRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { evidence: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await EvidenceRepository.list(mockDb, ctx, { controlId: 'ctrl-1' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.controlId).toBe('ctrl-1');
    });

    it('enforces tenant boundary', async () => {
        const { EvidenceRepository } = await import('@/app-layer/repositories/EvidenceRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { evidence: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await EvidenceRepository.list(mockDb, ctx);

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe('tenant-1');
    });
});

describe('WorkItemRepository._buildWhere', () => {
    it('searches title + key with q', async () => {
        const { WorkItemRepository } = await import('@/app-layer/repositories/WorkItemRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { task: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await WorkItemRepository.list(mockDb, ctx, { q: 'TSK-42' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.AND).toEqual([{
            OR: expect.arrayContaining([
                expect.objectContaining({ title: { contains: 'TSK-42', mode: 'insensitive' } }),
                expect.objectContaining({ key: { contains: 'TSK-42', mode: 'insensitive' } }),
            ]),
        }]);
    });

    it('filters by overdue due date', async () => {
        const { WorkItemRepository } = await import('@/app-layer/repositories/WorkItemRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { task: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await WorkItemRepository.list(mockDb, ctx, { due: 'overdue' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.dueAt).toBeDefined();
        expect(where.dueAt.lt).toBeInstanceOf(Date);
        expect(where.status).toEqual({ notIn: ['RESOLVED', 'CLOSED', 'CANCELED'] });
    });

    it('combines status + priority + assignee', async () => {
        const { WorkItemRepository } = await import('@/app-layer/repositories/WorkItemRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { task: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await WorkItemRepository.list(mockDb, ctx, { status: 'IN_PROGRESS', priority: 'P0', assigneeUserId: 'user-5' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.status).toBe('IN_PROGRESS');
        expect(where.priority).toBe('P0');
        expect(where.assigneeUserId).toBe('user-5');
    });

    it('preserves explicit status when combined with due filter', async () => {
        const { WorkItemRepository } = await import('@/app-layer/repositories/WorkItemRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { task: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await WorkItemRepository.list(mockDb, ctx, { status: 'OPEN', due: 'overdue' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.status).toBe('OPEN');
        expect(where.dueAt).toBeDefined();
        expect(where.dueAt.lt).toBeInstanceOf(Date);
    });

    it('combines status + due:next7d + search query', async () => {
        const { WorkItemRepository } = await import('@/app-layer/repositories/WorkItemRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { task: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await WorkItemRepository.list(mockDb, ctx, { status: 'IN_PROGRESS', due: 'next7d', q: 'urgent' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.status).toBe('IN_PROGRESS');
        expect(where.dueAt).toBeDefined();
        expect(where.AND).toEqual([{
            OR: expect.arrayContaining([
                expect.objectContaining({ title: { contains: 'urgent', mode: 'insensitive' } }),
            ]),
        }]);
    });
});

describe('VendorRepository._buildWhere', () => {
    it('searches name + legalName + domain with q', async () => {
        const { VendorRepository } = await import('@/app-layer/repositories/VendorRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { vendor: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await VendorRepository.list(mockDb, ctx, { q: 'aws' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.OR).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: { contains: 'aws', mode: 'insensitive' } }),
                expect.objectContaining({ legalName: { contains: 'aws', mode: 'insensitive' } }),
                expect.objectContaining({ domain: { contains: 'aws', mode: 'insensitive' } }),
            ])
        );
    });

    it('filters by reviewDue overdue', async () => {
        const { VendorRepository } = await import('@/app-layer/repositories/VendorRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { vendor: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await VendorRepository.list(mockDb, ctx, { reviewDue: 'overdue' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.nextReviewAt).toBeDefined();
        expect(where.nextReviewAt.lt).toBeInstanceOf(Date);
    });
});

describe('PolicyRepository._buildWhere', () => {
    it('searches title + description with q', async () => {
        const { PolicyRepository } = await import('@/app-layer/repositories/PolicyRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { policy: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await PolicyRepository.list(mockDb, ctx, { q: 'access' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.OR).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ title: { contains: 'access', mode: 'insensitive' } }),
                expect.objectContaining({ description: { contains: 'access', mode: 'insensitive' } }),
            ])
        );
    });

    it('combines status + q', async () => {
        const { PolicyRepository } = await import('@/app-layer/repositories/PolicyRepository');
        const mockFindMany = jest.fn().mockResolvedValue([]);
        const mockDb = { policy: { findMany: mockFindMany } } as unknown as PrismaTx;
        const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as RequestContext;

        await PolicyRepository.list(mockDb, ctx, { status: 'PUBLISHED', q: 'remote' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.status).toBe('PUBLISHED');
        expect(where.OR).toBeDefined();
    });
});

// ─── 9. Tenant isolation via where clause ───

