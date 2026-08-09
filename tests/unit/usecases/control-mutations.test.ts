/**
 * Unit tests for src/app-layer/usecases/control/mutations.ts
 *
 * Wave 4 of GAP-02. Controls are the core compliance primitive.
 * The single load-bearing invariant: tenant-scoped controls live in
 * the same table as the global library (`tenantId IS NULL`), so every
 * mutation MUST refuse to touch a row whose `tenantId` is null. A
 * regression here is a global-library mutation by an end-user — every
 * other tenant inherits the change.
 *
 * Behaviours protected:
 *   1. assertCanCreateControl / assertCanUpdateControl /
 *      assertCanSetApplicability gates.
 *   2. assertCanAdmin gate on deleteControl (separate from canWrite).
 *   3. updateControl / setControlStatus / setControlApplicability /
 *      markControlTestCompleted / deleteControl all REFUSE to act on
 *      a row with `tenantId === null` — even if the caller's tenant
 *      can otherwise see the row.
 *   4. setControlApplicability: NOT_APPLICABLE requires a justification.
 *   5. setControlOwner: validates user exists before linking
 *      (prevents dangling FK + a confusing UI null-state).
 *   6. markControlTestCompleted: rejects when applicability is
 *      NOT_APPLICABLE.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/ControlRepository', () => ({
    ControlRepository: {
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        setApplicability: jest.fn(),
        setOwner: jest.fn(),
    },
}));

jest.mock('@/app-layer/usecases/soft-delete-operations', () => ({
    restoreEntity: jest.fn(),
    purgeEntity: jest.fn(),
}));

jest.mock('@/app-layer/utils/cadence', () => ({
    computeNextDueAt: jest.fn(() => new Date('2026-12-31T00:00:00Z')),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createControl,
    updateControl,
    setControlStatus,
    setControlApplicability,
    setControlOwner,
    markControlTestCompleted,
    deleteControl,
} from '@/app-layer/usecases/control/mutations';
import { runInTenantContext } from '@/lib/db-context';
import { ControlRepository } from '@/app-layer/repositories/ControlRepository';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockGetById = ControlRepository.getById as jest.MockedFunction<typeof ControlRepository.getById>;
const mockCreate = ControlRepository.create as jest.MockedFunction<typeof ControlRepository.create>;
const mockUpdate = ControlRepository.update as jest.MockedFunction<typeof ControlRepository.update>;
const mockSetApplicability = ControlRepository.setApplicability as jest.MockedFunction<typeof ControlRepository.setApplicability>;
const mockSetOwner = ControlRepository.setOwner as jest.MockedFunction<typeof ControlRepository.setOwner>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({ id: 'c1', code: 'CTRL-1', name: 'X' } as never);
    mockUpdate.mockResolvedValue({ id: 'c1' } as never);
});

describe('createControl', () => {
    it('rejects READER (canCreateControl gate)', async () => {
        await expect(
            createControl(makeRequestContext('READER'), { name: 'X' }),
        ).rejects.toThrow();
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('emits CONTROL_CREATED audit', async () => {
        // The custom-control mint path calls
        // `db.controlKeySequence.upsert` to allocate `CTL-N` before
        // the repository write — stub it on the in-test db handle
        // so the usecase resolves to the CONTROL_CREATED audit.
        const db = {
            controlKeySequence: {
                upsert: jest.fn().mockResolvedValue({ lastValue: 1 }),
            },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await createControl(makeRequestContext('EDITOR'), { name: 'X' });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'CONTROL_CREATED' }),
        );
    });

    it('mints CTL-N via controlKeySequence.upsert when isCustom AND no code', async () => {
        const upsertMock = jest.fn().mockResolvedValue({ lastValue: 42 });
        const db = { controlKeySequence: { upsert: upsertMock } };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await createControl(makeRequestContext('EDITOR'), { name: 'X' });

        // Counter advanced exactly once.
        expect(upsertMock).toHaveBeenCalledTimes(1);
        // Repository got the minted code, not null.
        expect(mockCreate).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ code: 'CTL-42', isCustom: true }),
        );
    });

    it('bypasses the counter when a code IS supplied', async () => {
        const upsertMock = jest.fn();
        const db = { controlKeySequence: { upsert: upsertMock } };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await createControl(makeRequestContext('EDITOR'), {
            name: 'X',
            code: 'EXTERNAL-CODE',
        });

        // Caller-supplied code wins — counter NOT advanced.
        expect(upsertMock).not.toHaveBeenCalled();
        expect(mockCreate).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ code: 'EXTERNAL-CODE' }),
        );
    });

    it('bypasses the counter when isCustom is false (framework install)', async () => {
        const upsertMock = jest.fn();
        const db = { controlKeySequence: { upsert: upsertMock } };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await createControl(makeRequestContext('EDITOR'), {
            name: 'X',
            isCustom: false,
        });

        // Framework-installed controls never mint — their code /
        // the code comes from the catalogue.
        expect(upsertMock).not.toHaveBeenCalled();
    });
});

describe('updateControl — global-library guard', () => {
    it('throws forbidden when the row exists but belongs to the global library (tenantId === null)', async () => {
        // Repository returns null on update because the where filter
        // excluded global rows; the usecase then re-checks via getById
        // and throws forbidden.
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockUpdate.mockResolvedValueOnce(null as never);
        mockGetById.mockResolvedValueOnce({ id: 'c1', tenantId: null } as never);

        await expect(
            updateControl(makeRequestContext('EDITOR'), 'c1', { name: 'New' }),
        ).rejects.toThrow(/global library controls/);
        // Regression: a refactor that dropped this check would let any
        // EDITOR rename a global library control — every other tenant
        // would see the rename downstream.
    });

    it('throws notFound when the row does not exist anywhere', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockUpdate.mockResolvedValueOnce(null as never);
        mockGetById.mockResolvedValueOnce(null as never);

        await expect(
            updateControl(makeRequestContext('EDITOR'), 'missing', { name: 'X' }),
        ).rejects.toThrow(/Control not found/);
    });
});

describe('setControlStatus — global-library guard', () => {
    it('throws forbidden when the control is in the global library', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValueOnce({
            id: 'c1', tenantId: null, status: 'NOT_STARTED',
        } as never);

        await expect(
            setControlStatus(makeRequestContext('EDITOR'), 'c1', 'IN_PROGRESS'),
        ).rejects.toThrow(/global library/);
    });
});

describe('setControlApplicability', () => {
    it('rejects NOT_APPLICABLE without a justification', async () => {
        await expect(
            setControlApplicability(
                makeRequestContext('ADMIN'),
                'c1',
                'NOT_APPLICABLE',
                null,
            ),
        ).rejects.toThrow(/Justification is required/);
        // Regression: skipping this gate hides the audit-readiness
        // signal that explains WHY a control is not in scope. The
        // external auditor's first question is "show me the
        // justification" — without it, the control gets re-flagged.
    });

    it('throws forbidden when targeting a global-library control', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValueOnce({
            id: 'c1', tenantId: null,
        } as never);

        await expect(
            setControlApplicability(
                makeRequestContext('ADMIN'),
                'c1',
                'APPLICABLE',
                null,
            ),
        ).rejects.toThrow(/global library/);
    });

    it('emits CONTROL_APPLICABILITY_CHANGED audit on success', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValueOnce({
            id: 'c1', tenantId: 'tenant-1', applicability: 'APPLICABLE',
        } as never);
        mockSetApplicability.mockResolvedValueOnce({ id: 'c1' } as never);

        await setControlApplicability(
            makeRequestContext('ADMIN'),
            'c1',
            'NOT_APPLICABLE',
            'Outside scope per scope statement',
        );

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'CONTROL_APPLICABILITY_CHANGED' }),
        );
    });
});

describe('setControlOwner — user existence validation', () => {
    it('rejects when the ownerUserId does not exist in the User table', async () => {
        const queryRawUnsafe = jest.fn().mockResolvedValueOnce([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ $queryRawUnsafe: queryRawUnsafe } as never),
        );

        await expect(
            setControlOwner(
                makeRequestContext('EDITOR'),
                'c1',
                'no-such-user',
            ),
        ).rejects.toThrow(/not found/);
        expect(mockSetOwner).not.toHaveBeenCalled();
        // Regression: a refactor that skipped the existence check
        // would either dangle the FK (DB-level constraint failure
        // surfaces deep in the call) OR persist a stale id that the
        // UI renders as "Unknown owner".
    });

    it('allows clearing the owner (ownerUserId === null) without User lookup', async () => {
        const queryRawUnsafe = jest.fn();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ $queryRawUnsafe: queryRawUnsafe } as never),
        );
        mockSetOwner.mockResolvedValueOnce({ id: 'c1' } as never);

        await setControlOwner(makeRequestContext('EDITOR'), 'c1', null);

        // The User-lookup query is gated on `ownerUserId` truthiness —
        // null clears MUST not run the query.
        expect(queryRawUnsafe).not.toHaveBeenCalled();
    });
});

describe('markControlTestCompleted', () => {
    it('rejects when the control is NOT_APPLICABLE', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValueOnce({
            id: 'c1',
            tenantId: 'tenant-1',
            applicability: 'NOT_APPLICABLE',
            frequency: 'MONTHLY',
        } as never);

        await expect(
            markControlTestCompleted(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow(/NOT_APPLICABLE/);
        // Regression: marking NOT_APPLICABLE controls "tested" would
        // re-introduce them into the audit-readiness scoring (they
        // would have a recent lastTested) — defeating the whole point
        // of marking them out-of-scope.
    });

    it('throws forbidden on global-library controls', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValueOnce({
            id: 'c1',
            tenantId: null,
            applicability: 'APPLICABLE',
            frequency: 'MONTHLY',
        } as never);

        await expect(
            markControlTestCompleted(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow(/global library/);
    });
});

describe('deleteControl', () => {
    it('rejects EDITOR — delete requires canAdmin (separate from canWrite)', async () => {
        await expect(
            deleteControl(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow();
    });

    it('throws forbidden on global-library controls', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ control: { delete: jest.fn() } } as never),
        );
        mockGetById.mockResolvedValueOnce({
            id: 'c1', tenantId: null,
        } as never);

        await expect(
            deleteControl(makeRequestContext('ADMIN'), 'c1'),
        ).rejects.toThrow(/global library/);
    });

    it('emits SOFT_DELETE audit on success', async () => {
        const deleteSpy = jest.fn();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ control: { delete: deleteSpy } } as never),
        );
        mockGetById.mockResolvedValueOnce({
            id: 'c1', tenantId: 'tenant-1', code: 'CTRL', name: 'X',
        } as never);

        await deleteControl(makeRequestContext('ADMIN'), 'c1');

        expect(deleteSpy).toHaveBeenCalled();
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'SOFT_DELETE' }),
        );
    });
});
