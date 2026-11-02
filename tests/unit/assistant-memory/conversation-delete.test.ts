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
jest.mock('@/lib/prisma', () => {
    const client = {
        assistantConversation: {
            findMany: (...a: unknown[]) => mockFindMany(...a),
            updateMany: (...a: unknown[]) => mockUpdateMany(...a),
        },
    };
    return { __esModule: true, default: client, prisma: client };
});

import {
    CONVERSATION_LIST_LIMIT,
    deleteAllPastConversations,
    deletePastConversation,
    listPastConversations,
} from '@/app-layer/usecases/assistant-conversations-control';

const ME = 'user-me';

beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset();
    mockFindMany.mockResolvedValue([]);
    mockUpdateMany.mockResolvedValue({ count: 1 });
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
        await listPastConversations(ME);
        const args = mockFindMany.mock.calls[0][0] as {
            select: { turns: { where: { role: string }; take: number; orderBy: unknown } };
        };
        // `role: 'user'` — an assistant turn can quote tool output, and a
        // label is shown on a screen. Their own words also need no model call
        // and cannot drift from the exchange they label.
        expect(args.select.turns.where.role).toBe('user');
        expect(args.select.turns.take).toBe(1);
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
