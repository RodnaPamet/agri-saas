/**
 * Audit Coherence S10 (2026-05-24) — unit tests for the three
 * concrete restore validators.
 *
 * Pure functions — we mock the PrismaTx surface they touch and
 * pin both the accept and reject paths so a future refactor can't
 * quietly widen what's restorable.
 */
import {
    getRestoreValidator,
    RESTORE_VALIDATORS,
} from '@/app-layer/domain/restore-validators';
import type { PrismaTx } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';

function mockDb(overrides: Partial<{
    practice: { findFirst: jest.Mock };
    auditCycle: { findFirst: jest.Mock };
    tenantMembership: { findFirst: jest.Mock };
}> = {}): PrismaTx {
    return {
        practice: { findFirst: jest.fn() },
        auditCycle: { findFirst: jest.fn() },
        tenantMembership: { findFirst: jest.fn() },
        ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

describe('Task restore validator', () => {
    const ctx = makeRequestContext('ADMIN');
    const validator = getRestoreValidator('Task');

    it('accepts a task with no practiceId (no parent to check)', async () => {
        const db = mockDb();
        await expect(
            validator(ctx, db, { practiceId: null }),
        ).resolves.toBeUndefined();
    });

    it('accepts a task whose parent practice is alive', async () => {
        const findFirst = jest.fn().mockResolvedValueOnce({ id: 'ctl-1' });
        const db = mockDb({ practice: { findFirst } });

        await expect(
            validator(ctx, db, { practiceId: 'ctl-1' }),
        ).resolves.toBeUndefined();
        expect(findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: 'ctl-1',
                    deletedAt: null,
                }),
            }),
        );
    });

    it('refuses when the parent practice has been deleted', async () => {
        const findFirst = jest.fn().mockResolvedValueOnce(null);
        const db = mockDb({ practice: { findFirst } });

        await expect(
            validator(ctx, db, { practiceId: 'ctl-deleted' }),
        ).rejects.toThrow(/parent practice has been deleted/);
    });
});

describe('AuditPack restore validator', () => {
    const ctx = makeRequestContext('ADMIN');
    const validator = getRestoreValidator('AuditPack');

    it('accepts when the cycle is live and not CLOSED', async () => {
        const findFirst = jest.fn().mockResolvedValueOnce({
            id: 'cyc-1',
            status: 'IN_REVIEW',
            deletedAt: null,
        });
        const db = mockDb({ auditCycle: { findFirst } });

        await expect(
            validator(ctx, db, { auditCycleId: 'cyc-1' }),
        ).resolves.toBeUndefined();
    });

    it('refuses when the cycle does not exist', async () => {
        const findFirst = jest.fn().mockResolvedValueOnce(null);
        const db = mockDb({ auditCycle: { findFirst } });

        await expect(
            validator(ctx, db, { auditCycleId: 'cyc-missing' }),
        ).rejects.toThrow(/audit cycle has been deleted/);
    });

    it('refuses when the cycle is soft-deleted', async () => {
        const findFirst = jest.fn().mockResolvedValueOnce({
            id: 'cyc-1',
            status: 'IN_REVIEW',
            deletedAt: new Date(),
        });
        const db = mockDb({ auditCycle: { findFirst } });

        await expect(
            validator(ctx, db, { auditCycleId: 'cyc-1' }),
        ).rejects.toThrow(/audit cycle has been deleted/);
    });

    it('refuses when the cycle is COMPLETE', async () => {
        const findFirst = jest.fn().mockResolvedValueOnce({
            id: 'cyc-1',
            status: 'COMPLETE',
            deletedAt: null,
        });
        const db = mockDb({ auditCycle: { findFirst } });

        await expect(
            validator(ctx, db, { auditCycleId: 'cyc-1' }),
        ).rejects.toThrow(/audit cycle is COMPLETE/);
    });
});

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
            'Risk',
            'Practice',
            'Evidence',
            'Policy',
            'Vendor',
            'FileRecord',
            'Task',
            'Finding',
            'Audit',
            'AuditCycle',
            'AuditPack',
        ];
        for (const m of expected) {
            const v = RESTORE_VALIDATORS[m];
            expect(typeof v).toBe('function');
        }
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
        expect(dbAny.practice.findFirst).not.toHaveBeenCalled();
        expect(dbAny.auditCycle.findFirst).not.toHaveBeenCalled();
        expect(dbAny.tenantMembership.findFirst).not.toHaveBeenCalled();
    });
});
