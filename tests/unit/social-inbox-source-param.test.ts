/**
 * `GET /api/social/inbox?source=…` — the narrowing P8.4 depends on (#2798).
 *
 * This is not a convenience parameter, which is why it has its own suite. The
 * exchange messaging screen fetches the DM half from here and keeps its OWN
 * tenant-scoped query for the other half, because `listInbox`'s exchange half
 * is person-scoped: it admits the caller only as the inquirer or the listing's
 * seller, and does not reproduce `exchange_thread_audience`, which also admits
 * either farm's OWNER/ADMIN.
 *
 * So the two failure directions are not symmetric:
 *
 *   - narrowing when the caller asked for both ⇒ rows silently missing;
 *   - widening when the caller asked for `dm` ⇒ the screen renders some
 *     exchange threads TWICE, from two different audiences, and an owner's
 *     view disagrees with itself.
 *
 * The second is what an unrecognised value falling back to "both" would do,
 * which is why that case is a 400 and why these tests assert `listInbox` was
 * NOT CALLED rather than only checking the status.
 */
const mockGetUserCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getUserCtx: (...a: unknown[]) => mockGetUserCtx(...a),
}));

const mockAssertFeature = jest.fn();
jest.mock('@/lib/feature-flags', () => ({
    assertFeatureEnabled: (...a: unknown[]) => mockAssertFeature(...a),
}));

const mockListInbox = jest.fn();
jest.mock('@/app-layer/usecases/inbox', () => ({
    listInbox: (...a: unknown[]) => mockListInbox(...a),
    INBOX_PAGE_SIZE: 20,
}));

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/social/inbox/route';

/** The second argument Next hands a handler; this route has no segments. */
const NO_CTX = { params: Promise.resolve({}) };

function get(query: string): NextRequest {
    return new NextRequest(`http://t/api/social/inbox${query}`);
}

/** The `options` object the route passed to `listInbox`. */
function passedOptions(): Record<string, unknown> {
    return mockListInbox.mock.calls[0]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserCtx.mockResolvedValue({ userId: 'u1' });
    mockAssertFeature.mockResolvedValue(undefined);
    mockListInbox.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
});

describe('an absent ?source keeps P8.5 unchanged', () => {
    it('does not pass `sources` at all', async () => {
        const res = await GET(get(''), NO_CTX);
        expect(res.status).toBe(200);
        // Absent, not `['dm','exchange']`: the usecase's own default is what
        // every existing caller already gets, and restating it here would be a
        // second place for that default to drift.
        expect(passedOptions()).not.toHaveProperty('sources');
    });
});

describe('a recognised ?source narrows', () => {
    it('passes ["dm"] for source=dm', async () => {
        const res = await GET(get('?source=dm'), NO_CTX);
        expect(res.status).toBe(200);
        expect(passedOptions().sources).toEqual(['dm']);
    });

    it('passes ["exchange"] for source=exchange', async () => {
        await GET(get('?source=exchange'), NO_CTX);
        expect(passedOptions().sources).toEqual(['exchange']);
    });

    it('accepts both, in the order given, and tolerates spaces', async () => {
        await GET(get('?source=exchange,%20dm'), NO_CTX);
        expect(passedOptions().sources).toEqual(['exchange', 'dm']);
    });
});

describe('an unrecognised ?source is REFUSED, never widened', () => {
    it.each([
        ['a bogus value', '?source=bogus'],
        ['an empty value', '?source='],
        ['one bad member beside a good one', '?source=dm,bogus'],
        ['a near-miss in case', '?source=DM'],
    ])('400s on %s and never reaches the usecase', async (_label, query) => {
        const res = await GET(get(query), NO_CTX);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('INVALID_SOURCE');
        // The assertion that matters: a fallback to "both" would be a 200
        // here, and the screen would render some exchange threads twice.
        expect(mockListInbox).not.toHaveBeenCalled();
    });
});
