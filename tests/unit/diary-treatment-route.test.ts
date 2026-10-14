/**
 * The treatment-record route at the HTTP boundary — #1740 gap (2).
 *
 * `tests/integration/diary-treatment.test.ts` drives the usecase against a
 * live database and proves the write's shape: one task per block, the handle
 * stamped, no stock deducted, no notification. This file proves the two things
 * only reachable through the handler, both of which are wiring rather than
 * logic and both of which would break silently.
 *
 *   1. `Idempotency-Key` becomes the TREATMENT HANDLE. The usecase mints a
 *      UUID when it gets nothing, so a route that dropped the header would
 *      still return 201 with a plausible-looking handle — and every offline
 *      replay would write the treatment again. The failure is invisible from
 *      the response.
 *   2. An absent header passes `undefined`, NOT the empty string. `|| undefined`
 *      is doing that, and `?? undefined` would pass `''` for a header sent
 *      blank, which the usecase's `?.trim() ||` happens to tolerate today —
 *      so this pins the contract at the boundary rather than relying on the
 *      other side's leniency.
 */
const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
}));

jest.mock('@/app-layer/usecases/modules', () => ({
    assertModuleEnabled: jest.fn().mockResolvedValue(undefined),
}));

const mockRecord = jest.fn();
const mockGet = jest.fn();
jest.mock('@/app-layer/usecases/diary-treatment', () => ({
    recordDiaryTreatment: (...a: unknown[]) => mockRecord(...a),
    getDiaryTreatment: (...a: unknown[]) => mockGet(...a),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/t/[tenantSlug]/journal/treatments/route';
import { GET } from '@/app/api/t/[tenantSlug]/journal/treatments/[treatmentGroupId]/route';

const BODY = {
    kind: 'SPRAY',
    occurredOn: '2026-03-04',
    parcelIds: ['p1', 'p2'],
    productItemId: 'item-1',
    doseValue: 2,
    doseUnitId: 'unit-1',
};

const params = Promise.resolve({ tenantSlug: 'acme' });

const post = (headers: Record<string, string> = {}) =>
    POST(
        new NextRequest('http://localhost/api/t/acme/journal/treatments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(BODY),
        }),
        { params },
    );

beforeEach(() => {
    jest.clearAllMocks();
    mockGetTenantCtx.mockResolvedValue({ tenantId: 't1', userId: 'u1', role: 'OWNER' });
    mockRecord.mockResolvedValue({
        treatmentGroupId: 'handle-1',
        parcelCount: 2,
        taskIds: ['task-1'],
        replayed: false,
    });
});

describe('POST /api/t/{tenantSlug}/journal/treatments', () => {
    it('passes Idempotency-Key through as the treatment handle', async () => {
        const res = await post({ 'Idempotency-Key': 'abc-123' });

        expect(res.status).toBe(201);
        expect(mockRecord).toHaveBeenCalledTimes(1);
        // The third argument IS the handle. A route that dropped it would look
        // identical from the response, and every replay would write again.
        expect(mockRecord.mock.calls[0][2]).toBe('abc-123');
    });

    it('passes undefined when no key was sent, so the usecase mints one', async () => {
        await post();
        expect(mockRecord.mock.calls[0][2]).toBeUndefined();
    });

    it('returns the handle and counts the saved screen shows', async () => {
        const res = await post({ 'Idempotency-Key': 'abc-123' });
        await expect(res.json()).resolves.toMatchObject({
            treatmentGroupId: 'handle-1',
            parcelCount: 2,
            replayed: false,
        });
    });

    it('refuses a body the schema does not accept, without reaching the usecase', async () => {
        const res = await POST(
            new NextRequest('http://localhost/api/t/acme/journal/treatments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // An instant rather than a day: the register records a DAY.
                body: JSON.stringify({ ...BODY, occurredOn: '2026-03-04T10:00:00Z' }),
            }),
            { params },
        );

        expect(res.status).toBe(400);
        expect(mockRecord).not.toHaveBeenCalled();
    });
});

/**
 * The read's 404, which is the only thing the GET handler owns.
 *
 * `getDiaryTreatment` returns `null` rather than throwing so the PDF route can
 * reuse it without catching — which means the mapping from `null` to a coded
 * 404 lives in the handler and nowhere else. A handler that returned the bare
 * `null` would answer 200 with a JSON `null` body, and a client checking
 * "did I get a 200" would read a treatment that does not exist as one that
 * does. That is the opposite of what this read is for.
 */
describe('GET /api/t/{tenantSlug}/journal/treatments/{treatmentGroupId}', () => {
    const handleParams = Promise.resolve({ tenantSlug: 'acme', treatmentGroupId: 'h1' });
    const get = () =>
        GET(
            new NextRequest('http://localhost/api/t/acme/journal/treatments/h1'),
            { params: handleParams },
        );

    it('404s with a code when nothing was recorded under the handle', async () => {
        mockGet.mockResolvedValue(null);
        const res = await get();
        expect(res.status).toBe(404);
        await expect(res.json()).resolves.toMatchObject({
            error: { code: 'TREATMENT_NOT_FOUND' },
        });
    });

    it('returns the summary, including an INCOMPLETE one, rather than 404ing it', async () => {
        // The half-landed state must come back as a 200 the client can read,
        // not as absent — a 404 here makes it write a duplicate treatment.
        mockGet.mockResolvedValue({
            treatmentGroupId: 'h1',
            parcelCount: 2,
            completedCount: 0,
            taskIds: ['t1'],
            occurredOn: null,
            complete: false,
        });
        const res = await get();
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({
            complete: false, completedCount: 0, parcelCount: 2, taskIds: ['t1'],
        });
    });

    it('passes the handle from the path, not from a query string', async () => {
        mockGet.mockResolvedValue({
            treatmentGroupId: 'h1', parcelCount: 1, completedCount: 1, taskIds: ['t1'],
            occurredOn: '2026-03-04', complete: true,
        });
        await get();
        expect(mockGet.mock.calls[0][1]).toBe('h1');
    });
});
