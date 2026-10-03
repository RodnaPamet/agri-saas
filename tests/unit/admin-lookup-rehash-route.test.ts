/**
 * The lookup-hash rehash route: gated, REACHABLE, and honest about the verdict.
 *
 * The reachability half is here rather than left to a guard for the reason the
 * sibling key-rotation suite gives: every assertion that drives a handler
 * directly still passes on a route the Edge 401s before the handler runs. That
 * has been the shape of eight defects in this repo (SCIM, `iflk_` keys, three
 * signed webhooks, the flag console, both key-rotation paths), and an
 * `x-platform-admin-key` request carries no NextAuth JWE, so it is the DEFAULT
 * outcome for a new platform route rather than an unlucky one.
 *
 * The verdict half matters because an operator deletes a key based on it. A
 * route that reported `previousKeyRetirable: true` one pass early would make
 * every row still on the old hash permanently unfindable — the account exists
 * and no lookup can reach it.
 */
import type { NextRequest } from 'next/server';
import { isPublicPath } from '@/lib/auth/guard';

export {};

const HEADER = 'x-platform-admin-key';
const REAL_KEY = 'k'.repeat(48); // pragma: allowlist secret -- test fixture

const countMock = jest.fn();
const rehashMock = jest.fn();
const retirableMock = jest.fn();
const pinnedMock = jest.fn();

type Handler = (req: NextRequest) => Promise<Response>;

function makeReq(opts: { method?: string; key?: string; body?: string } = {}): NextRequest {
    const headers = new Headers();
    if (opts.key !== undefined) headers.set(HEADER, opts.key);
    const url = new URL('http://localhost:3000/api/admin/lookup-rehash');
    return {
        method: opts.method ?? 'GET',
        headers,
        nextUrl: url,
        url: url.toString(),
        text: async () => opts.body ?? '',
    } as unknown as NextRequest;
}

function loadRoute(key: string | undefined): { GET: Handler; POST: Handler } {
    jest.resetModules();
    jest.doMock('@/env', () => ({
        env: { PLATFORM_ADMIN_API_KEY: key, PLATFORM_ADMIN_API_KEY_PREVIOUS: undefined },
    }));
    jest.doMock('@/app-layer/usecases/lookup-rehash', () => ({
        countStaleLookupHashes: countMock,
        rehashLookupHashes: rehashMock,
        lookupPreviousKeyRetirable: retirableMock,
    }));
    jest.doMock('@/lib/security/encryption', () => ({ isLookupKeyPinned: pinnedMock }));
    return require('@/app/api/admin/lookup-rehash/route');
}

const CLEAN = {
    total: 4,
    stale: 0,
    perColumn: [
        { model: 'User', hashColumn: 'emailHash', total: 3, stale: 0, undecryptable: 0 },
        {
            model: 'UserIdentityLink',
            hashColumn: 'emailAtLinkTimeHash',
            total: 1,
            stale: 0,
            undecryptable: 0,
        },
    ],
};

beforeEach(() => {
    jest.clearAllMocks();
    pinnedMock.mockReturnValue(true);
    countMock.mockResolvedValue(CLEAN);
    retirableMock.mockResolvedValue({ retirable: true, stale: 0, undecryptable: 0 });
    rehashMock.mockResolvedValue([]);
});

describe('the Edge lets this path through at all', () => {
    it('is public to the middleware, or the handler below never runs', () => {
        expect(isPublicPath('/api/admin/lookup-rehash')).toBe(true);
    });

    it('does NOT open a neighbouring path', () => {
        // The reason the entry is exact with no children prefix: there are no
        // child paths, and `startsWith('/api/admin/lookup-rehash')` would open
        // these three as a side effect.
        expect(isPublicPath('/api/admin/lookup-rehash-report')).toBe(false);
        expect(isPublicPath('/api/admin/lookup-rehashing')).toBe(false);
        expect(isPublicPath('/api/admin/lookup-rehash/anything')).toBe(false);
    });
});

describe('the platform gate', () => {
    it.each(['GET', 'POST'])('%s with no header is refused', async (method) => {
        const route = loadRoute(REAL_KEY);
        const res = await (method === 'GET' ? route.GET : route.POST)(makeReq({ method }));
        expect(res.status).toBe(401);
        expect(countMock).not.toHaveBeenCalled();
        expect(rehashMock).not.toHaveBeenCalled();
    });

    it.each(['GET', 'POST'])('%s with a WRONG header is refused', async (method) => {
        const route = loadRoute(REAL_KEY);
        const res = await (method === 'GET' ? route.GET : route.POST)(
            makeReq({ method, key: 'x'.repeat(48) }),
        );
        expect(res.status).toBe(401);
        expect(rehashMock).not.toHaveBeenCalled();
    });

    it('fails CLOSED when no key is configured, even with a matching header', async () => {
        // The deployment-without-the-variable case. An unconfigured gate that
        // accepted `''` would be an open sweep endpoint.
        //
        // 503, not 401, and that distinction is deliberate upstream: 503 says
        // the capability is not configured on this deployment, 401 says the
        // credential was wrong. An operator seeing 401 would go hunting for the
        // right key; one seeing 503 knows to set the variable. What matters for
        // the security property is the same either way — nothing was swept.
        const route = loadRoute(undefined);
        const res = await route.POST(makeReq({ method: 'POST', key: '' }));
        expect(res.status).toBe(503);
        expect(rehashMock).not.toHaveBeenCalled();
    });
});

describe('GET answers the question an operator is actually asking', () => {
    it('reports the verdict, the counts, and whether a lookup key is even pinned', async () => {
        const route = loadRoute(REAL_KEY);
        const res = await route.GET(makeReq({ key: REAL_KEY }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
            lookupKeyPinned: true,
            total: 4,
            stale: 0,
            previousKeyRetirable: true,
            undecryptable: 0,
        });
        expect(body.perColumn).toHaveLength(2);
    });

    it('scans ONCE — the verdict is handed the counts, not left to re-scan', async () => {
        // Every row in scope is decrypted to answer this. Two independent calls
        // decrypted the whole user table twice, which on a real deployment is
        // the difference between a slow endpoint and a timeout.
        const route = loadRoute(REAL_KEY);
        await route.GET(makeReq({ key: REAL_KEY }));
        expect(countMock).toHaveBeenCalledTimes(1);
        expect(retirableMock).toHaveBeenCalledWith(CLEAN);
    });

    it('says NOT retirable while anything is stale', async () => {
        countMock.mockResolvedValue({ ...CLEAN, stale: 2 });
        retirableMock.mockResolvedValue({ retirable: false, stale: 2, undecryptable: 0 });
        const route = loadRoute(REAL_KEY);
        const body = await (await route.GET(makeReq({ key: REAL_KEY }))).json();
        expect(body.previousKeyRetirable).toBe(false);
        expect(body.stale).toBe(2);
    });

    it('says NOT retirable when nothing is stale but something is UNDECRYPTABLE', async () => {
        // The dangerous direction. `stale: 0` alone reads as finished, and an
        // operator who deleted the key here would lose the row for good.
        retirableMock.mockResolvedValue({ retirable: false, stale: 0, undecryptable: 1 });
        const route = loadRoute(REAL_KEY);
        const body = await (await route.GET(makeReq({ key: REAL_KEY }))).json();
        expect(body.stale).toBe(0);
        expect(body.undecryptable).toBe(1);
        expect(body.previousKeyRetirable).toBe(false);
    });

    it('surfaces an UNPINNED lookup key, because it changes what `stale: 0` means', async () => {
        // With no pinned key the hashes derive from the KEK and nothing CAN be
        // stale, so `stale: 0` means "not applicable" rather than "swept".
        pinnedMock.mockReturnValue(false);
        const route = loadRoute(REAL_KEY);
        const body = await (await route.GET(makeReq({ key: REAL_KEY }))).json();
        expect(body.lookupKeyPinned).toBe(false);
    });

    it('does not WRITE', async () => {
        const route = loadRoute(REAL_KEY);
        await route.GET(makeReq({ key: REAL_KEY }));
        expect(rehashMock).not.toHaveBeenCalled();
    });
});

describe('POST runs one pass and re-READS the verdict', () => {
    const PASS = [
        {
            model: 'User',
            hashColumn: 'emailHash',
            scanned: 3,
            rehashed: 2,
            alreadyCurrent: 1,
            errors: 0,
            collisions: [] as string[],
        },
        {
            model: 'UserIdentityLink',
            hashColumn: 'emailAtLinkTimeHash',
            scanned: 1,
            rehashed: 1,
            alreadyCurrent: 0,
            errors: 0,
            collisions: [] as string[],
        },
    ];

    it('sums every column and reports the fresh verdict', async () => {
        rehashMock.mockResolvedValue(PASS);
        const route = loadRoute(REAL_KEY);
        const body = await (
            await route.POST(makeReq({ method: 'POST', key: REAL_KEY }))
        ).json();
        expect(body).toMatchObject({
            totalScanned: 4,
            totalRehashed: 3,
            totalAlreadyCurrent: 1,
            totalErrors: 0,
            collisions: [],
            previousKeyRetirable: true,
        });
        expect(body.perColumn).toHaveLength(2);
    });

    it('the verdict comes from a RE-READ, not from the pass totals', async () => {
        // A collided row is still stale, so `scanned - rehashed == 0` would
        // report it as finished. The re-read is the only honest source.
        rehashMock.mockResolvedValue([
            { ...PASS[0], rehashed: 2, errors: 1, collisions: ['usr_dup'] },
        ]);
        retirableMock.mockResolvedValue({ retirable: false, stale: 1, undecryptable: 0 });
        const route = loadRoute(REAL_KEY);
        const body = await (
            await route.POST(makeReq({ method: 'POST', key: REAL_KEY }))
        ).json();
        expect(body.previousKeyRetirable).toBe(false);
        expect(body.stale).toBe(1);
        expect(retirableMock).toHaveBeenCalledWith();
    });

    it('surfaces collision row ids, which need a human rather than a retry', async () => {
        // A unique violation here means two rows claim one address — the
        // duplicate-`User` defect #1237 exists to prevent. Retrying forever
        // cannot fix it; the id is the only actionable thing to hand back.
        rehashMock.mockResolvedValue([
            { ...PASS[0], collisions: ['usr_a', 'usr_b'], errors: 2, rehashed: 0 },
        ]);
        const route = loadRoute(REAL_KEY);
        const body = await (
            await route.POST(makeReq({ method: 'POST', key: REAL_KEY }))
        ).json();
        expect(body.collisions).toEqual(['usr_a', 'usr_b']);
        expect(body.totalErrors).toBe(2);
    });

    it('an EMPTY body is a valid request — the operator need not send JSON', async () => {
        const route = loadRoute(REAL_KEY);
        const res = await route.POST(makeReq({ method: 'POST', key: REAL_KEY, body: '' }));
        expect(res.status).toBe(200);
        expect(rehashMock).toHaveBeenCalledWith({ batchSize: undefined });
    });

    it('passes a supplied batchSize through', async () => {
        const route = loadRoute(REAL_KEY);
        await route.POST(
            makeReq({ method: 'POST', key: REAL_KEY, body: JSON.stringify({ batchSize: 50 }) }),
        );
        expect(rehashMock).toHaveBeenCalledWith({ batchSize: 50 });
    });

    it('refuses malformed JSON with a 400 and sweeps nothing', async () => {
        const route = loadRoute(REAL_KEY);
        const res = await route.POST(
            makeReq({ method: 'POST', key: REAL_KEY, body: '{not json' }),
        );
        expect(res.status).toBe(400);
        expect(rehashMock).not.toHaveBeenCalled();
    });

    it.each([0, -1, 99999])('refuses an out-of-range batchSize %p', async (batchSize) => {
        // A 400 rather than a throw: the Zod failure propagates into
        // `withApiErrorHandling`, which is the shared translation every route
        // relies on. Asserting a rejection here would have been asserting my
        // own guess about the error path instead of the handler's answer.
        const route = loadRoute(REAL_KEY);
        const res = await route.POST(
            makeReq({ method: 'POST', key: REAL_KEY, body: JSON.stringify({ batchSize }) }),
        );
        expect(res.status).toBe(400);
        expect(rehashMock).not.toHaveBeenCalled();
    });
});
