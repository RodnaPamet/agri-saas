/**
 * #3193 — the channel search route passes the `beforeId` tie-breaker on.
 *
 * `searchChannelPosts` already handled it (p9-7-search-tie-break proves that
 * at the usecase); the route parsed only `before`, so a client paging over
 * HTTP lost every row tied with the page boundary.
 */
import { NextRequest } from 'next/server';

const searchChannelPosts = jest.fn(async () => ({ hits: [], hasMore: false }));
jest.mock('@/app-layer/usecases/channels', () => ({
    ...jest.requireActual('@/app-layer/usecases/channels'),
    searchChannelPosts: (...a: unknown[]) => searchChannelPosts(...(a as [])),
}));
jest.mock('@/app-layer/context', () => ({
    ...jest.requireActual('@/app-layer/context'),
    getUserCtx: jest.fn(async () => ({ requestId: 'r', userId: 'u1' })),
}));
jest.mock('@/lib/feature-flags', () => ({
    ...jest.requireActual('@/lib/feature-flags'),
    assertFeatureEnabled: jest.fn(async () => undefined),
    isFeatureEnabled: jest.fn(async () => true),
}));

import { GET } from '@/app/api/social/channel-search/route';

it('hands `before` AND `beforeId` to the search', async () => {
    const before = '2026-11-18T10:00:00.000Z';
    await GET(
        new NextRequest(`http://localhost/api/social/channel-search?q=нива&before=${before}&beforeId=post-9`),
        { params: Promise.resolve({}) },
    );
    expect(searchChannelPosts).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ before: new Date(before), beforeId: 'post-9' }),
    );
});
