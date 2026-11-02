/**
 * Recall over a person's past exchanges (#2695).
 *
 * The design is forced by encryption, not chosen: `AssistantTurn.content` is
 * ciphertext at rest, so there is no SQL text search — `LIKE` sees a `v2:`
 * envelope and `hashForLookup` is an exact-match HMAC. Matching words means
 * decrypting and comparing in memory, so the DATE filter narrows and a cap
 * bounds what is left (owner decision 2026-11-02).
 *
 * Which makes the BOUNDS part of the contract rather than an implementation
 * detail, and that is most of what this suite asserts.
 */
const mockFindMany = jest.fn();
jest.mock('@/lib/prisma', () => {
    const client = { assistantConversation: { findMany: (...a: unknown[]) => mockFindMany(...a) } };
    return { __esModule: true, default: client, prisma: client };
});

import {
    RECALL_CONVERSATION_CAP,
    RECALL_EXCERPT_CHARS,
    RECALL_MAX_EXCERPTS,
    RECALL_TURN_SCAN_CAP,
    searchPastConversations,
} from '@/app-layer/usecases/assistant-conversations-control';

const ME = 'user-me';
const D = (iso: string) => new Date(iso);

function conversation(id: string, texts: Array<[string, string]>) {
    return {
        id,
        turns: texts.map(([role, content], i) => ({
            role,
            content,
            createdAt: D(`2026-10-${String(10 + i).padStart(2, '0')}T09:00:00Z`),
        })),
    };
}

beforeEach(() => {
    mockFindMany.mockReset();
    mockFindMany.mockResolvedValue([]);
});

describe('the query', () => {
    it('excludes DELETED conversations — #2695 constraint 3', async () => {
        await searchPastConversations(ME, { query: 'повитица' });
        const args = mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
        // The tombstone landed FIRST so this filter exists before recall does.
        // Without it, a search resurrects exchanges the person deleted — and
        // it would look correct until somebody asked the right question.
        expect(args.where.deletedAt).toBeNull();
        expect(args.where.userId).toBe(ME);
    });

    it('is person-scoped ACROSS farms — no tenantId anywhere', async () => {
        await searchPastConversations(ME, { query: 'повитица' });
        const args = mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
        expect(args.where).not.toHaveProperty('tenantId');
    });

    it('applies the date range, which is what reaches older exchanges', async () => {
        await searchPastConversations(ME, {
            query: 'повитица',
            from: '2026-09-01',
            to: '2026-09-30',
        });
        const args = mockFindMany.mock.calls[0][0] as {
            where: { lastTurnAt?: { gte?: Date; lte?: Date } };
        };
        expect(args.where.lastTurnAt?.gte).toEqual(D('2026-09-01'));
        expect(args.where.lastTurnAt?.lte).toEqual(D('2026-09-30'));
    });

    it('omits the date filter entirely when no range is given', async () => {
        await searchPastConversations(ME, { query: 'повитица' });
        const args = mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
        // Not `{ gte: undefined }` — Prisma would treat an empty object as a
        // filter and the newest-first cap is what bounds it instead.
        expect(args.where).not.toHaveProperty('lastTurnAt');
    });

    it('bounds the conversations it reads', async () => {
        await searchPastConversations(ME, { query: 'повитица' });
        const args = mockFindMany.mock.calls[0][0] as { take: number; orderBy: unknown };
        expect(args.take).toBe(RECALL_CONVERSATION_CAP);
        expect(args.orderBy).toEqual({ lastTurnAt: 'desc' });
    });
});

describe('matching, in the language the product is in', () => {
    beforeEach(() => {
        mockFindMany.mockResolvedValue([
            conversation('c1', [
                ['user', 'Имам проблем с повитицата в пшеницата'],
                ['assistant', 'Повитицата се третира с хербицид'],
                ['user', 'благодаря'],
            ]),
        ]);
    });

    it('matches a SUBSTRING, so a stem finds an inflected form', async () => {
        // A `\b`-anchored regex would find NOTHING here: JavaScript's word
        // boundary is ASCII-only, so /\bповитиц/ never matches Cyrillic. A
        // boundary-based search would return empty for every Bulgarian query
        // and look like "nothing was said".
        const out = await searchPastConversations(ME, { query: 'повитиц' });
        expect(out.length).toBeGreaterThan(0);
        expect(out.some((e) => e.text.includes('повитицата'))).toBe(true);
    });

    it('is case-insensitive across Cyrillic', async () => {
        const out = await searchPastConversations(ME, { query: 'ПОВИТИЦ' });
        expect(out.length).toBeGreaterThan(0);
    });

    it('labels who said it, and dates each excerpt to a DAY', async () => {
        const out = await searchPastConversations(ME, { query: 'повитиц' });
        expect(out.map((e) => e.role)).toContain('assistant');
        expect(out.map((e) => e.role)).toContain('user');
        // A day, not a timestamp: the model can say "on the 14th" and a
        // timestamp would invite false precision about when exactly.
        expect(out[0].on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns nothing for a query too short to mean anything', async () => {
        expect(await searchPastConversations(ME, { query: 'а' })).toEqual([]);
        // And does not even ask the database.
        expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('a non-match returns EMPTY rather than everything', async () => {
        expect(await searchPastConversations(ME, { query: 'трактор' })).toEqual([]);
    });
});

describe('the bounds are the contract', () => {
    it('stops at RECALL_MAX_EXCERPTS', async () => {
        mockFindMany.mockResolvedValue([
            conversation(
                'c1',
                Array.from({ length: 30 }, () => ['user', 'повитица пак'] as [string, string]),
            ),
        ]);
        const out = await searchPastConversations(ME, { query: 'повитица' });
        expect(out).toHaveLength(RECALL_MAX_EXCERPTS);
    });

    it('stops SCANNING at the decrypt cap even when nothing matches', async () => {
        // The cap that makes this affordable. Every turn read here was
        // decrypted, so an unbounded scan is an unbounded cost that grows with
        // the person's history — which is what the owner rejected.
        const many = Array.from({ length: 20 }, (_, i) =>
            conversation(
                `c${i}`,
                Array.from({ length: 60 }, () => ['user', 'нищо подобно'] as [string, string]),
            ),
        );
        mockFindMany.mockResolvedValue(many);
        const out = await searchPastConversations(ME, { query: 'повитица' });
        expect(out).toEqual([]);
        // 20 × 60 = 1200 turns available; the cap is what stopped it.
        expect(RECALL_TURN_SCAN_CAP).toBeLessThan(1200);
    });

    it('truncates each excerpt', async () => {
        mockFindMany.mockResolvedValue([
            conversation('c1', [['user', `повитица ${'я'.repeat(RECALL_EXCERPT_CHARS + 200)}`]]),
        ]);
        const out = await searchPastConversations(ME, { query: 'повитица' });
        expect(out[0].text).toHaveLength(RECALL_EXCERPT_CHARS);
    });

    it('bounds turns PER conversation, so one long exchange cannot hide the rest', async () => {
        await searchPastConversations(ME, { query: 'повитица' });
        const args = mockFindMany.mock.calls[0][0] as {
            select: { turns: { take: number; orderBy: unknown } };
        };
        expect(args.select.turns.take).toBeLessThanOrEqual(60);
        expect(args.select.turns.orderBy).toEqual({ createdAt: 'desc' });
    });
});
