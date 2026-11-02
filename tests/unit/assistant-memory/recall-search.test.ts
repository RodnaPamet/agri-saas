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
/** Every tenant a content read was run under, in order. */
const tenantContexts: string[] = [];
jest.mock('@/lib/prisma', () => {
    const client = { assistantConversation: { findMany: (...a: unknown[]) => mockFindMany(...a) } };
    return { __esModule: true, default: client, prisma: client };
});
/*
 * `withTenantDb` is the seam the content read goes through, and mocking it is
 * the only way this suite can see the property that matters.
 *
 * It had none, and that is why the real defect shipped: the whole file mocked
 * `prisma` and a double hands back whatever string it was given, so plaintext
 * and a `v2:` envelope are the same observation. The implementation read turns
 * person-scoped with no tenant bound, the extension resolved no DEK, and every
 * test here stayed green over a search that matched NOTHING for every query.
 *
 * So the double records the tenant each content read ran under, and a test
 * below asserts it — the unit-level half of the integration proof in
 * `assistant-conversation-window`'s §8.
 */
jest.mock('@/lib/db-context', () => ({
    withTenantDb: async (tenantId: string, cb: (db: unknown) => Promise<unknown>) => {
        tenantContexts.push(tenantId);
        return cb({
            assistantConversation: { findMany: (...a: unknown[]) => mockFindMany(...a) },
        });
    },
}));

import {
    RECALL_CONVERSATION_CAP,
    RECALL_EXCERPT_CHARS,
    RECALL_MAX_EXCERPTS,
    RECALL_TURN_SCAN_CAP,
    searchPastConversations,
} from '@/app-layer/usecases/assistant-conversations-control';

const ME = 'user-me';
const D = (iso: string) => new Date(iso);

const FARM = 'tenant-a';

function conversation(id: string, texts: Array<[string, string]>, tenantId = FARM) {
    return {
        id,
        // Selected by the metadata query, and what routes the content read to
        // the farm whose DEK can decrypt these turns.
        tenantId,
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
    tenantContexts.length = 0;
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

    it('is case-insensitive on BOTH sides, not just the query', async () => {
        /*
         * The query side alone proves nothing: the needle is lowercased once
         * when it is read, so an uppercase QUERY matches whatever the content
         * casing. My first version tested only that, and a mutation making the
         * CONTENT comparison case-sensitive sailed past it.
         *
         * The fixture's assistant turn opens «Повитицата» with a capital П, so
         * this asserts the content is folded too.
         */
        const upperQuery = await searchPastConversations(ME, { query: 'ПОВИТИЦ' });
        expect(upperQuery.length).toBeGreaterThan(0);

        const lowerQuery = await searchPastConversations(ME, { query: 'повитиц' });
        // The capital-П turn must be among them, which is the half a
        // query-only fold misses.
        expect(lowerQuery.some((e) => e.text.startsWith('Повитицата'))).toBe(true);
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

    it('stops SCANNING at the decrypt cap — a match BEYOND it is missed', async () => {
        /*
         * The cap has to be OBSERVABLE or the test is decorative, and my first
         * version was: it asserted an empty result over non-matching content
         * plus `CAP < 1200`, and removing the cap entirely changed neither.
         * Found by mutation.
         *
         * So the match is planted BEYOND the budget. With the cap, it is
         * missed; without it, it is found. That also documents the accepted
         * cost of the owner's date-bounded choice in the one place somebody
         * will look — a match older than the budget needs a date range to
         * reach it.
         */
        const filler = Array.from({ length: 10 }, (_, i) =>
            conversation(
                `c${i}`,
                Array.from({ length: 60 }, () => ['user', 'нищо подобно'] as [string, string]),
            ),
        );
        // 600 filler turns ahead of it, against a 300 cap.
        mockFindMany.mockResolvedValue([
            ...filler,
            conversation('late', [['user', 'ето я повитицата']]),
        ]);
        const out = await searchPastConversations(ME, { query: 'повитица' });
        expect(out).toEqual([]);
        expect(RECALL_TURN_SCAN_CAP).toBeLessThan(600);
    });

    it('and a match INSIDE the budget is found — the control for the above', async () => {
        // Without this, the test above passes for a search that finds nothing
        // ever, which is the same reading as a working cap.
        mockFindMany.mockResolvedValue([
            conversation('early', [['user', 'ето я повитицата']]),
            ...Array.from({ length: 10 }, (_, i) =>
                conversation(
                    `c${i}`,
                    Array.from({ length: 60 }, () => ['user', 'нищо подобно'] as [string, string]),
                ),
            ),
        ]);
        const out = await searchPastConversations(ME, { query: 'повитица' });
        expect(out).toHaveLength(1);
    });

    it('truncates each excerpt', async () => {
        mockFindMany.mockResolvedValue([
            conversation('c1', [['user', `повитица ${'я'.repeat(RECALL_EXCERPT_CHARS + 200)}`]]),
        ]);
        const out = await searchPastConversations(ME, { query: 'повитица' });
        expect(out[0].text).toHaveLength(RECALL_EXCERPT_CHARS);
    });

    it('bounds turns PER conversation, so one long exchange cannot hide the rest', async () => {
        mockFindMany.mockResolvedValue([conversation('c1', [['user', 'нещо']])]);
        await searchPastConversations(ME, { query: 'повитица' });
        // Call 1 is the CONTENT read — call 0 is the metadata query, which
        // selects no turns at all. A nested `take` is per PARENT, which is why
        // the shape stays nested instead of flattening to one turn query.
        const args = mockFindMany.mock.calls[1][0] as {
            select: { turns: { take: number; orderBy: unknown } };
        };
        expect(args.select.turns.take).toBeLessThanOrEqual(60);
        expect(args.select.turns.orderBy).toEqual({ createdAt: 'desc' });
    });
});

describe('the content read runs under a TENANT, because the key is per tenant', () => {
    it('reads turns inside the conversation’s own farm', async () => {
        mockFindMany.mockResolvedValue([conversation('c1', [['user', 'повитица тук']])]);
        const out = await searchPastConversations(ME, { query: 'повитица' });
        expect(out).toHaveLength(1);
        // Without this the search reads ciphertext and matches nothing, with
        // no error and no log — the defect measured 2026-11-02.
        expect(tenantContexts).toEqual([FARM]);
    });

    it('groups by FARM: one context per farm, never one per conversation', async () => {
        mockFindMany.mockResolvedValue([
            conversation('a1', [['user', 'повитица 1']], 'farm-a'),
            conversation('a2', [['user', 'повитица 2']], 'farm-a'),
            conversation('b1', [['user', 'повитица 3']], 'farm-b'),
        ]);
        await searchPastConversations(ME, { query: 'повитица' });
        // Two farms, three conversations, two contexts. A context per
        // conversation would be an N+1 over the cap; a single context would
        // return ciphertext for every other farm.
        expect(tenantContexts).toEqual(['farm-a', 'farm-b']);
    });

    it('asks for nothing when the person has no conversations', async () => {
        mockFindMany.mockResolvedValue([]);
        expect(await searchPastConversations(ME, { query: 'повитица' })).toEqual([]);
        // No empty-`in` content query, which Prisma would run and which would
        // open a transaction for nothing.
        expect(tenantContexts).toEqual([]);
        expect(mockFindMany).toHaveBeenCalledTimes(1);
    });
});
