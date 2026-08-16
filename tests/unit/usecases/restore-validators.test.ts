/**
 * Audit Coherence S10 (2026-05-24) — unit tests for the restore
 * validators.
 *
 * Pure functions — we mock the PrismaTx surface they touch and
 * pin both the accept and reject paths so a future refactor can't
 * quietly widen what's restorable.
 *
 * GRC teardown phase 3 narrowed this file rather than shrinking it by
 * deletion alone. `RestorableModel` went from twelve members to four
 * (Asset / Evidence / FileRecord / Task), and two describe blocks lost
 * their subject outright:
 *
 *   - `AuditPack` — the model is gone, along with `AuditCycle` and the
 *     cycle-status precondition its validator enforced.
 *   - `Task` — the model SURVIVES, but its validator does not. It
 *     checked that the parent `Practice` was still alive; with
 *     `Task.practiceId` dropped there is no parent to check, so `Task`
 *     is now wired to `NOOP_VALIDATOR`. Deleting those three cases is
 *     correct — keeping them re-pointed at the no-op would have
 *     asserted that a lookup nobody performs returns nothing.
 *
 * `Evidence` is the only model left with a real precondition, so it is
 * the only behavioural block below.
 */
import {
    getRestoreValidator,
    RESTORE_VALIDATORS,
} from '@/app-layer/domain/restore-validators';
import type { PrismaTx } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';

function mockDb(overrides: Partial<{
    tenantMembership: { findFirst: jest.Mock };
}> = {}): PrismaTx {
    return {
        tenantMembership: { findFirst: jest.fn() },
        ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

describe('Evidence restore validator', () => {
    const ctx = makeRequestContext('ADMIN');
    const validator = getRestoreValidator('Evidence');

    it('accepts when ownerUserId is null (no owner to check)', async () => {
        const db = mockDb();
        await expect(
            validator(ctx, db, { ownerUserId: null }),
        ).resolves.toBeUndefined();
    });

    it('accepts when the owner is an ACTIVE tenant member', async () => {
        const findFirst = jest.fn().mockResolvedValueOnce({ id: 'mem-1' });
        const db = mockDb({ tenantMembership: { findFirst } });

        await expect(
            validator(ctx, db, { ownerUserId: 'usr-7' }),
        ).resolves.toBeUndefined();
        expect(findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: 'usr-7',
                    status: 'ACTIVE',
                }),
            }),
        );
    });

    it('refuses when the owner is no longer an ACTIVE member', async () => {
        const findFirst = jest.fn().mockResolvedValueOnce(null);
        const db = mockDb({ tenantMembership: { findFirst } });

        await expect(
            validator(ctx, db, { ownerUserId: 'usr-removed' }),
        ).rejects.toThrow(/evidence owner is no longer an active member/);
    });
});

describe('Registry totality', () => {
    it('exposes a validator for every RestorableModel', () => {
        type RM = keyof typeof RESTORE_VALIDATORS;
        const expected: ReadonlyArray<RM> = [
            'Asset',
            'Evidence',
            'FileRecord',
            'Task',
        ];
        for (const m of expected) {
            const v = RESTORE_VALIDATORS[m];
            expect(typeof v).toBe('function');
        }
        // Totality in the other direction too: a model added to the
        // union without a validator would make the lookup partial, and
        // `getRestoreValidator` has no fallback.
        expect(Object.keys(RESTORE_VALIDATORS).sort()).toEqual([...expected].sort());
    });

    it('NOOP validators accept any record without touching the DB', async () => {
        const ctx = makeRequestContext('ADMIN');
        const db = mockDb();
        // Asset has the no-op validator wired.
        const validator = getRestoreValidator('Asset');
        await expect(validator(ctx, db, { whatever: true })).resolves.toBeUndefined();
        // Confirm no parent lookup was issued.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbAny = db as any;
        expect(dbAny.tenantMembership.findFirst).not.toHaveBeenCalled();
    });

    it('Task is a no-op now that it has no parent practice', async () => {
        // Regression pin for the phase-3 narrowing: Task USED to check
        // that its parent Practice was live. If a future change
        // re-introduces a parent lookup on Task, this fails and the
        // author has to say what the new precondition is.
        const ctx = makeRequestContext('ADMIN');
        const db = mockDb();
        await expect(
            getRestoreValidator('Task')(ctx, db, { id: 'task-1' }),
        ).resolves.toBeUndefined();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((db as any).tenantMembership.findFirst).not.toHaveBeenCalled();
    });
});
