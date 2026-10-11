/**
 * P5.9 — the suspension's post-commit effects are WIRED (#1600).
 *
 * ## Why a third test file for this
 *
 * Found by mutation proof, which is the only reason it exists. Deleting the
 * `afterCommit('suspension.invalidate-cache', …)` call from `suspendAccount`
 * reddened **nothing**:
 *
 *   - the integration suite has no `REDIS_URL`, so `getRedis()` is null there
 *     and the invalidation is a no-op whether or not it is called;
 *   - `suspension-cache.test.ts` proves the HELPER deletes the right key, and
 *     cannot see whether anybody calls it.
 *
 * That is the `a-seam-is-a-new-collector` shape: the two tests between them
 * covered both sides of a seam and neither covered the seam. A dropped
 * invalidation would have made the cache TTL the real revocation lag — the
 * exact thing this phase exists to remove, rebuilt with a smaller number — and
 * shipped green.
 *
 * So this asserts the CALLS, with everything underneath mocked.
 */
const invalidateSuspensionCache = jest.fn();
jest.mock('@/lib/auth/suspension', () => ({
    invalidateSuspensionCache: (...a: unknown[]) => invalidateSuspensionCache(...a),
    isAccountSuspended: jest.fn(),
}));

const appendPlatformAuditEntry = jest.fn();
jest.mock('@/lib/audit/platform-audit-writer', () => ({
    appendPlatformAuditEntry: (...a: unknown[]) => appendPlatformAuditEntry(...a),
    PLATFORM_AUDIT_SCOPES: ['feature-flags', 'key-rotation', 'moderation'],
}));

const userFindUnique = jest.fn();
const userUpdate = jest.fn();
const sessionUpdateMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        // No real transaction frame, so `afterCommit` fires inline — which is
        // what makes the effects observable here at all.
        $transaction: (fn: (tx: unknown) => unknown) =>
            fn({
                user: {
                    findUnique: (...a: unknown[]) => userFindUnique(...a),
                    update: (...a: unknown[]) => userUpdate(...a),
                },
                userSession: { updateMany: (...a: unknown[]) => sessionUpdateMany(...a) },
            }),
    },
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { suspendAccount, liftSuspension } from '@/app-layer/usecases/account-suspension';

beforeEach(() => {
    invalidateSuspensionCache.mockReset().mockResolvedValue(undefined);
    appendPlatformAuditEntry.mockReset().mockResolvedValue(undefined);
    userFindUnique.mockReset().mockResolvedValue({ id: 'u1', suspendedAt: null });
    userUpdate.mockReset().mockResolvedValue({});
    sessionUpdateMany.mockReset().mockResolvedValue({ count: 2 });
});

describe('suspending wires both post-commit effects', () => {
    it('invalidates the cached verdict', async () => {
        await suspendAccount({ userId: 'u1', generation: 'current' });

        // THE MUTATION TARGET. Without this assertion, dropping the
        // invalidation is green everywhere.
        expect(invalidateSuspensionCache).toHaveBeenCalledWith('u1');
    });

    it('appends to the moderation chain, naming the key generation', async () => {
        await suspendAccount({ userId: 'u1', generation: 'previous' });

        expect(appendPlatformAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({
                scope: 'moderation',
                action: 'ACCOUNT_SUSPENDED',
                // No person: the credential is a key. #1599 owns the model
                // that would make this a person.
                actorUserId: null,
                detailsJson: expect.objectContaining({
                    targetUserId: 'u1',
                    moderatorRef: 'platform-key:previous',
                }),
            }),
        );
    });

    it('records WHETHER there was a reason, never the reason itself', async () => {
        await suspendAccount({ userId: 'u1', generation: 'current', reason: 'repeat abuse' });

        const details = appendPlatformAuditEntry.mock.calls[0][0].detailsJson;
        expect(details.hasReason).toBe(true);
        // `detailsJson` is not an encrypted column; the rationale belongs on
        // `ModerationAction.rationale`, which is.
        expect(JSON.stringify(details)).not.toContain('repeat abuse');
    });

    it('does NEITHER when the account is already suspended', async () => {
        userFindUnique.mockResolvedValue({ id: 'u1', suspendedAt: new Date() });

        const result = await suspendAccount({ userId: 'u1', generation: 'current' });

        expect(result.alreadySuspended).toBe(true);
        // A second chain entry would make the history claim two suspensions.
        expect(appendPlatformAuditEntry).not.toHaveBeenCalled();
        expect(invalidateSuspensionCache).not.toHaveBeenCalled();
        expect(userUpdate).not.toHaveBeenCalled();
    });

    it('does NEITHER when the account does not exist', async () => {
        userFindUnique.mockResolvedValue(null);

        const result = await suspendAccount({ userId: 'nope', generation: 'current' });

        expect(result.applied).toBe(false);
        expect(appendPlatformAuditEntry).not.toHaveBeenCalled();
        expect(invalidateSuspensionCache).not.toHaveBeenCalled();
    });

    it('a chain-append failure does not undo the suspension', async () => {
        // Best-effort, per the #1619 ruling for this scope: the suspension has
        // already taken effect in the database, so a bookkeeping failure must
        // not propagate.
        appendPlatformAuditEntry.mockRejectedValue(new Error('chain locked'));

        await expect(suspendAccount({ userId: 'u1', generation: 'current' }))
            .resolves.toMatchObject({ applied: true });
    });

    it('bumps sessionVersion AND stamps suspendedAt in one update', async () => {
        await suspendAccount({ userId: 'u1', generation: 'current' });

        const data = userUpdate.mock.calls[0][0].data;
        expect(data.suspendedAt).toBeInstanceOf(Date);
        // The slow path kept as a backstop: if the per-request check were ever
        // bypassed, the throttled sessionVersion check still ends the session.
        expect(data.sessionVersion).toEqual({ increment: 1 });
    });

    it('revokes only the LIVE session rows', async () => {
        await suspendAccount({ userId: 'u1', generation: 'current' });

        expect(sessionUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: 'u1', revokedAt: null },
            }),
        );
    });
});

describe('lifting wires them too', () => {
    beforeEach(() => {
        userFindUnique.mockResolvedValue({ id: 'u1', suspendedAt: new Date() });
    });

    it('invalidates the cached verdict, so access returns immediately', async () => {
        await liftSuspension({ userId: 'u1', generation: 'current' });

        // An appeal upheld is exactly the moment a stale '1' must not hold
        // someone out for the remaining TTL.
        expect(invalidateSuspensionCache).toHaveBeenCalledWith('u1');
    });

    it('appends the LIFTED verb, so the history is not all suspensions', async () => {
        await liftSuspension({ userId: 'u1', generation: 'current' });

        expect(appendPlatformAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'ACCOUNT_SUSPENSION_LIFTED' }),
        );
    });

    it('clears suspendedAt and does NOT decrement sessionVersion', async () => {
        await liftSuspension({ userId: 'u1', generation: 'current' });

        const data = userUpdate.mock.calls[0][0].data;
        expect(data.suspendedAt).toBeNull();
        // One-way: reinstatement restores the ability to sign in, not the
        // sessions that existed before — un-revoking one would resurrect a
        // credential that may since have been shared or captured.
        expect(data).not.toHaveProperty('sessionVersion');
    });

    it('does nothing when the account was not suspended', async () => {
        userFindUnique.mockResolvedValue({ id: 'u1', suspendedAt: null });

        const result = await liftSuspension({ userId: 'u1', generation: 'current' });

        expect(result.wasSuspended).toBe(false);
        expect(appendPlatformAuditEntry).not.toHaveBeenCalled();
    });
});
