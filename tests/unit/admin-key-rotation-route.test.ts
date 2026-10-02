/**
 * The platform master-KEK rotation route: gated, reachable, and honest about
 * whether a sweep could have done anything.
 *
 * Why the reachability half is here and not left to a guard: every assertion
 * that drives a handler directly would still pass on a route the Edge 401s
 * before the handler runs — the SCIM / `iflk_` / signed-webhook shape, now
 * seven prior instances in this repo. `isPublicPath` is the real function.
 */
import type { NextRequest } from 'next/server';
import { isPublicPath } from '@/lib/auth/guard';

export {};

const HEADER = 'x-platform-admin-key';
const REAL_KEY = 'r'.repeat(48); // pragma: allowlist secret -- test fixture

const sweepMock = jest.fn();
const countMock = jest.fn();
const inFlightMock = jest.fn();

function makeReq(opts: { method?: string; key?: string; body?: string } = {}): NextRequest {
    const headers = new Headers();
    if (opts.key !== undefined) headers.set(HEADER, opts.key);
    const url = new URL('http://localhost:3000/api/admin/key-rotation');
    return {
        method: opts.method ?? 'GET',
        headers,
        nextUrl: url,
        url: url.toString(),
        text: async () => opts.body ?? '',
    } as unknown as NextRequest;
}

type Handler = (req: NextRequest) => Promise<Response>;

function loadRoute(key: string | undefined): { GET: Handler; POST: Handler } {
    jest.resetModules();
    jest.doMock('@/env', () => ({
        env: { PLATFORM_ADMIN_API_KEY: key, PLATFORM_ADMIN_API_KEY_PREVIOUS: undefined },
    }));
    jest.doMock('@/app-layer/usecases/global-key-rotation', () => ({
        sweepGlobalKeyRotation: sweepMock,
        countUnmigrated: countMock,
        sweepableColumns: () => [
            { model: 'User', table: 'User', manifestName: 'emailEncrypted', column: 'emailEncrypted', manifest: 'pii' },
            { model: 'Task', table: 'Task', manifestName: 'description', column: 'description', manifest: 'encrypted-fields' },
        ],
    }));
    jest.doMock('@/lib/security/encryption', () => ({
        ...jest.requireActual('@/lib/security/encryption'),
        kekRotationInFlight: inFlightMock,
    }));
    return require('@/app/api/admin/key-rotation/route');
}

beforeEach(() => {
    jest.clearAllMocks();
    countMock.mockResolvedValue({ total: 0, perColumn: [] });
    inFlightMock.mockReturnValue(true);
    sweepMock.mockResolvedValue({
        rotationInFlight: true,
        columns: 2,
        perColumn: [],
        totalScanned: 4,
        totalRewritten: 4,
        totalAlreadyPrimary: 0,
        totalErrors: 0,
        remaining: 0,
        durationMs: 12,
    });
});

describe('the route is REACHABLE, which the gate below cannot tell you', () => {
    it('bypasses the Edge session gate', () => {
        expect(isPublicPath('/api/admin/key-rotation')).toBe(true);
    });

    it('and the opening does not widen to a neighbour', () => {
        // Exact entry + children prefix, so a future sibling needs its own.
        expect(isPublicPath('/api/admin/key-rotation-report')).toBe(false);
        expect(isPublicPath('/api/admin/key-rotationX')).toBe(false);
        // Control: the predicate discriminates.
        expect(isPublicPath('/api/admin/diagnostics')).toBe(false);
        expect(isPublicPath('/api/readyz')).toBe(true);
    });

    it('the TENANT-scoped sibling stays behind the session gate', () => {
        // Unrelated route, different auth model (requirePermission). Opening it
        // would strip a real permission check.
        expect(isPublicPath('/api/t/acme/admin/key-rotation')).toBe(false);
    });
});

describe('the gate covers both methods', () => {
    it('503s with no platform key configured, touching nothing', async () => {
        const { GET, POST } = loadRoute(undefined);
        expect((await GET(makeReq({ key: REAL_KEY }))).status).toBe(503);
        expect((await POST(makeReq({ method: 'POST', key: REAL_KEY }))).status).toBe(503);
        expect(countMock).not.toHaveBeenCalled();
        expect(sweepMock).not.toHaveBeenCalled();
    });

    it.each([
        ['missing header', undefined],
        ['wrong key', 'q'.repeat(48)],
        ['empty key', ''],
    ])('401s on %s — and does NOT run a sweep', async (_l, key) => {
        const { GET, POST } = loadRoute(REAL_KEY);
        expect((await GET(makeReq({ key }))).status).toBe(401);
        expect((await POST(makeReq({ method: 'POST', key }))).status).toBe(401);
        expect(sweepMock).not.toHaveBeenCalled();
    });
});

describe('GET answers "may I remove DATA_ENCRYPTION_KEY_PREVIOUS yet?"', () => {
    it('remaining 0 -> previousKeyRetirable true', async () => {
        countMock.mockResolvedValue({
            total: 0,
            perColumn: [{ model: 'User', column: 'emailEncrypted', unmigrated: 0, v1Total: 6 }],
        });
        const { GET } = loadRoute(REAL_KEY);
        const body = await (await GET(makeReq({ key: REAL_KEY }))).json();
        // Note v1Total is 6 while unmigrated is 0 — the whole reason the field
        // exists. `LIKE 'v1:%'` would have reported 6 rows of outstanding work
        // forever, because a migrated row is still `v1:`.
        expect(body.remaining).toBe(0);
        expect(body.previousKeyRetirable).toBe(true);
        expect(body.columns[0].v1Total).toBe(6);
    });

    it('remaining > 0 -> previousKeyRetirable false', async () => {
        countMock.mockResolvedValue({
            total: 3,
            perColumn: [{ model: 'User', column: 'emailEncrypted', unmigrated: 3, v1Total: 6 }],
        });
        const { GET } = loadRoute(REAL_KEY);
        const body = await (await GET(makeReq({ key: REAL_KEY }))).json();
        expect(body.remaining).toBe(3);
        expect(body.previousKeyRetirable).toBe(false);
    });

    it('reports whether a rotation is in flight', async () => {
        inFlightMock.mockReturnValue(false);
        const { GET } = loadRoute(REAL_KEY);
        const body = await (await GET(makeReq({ key: REAL_KEY }))).json();
        expect(body.rotationInFlight).toBe(false);
    });
});

describe('POST runs a pass and reports the manifest union', () => {
    it('returns the sweep result plus the retirable verdict', async () => {
        const { POST } = loadRoute(REAL_KEY);
        const res = await POST(makeReq({ method: 'POST', key: REAL_KEY }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.totalRewritten).toBe(4);
        expect(body.remaining).toBe(0);
        expect(body.previousKeyRetirable).toBe(true);
        // Surfaced so an operator can SEE that both manifests are covered —
        // the whole defect was a sweep that silently knew only one.
        expect(body.manifests).toEqual(['encrypted-fields', 'pii']);
    });

    it('an empty body is fine; a malformed one is 400 without sweeping', async () => {
        const { POST } = loadRoute(REAL_KEY);
        expect((await POST(makeReq({ method: 'POST', key: REAL_KEY, body: '' }))).status).toBe(200);

        jest.clearAllMocks();
        const { POST: P2 } = loadRoute(REAL_KEY);
        expect((await P2(makeReq({ method: 'POST', key: REAL_KEY, body: '{not json' }))).status).toBe(400);
        expect(sweepMock).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range batchSize rather than clamping silently', async () => {
        const { POST } = loadRoute(REAL_KEY);
        const res = await POST(makeReq({ method: 'POST', key: REAL_KEY, body: '{"batchSize":5000}' }));
        expect(res.status).toBe(400);
        expect(sweepMock).not.toHaveBeenCalled();
    });

    it('passes a valid batchSize through', async () => {
        const { POST } = loadRoute(REAL_KEY);
        await POST(makeReq({ method: 'POST', key: REAL_KEY, body: '{"batchSize":50}' }));
        expect(sweepMock).toHaveBeenCalledWith({ batchSize: 50 });
    });
});
