/**
 * Audit Coherence S7 (2026-05-24) — unit tests for `revokeDecision`.
 *
 * `revokeDecision` lets a reviewer (or admin acting on their behalf)
 * reset a submitted CONFIRM / REVOKE / MODIFY verdict back to
 * pending. The audit row preserves the prior verdict + the
 * required reason field for SOC 2 evidence.
 *
 * The usecase orchestrates AccessReviewRepository + logEvent inside
 * a tenant context. We mock both seams so the tests focus on the
 * gate logic + the audit detailsJson shape.
 */

const logEventMock = jest.fn().mockResolvedValue(undefined);
const runInTenantContextMock = jest.fn(
    async (
        _ctx: unknown,
        cb: (db: unknown) => Promise<unknown>,
    ) => cb({}),
);

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: runInTenantContextMock,
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: logEventMock,
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string) => `SANITISED(${s})`,
}));

const getDecisionMock = jest.fn();
const resetDecisionMock = jest.fn();
jest.mock('@/app-layer/repositories/AccessReviewRepository', () => ({
    AccessReviewRepository: {
        getDecision: (...a: unknown[]) => getDecisionMock(...a),
        resetDecision: (...a: unknown[]) => resetDecisionMock(...a),
    },
}));

import { revokeDecision } from '@/app-layer/usecases/access-review';
import { makeRequestContext } from '../../helpers/make-context';

describe('revokeDecision (Audit Coherence S7)', () => {
    beforeEach(() => {
        logEventMock.mockClear();
        runInTenantContextMock.mockClear();
        getDecisionMock.mockReset();
        resetDecisionMock.mockReset();
    });

    function fixture(overrides: Partial<{
        decision: 'CONFIRM' | 'REVOKE' | 'MODIFY' | null;
        executedAt: Date | null;
        reviewStatus: 'OPEN' | 'IN_REVIEW' | 'CLOSED';
        reviewDeleted: boolean;
        reviewerUserId: string;
    }> = {}) {
        // `decision: null` is a meaningful test input — use the
        // `in` check rather than ?? so null doesn't fall back to
        // the default.
        const decision = 'decision' in overrides ? overrides.decision : 'CONFIRM';
        return {
            id: 'dec-1',
            tenantId: 'tenant-1',
            subjectUserId: 'sub-9',
            decision,
            executedAt: overrides.executedAt ?? null,
            accessReview: {
                id: 'rv-1',
                tenantId: 'tenant-1',
                status: overrides.reviewStatus ?? 'IN_REVIEW',
                reviewerUserId: overrides.reviewerUserId ?? 'user-1',
                deletedAt: overrides.reviewDeleted ? new Date() : null,
            },
        };
    }

    it('happy path: reviewer revokes their own CONFIRM verdict', async () => {
        getDecisionMock.mockResolvedValueOnce(fixture({ decision: 'CONFIRM' }));
        resetDecisionMock.mockResolvedValueOnce(1);

        const ctx = makeRequestContext('EDITOR', {
            userId: 'user-1', // matches reviewerUserId
        });
        const r = await revokeDecision(ctx, 'dec-1', {
            reason: 'wrong subject; meant to revoke',
        });

        expect(r).toEqual({ decisionId: 'dec-1', accessReviewId: 'rv-1' });
        expect(resetDecisionMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: 'user-1' }),
            'dec-1',
        );
        expect(logEventMock).toHaveBeenCalledTimes(1);
        const [, , audit] = logEventMock.mock.calls[0];
        expect(audit.action).toBe('ACCESS_REVIEW_DECISION_REVOKED');
        expect(audit.detailsJson.category).toBe('access');
        expect(audit.detailsJson.before.decision).toBe('CONFIRM');
        expect(audit.detailsJson.after.decision).toBeNull();
        expect(audit.detailsJson.reason).toBe(
            'SANITISED(wrong subject; meant to revoke)',
        );
        expect(audit.detailsJson.actorIsAssignedReviewer).toBe(true);
    });

    it('admin can revoke on behalf of the reviewer', async () => {
        getDecisionMock.mockResolvedValueOnce(
            fixture({ decision: 'REVOKE', reviewerUserId: 'user-99' }),
        );
        resetDecisionMock.mockResolvedValueOnce(1);

        const ctx = makeRequestContext('ADMIN', { userId: 'admin-7' });
        const r = await revokeDecision(ctx, 'dec-1', {
            reason: 'reviewer on vacation; correcting',
        });

        expect(r.decisionId).toBe('dec-1');
        const [, , audit] = logEventMock.mock.calls[0];
        expect(audit.detailsJson.actorIsAssignedReviewer).toBe(false);
    });

    it('rejects when the campaign is CLOSED', async () => {
        getDecisionMock.mockResolvedValueOnce(
            fixture({ decision: 'CONFIRM', reviewStatus: 'CLOSED' }),
        );

        const ctx = makeRequestContext('ADMIN', { userId: 'admin-7' });
        await expect(
            revokeDecision(ctx, 'dec-1', { reason: 'noop' }),
        ).rejects.toMatchObject({ code: 'ACCESS_REVIEW_DECISIONS_IMMUTABLE' });
        expect(resetDecisionMock).not.toHaveBeenCalled();
        expect(logEventMock).not.toHaveBeenCalled();
    });

    it('rejects when the access review row is soft-deleted', async () => {
        getDecisionMock.mockResolvedValueOnce(
            fixture({ decision: 'CONFIRM', reviewDeleted: true }),
        );

        const ctx = makeRequestContext('ADMIN', { userId: 'admin-7' });
        await expect(
            revokeDecision(ctx, 'dec-1', { reason: 'noop' }),
        ).rejects.toMatchObject({ code: 'ACCESS_REVIEW_NOT_FOUND' });
    });

    it('rejects when the decision was never submitted', async () => {
        getDecisionMock.mockResolvedValueOnce(fixture({ decision: null }));

        const ctx = makeRequestContext('ADMIN', { userId: 'admin-7' });
        await expect(
            revokeDecision(ctx, 'dec-1', { reason: 'noop' }),
        ).rejects.toMatchObject({ code: 'ACCESS_REVIEW_DECISION_NOT_RECORDED' });
        expect(resetDecisionMock).not.toHaveBeenCalled();
    });

    it('rejects when the decision was already executed', async () => {
        getDecisionMock.mockResolvedValueOnce(
            fixture({ decision: 'REVOKE', executedAt: new Date() }),
        );

        const ctx = makeRequestContext('ADMIN', { userId: 'admin-7' });
        await expect(
            revokeDecision(ctx, 'dec-1', { reason: 'too late' }),
        ).rejects.toMatchObject({ code: 'ACCESS_REVIEW_DECISION_ALREADY_EXECUTED' });
        expect(resetDecisionMock).not.toHaveBeenCalled();
    });

    it('rejects when caller is not the reviewer or an admin', async () => {
        getDecisionMock.mockResolvedValueOnce(
            fixture({ decision: 'CONFIRM', reviewerUserId: 'user-99' }),
        );

        const ctx = makeRequestContext('EDITOR', { userId: 'user-1' });
        await expect(
            revokeDecision(ctx, 'dec-1', { reason: 'noop' }),
        ).rejects.toMatchObject({ code: 'ACCESS_REVIEW_NOT_ASSIGNED_REVIEWER' });
        expect(resetDecisionMock).not.toHaveBeenCalled();
    });

    it('rejects when the decision row does not exist', async () => {
        getDecisionMock.mockResolvedValueOnce(null);

        const ctx = makeRequestContext('ADMIN', { userId: 'admin-7' });
        await expect(
            revokeDecision(ctx, 'dec-1', { reason: 'noop' }),
        ).rejects.toMatchObject({ code: 'ACCESS_REVIEW_DECISION_NOT_FOUND' });
    });

    it('surfaces a notFound when the row was concurrently executed', async () => {
        // Repository gate (executedAt: null) loses the race — count === 0.
        getDecisionMock.mockResolvedValueOnce(fixture({ decision: 'CONFIRM' }));
        resetDecisionMock.mockResolvedValueOnce(0);

        const ctx = makeRequestContext('ADMIN', { userId: 'admin-7' });
        await expect(
            revokeDecision(ctx, 'dec-1', { reason: 'concurrent close' }),
        ).rejects.toMatchObject({ code: 'ACCESS_REVIEW_DECISION_NOT_FOUND' });
        // No audit row written when the reset never landed.
        expect(logEventMock).not.toHaveBeenCalled();
    });

    it('requires a reason of length >= 3', async () => {
        const ctx = makeRequestContext('ADMIN', { userId: 'admin-7' });
        await expect(
            revokeDecision(ctx, 'dec-1', { reason: 'no' }),
        ).rejects.toThrow();
        expect(getDecisionMock).not.toHaveBeenCalled();
    });
});
