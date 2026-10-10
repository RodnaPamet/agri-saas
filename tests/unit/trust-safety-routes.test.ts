/**
 * The notice routes at the HTTP boundary (P5.2, #1593).
 *
 * The integration suite (`tests/integration/p5-2-report-intake.test.ts`) drives
 * the usecase against a live database and proves the RLS arm. This one proves
 * the things only reachable through the handler:
 *
 *   1. the anonymous route accepts a body from NOBODY — the Art 16 duty;
 *   2. it discloses nothing about the subject, so it is not an enumeration
 *      oracle;
 *   3. the signed-in route REFUSES without a session;
 *   4. the reporter is taken from the session and a body value is ignored.
 *
 * ## Why (2) needs its own test
 *
 * It is the one property that cannot be seen from the usecase. `fileNotice`
 * returns the same shape whether or not the subject existed — the difference is
 * recorded on the snapshot — so the claim "the response does not reveal it" is
 * a claim about the ROUTE, and it would be broken by a well-meaning change that
 * surfaced `captureError` to the caller "so the client can show a better
 * message".
 */
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: (...a: unknown[]) => mockAuth(...a) }));

const mockFileNotice = jest.fn();
const mockListOwnReports = jest.fn();
jest.mock('@/app-layer/usecases/trust-safety', () => ({
    fileNotice: (...a: unknown[]) => mockFileNotice(...a),
    listOwnReports: (...a: unknown[]) => mockListOwnReports(...a),
}));

import { NextRequest } from 'next/server';

import { POST as postNotice } from '@/app/api/public/notices/route';
import { POST as postReport, GET as getReports } from '@/app/api/social/reports/route';

const VALID = {
    subjectKind: 'LISTING',
    subjectId: 'listing-abc',
    reasonCode: 'MISLEADING_LISTING',
    detail: 'the grade is not as stated',
};

/**
 * The second argument Next hands a route handler. These routes take no dynamic
 * segments, so it is empty — but `withApiErrorHandling` types it, and omitting
 * it compiles only because the handler ignores it. Passing it keeps the test
 * calling the handler the way the framework does.
 */
const NO_CTX = { params: Promise.resolve({}) };

function post(url: string, body: unknown): NextRequest {
    return new NextRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockFileNotice.mockResolvedValue({ id: 'cr-test', status: 'RECEIVED' });
    mockListOwnReports.mockResolvedValue([]);
});

describe('POST /api/public/notices — the anonymous Art 16 duty', () => {
    it('accepts a notice with NO session at all', async () => {
        // `auth()` returning null is the whole point: Art 16 requires a
        // mechanism any person can use, so requiring an account would be
        // requiring an account to exercise a right.
        mockAuth.mockResolvedValue(null);
        const res = await postNotice(post('http://t/api/public/notices', VALID), NO_CTX);
        expect(res.status).toBe(201);
        await expect(res.json()).resolves.toEqual({ id: 'cr-test', status: 'RECEIVED' });
    });

    it('files with a NULL reporter — DECISION 5, no identifier at all', async () => {
        mockAuth.mockResolvedValue(null);
        await postNotice(post('http://t/api/public/notices', VALID), NO_CTX);
        expect(mockFileNotice).toHaveBeenCalledTimes(1);
        // Second argument is the reporter. `null`, not an IP and not a hash of
        // one: the limiter sees the address, the row never does.
        expect(mockFileNotice.mock.calls[0][1]).toBeNull();
    });

    it('IGNORES a client-supplied reporterUserId rather than rejecting it', async () => {
        // Dropped, not 400ed, so a caller can neither attribute a notice to
        // someone else nor learn from an error whether the field exists.
        mockAuth.mockResolvedValue(null);
        const res = await postNotice(
            post('http://t/api/public/notices', { ...VALID, reporterUserId: 'u-victim' }),
            NO_CTX,
        );
        expect(res.status).toBe(201);
        expect(mockFileNotice.mock.calls[0][0]).not.toHaveProperty('reporterUserId');
        expect(mockFileNotice.mock.calls[0][1]).toBeNull();
    });

    it('IGNORES a client-supplied status', async () => {
        mockAuth.mockResolvedValue(null);
        await postNotice(post('http://t/api/public/notices', { ...VALID, status: 'REJECTED' }), NO_CTX);
        expect(mockFileNotice.mock.calls[0][0]).not.toHaveProperty('status');
    });

    it('discloses NOTHING about the subject — not an enumeration oracle', async () => {
        // The usecase records SUBJECT_NOT_FOUND on the snapshot for the
        // moderator. The response must not carry it, or an unauthenticated
        // caller could tell a real listing id from a made-up one by filing
        // notices.
        mockAuth.mockResolvedValue(null);
        const res = await postNotice(post('http://t/api/public/notices', VALID), NO_CTX);
        const body = (await res.json()) as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['id', 'status']);
        expect(JSON.stringify(body)).not.toMatch(/NOT_FOUND|captureError|snapshot/i);
    });

    it.each([
        ['malformed JSON', '{not json'],
        ['a missing subjectKind', { subjectId: 'x', reasonCode: 'SPAM' }],
        ['an unknown subjectKind', { ...VALID, subjectKind: 'GALAXY' }],
        ['an unknown reasonCode', { ...VALID, reasonCode: 'VIBES' }],
        ['an empty subjectId', { ...VALID, subjectId: '' }],
    ])('400s on %s, with a uniform body', async (_label, body) => {
        mockAuth.mockResolvedValue(null);
        const res = await postNotice(post('http://t/api/public/notices', body), NO_CTX);
        expect(res.status).toBe(400);
        // Uniform: no field names, because a validation message would tell an
        // unauthenticated caller the schema, and the accepted `reasonCode`
        // values are a product decision rather than public API surface.
        await expect(res.json()).resolves.toEqual({ error: 'invalid_request' });
        expect(mockFileNotice).not.toHaveBeenCalled();
    });

    it('accepts a notice with NO detail — Art 16 does not require prose', async () => {
        mockAuth.mockResolvedValue(null);
        const { detail: _omitted, ...noDetail } = VALID;
        const res = await postNotice(post('http://t/api/public/notices', noDetail), NO_CTX);
        expect(res.status).toBe(201);
    });
});

describe('POST /api/social/reports — the signed-in half', () => {
    it('REFUSES without a session', async () => {
        mockAuth.mockResolvedValue(null);
        // `withApiErrorHandling` CATCHES the thrown `unauthorized()` and
        // answers 401, so the assertion is on the response a client gets
        // rather than on a rejected promise. Written as `.rejects` first,
        // which is how I learned the wrapper converts it.
        const res = await postReport(post('http://t/api/social/reports', VALID), NO_CTX);
        expect(res.status).toBe(401);
        expect(mockFileNotice).not.toHaveBeenCalled();
    });

    it('files with the reporter from the SESSION, not the body', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u-real' }, userId: 'u-real' });
        const res = await postReport(
            post('http://t/api/social/reports', { ...VALID, reporterUserId: 'u-someone-else' }),
            NO_CTX,
        );
        expect(res.status).toBe(201);
        expect(mockFileNotice.mock.calls[0][1]).toBe('u-real');
    });
});

describe('GET /api/social/reports — my notices', () => {
    it('REFUSES without a session', async () => {
        mockAuth.mockResolvedValue(null);
        const res = await getReports(new NextRequest('http://t/api/social/reports'), NO_CTX);
        expect(res.status).toBe(401);
        expect(mockListOwnReports).not.toHaveBeenCalled();
    });

    it('returns an empty list as a real answer, not an error', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u-real' }, userId: 'u-real' });
        mockListOwnReports.mockResolvedValue([]);
        const res = await getReports(new NextRequest('http://t/api/social/reports'), NO_CTX);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ reports: [] });
    });

    it('passes the PERSON context through, which is what the policy arm needs', async () => {
        // The failure this pins: a refactor that passed a tenant context here
        // would make the arm match nothing and return `[]` forever, with no
        // error anywhere.
        mockAuth.mockResolvedValue({ user: { id: 'u-real' }, userId: 'u-real' });
        await getReports(new NextRequest('http://t/api/social/reports'), NO_CTX);
        expect(mockListOwnReports).toHaveBeenCalledTimes(1);
        const ctx = mockListOwnReports.mock.calls[0][0] as Record<string, unknown>;
        expect(ctx.userId).toBe('u-real');
        // A UserContext has no tenant, and that absence is load-bearing:
        // `runInUserContext` must not set `app.tenant_id`.
        expect(ctx).not.toHaveProperty('tenantId');
    });
});
