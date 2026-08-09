/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests: setPracticeApplicability usecase
 * Tests: permissions, audit log, justification enforcement, global practice protection
 */

const mockDb = {} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/PracticeRepository', () => ({
    PracticeRepository: {
        getById: jest.fn(),
        setApplicability: jest.fn(),
        list: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
}));


jest.mock('@/app-layer/repositories/FrameworkRepository', () => ({
    FrameworkRepository: { listFrameworks: jest.fn(), listRequirements: jest.fn() },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

import { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { PracticeRepository } from '@/app-layer/repositories/PracticeRepository';
import { logEvent } from '@/app-layer/events/audit';
import { setPracticeApplicability, listPractices } from '@/app-layer/usecases/practice';

const adminCtx: RequestContext = {
    requestId: 'req-test',
    userId: 'user-admin',
    tenantId: 'tenant-1',
    role: 'ADMIN' as any,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('ADMIN'),
};

const readerCtx: RequestContext = {
    requestId: 'req-test',
    userId: 'user-reader',
    tenantId: 'tenant-1',
    role: 'READER' as any,
    permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
    appPermissions: getPermissionsForRole('READER'),
};

describe('setPracticeApplicability', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('marks a practice as NOT_APPLICABLE with justification', async () => {
        const existing = { id: 'ctrl-1', tenantId: 'tenant-1', applicability: 'APPLICABLE', name: 'Test Practice' };
        const updated = { ...existing, applicability: 'NOT_APPLICABLE', applicabilityJustification: 'Cloud-only' };

        (PracticeRepository.getById as jest.Mock).mockResolvedValue(existing);
        (PracticeRepository.setApplicability as jest.Mock).mockResolvedValue(updated);

        const result = await setPracticeApplicability(adminCtx, 'ctrl-1', 'NOT_APPLICABLE', 'Cloud-only');

        expect(result.applicability).toBe('NOT_APPLICABLE');
        expect(PracticeRepository.setApplicability).toHaveBeenCalledWith(
            mockDb, adminCtx, 'ctrl-1', 'NOT_APPLICABLE', 'Cloud-only'
        );
    });

    it('marks a practice as APPLICABLE (re-applies)', async () => {
        const existing = { id: 'ctrl-1', tenantId: 'tenant-1', applicability: 'NOT_APPLICABLE', name: 'Test Practice' };
        const updated = { ...existing, applicability: 'APPLICABLE', applicabilityJustification: null };

        (PracticeRepository.getById as jest.Mock).mockResolvedValue(existing);
        (PracticeRepository.setApplicability as jest.Mock).mockResolvedValue(updated);

        const result = await setPracticeApplicability(adminCtx, 'ctrl-1', 'APPLICABLE', null);

        expect(result.applicability).toBe('APPLICABLE');
    });

    it('emits APPLICABILITY_CHANGED audit event with old→new values', async () => {
        const existing = { id: 'ctrl-1', tenantId: 'tenant-1', applicability: 'APPLICABLE', name: 'Test' };
        const updated = { ...existing, applicability: 'NOT_APPLICABLE' };

        (PracticeRepository.getById as jest.Mock).mockResolvedValue(existing);
        (PracticeRepository.setApplicability as jest.Mock).mockResolvedValue(updated);

        await setPracticeApplicability(adminCtx, 'ctrl-1', 'NOT_APPLICABLE', 'Reason');

        expect(logEvent).toHaveBeenCalledWith(mockDb, adminCtx, expect.objectContaining({
            action: 'CONTROL_APPLICABILITY_CHANGED',
            entityType: 'Practice',
            entityId: 'ctrl-1',
            metadata: expect.objectContaining({
                oldApplicability: 'APPLICABLE',
                newApplicability: 'NOT_APPLICABLE',
                justification: 'Reason',
            }),
        }));
    });

    it('throws forbidden when READER tries to set applicability', async () => {
        await expect(
            setPracticeApplicability(readerCtx, 'ctrl-1', 'NOT_APPLICABLE', 'Reason')
        ).rejects.toThrow(/permission/i);
    });

    it('throws notFound when practice does not exist', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue(null);

        await expect(
            setPracticeApplicability(adminCtx, 'nonexistent', 'NOT_APPLICABLE', 'Reason')
        ).rejects.toThrow(/not found/i);
    });

    it('throws forbidden for global library practice (tenantId=null)', async () => {
        const globalPractice = { id: 'ctrl-lib', tenantId: null, applicability: 'APPLICABLE', name: 'Library Practice' };
        (PracticeRepository.getById as jest.Mock).mockResolvedValue(globalPractice);

        await expect(
            setPracticeApplicability(adminCtx, 'ctrl-lib', 'NOT_APPLICABLE', 'Reason')
        ).rejects.toThrow(/global library/i);
    });
});

describe('listPractices with applicability filter', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('passes applicability filter to repository', async () => {
        (PracticeRepository.list as jest.Mock).mockResolvedValue([]);

        await listPractices(adminCtx, { applicability: 'NOT_APPLICABLE' });

        // Fourth arg is the SSR-cap options bag added in the
        // interim pagination work; default `{}` when no take is set.
        expect(PracticeRepository.list).toHaveBeenCalledWith(
            mockDb, adminCtx, { applicability: 'NOT_APPLICABLE' }, {}
        );
    });

    it('works without filter', async () => {
        (PracticeRepository.list as jest.Mock).mockResolvedValue([]);

        await listPractices(adminCtx);

        expect(PracticeRepository.list).toHaveBeenCalledWith(
            mockDb, adminCtx, undefined, {}
        );
    });
});
