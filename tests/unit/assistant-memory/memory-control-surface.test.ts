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
            where: { userId: string; deletedAt: null; supersededAt: null };
            orderBy: { sourceAt: string };
            take: number;
        };
        // BOTH columns. `deletedAt` is the person's «Изтрий» (rule 5);
        // `supersededAt` is the extractor retiring a point under rule 4. They
        // are separate facts and separate columns, and a filter naming only
        // one shows points that have already been replaced.
        expect(args.where).toEqual({ userId: ME, deletedAt: null, supersededAt: null });
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
        expect(args.where).toEqual({ id: 'f1', userId: ME, deletedAt: null, supersededAt: null });
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
        // BOTH columns. `deletedAt` is the person's «Изтрий» (rule 5);
        // `supersededAt` is the extractor retiring a point under rule 4. They
        // are separate facts and separate columns, and a filter naming only
        // one shows points that have already been replaced.
        expect(args.where).toEqual({ userId: ME, deletedAt: null, supersededAt: null });
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
        expect(args.where).toEqual({ id: 'f1', userId: ME, deletedAt: null, supersededAt: null });
        expect(args.data.editedByPerson).toBe(true);
        expect(args.data.text).toBe('отглежда слънчоглед');
    });

    it('replaces the EVIDENCE with the correction — rules 3, 4 and 6 meeting', async () => {
        // Not a detail. `sourceQuote` is what rules 4 and 5 are read from, so
        // an edited point still carrying the SUPERSEDED sentence would be
        // misleading evidence: "the latest statement wins" means the latest
        // statement IS the evidence, and rule 3 says a point may only be
        // learned from the person's own words — a correction they typed is the
        // purest case of that.
        //
        // It also gives rule 5 a property for free: the extractor cannot later
        // re-derive the OLD point, because the evidence it would have matched
        // is gone.
        //
        // This is also what makes the model honestly coverable by the
        // sanitiser guard — both encrypted free-text columns now go through
        // `sanitizePlainText` at the one path a person writes them, rather
        // than one being covered and the other having no writer at all.
        const before = new Date('2026-10-01T00:00:00.000Z');
        await editRememberedPoint(ME, 'f1', '  отглежда слънчоглед  ');
        const data = (updateMany.mock.calls[0][0] as {
            data: { text: string; sourceQuote: string; sourceAt: Date };
        }).data;
        expect(data.sourceQuote).toBe('отглежда слънчоглед');
        expect(data.sourceQuote).toBe(data.text);
        // And the evidence is re-dated, or rule 4's "latest wins" would read
        // the correction as older than the point it replaced.
        expect(data.sourceAt.getTime()).toBeGreaterThan(before.getTime());
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

    /*
     * The two refusals must stay TELLABLE APART, and nothing above checks
     * that: every assertion in this file matched a MESSAGE, and a 404 whose
     * message is "A remembered point cannot be empty." satisfies `/empty/i`
     * perfectly. `MEMORY_POINT_EMPTY` shipped as a `codedNotFound` for exactly
     * that reason — found by the spec guard, not by a test.
     *
     * It matters because 404 is LOAD-BEARING here: this file answers it for an
     * id that is unknown, already forgotten or somebody else's, and those three
     * are indistinguishable ON PURPOSE (a 403 would confirm the id exists).
     * Folding a body-validation failure into that status means a client can no
     * longer tell "that point is not yours" from "your text was blank" — the
     * caller's own mistake, about a point they do own, reported as the privacy
     * refusal. So this asserts the PAIR, as a comparison.
     */
    it('a blank text and a point that is not mine are DISTINGUISHABLE', async () => {
        const blank = await editRememberedPoint(ME, 'f1', '   ').catch((e) => e);
        updateMany.mockResolvedValue({ count: 0 });
        const notMine = await editRememberedPoint(ME, 'f1', 'нещо').catch((e) => e);

        expect(blank.code).toBe('MEMORY_POINT_EMPTY');
        expect(blank.status).toBe(400);
        expect(notMine.code).toBe('MEMORY_POINT_NOT_FOUND');
        expect(notMine.status).toBe(404);

        // The property, not the two readings: neither field may collapse.
        expect(blank.status).not.toBe(notMine.status);
        expect(blank.code).not.toBe(notMine.code);
    });

    it('editing a point that is not mine is NOT FOUND', async () => {
        updateMany.mockResolvedValue({ count: 0 });
        await expect(editRememberedPoint(ME, 'f1', 'нещо')).rejects.toThrow(/not found/i);
        // And it must not read the row back after a refused write.
        expect(findFirstOrThrow).not.toHaveBeenCalled();
    });
});
