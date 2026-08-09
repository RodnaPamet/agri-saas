/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `src/app-layer/usecases/soft-delete-lifecycle.ts` —
 * restore + purge + list-soft-deleted.
 *
 * Wave-9 / stage-3g branch coverage. Compliance-critical: a bug
 * in the purge guard could permanently destroy non-deleted rows;
 * a bug in restore could surface previously-deleted records that
 * shouldn't be visible (e.g. data subject deletion under GDPR).
 *
 * Branch matrix:
 *   restoreSoftDeleted: unknown model / delegate missing / record
 *     not-found / happy
 *   purgeSoftDeleted:   unknown model / delegate missing / record
 *     not-found / happy
 *   listSoftDeleted:    unknown model / take + skip defaults / pass-through
 *   getDelegate:        unknown model key
 */

jest.mock('@/lib/soft-delete', () => {
    const actual = jest.requireActual('@/lib/soft-delete');
    return {
        ...actual,
        SOFT_DELETE_MODELS: new Set(['Practice', 'Risk', 'Evidence']),
        withDeleted: (q: any) => ({ ...q, _withDeleted: true }),
    };
});

import {
    restoreSoftDeleted,
    purgeSoftDeleted,
    listSoftDeleted,
} from '@/app-layer/usecases/soft-delete-lifecycle';

function makeDelegate(overrides: Partial<{ findFirst: any; findMany: any; update: any }> = {}) {
    return {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        ...overrides,
    };
}

function makeTx(delegates: Record<string, any>) {
    return {
        ...delegates,
        $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };
}

// ──────────────────────────────────────────────────────────────────────
// restoreSoftDeleted
// ──────────────────────────────────────────────────────────────────────
describe('restoreSoftDeleted', () => {
    it('rejects models not in SOFT_DELETE_MODELS', async () => {
        const tx = makeTx({ practice: makeDelegate() });
        await expect(
            restoreSoftDeleted(tx, { model: 'UnsupportedModel', id: 'x' }),
        ).rejects.toThrow(/does not support soft-delete/i);
    });

    it('throws when the Prisma delegate for the model key is missing', async () => {
        // `Practice` is in SOFT_DELETE_MODELS but no `practice` key on
        // the tx object — defensive guard against rename mismatch.
        const tx = makeTx({}); // no delegates
        await expect(
            restoreSoftDeleted(tx, { model: 'Practice', id: 'x' }),
        ).rejects.toThrow(/prisma delegate not found/i);
    });

    it('throws notFound when the record is not soft-deleted (or missing)', async () => {
        const tx = makeTx({ practice: makeDelegate() });
        await expect(
            restoreSoftDeleted(tx, { model: 'Practice', id: 'c-gone' }),
        ).rejects.toThrow(/no soft-deleted practice found/i);
    });

    it('clears deletedAt + deletedByUserId on happy path', async () => {
        const delegate = makeDelegate({
            findFirst: jest.fn().mockResolvedValue({ id: 'c-1', deletedAt: new Date(), deletedByUserId: 'u-1' }),
            update: jest.fn().mockResolvedValue({}),
        });
        const tx = makeTx({ practice: delegate });

        const result = await restoreSoftDeleted(tx, { model: 'Practice', id: 'c-1' });

        expect(result.id).toBe('c-1');
        expect(result.model).toBe('Practice');
        // The withDeleted wrapper was applied to the findFirst lookup.
        expect(delegate.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ _withDeleted: true }),
        );
        // Update clears both soft-delete columns.
        expect(delegate.update).toHaveBeenCalledWith({
            where: { id: 'c-1' },
            data: { deletedAt: null, deletedByUserId: null },
        });
    });
});

// ──────────────────────────────────────────────────────────────────────
// purgeSoftDeleted — the dangerous one
// ──────────────────────────────────────────────────────────────────────
describe('purgeSoftDeleted', () => {
    it('rejects models not in SOFT_DELETE_MODELS', async () => {
        const tx = makeTx({ practice: makeDelegate() });
        await expect(
            purgeSoftDeleted(tx, { model: 'UnsupportedModel', id: 'x' }),
        ).rejects.toThrow(/does not support soft-delete/i);
    });

    it('REFUSES to purge a record that is not soft-deleted (safety guard)', async () => {
        // The findFirst lookup uses `deletedAt: { not: null }` —
        // a not-yet-soft-deleted record returns null and the
        // function bails BEFORE the raw DELETE fires.
        const tx = makeTx({ practice: makeDelegate() });
        await expect(
            purgeSoftDeleted(tx, { model: 'Practice', id: 'c-live' }),
        ).rejects.toThrow(/only soft-deleted records can be purged/i);
        // Critical regression: the executeRawUnsafe MUST NOT have fired.
        expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('fires the raw DELETE bypassing the soft-delete middleware', async () => {
        const delegate = makeDelegate({
            findFirst: jest.fn().mockResolvedValue({ id: 'c-1', deletedAt: new Date() }),
        });
        const tx = makeTx({ practice: delegate });

        const result = await purgeSoftDeleted(tx, { model: 'Practice', id: 'c-1' });

        expect(result.id).toBe('c-1');
        expect(result.model).toBe('Practice');
        // Raw SQL bypasses middleware (load-bearing for true hard-delete).
        expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
            'DELETE FROM "Practice" WHERE "id" = $1',
            'c-1',
        );
    });
});

// ──────────────────────────────────────────────────────────────────────
// listSoftDeleted
// ──────────────────────────────────────────────────────────────────────
describe('listSoftDeleted', () => {
    it('rejects unknown model', async () => {
        const tx = makeTx({});
        await expect(
            listSoftDeleted(tx, 'Unknown', 'tenant-1'),
        ).rejects.toThrow(/does not support soft-delete/i);
    });

    it('defaults take=50, skip=0 when no options', async () => {
        const delegate = makeDelegate();
        const tx = makeTx({ practice: delegate });

        await listSoftDeleted(tx, 'Practice', 'tenant-1');

        const args = delegate.findMany.mock.calls[0][0];
        expect(args.take).toBe(50);
        expect(args.skip).toBe(0);
        expect(args._withDeleted).toBe(true);
        expect(args.where).toMatchObject({
            tenantId: 'tenant-1',
            deletedAt: { not: null },
        });
    });

    it('respects explicit take + skip', async () => {
        const delegate = makeDelegate();
        const tx = makeTx({ practice: delegate });

        await listSoftDeleted(tx, 'Practice', 'tenant-1', { take: 200, skip: 100 });

        const args = delegate.findMany.mock.calls[0][0];
        expect(args.take).toBe(200);
        expect(args.skip).toBe(100);
    });

    it('orders by deletedAt DESC (most-recent deletes first for admin view)', async () => {
        const delegate = makeDelegate();
        const tx = makeTx({ practice: delegate });

        await listSoftDeleted(tx, 'Practice', 'tenant-1');

        const args = delegate.findMany.mock.calls[0][0];
        expect(args.orderBy).toEqual({ deletedAt: 'desc' });
    });
});
