/**
 * GAP-13 parity: /api/readyz must reflect Redis health the same way
 * /api/health does (covered by tests/unit/health-route.test.ts).
 *
 * /api/readyz is the modern Kubernetes-shaped readiness probe;
 * /api/health is the deprecated legacy alias kept for existing load
 * balancers. Both must return 503 + structured error when Redis is
 * down, since Redis is a true production dependency post-GAP-13.
 */
export {};

// ─── Mocks (declared before requires) ───────────────────────────────

jest.mock('@prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    })),
}));

const pingMock = jest.fn();
jest.mock('@/lib/redis', () => ({
    getRedis: jest.fn(() => ({ ping: pingMock })),
}));

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

describe('GET /api/readyz (GAP-13: Redis is a production dependency)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('returns 200 + ready when Redis PINGs PONG', async () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        pingMock.mockResolvedValue('PONG');
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.status).toBe('ready');
        expect(body.checks.database.status).toBe('ok');
        expect(body.checks.redis.status).toBe('ok');
    });

    it('returns 503 + not_ready when Redis ping throws (Redis is down)', async () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        pingMock.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'));
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(503);
        expect(body.status).toBe('not_ready');
        expect(body.checks.redis.status).toBe('error');
        expect(body.checks.redis.error).toBe('Ping failed');
        // Sanity: error string is generic — no host/port/password leakage.
        expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
        expect(JSON.stringify(body)).not.toContain('localhost:6379');
        expect(JSON.stringify(body)).not.toContain('127.0.0.1');
    });

    it('returns 503 + Not configured under NODE_ENV=production when REDIS_URL is unset', async () => {
        // GAP-13 — env validation should refuse to boot in this state.
        // The endpoint check is defense-in-depth for the
        // SKIP_ENV_VALIDATION=1 escape hatch. Surfacing 'Not configured'
        // as a 503 prevents the orchestrator from routing traffic to
        // a misconfigured prod instance.
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        delete process.env.REDIS_URL;
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(503);
        expect(body.status).toBe('not_ready');
        expect(body.checks.redis.status).toBe('error');
        expect(body.checks.redis.error).toBe('Not configured');
    });

    it('returns 200 + ready under NODE_ENV=development when REDIS_URL is unset', async () => {
        // Dev/test ergonomics: a contributor running the app without
        // local Redis must not see a red probe. The redis check is
        // included in `checks` only when configured-or-prod; in dev
        // without REDIS_URL it's omitted entirely.
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
        delete process.env.REDIS_URL;
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.status).toBe('ready');
    });

    it('returns 503 with NO retry-loop hints in the response body (no info leak)', async () => {
        // GAP-13 explicitly requires no leakage of sensitive connection
        // details on failure. Re-asserts the property tested above
        // with a stronger check: no Redis-shaped strings whatsoever
        // in the visible body.
        process.env.REDIS_URL = 'redis://admin:supersecret@redis-prod.internal:6379/0';
        pingMock.mockRejectedValue(new Error('NOAUTH Authentication required.'));
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();
        const bodyStr = JSON.stringify(body);

        expect(res.status).toBe(503);
        expect(bodyStr).not.toContain('admin');
        expect(bodyStr).not.toContain('supersecret');
        expect(bodyStr).not.toContain('redis-prod.internal');
        expect(bodyStr).not.toContain('NOAUTH');
    });
});

describe('GET /api/readyz — capabilities.satellite is REPORTED, never GATING', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('stays 200/ready with NO Earth-Engine credentials and names the missing keys', async () => {
        // Satellite is a DEGRADABLE capability, not a dependency: /farm-risk
        // shows "no data" levels and the briefing runs without imagery, both
        // by design. A missing key must therefore never 503 a healthy
        // instance — but it must be visible, because otherwise a prod deploy
        // that never got its keys goes dark with no signal at all.
        process.env.REDIS_URL = 'redis://localhost:6379';
        delete process.env.GEE_PROJECT_ID;
        delete process.env.GEE_SERVICE_ACCOUNT_KEY;
        pingMock.mockResolvedValue('PONG');
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.status).toBe('ready');
        expect(body.capabilities.satellite).toEqual({
            configured: false,
            missing: ['GEE_PROJECT_ID', 'GEE_SERVICE_ACCOUNT_KEY'],
        });
        // Outside the probe's gating surfaces, so automation is unaffected.
        expect(body.failed).not.toContain('satellite');
        expect(body.checks).not.toHaveProperty('satellite');
    });

    it('reports configured:true when both keys are present', async () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        process.env.GEE_PROJECT_ID = 'my-ee-project';
        process.env.GEE_SERVICE_ACCOUNT_KEY = '{"type":"service_account"}';
        pingMock.mockResolvedValue('PONG');
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.capabilities.satellite).toEqual({ configured: true, missing: [] });
    });

    it('never echoes the credential VALUES into the probe body', async () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        process.env.GEE_PROJECT_ID = 'secret-ee-project-id';
        process.env.GEE_SERVICE_ACCOUNT_KEY = '{"private_key":"---BEGIN PRIVATE KEY---"}';
        pingMock.mockResolvedValue('PONG');
        const { GET } = loadRouteFresh();

        const res = await GET();
        const bodyStr = JSON.stringify(await res.json());

        expect(bodyStr).not.toContain('secret-ee-project-id');
        expect(bodyStr).not.toContain('PRIVATE KEY');
    });
});
