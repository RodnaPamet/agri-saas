/**
 * `GET /api/agro-progress` (#3173): the newest snapshot, signed-in only, and
 * `progress: null` — not an error — before the job has stored one.
 */
const findFirst = jest.fn();
jest.mock('@/lib/prisma', () => ({ prisma: { campaignProgressSnapshot: { findFirst: (...a: unknown[]) => findFirst(...a) } } }));
const getUserCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({ getUserCtx: (...a: unknown[]) => getUserCtx(...a) }));

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/agro-progress/route';
import { getCampaignProgress } from '@/app-layer/usecases/campaign-progress';

const call = () => GET(new NextRequest('http://localhost/api/agro-progress'), { params: Promise.resolve({}) } as never);

beforeEach(() => {
    jest.clearAllMocks();
    getUserCtx.mockResolvedValue({ userId: 'u1' });
});

it('serves the newest snapshot, dates as days', async () => {
    findFirst.mockResolvedValue({
        asOf: new Date('2026-11-05T00:00:00Z'),
        bulletinDate: new Date('2026-11-11T00:00:00Z'),
        sourceUrl: 'https://www.mzh.government.bg/media/filer_public/2026/11/11/operativen_analiz_2026-11-11.pdf',
        tablesJson: { harvest: [{ asOf: '2026-11-05', lastYear: 2025, title: 'Реколта', rows: [] }], sowing: [] },
    });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress).toMatchObject({ asOf: '2026-11-05', bulletinDate: '2026-11-11', sowing: [] });
    expect(findFirst.mock.calls[0][0].orderBy[0]).toEqual({ asOf: 'desc' });
});

it('answers null before any snapshot', async () => {
    findFirst.mockResolvedValue(null);
    expect(await (await call()).json()).toEqual({ progress: null });
});

it('refuses an anonymous caller', async () => {
    getUserCtx.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
    const res = await call();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(findFirst).not.toHaveBeenCalled();
});

it('the usecase reads the newest by «към» date and tolerates a snapshot missing a table kind', async () => {
    findFirst.mockResolvedValue({
        asOf: new Date('2026-07-09T00:00:00Z'),
        bulletinDate: new Date('2026-07-15T00:00:00Z'),
        sourceUrl: 'https://www.mzh.government.bg/x.pdf',
        tablesJson: { harvest: [] },
    });
    await expect(getCampaignProgress()).resolves.toMatchObject({ asOf: '2026-07-09', harvest: [], sowing: [] });
    expect(findFirst.mock.calls[0][0].orderBy).toEqual([{ asOf: 'desc' }, { bulletinDate: 'desc' }]);
});
