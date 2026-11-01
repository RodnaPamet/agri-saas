/**
 * «Какво помни асистентът» — the four verbs (#2671).
 *
 * The assertions here are about the two rules that are easiest to break by
 * writing the obvious code:
 *
 *   · rule 5 — «Изтрий» must TOMBSTONE, not delete. `delete` is what a reader
 *     writes for "forget this", and it would let the next conversation that
 *     mentioned the same thing re-learn it from the same evidence, so the
 *     person's decision would not stick. The call SHAPE is the property, which
 *     is why this is asserted on the query rather than on a row count.
 *   · rule 6 — an edit must set `editedByPerson`. Without it the extractor
 *     overwrites the correction and correcting a point is pointless, so the
 *     flag is the real effect of the verb and the new text is the side effect.
 *
 * And the one that is a security property rather than a design rule: every
 * write carries `userId` in its `where`. `AssistantMemoryFact` has no
 * `app_user` write arm, so these usecases run on the privileged client — the
 * `where` clause IS the authorisation, not a filter on top of one.
 */
const updateMany = jest.fn<Promise<{ count: number }>, unknown[]>();
const findMany = jest.fn<Promise<unknown[]>, unknown[]>();
const findFirstOrThrow = jest.fn<Promise<unknown>, unknown[]>();
const deleteMany = jest.fn<Promise<{ count: number }>, unknown[]>();
const deleteOne = jest.fn<Promise<unknown>, unknown[]>();

jest.mock('@/lib/prisma', () => ({
    prisma: {
        assistantMemoryFact: {
            updateMany: (...a: unknown[]) => updateMany(...a),
            findMany: (...a: unknown[]) => findMany(...a),
            findFirstOrThrow: (...a: unknown[]) => findFirstOrThrow(...a),
            // Present on the double DELIBERATELY, so "forget does not call
            // delete" is a claim this test can actually falsify. A double
            // lacking them would make the assertion vacuous — the call would
            // throw for the wrong reason and still look like a pass.
            deleteMany: (...a: unknown[]) => deleteMany(...a),
            delete: (...a: unknown[]) => deleteOne(...a),
        },
    },
}));
jest.mock('@/lib/db-context', () => ({
    runInUserContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({ assistantMemoryFact: { findMany: (...a: unknown[]) => findMany(...a) } }),
}));

import {
    REMEMBERED_POINT_LIMIT,
    REMEMBERED_POINT_MAX_CHARS,
    editRememberedPoint,
    forgetAllRememberedPoints,
    forgetRememberedPoint,
    listRememberedPoints,
} from '@/app-layer/usecases/assistant-memory';

const ME = 'user-me';
const AT = new Date('2026-11-01T10:00:00.000Z');

beforeEach(() => {
    jest.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
    findMany.mockResolvedValue([{ id: 'f1', text: 'отглежда пшеница', sourceAt: AT }]);
    findFirstOrThrow.mockResolvedValue({ id: 'f1', text: 'поправено', sourceAt: AT });
});

describe('listRememberedPoints', () => {
    it('asks only for LIVE points, newest first, bounded', async () => {
        const out = await listRememberedPoints(ME);
        const args = findMany.mock.calls[0][0] as {
            where: { userId: string; deletedAt: null };
            orderBy: { sourceAt: string };
            take: number;
        };
        expect(args.where).toEqual({ userId: ME, deletedAt: null });
        expect(args.orderBy).toEqual({ sourceAt: 'desc' });
        expect(args.take).toBe(REMEMBERED_POINT_LIMIT);
        // The client shape: no evidence, and an unformatted ISO date.
        expect(out).toEqual([
            { id: 'f1', text: 'отглежда пшеница', rememberedAt: '2026-11-01T10:00:00.000Z' },
        ]);
    });

    it('never returns the evidence', async () => {
        // Rule 7 keeps `sourceQuote` server-side. A projection that leaked it
        // would still look right in the list, which is why this is explicit.
        findMany.mockResolvedValue([
            { id: 'f1', text: 'x', sourceAt: AT, sourceQuote: 'Отглеждам пшеница.' },
        ]);
        const [point] = await listRememberedPoints(ME);
        expect(Object.keys(point).sort()).toEqual(['id', 'rememberedAt', 'text']);
    });
});

describe('forget — rule 5, a tombstone and not a delete', () => {
    it('sets deletedAt and calls NO delete', async () => {
        await forgetRememberedPoint(ME, 'f1');
        const args = updateMany.mock.calls[0][0] as {
            where: Record<string, unknown>;
            data: { deletedAt: Date };
        };
        expect(args.where).toEqual({ id: 'f1', userId: ME, deletedAt: null });
        expect(args.data.deletedAt).toBeInstanceOf(Date);
        // THE rule-5 assertion. Both doubles exist, so this can fail.
        expect(deleteOne).not.toHaveBeenCalled();
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it('a point that is not mine is NOT FOUND, never forbidden', async () => {
        // A 403 would confirm the id exists, and these ids are about people.
        updateMany.mockResolvedValue({ count: 0 });
        await expect(forgetRememberedPoint(ME, 'someone-elses')).rejects.toThrow(
            /not found/i,
        );
    });

    it('forget-all scopes by userId and reports the count', async () => {
        updateMany.mockResolvedValue({ count: 4 });
        expect(await forgetAllRememberedPoints(ME)).toBe(4);
        const args = updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
        expect(args.where).toEqual({ userId: ME, deletedAt: null });
        expect(deleteMany).not.toHaveBeenCalled();
    });
});

describe('edit — rule 6, the point becomes the person’s', () => {
    it('sets editedByPerson, which is the REAL effect of the verb', async () => {
        await editRememberedPoint(ME, 'f1', 'отглежда слънчоглед');
        const args = updateMany.mock.calls[0][0] as {
            where: Record<string, unknown>;
            data: { text: string; editedByPerson: boolean };
        };
        expect(args.where).toEqual({ id: 'f1', userId: ME, deletedAt: null });
        expect(args.data.editedByPerson).toBe(true);
        expect(args.data.text).toBe('отглежда слънчоглед');
    });

    it('SANITISES and BOUNDS the text — it re-enters the prompt on every answer', async () => {
        await editRememberedPoint(ME, 'f1', `  ${'я'.repeat(REMEMBERED_POINT_MAX_CHARS + 50)}  `);
        const args = updateMany.mock.calls[0][0] as { data: { text: string } };
        // Trimmed by `sanitizePlainText` (#1825) and clamped.
        expect(args.data.text.length).toBe(REMEMBERED_POINT_MAX_CHARS);
        expect(args.data.text.startsWith(' ')).toBe(false);
    });

    it('a whitespace-only edit is EMPTY, not a truthy string', async () => {
        // `sanitizePlainText` trims since #1825, so the blank check has to run
        // AFTER it — before that change `'   '` was truthy and would have
        // been stored as a remembered point of three spaces.
        await expect(editRememberedPoint(ME, 'f1', '   ')).rejects.toThrow(/empty/i);
        expect(updateMany).not.toHaveBeenCalled();
    });

    it('editing a point that is not mine is NOT FOUND', async () => {
        updateMany.mockResolvedValue({ count: 0 });
        await expect(editRememberedPoint(ME, 'f1', 'нещо')).rejects.toThrow(/not found/i);
        // And it must not read the row back after a refused write.
        expect(findFirstOrThrow).not.toHaveBeenCalled();
    });
});
