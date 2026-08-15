/**
 * Unit tests for src/app-layer/usecases/evidence.ts
 *
 * Wave 2 of GAP-02. Existing tests cover plumbing; this file locks
 * in the security-load-bearing review-flow assertions:
 *
 *   1. reviewEvidence step gates: SUBMITTED requires canWrite,
 *      APPROVED / REJECTED require canAdmin (separation of duty).
 *      An unknown action errors out — no silent transition.
 *   2. STATUS_CHANGE audit fired with correct from/to status.
 *   3. Notification created for the evidence owner on APPROVED /
 *      REJECTED, NOT on SUBMITTED.
 *
 * The cross-tenant practice-id rejection that used to head this list
 * went with the GRC teardown: `createEvidence` no longer accepts a
 * `practiceId`, so there is no cross-tenant practice link to reject.
 * The equivalent guarantee for the surviving attachment columns
 * (assetId / taskId / sourceLogEntryId) is the download provenance
 * gate, covered in tests/unit/security/evidence-download-gate.test.ts.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        create: jest.fn(),
        getById: jest.fn(),
        update: jest.fn(),
        addReview: jest.fn(),
    },
}));

jest.mock('@/lib/storage', () => ({
    uploadFile: jest.fn(),
    validateFile: jest.fn(),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createEvidence,
    reviewEvidence,
} from '@/app-layer/usecases/evidence';
import { runInTenantContext } from '@/lib/db-context';
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockCreate = EvidenceRepository.create as jest.MockedFunction<typeof EvidenceRepository.create>;
const mockGetById = EvidenceRepository.getById as jest.MockedFunction<typeof EvidenceRepository.getById>;
const mockUpdate = EvidenceRepository.update as jest.MockedFunction<typeof EvidenceRepository.update>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('createEvidence — write gates', () => {
    it('rejects READER on create (canWrite gate)', async () => {
        await expect(
            createEvidence(makeRequestContext('READER'), {
                type: 'LINK',
                title: 'x',
            }),
        ).rejects.toThrow();
    });

    it('persists status=DRAFT by default', async () => {
        const fakeDb = {};
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));
        mockCreate.mockResolvedValue({ id: 'e1', fileRecordId: null } as never);

        await createEvidence(makeRequestContext('EDITOR'), {
            type: 'LINK',
            title: 'doc',
        });
        const repoArgs = mockCreate.mock.calls[0][2];
        expect(repoArgs.status).toBe('DRAFT');
    });
});

describe('reviewEvidence — separation of duty', () => {
    const evidenceRow = {
        id: 'e1', title: 'doc', status: 'DRAFT',
        owner: null, ownerUserId: null,
    };

    function setupDbWithEvidence() {
        const fakeDb = {
            user: { findUnique: jest.fn(), findFirst: jest.fn() },
            notification: { create: jest.fn() },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));
        mockGetById.mockResolvedValue(evidenceRow as never);
        return fakeDb;
    }

    it('SUBMITTED: EDITOR can submit (canWrite), READER cannot', async () => {
        setupDbWithEvidence();
        await reviewEvidence(makeRequestContext('EDITOR'), 'e1', {
            action: 'SUBMITTED',
            comment: null,
        });
        expect(mockUpdate).toHaveBeenCalled();

        await expect(
            reviewEvidence(makeRequestContext('READER'), 'e1', {
                action: 'SUBMITTED',
                comment: null,
            }),
        ).rejects.toThrow();
    });

    it('APPROVED requires canAdmin — EDITOR cannot approve their own submission', async () => {
        await expect(
            reviewEvidence(makeRequestContext('EDITOR'), 'e1', {
                action: 'APPROVED',
                comment: null,
            }),
        ).rejects.toThrow();
        // Regression: separation-of-duty gate — the user who CAN
        // submit must NOT be able to approve. A bug that collapses
        // both gates to canWrite would let any EDITOR self-approve.
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('REJECTED also requires canAdmin', async () => {
        await expect(
            reviewEvidence(makeRequestContext('EDITOR'), 'e1', {
                action: 'REJECTED',
                comment: 'no',
            }),
        ).rejects.toThrow();
    });

    it('ADMIN can APPROVE — emits STATUS_CHANGE audit with correct transition', async () => {
        // Audit S3 (2026-05-22) — DRAFT → APPROVED is now illegal
        // per the explicit state machine. Reviewers can only APPROVE
        // a row that's already SUBMITTED. Fixture overridden for
        // this case; the default `evidenceRow` (DRAFT) test the
        // SUBMITTED flow below.
        const fakeDb = {
            user: { findUnique: jest.fn(), findFirst: jest.fn() },
            notification: { create: jest.fn() },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));
        mockGetById.mockResolvedValue({
            ...evidenceRow,
            status: 'SUBMITTED',
        } as never);

        await reviewEvidence(makeRequestContext('ADMIN'), 'e1', {
            action: 'APPROVED',
            comment: 'looks good',
        });

        expect(mockUpdate).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'e1',
            { status: 'APPROVED' },
        );
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'STATUS_CHANGE',
                entityType: 'Evidence',
                entityId: 'e1',
                detailsJson: expect.objectContaining({
                    fromStatus: 'SUBMITTED',
                    toStatus: 'APPROVED',
                }),
            }),
        );
    });

    it('rejects unknown actions — no silent state transition', async () => {
        await expect(
            reviewEvidence(makeRequestContext('ADMIN'), 'e1', {
                action: 'WHAT_IS_THIS',
                comment: null,
            }),
        ).rejects.toThrow(/Invalid review action/);
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('throws notFound for cross-tenant evidence id', async () => {
        const fakeDb = { user: { findUnique: jest.fn() }, notification: { create: jest.fn() } };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));
        mockGetById.mockResolvedValue(null);
        await expect(
            reviewEvidence(makeRequestContext('ADMIN'), 'cross-tenant-id', {
                action: 'APPROVED',
                comment: null,
            }),
        ).rejects.toThrow(/not found/);
    });

    it('does NOT create a notification on SUBMITTED (only APPROVED / REJECTED)', async () => {
        const fakeDb = setupDbWithEvidence();
        await reviewEvidence(makeRequestContext('EDITOR'), 'e1', {
            action: 'SUBMITTED',
            comment: null,
        });
        expect(fakeDb.notification.create).not.toHaveBeenCalled();
    });
});
