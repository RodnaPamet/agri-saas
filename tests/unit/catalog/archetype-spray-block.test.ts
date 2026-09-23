/**
 * A spray may not be FILED against a seeded archetype (#1078).
 *
 * `scripts/import-products.ts` seeds ~22 generic illustrative products per
 * tenant — deliberately, because shipping a real proprietary label database
 * is a licensing problem — and the design has always been that an operator
 * replaces them. Nothing enforced that, so every spray this product has ever
 * filed inherited a placeholder: on production, 22 of 24 catalogue rows are
 * archetypes and the ДНЕВНИК prints their names into the column headed
 * «Употребено средство за РЗ /търговско наименование/».
 *
 * Two properties carry the weight, and both are about WHEN the refusal fires:
 *
 *  • **Completion, not planning.** An operator mid-season can still build a
 *    plan against a placeholder. Completion is the moment the row becomes
 *    evidence, so it is the moment the product has to be real.
 *
 *  • **Only on the way IN.** Reverting a line to PENDING must stay possible
 *    whatever its product is — a line filed before this guard existed could
 *    otherwise never be corrected, which would make the guard a trap for
 *    exactly the data it exists to clean up.
 */
const mockDb = {
    operationParcel: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn(), count: jest.fn() },
    task: { findFirst: jest.fn(), update: jest.fn() },
    // Touched after the status flip — the cert snapshot and the
    // already-applied check. Mocked so the ALLOWED paths reach the end
    // rather than dying past the assertion under test.
    tenantMembership: { findUnique: jest.fn() },
    logEntry: { findUnique: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));
jest.mock('../../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(), assertCanWrite: jest.fn(), assertCanAdmin: jest.fn(),
}));
jest.mock('../../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('../../../src/app-layer/usecases/inventory', () => ({
    // The stock/journal side effect of completing a spray. Not under test
    // here, and letting it run would exercise inventory against a mock db.
    recordInputApplication: jest.fn(async () => ({ journalEntryId: null })),
}));
jest.mock('../../../src/app-layer/automation', () => ({ emitAutomationEvent: jest.fn() }));
jest.mock('@/lib/observability', () => ({
    traceAgUsecase: (_n: string, _c: unknown, fn: () => unknown) => fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { markOperationParcel } from '@/app-layer/usecases/field-operation';
import { makeRequestContext } from '../../helpers/make-context';

const CTX = makeRequestContext('EDITOR', { userId: 'u1' });

function line(product: { name: string; isArchetype: boolean } | null, status = 'PENDING') {
    return {
        id: 'line-1', taskId: 'task-1', tenantId: CTX.tenantId, status, version: 0,
        task: { id: 'task-1', assigneeUserId: 'u1', status: 'IN_PROGRESS', key: 'FO-1', applicationTechnique: null },
        product,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.operationParcel.updateMany.mockResolvedValue({ count: 1 });
    mockDb.operationParcel.update.mockResolvedValue({ id: 'line-1', status: 'DONE' });
    // Remaining-lines roll-up that decides whether the parent task closes.
    mockDb.operationParcel.count.mockResolvedValue(1);
    mockDb.task.findFirst.mockResolvedValue({ id: 'task-1', status: 'IN_PROGRESS' });
    mockDb.tenantMembership.findUnique.mockResolvedValue(null);
    mockDb.logEntry.findUnique.mockResolvedValue(null);
});

describe('completing a spray line', () => {
    it('is REFUSED when the product is a seeded archetype', async () => {
        mockDb.operationParcel.findFirst.mockResolvedValue(
            line({ name: 'Generic Chlorothalonil 720 SC', isArchetype: true }),
        );
        await expect(markOperationParcel(CTX, 'task-1', 'line-1', 'DONE')).rejects.toThrow(
            /sample product/i,
        );
        expect(mockDb.operationParcel.updateMany).not.toHaveBeenCalled();
    });

    it('names the product, so the operator knows which one to replace', async () => {
        mockDb.operationParcel.findFirst.mockResolvedValue(
            line({ name: 'Generic MAP 11-52-0', isArchetype: true }),
        );
        await expect(markOperationParcel(CTX, 'task-1', 'line-1', 'DONE')).rejects.toThrow(
            /Generic MAP 11-52-0/,
        );
    });

    it('is ALLOWED when the product is a real one', async () => {
        mockDb.operationParcel.findFirst.mockResolvedValue(
            line({ name: 'Karate Zeon 5 CS', isArchetype: false }),
        );
        await expect(markOperationParcel(CTX, 'task-1', 'line-1', 'DONE')).resolves.toBeDefined();
    });

    it('is ALLOWED when the line carries no product at all', async () => {
        // A fertiliser line, or one recorded without an input. Absent is not
        // an archetype, and treating it as one would block ordinary work.
        mockDb.operationParcel.findFirst.mockResolvedValue(line(null));
        await expect(markOperationParcel(CTX, 'task-1', 'line-1', 'DONE')).resolves.toBeDefined();
    });
});

describe('reverting a line', () => {
    it('is ALLOWED even on an archetype — the guard is one-way', async () => {
        // The rows this guard exists to clean up were filed BEFORE it existed.
        // If reverting were blocked too, they could never be corrected and the
        // guard would trap exactly the data it is meant to fix.
        mockDb.operationParcel.findFirst.mockResolvedValue(
            line({ name: 'Generic Bt kurstaki', isArchetype: true }, 'DONE'),
        );
        await expect(
            markOperationParcel(CTX, 'task-1', 'line-1', 'PENDING'),
        ).resolves.toBeDefined();
    });
});
