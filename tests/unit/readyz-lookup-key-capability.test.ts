/**
 * P1.1 — `/api/readyz` reports whether the lookup key is PINNED.
 *
 * "The code shipped" and "the capability is active" are different claims, and
 * here the gap between them is whether the master KEK can be rotated at all.
 * While `LOOKUP_HMAC_KEY` is unset the lookup hash BOOTSTRAPS off
 * `DATA_ENCRYPTION_KEY` — the pre-P1.1 behaviour — so a deployment can carry
 * this code and still be one rotation away from making every sign-in report
 * "no such user" and every registration create a duplicate.
 *
 * Nothing logs that. Nothing fails. So it is reported, and reported from the
 * same predicate the hash derivation branches on (`isLookupKeyPinned`), because
 * a probe with its own copy of the rule can disagree with the code it
 * describes.
 *
 * Two rules it must obey, mirroring `capabilities.email`:
 *   · REPORTED, never GATING — an unpinned key must not 503 a healthy
 *     instance. It has been the live state since the product shipped.
 *   · A boolean and nothing else. Never the key, never its length, never a
 *     hash of it — `/api/readyz` is unauthenticated by design.
 */
export {};

jest.mock('@prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    })),
}));

const pingMock = jest.fn();
jest.mock('@/lib/redis', () => ({
    getRedis: jest.fn(() => ({ ping: pingMock })),
}));

/** Reload the route so the current `process.env` is what the handler sees. */
function loadRouteFresh() {
    jest.resetModules();
    jest.doMock('@prisma/client', () => ({
        PrismaClient: jest.fn().mockImplementation(() => ({
            $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        })),
    }));
    jest.doMock('@/lib/redis', () => ({
        getRedis: jest.fn(() => ({ ping: pingMock })),
    }));
    return require('@/app/api/readyz/route');
}

interface ProbeBody {
    status: string;
    failed: string[];
    capabilities: { lookupKey: { pinned: boolean } };
}

async function probe(): Promise<{ status: number; body: ProbeBody }> {
    const { GET } = loadRouteFresh();
    const res = await GET();
    return { status: res.status, body: await res.json() };
}

const PINNED = 'a-pinned-lookup-key-of-at-least-32-characters'; // pragma: allowlist secret -- test fixture

describe('GET /api/readyz — capabilities.lookupKey', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        process.env.REDIS_URL = 'redis://localhost:6379';
        process.env.DATA_ENCRYPTION_KEY = 'a-master-kek-of-at-least-32-characters!!'; // pragma: allowlist secret -- test fixture
        delete process.env.LOOKUP_HMAC_KEY;
        pingMock.mockResolvedValue('PONG');
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('unset -> pinned:false, and the probe is still READY', async () => {
        const { status, body } = await probe();
        expect(body.capabilities.lookupKey).toEqual({ pinned: false });
        // Never gating. This has been the live state since the product
        // shipped; 503-ing on it would turn a latent hazard into an outage.
        expect(status).toBe(200);
        expect(body.status).toBe('ready');
        expect(body.failed).toEqual([]);
    });

    it('pinned -> pinned:true', async () => {
        process.env.LOOKUP_HMAC_KEY = PINNED;
        const { status, body } = await probe();
        expect(body.capabilities.lookupKey).toEqual({ pinned: true });
        expect(status).toBe(200);
    });

    it('a SHORT value reads as unpinned — the probe agrees with the derivation', async () => {
        // `getLookupKeyMaterial` treats a short value as absent and falls back
        // to the bootstrap, so a probe that called it pinned would tell an
        // operator the KEK is rotatable when it is not. Same predicate, same
        // answer, which is the only way the two cannot drift.
        process.env.LOOKUP_HMAC_KEY = 'too-short';
        const { body } = await probe();
        expect(body.capabilities.lookupKey).toEqual({ pinned: false });
    });

    it('an EMPTY value reads as unpinned — that is the schema default', async () => {
        process.env.LOOKUP_HMAC_KEY = '';
        const { body } = await probe();
        expect(body.capabilities.lookupKey).toEqual({ pinned: false });
    });

    it('leaks nothing about the key beyond the boolean', async () => {
        process.env.LOOKUP_HMAC_KEY = PINNED;
        const { body } = await probe();
        // `/api/readyz` is in PUBLIC_PATH_PREFIXES and probed from six GCP
        // regions, so the body is effectively public.
        const serialised = JSON.stringify(body);
        expect(serialised).not.toContain(PINNED);
        expect(serialised).not.toContain(PINNED.slice(0, 12));

        // The length check is a SHAPE assertion, not a substring one. The first
        // version grepped the body for `String(PINNED.length)` — the two
        // characters "45" — which collides with `latencyMs` and failed only on
        // the runs where the probe happened to take 45ms. A test whose verdict
        // depends on a timing value is worse than no test: it fails for a
        // reason unrelated to the property and teaches you to retry it.
        const cap = body.capabilities.lookupKey as unknown as Record<string, unknown>;
        expect(Object.keys(cap)).toEqual(['pinned']);
        expect(typeof cap.pinned).toBe('boolean');
        for (const v of Object.values(cap)) expect(typeof v).not.toBe('number');
    });

    it('the capability sits OUTSIDE checks/failed, like email and basemap', async () => {
        const { body } = await probe();
        expect(body.failed).not.toContain('lookupKey');
        expect(Object.keys(body as unknown as Record<string, unknown>)).toContain('capabilities');
    });
});
