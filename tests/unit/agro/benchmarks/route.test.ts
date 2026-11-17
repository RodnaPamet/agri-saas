/**
 * `GET /api/agro-benchmarks` — what the route refuses and the shape it returns.
 */
const getUserCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getUserCtx: (...a: unknown[]) => getUserCtxMock(...a),
}));

import { NextRequest } from 'next/server';

import { unauthorized } from '@/lib/errors/types';

import { GET } from '@/app/api/agro-benchmarks/route';

const NO_PARAMS = { params: Promise.resolve({}) };

function call(qs: string, headers?: Record<string, string>) {
    return GET(new NextRequest(`https://app.agrent.bg/api/agro-benchmarks${qs}`, { headers }), NO_PARAMS);
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

it('refuses an unknown commodity rather than answering with an empty list', async () => {
    expect((await call('?commodity=dragonfruit')).status).toBe(400);
});

it('answers everything without a filter, with its sources', async () => {
    const res = await call('');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe(1);
    expect(Object.keys(body.sources).length).toBeGreaterThan(0);
    expect(body.yields.length).toBeGreaterThan(1);
});

it('narrows to one commodity', async () => {
    const all = await (await call('')).json();
    const one = await (await call('?commodity=wheat')).json();
    expect(one.yields.length).toBeGreaterThan(0);
    expect(one.yields.length).toBeLessThan(all.yields.length);
});

it('answers a repeat with 304 on a matching ETag', async () => {
    const first = await call('');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect((await call('', { 'if-none-match': etag! })).status).toBe(304);
});
