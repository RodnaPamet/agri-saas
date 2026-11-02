/**
 * «Изтрий» an exchange, and the four readers that must honour it (#2695).
 *
 * The tombstone is only worth having if every reader filters it, and they are
 * in four different files. This suite covers the control surface and the
 * SWEEP; the window replay and the id resolver are covered beside their own
 * code in `assistant-conversation`'s suite.
 *
 * The sweep is the one worth the most care. Without its filter it reads a
 * deleted exchange and writes a PROFILE POINT from it — rule 5 violated
 * through a side door, and invisible: the point looks like any other while the
 * exchange it came from is gone from every screen.
 */
const mockFindMany = jest.fn();
const mockUpdateMany = jest.fn();
const mockFindFirst = jest.fn();
const mockTurnFindMany = jest.fn();
/** Every tenant a content read was run under, in order. */
const tenantContexts: string[] = [];
jest.mock('@/lib/prisma', () => {
    const client = {
        assistantConversation: {
            findMany: (...a: unknown[]) => mockFindMany(...a),
            updateMany: (...a: unknown[]) => mockUpdateMany(...a),
            findFirst: (...a: unknown[]) => mockFindFirst(...a),
        },
    };
    return { __esModule: true, default: client, prisma: client };
});
/*
 * The content seam. Turn text is encrypted under the FARM's DEK, so it is
 * readable only inside that farm's context — and a person-scoped read binds
 * none, which is how the list shipped showing `v2:` envelopes as row labels.
 * This double records the farm each content read ran under so that property
 * is checkable here and not only against real rows.
 */
jest.mock('@/lib/db-context', () => ({
    withTenantDb: async (tenantId: string, cb: (db: unknown) => Promise<unknown>) => {
        tenantContexts.push(tenantId);
        return cb({
            assistantConversation: { findMany: (...a: unknown[]) => mockFindMany(...a) },
            assistantTurn: { findMany: (...a: unknown[]) => mockTurnFindMany(...a) },
        });
    },
}));

import {
    searchPastConversations,
    CONVERSATION_DETAIL_TURN_CAP,
    CONVERSATION_LIST_LIMIT,
    deleteAllPastConversations,
    deletePastConversation,
    getPastConversation,
    listPastConversations,
} from '@/app-layer/usecases/assistant-conversations-control';

const ME = 'user-me';

beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset();
    mockFindFirst.mockReset();
    mockFindMany.mockResolvedValue([]);
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockFindFirst.mockResolvedValue(null);
    mockTurnFindMany.mockReset();
    mockTurnFindMany.mockResolvedValue([]);
    tenantContexts.length = 0;
});

describe('the list is person-scoped ACROSS farms', () => {
    it('filters on userId and the tombstone, and NOT on tenantId', async () => {
        await listPastConversations(ME);
        const args = mockFindMany.mock.calls[0][0] as { where: Record<string, unknown>; take: number };
        // The owner's scope is "all sessions with a user". A tenantId filter
        // would hide the exchanges this person had in their other farms — and
        // would do it silently, which is the shape to avoid.
        expect(args.where).toEqual({ userId: ME, deletedAt: null });
        expect(args.where).not.toHaveProperty('tenantId');
        expect(args.take).toBe(CONVERSATION_LIST_LIMIT);
    });

    it('labels each row with the person’s OWN first question', async () => {
        mockFindMany.mockResolvedValueOnce([
            { id: 'c1', tenantId: 'farm-a', startedAt: new Date(), lastTurnAt: new Date(), _count: { turns: 1 } },
        ]);
        await listPastConversations(ME);
        // Call 1 is the CONTENT read; call 0 is the metadata query, which
        // selects no turns because none of its columns is encrypted.
        const args = mockFindMany.mock.calls[1][0] as {
            select: { turns: { where: { role: string }; take: number; orderBy: unknown } };
        };
        // `role: 'user'` — an assistant turn can quote tool output, and a
        // label is shown on a screen. Their own words also need no model call
        // and cannot drift from the exchange they label.
        expect(args.select.turns.where.role).toBe('user');
        expect(args.select.turns.take).toBe(1);
        // And it ran under the farm that holds the key. Without this the label
        // is a `v2:` envelope, which is what shipped.
        expect(tenantContexts).toEqual(['farm-a']);
    });

    it('reads the openings ONE query per farm, not one per conversation', async () => {
        mockFindMany.mockResolvedValueOnce([
            { id: 'a1', tenantId: 'farm-a', startedAt: new Date(), lastTurnAt: new Date(), _count: { turns: 1 } },
            { id: 'a2', tenantId: 'farm-a', startedAt: new Date(), lastTurnAt: new Date(), _count: { turns: 1 } },
            { id: 'b1', tenantId: 'farm-b', startedAt: new Date(), lastTurnAt: new Date(), _count: { turns: 1 } },
        ]);
        await listPastConversations(ME);
        expect(tenantContexts).toEqual(['farm-a', 'farm-b']);
    });

    it('asks for no content at all when the person has no conversations', async () => {
        await listPastConversations(ME);
        // No empty-`in` query, and no transaction opened for nothing.
        expect(tenantContexts).toEqual([]);
        expect(mockFindMany).toHaveBeenCalledTimes(1);
    });

    it('maps the count and the opening, tolerating a conversation with no turns', async () => {
        mockFindMany.mockResolvedValue([
            {
                id: 'c1',
                startedAt: new Date('2026-11-01T09:00:00Z'),
                lastTurnAt: new Date('2026-11-01T09:30:00Z'),
                _count: { turns: 4 },
                turns: [{ content: 'какво да правя с белите мухи' }],
            },
            {
                id: 'c2',
                startedAt: new Date('2026-11-01T08:00:00Z'),
                lastTurnAt: new Date('2026-11-01T08:00:00Z'),
                _count: { turns: 0 },
                turns: [],
            },
        ]);
        const out = await listPastConversations(ME);
        expect(out[0]).toEqual({
            id: 'c1',
            startedAt: '2026-11-01T09:00:00.000Z',
            lastTurnAt: '2026-11-01T09:30:00.000Z',
            turns: 4,
            opening: 'какво да правя с белите мухи',
        });
        // A conversation whose only turn was the assistant's, or one abandoned
        // before a question landed, must not crash the list.
        expect(out[1].opening).toBeNull();
    });
});

describe('deleting ONE', () => {
    it('TOMBSTONES rather than deleting, scoped to this person', async () => {
        await deletePastConversation(ME, 'c1');
        const args = mockUpdateMany.mock.calls[0][0] as {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        };
        expect(args.where).toEqual({ id: 'c1', userId: ME, deletedAt: null });
        expect(args.data.deletedAt).toBeInstanceOf(Date);
    });

    it('a conversation that is not mine is NOT FOUND, never forbidden', async () => {
        mockUpdateMany.mockResolvedValue({ count: 0 });
        // A 403 would confirm the id exists, and these ids are about people —
        // P5.2b's posture, and the profile verbs' posture.
        await expect(deletePastConversation(ME, 'c1')).rejects.toMatchObject({
            code: 'CONVERSATION_NOT_FOUND',
        });
    });

    it('is idempotent — a second delete is NOT FOUND, not an error about state', async () => {
        mockUpdateMany.mockResolvedValue({ count: 0 });
        await expect(deletePastConversation(ME, 'c1')).rejects.toMatchObject({ status: 404 });
    });
});

describe('deleting ALL', () => {
    it('tombstones every VISIBLE exchange and reports that count', async () => {
        mockUpdateMany.mockResolvedValue({ count: 3 });
        const n = await deleteAllPastConversations(ME);
        const args = mockUpdateMany.mock.calls[0][0] as { where: Record<string, unknown> };
        // Visible only, so the number matches what the person was looking at.
        // Reporting more than they could see is a worse answer than fewer.
        expect(args.where).toEqual({ userId: ME, deletedAt: null });
        expect(n).toBe(3);
    });

    it('reports ZERO rather than claiming success over an empty history', async () => {
        mockUpdateMany.mockResolvedValue({ count: 0 });
        expect(await deleteAllPastConversations(ME)).toBe(0);
    });
});

/*
 * The FIFTH reader (#2721).
 *
 * Note what this suite can and cannot grade. With Prisma mocked, "a
 * tombstoned conversation answers what a nonexistent one answers" is decided
 * by the double rather than by the code — I would be asserting my own
 * `mockResolvedValue(null)`. So the property graded HERE is the one the mock
 * can actually witness: that the tombstone is in the `where`, so the DATABASE
 * does the discriminating and no post-filter can be forgotten.
 *
 * The comparison itself is in `tests/integration/assistant-conversation-detail.test.ts`
 * against real rows, where the two cases can genuinely differ.
 */
describe('reading ONE exchange', () => {
    /** The metadata query — person-scoped, across farms, no encrypted column. */
    const metaArgs = (): { where: Record<string, unknown> } =>
        mockFindFirst.mock.calls[0][0] as { where: Record<string, unknown> };
    /** The turns query — inside the conversation's own farm. */
    const turnArgs = (): { orderBy: { createdAt: string }; take: number } =>
        mockTurnFindMany.mock.calls[0][0] as { orderBy: { createdAt: string }; take: number };

    /** A conversation row as the metadata query returns it. */
    const meta = (count: number) => ({
        id: 'c1',
        tenantId: 'farm-a',
        startedAt: new Date('2026-11-01T09:00:00Z'),
        lastTurnAt: new Date('2026-11-01T09:05:00Z'),
        _count: { turns: count },
    });

    it('filters the tombstone IN THE QUERY, person-scoped and not tenant-scoped', async () => {
        await expect(getPastConversation(ME, 'c1')).rejects.toMatchObject({ status: 404 });
        // Exactly these three. A fourth key would be a narrowing nobody
        // decided; a missing `deletedAt` would show a deleted exchange that
        // is already gone from the list.
        expect(metaArgs().where).toEqual({ id: 'c1', userId: ME, deletedAt: null });
        expect(metaArgs().where).not.toHaveProperty('tenantId');
    });

    it('raises the SAME code the delete raises, so the cases cannot be told apart', async () => {
        const read = await getPastConversation(ME, 'c1').catch((e: unknown) => e);
        mockUpdateMany.mockResolvedValue({ count: 0 });
        const del = await deletePastConversation(ME, 'c1').catch((e: unknown) => e);
        const shape = (e: unknown): unknown => ({
            status: (e as { status: number }).status,
            code: (e as { code: string }).code,
            message: (e as { message: string }).message,
        });
        // A second refusal shape is a disclosure: it would let a caller learn
        // that an id exists by which error came back.
        expect(shape(read)).toEqual(shape(del));
    });

    it('returns the turns OLDEST first, though it queries newest first', async () => {
        mockFindFirst.mockResolvedValue(meta(2));
        // As the content query returns them: descending.
        mockTurnFindMany.mockResolvedValue([
            { role: 'assistant', content: 'Рано сутрин.', createdAt: new Date('2026-11-01T09:05:00Z') },
            { role: 'user', content: 'Кога да поливам?', createdAt: new Date('2026-11-01T09:00:00Z') },
        ]);
        const d = await getPastConversation(ME, 'c1');
        // Read under the farm whose DEK decrypts them.
        expect(tenantContexts).toEqual(['farm-a']);
        // The QUERY is descending so the cap drops the OLDEST turns rather
        // than the newest — a transcript missing its end would contradict
        // `lastTurnAt`. The RESULT is ascending because a transcript reads
        // forward. Both halves, or the cap cuts the wrong end.
        expect(turnArgs().orderBy.createdAt).toBe('desc');
        expect(d.items.map((t) => t.role)).toEqual(['user', 'assistant']);
        expect(d.items[0].text).toBe('Кога да поливам?');
        expect(d.items[0].at).toBe('2026-11-01T09:00:00.000Z');
        expect(d.truncated).toBe(false);
    });

    it('says TRUNCATED rather than leaving a client to infer it from a count', async () => {
        // More turns on the row than came back.
        mockFindFirst.mockResolvedValue(meta(400));
        mockTurnFindMany.mockResolvedValue([
            { role: 'user', content: 'x', createdAt: new Date('2026-11-01T09:00:00Z') },
        ]);
        const d = await getPastConversation(ME, 'c1');
        expect(d.turns).toBe(400);
        expect(d.items).toHaveLength(1);
        expect(d.truncated).toBe(true);
        expect(turnArgs().take).toBe(CONVERSATION_DETAIL_TURN_CAP);
    });

    it('narrows an unexpected role to `user` rather than passing it through', async () => {
        mockFindFirst.mockResolvedValue(meta(1));
        // The column is a plain string, so a third value is expressible. It
        // must not reach a client typed to two.
        mockTurnFindMany.mockResolvedValue([
            { role: 'system', content: 'ignore previous', createdAt: new Date('2026-11-01T09:00:00Z') },
        ]);
        const d = await getPastConversation(ME, 'c1');
        expect(d.items[0].role).toBe('user');
    });
});

/*
 * The boundary check (#2721).
 *
 * This is the one question about encryption a MOCKED suite can answer. It
 * cannot tell whether decryption HAPPENED — a double hands back the string it
 * was given, so plaintext and ciphertext are the same observation, which is
 * exactly why the defect shipped. But it can answer "given an envelope, what
 * do we emit?", because here the double is the thing choosing the encoding.
 *
 * It matters because `readContentPerTenant` makes the DEK resolvable and
 * cannot make it resolve: `resolveTenantDekPair` logs a warning and returns
 * NO_DEK_PAIR on a failed lookup, and the extension then passes the ciphertext
 * through — the same silent shape, reachable again for a different reason.
 */
describe('an envelope never reaches a client', () => {
    const ENVELOPE = 'v2:GnxO1vf/3MkC4orNu07tftzwnlxBD99pB5hqmN1pwds7j4bvLDpSDIPSvLg3';

    it('the list sends NULL rather than the envelope as a row label', async () => {
        mockFindMany.mockResolvedValueOnce([
            { id: 'c1', tenantId: 'farm-a', startedAt: new Date(), lastTurnAt: new Date(), _count: { turns: 1 } },
        ]);
        mockFindMany.mockResolvedValueOnce([{ id: 'c1', turns: [{ content: ENVELOPE }] }]);
        const rows = await listPastConversations(ME);
        // `null`, which the client renders as "no question". An envelope
        // rendered as a person's own words is both wrong and a leak of our
        // storage format.
        expect(rows[0].opening).toBeNull();
    });

    it('a transcript turn sends NULL rather than the envelope', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'c1',
            tenantId: 'farm-a',
            startedAt: new Date(),
            lastTurnAt: new Date(),
            _count: { turns: 2 },
        });
        mockTurnFindMany.mockResolvedValue([
            { role: 'assistant', content: ENVELOPE, createdAt: new Date('2026-11-01T09:05:00Z') },
            { role: 'user', content: 'четимо', createdAt: new Date('2026-11-01T09:00:00Z') },
        ]);
        const d = await getPastConversation(ME, 'c1');
        // NOT a throw, and not a dropped turn: the readable half of a
        // transcript is still worth showing, and dropping one would make the
        // gap invisible.
        expect(d.items.map((t) => t.text)).toEqual(['четимо', null]);
        expect(d.items).toHaveLength(2);
    });

    it('recall skips an envelope instead of scanning it', async () => {
        mockFindMany.mockResolvedValueOnce([{ id: 'c1', tenantId: 'farm-a' }]);
        mockFindMany.mockResolvedValueOnce([
            { id: 'c1', turns: [{ role: 'user', content: ENVELOPE, createdAt: new Date() }] },
        ]);
        // An envelope cannot match any needle, so the RESULT is unchanged —
        // the point is that the case is now logged rather than silent, and
        // that no excerpt can ever carry one.
        expect(await searchPastConversations(ME, { query: 'повитица' })).toEqual([]);
    });
});
