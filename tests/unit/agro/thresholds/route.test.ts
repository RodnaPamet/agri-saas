/**
 * `GET /api/agro-thresholds` — what the route refuses and the shape it returns.
 */
const getUserCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getUserCtx: (...a: unknown[]) => getUserCtxMock(...a),
}));

import { NextRequest } from 'next/server';

import { unauthorized } from '@/lib/errors/types';

import { GET } from '@/app/api/agro-thresholds/route';

const NO_PARAMS = { params: Promise.resolve({}) };

function call(qs: string, headers?: Record<string, string>) {
    return GET(new NextRequest(`https://app.agrent.bg/api/agro-thresholds${qs}`, { headers }), NO_PARAMS);
}

beforeEach(() => {
    jest.clearAllMocks();
    getUserCtxMock.mockResolvedValue({ userId: 'u-1' });
});

it('requires a signed-in person', async () => {
    getUserCtxMock.mockRejectedValue(unauthorized());
    const res = await call('');
    expect(res.status).toBe(401);
    expect(getUserCtxMock).toHaveBeenCalled();
});

it('refuses an unknown crop rather than answering with an empty list', async () => {
    expect((await call('?crop=dragonfruit')).status).toBe(400);
});

it('answers everything without a filter, with its sources', async () => {
    const res = await call('');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe(1);
    expect(Object.keys(body.sources).length).toBeGreaterThan(0);
    expect(body.thresholds.length).toBeGreaterThan(1);
});

it('narrows to one crop', async () => {
    const all = await (await call('')).json();
    const one = await (await call('?crop=wheat')).json();
    expect(one.thresholds.length).toBeGreaterThan(0);
    expect(one.thresholds.length).toBeLessThan(all.thresholds.length);
});

it('answers a repeat with 304 on a matching ETag', async () => {
    const first = await call('');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect((await call('', { 'if-none-match': etag! })).status).toBe(304);
});
