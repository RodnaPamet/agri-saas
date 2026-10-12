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

// #1667 — lifting a suspension stops a MODERATION erasure, so the erasure
// verdict's own cache has to be dropped as well. Mocked here because this file
// is about which post-commit effects are CALLED.
const invalidateDeletionPendingCache = jest.fn();
jest.mock('@/lib/auth/deletion-pending', () => ({
    ...jest.requireActual('@/lib/auth/deletion-pending'),
    invalidateDeletionPendingCache: (...a: unknown[]) =>
        invalidateDeletionPendingCache(...a),
}));

const appendPlatformAuditEntry = jest.fn();
jest.mock('@/lib/audit/platform-audit-writer', () => ({
    appendPlatformAuditEntry: (...a: unknown[]) => appendPlatformAuditEntry(...a),
    PLATFORM_AUDIT_SCOPES: ['feature-flags', 'key-rotation', 'moderation'],
}));

const userFindUnique = jest.fn();
const userUpdate = jest.fn();
const sessionUpdateMany = jest.fn();
// #1667 — a direct suspension now records the DECISION, so the transaction
// reaches one more delegate. Without it every test in this file failed on a
// missing `moderationAction`, which is the ordinary cost of a new write and
// cheaper than discovering it in CI.
const moderationActionCreate = jest.fn();
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
                moderationAction: {
                    create: (...a: unknown[]) => moderationActionCreate(...a),
                },
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
    moderationActionCreate.mockReset().mockResolvedValue({});
    invalidateDeletionPendingCache.mockReset().mockResolvedValue(undefined);
});

describe('suspending wires both post-commit effects', () => {
    it('invalidates the cached verdict', async () => {
        await suspendAccount({ userId: 'u1', generation: 'current', reason: 'repeat abuse' });

        // THE MUTATION TARGET. Without this assertion, dropping the
        // invalidation is green everywhere.
        expect(invalidateSuspensionCache).toHaveBeenCalledWith('u1');
    });

    it('appends to the moderation chain, naming the key generation', async () => {
        await suspendAccount({ userId: 'u1', generation: 'previous', reason: 'repeat abuse' });

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
        // `detailsJson` is not an encrypted column.
        expect(JSON.stringify(details)).not.toContain('repeat abuse');
    });

    it('and the reason itself reaches ModerationAction.rationale', async () => {
        // The other half, which the comment above used to assert on its own:
        // "the rationale belongs on `ModerationAction.rationale`, which is
        // [encrypted]". That was ASPIRATIONAL — this path created no action
        // row, so the reason was accepted and dropped (#1667). Now it is a
        // claim with a test.
        await suspendAccount({ userId: 'u1', generation: 'current', reason: 'repeat abuse' });

        expect(moderationActionCreate).toHaveBeenCalledTimes(1);
        expect(moderationActionCreate.mock.calls[0][0].data).toMatchObject({
            // PROACTIVE: no notice behind it, which is why `reportId` is
            // nullable on that model.
            reportId: null,
            actionKind: 'ACCOUNT_SUSPENDED',
            // The subject is a PERSON, not content.
            subjectKind: 'ACCOUNT',
            subjectId: 'u1',
            rationale: 'repeat abuse',
            moderatorRef: 'platform-key:current',
        });
    });

    it('records NO action for an idempotent repeat', async () => {
        // One decision, one row. A second action would make the history claim
        // two suspensions — the same reasoning the chain-entry test below
        // applies to `PlatformAuditLog`.
        userFindUnique.mockResolvedValue({ id: 'u1', suspendedAt: new Date() });

        await suspendAccount({ userId: 'u1', generation: 'current', reason: 'repeat abuse' });

        expect(moderationActionCreate).not.toHaveBeenCalled();
    });

    it('records NO action for an account that does not exist', async () => {
        // A decision about nobody. `applied: false` is the caller's 404.
        userFindUnique.mockResolvedValue(null);

        await suspendAccount({ userId: 'nope', generation: 'current', reason: 'repeat abuse' });

        expect(moderationActionCreate).not.toHaveBeenCalled();
    });

    it('does NEITHER when the account is already suspended', async () => {
        userFindUnique.mockResolvedValue({ id: 'u1', suspendedAt: new Date() });

        const result = await suspendAccount({ userId: 'u1', generation: 'current', reason: 'repeat abuse' });

        expect(result.alreadySuspended).toBe(true);
        // A second chain entry would make the history claim two suspensions.
        expect(appendPlatformAuditEntry).not.toHaveBeenCalled();
        expect(invalidateSuspensionCache).not.toHaveBeenCalled();
        expect(userUpdate).not.toHaveBeenCalled();
    });

    it('does NEITHER when the account does not exist', async () => {
        userFindUnique.mockResolvedValue(null);

        const result = await suspendAccount({ userId: 'nope', generation: 'current', reason: 'repeat abuse' });

        expect(result.applied).toBe(false);
        expect(appendPlatformAuditEntry).not.toHaveBeenCalled();
        expect(invalidateSuspensionCache).not.toHaveBeenCalled();
    });

    it('a chain-append failure does not undo the suspension', async () => {
        // Best-effort, per the #1619 ruling for this scope: the suspension has
        // already taken effect in the database, so a bookkeeping failure must
        // not propagate.
        appendPlatformAuditEntry.mockRejectedValue(new Error('chain locked'));

        await expect(suspendAccount({ userId: 'u1', generation: 'current', reason: 'repeat abuse' }))
            .resolves.toMatchObject({ applied: true });
    });

    it('bumps sessionVersion AND stamps suspendedAt in one update', async () => {
        await suspendAccount({ userId: 'u1', generation: 'current', reason: 'repeat abuse' });

        const data = userUpdate.mock.calls[0][0].data;
        expect(data.suspendedAt).toBeInstanceOf(Date);
        // The slow path kept as a backstop: if the per-request check were ever
        // bypassed, the throttled sessionVersion check still ends the session.
        expect(data.sessionVersion).toEqual({ increment: 1 });
    });

    it('revokes only the LIVE session rows', async () => {
        await suspendAccount({ userId: 'u1', generation: 'current', reason: 'repeat abuse' });

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

describe('lifting a suspension stops a moderator erasure (#1667)', () => {
    it('drops the deletion-pending cache when it stopped one', async () => {
        // Without this, `/me` keeps reporting a `deletion` that no longer
        // exists for the remainder of the TTL — and the phone offers a cancel
        // for it, which is the promise-then-refuse shape this whole thread has
        // been about.
        userFindUnique.mockResolvedValue({
            id: 'u1',
            suspendedAt: new Date(),
            deletionRequestedAt: new Date(),
            deletionRequestedBy: 'MODERATION',
        });

        const result = await liftSuspension({ userId: 'u1', generation: 'current' });

        expect(result.erasureStopped).toBe(true);
        expect(invalidateDeletionPendingCache).toHaveBeenCalledWith('u1');
        // ONE update. The count, not atomicity — two updates inside the
        // same `$transaction` are still atomic, so this does not prove the
        // reinstatement cannot half-apply and the usecase's comment no longer
        // claims it does. What it holds is that a later edit has nowhere to put
        // a second statement, which is the shape that gets hoisted out of the
        // transaction and then really can half-apply.
        expect(userUpdate).toHaveBeenCalledTimes(1);
        expect(userUpdate.mock.calls[0][0].data).toMatchObject({
            suspendedAt: null,
            deletionRequestedAt: null,
            deletionRequestedBy: null,
        });
    });

    it('does NOT drop it when there was nothing to stop', async () => {
        // The control. A cache drop on every lift would make the assertion
        // above pass for the wrong reason, and would also clear a verdict for
        // somebody mid-deletion who was never erasure-bound by a moderator.
        userFindUnique.mockResolvedValue({
            id: 'u1',
            suspendedAt: new Date(),
            deletionRequestedAt: null,
            deletionRequestedBy: null,
        });

        const result = await liftSuspension({ userId: 'u1', generation: 'current' });

        expect(result.erasureStopped).toBe(false);
        expect(invalidateDeletionPendingCache).not.toHaveBeenCalled();
    });

    it('leaves a SELF-requested deletion alone', async () => {
        userFindUnique.mockResolvedValue({
            id: 'u1',
            suspendedAt: new Date(),
            deletionRequestedAt: new Date(),
            deletionRequestedBy: 'SELF',
        });

        const result = await liftSuspension({ userId: 'u1', generation: 'current' });

        expect(result.erasureStopped).toBe(false);
        // `terminatedAt` is cleared alongside — unconditionally, so a lift of a
        // never-terminated account writes NULL over NULL. That is what gives
        // the person their own request back: `cancelAccountDeletion` refuses
        // while `terminatedAt` is set, so leaving it would un-suspend somebody
        // and still hold them to an erasure they could no longer stop.
        // `toEqual`, not `toMatchObject`, so a future key that clears the
        // deletion here fails instead of passing silently.
        expect(userUpdate.mock.calls[0][0].data).toEqual({
            suspendedAt: null,
            terminatedAt: null,
        });
    });
});
