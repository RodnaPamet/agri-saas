/**
 * Epic OI-3 — readyz dependency-check tests.
 *
 * Covers the 7 cases the upgraded readyz route can produce:
 *   1. all-ready (200, every check ok or skipped)
 *   2. database failure → 503, checks.database.status='error'
 *   3. redis failure    → 503, checks.redis.status='error'
 *   4. storage failure  → 503, checks.storage.status='error'
 *   5. multi failure    → 503, all failed components listed in `failed`
 *   6. skipped paths    → 200 (REDIS_URL unset, STORAGE_PROVIDER!='s3')
 *   7. timeout          → 503 with error='timeout' (and probe doesn't hang)
 *
 * Strategy:
 *   - Mock the Prisma client (`$queryRaw`), ioredis (`getRedis().ping()`),
 *     and the AWS S3Client (`send(HeadBucketCommand)`).
 *   - Tests use the actual route handler — no HTTP server, just call GET().
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jest } from '@jest/globals';

// ─── Mocks (declared BEFORE the route imports it) ──────────────────

const mockQueryRaw = jest.fn<() => Promise<unknown>>();

jest.mock('@prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        $queryRaw: mockQueryRaw,
    })),
}));

const mockPing = jest.fn<() => Promise<string>>();

jest.mock('@/lib/redis', () => ({
    getRedis: jest.fn(() => ({ ping: mockPing })),
}));

const mockS3Send = jest.fn<(cmd: unknown) => Promise<unknown>>();

jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
    HeadBucketCommand: jest.fn().mockImplementation((input: unknown) => ({
        input,
        kind: 'HeadBucketCommand',
    })),
}));

// Also mute the logger so warn calls don't pollute test output.
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// ─── Env mutation helpers ──────────────────────────────────────────

const originalEnv = { ...process.env };

beforeEach(() => {
    // Reset all mocks; configure default-happy values per test.
    jest.clearAllMocks();
    process.env = {
        ...originalEnv,
        REDIS_URL: 'redis://localhost:6379',
        STORAGE_PROVIDER: 's3',
        S3_BUCKET: 'inflect-test-bucket',
        S3_REGION: 'us-east-1',
    };
});

afterAll(() => {
    process.env = originalEnv;
});

// Lazy import so the mocks above are already in place when the route
// module's top-level `new PrismaClient()` runs.
async function callReadyz() {
    // Re-import per test to bust the env module's cache (which reads
    // process.env at module-load time).
    jest.resetModules();

    const { GET } = require('@/app/api/readyz/route');
    const res: Response = await GET();
    return { status: res.status, body: await res.json() };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('OI-3 readyz — all-ready path', () => {
    beforeEach(() => {
        mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
        mockPing.mockResolvedValue('PONG');
        mockS3Send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    });

    it('returns 200 when every dependency is reachable', async () => {
        const { status, body } = await callReadyz();
        expect(status).toBe(200);
        expect(body.status).toBe('ready');
        expect(body.failed).toEqual([]);
        expect(body.checks.database.status).toBe('ok');
        expect(body.checks.redis.status).toBe('ok');
        expect(body.checks.storage.status).toBe('ok');
        expect(typeof body.latencyMs).toBe('number');
    });

    it('runs all three checks in parallel (each check has a latencyMs)', async () => {
        const { body } = await callReadyz();
        expect(body.checks.database).toHaveProperty('latencyMs');
        expect(body.checks.redis).toHaveProperty('latencyMs');
        expect(body.checks.storage).toHaveProperty('latencyMs');
    });
});

describe('OI-3 readyz — database failure', () => {
    beforeEach(() => {
        mockQueryRaw.mockRejectedValue(new Error('connection refused 127.0.0.1:5432'));
        mockPing.mockResolvedValue('PONG');
        mockS3Send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    });

    it('returns 503 with database in failed[] and checks.database.status=error', async () => {
        const { status, body } = await callReadyz();
        expect(status).toBe(503);
        expect(body.status).toBe('not_ready');
        expect(body.failed).toEqual(['database']);
        expect(body.checks.database.status).toBe('error');
        expect(body.checks.database.error).toBe('Connection failed');
    });

    it('does NOT leak the underlying error message (e.g. host:port)', async () => {
        const { body } = await callReadyz();
        // The bounded error code is what's exposed; the raw error
        // message (which contains the host) must not appear in any
        // field of the response.
        const json = JSON.stringify(body);
        expect(json).not.toContain('127.0.0.1:5432');
        expect(json).not.toContain('connection refused');
    });
});

describe('OI-3 readyz — redis failure', () => {
    beforeEach(() => {
        mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
        mockPing.mockRejectedValue(new Error('READONLY connection lost'));
        mockS3Send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    });

    it('returns 503 with redis in failed[] and checks.redis.status=error', async () => {
        const { status, body } = await callReadyz();
        expect(status).toBe(503);
        expect(body.failed).toEqual(['redis']);
        expect(body.checks.redis.status).toBe('error');
        expect(body.checks.redis.error).toBe('Ping failed');
    });

    it('flags an unexpected ping response (not PONG) as redis error', async () => {
        mockPing.mockResolvedValue('UNEXPECTED');
        const { status, body } = await callReadyz();
        expect(status).toBe(503);
        expect(body.checks.redis.error).toBe('Unexpected ping response');
    });
});

describe('OI-3 readyz — storage failure', () => {
    beforeEach(() => {
        mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
        mockPing.mockResolvedValue('PONG');
        mockS3Send.mockRejectedValue(new Error('NoSuchBucket: The specified bucket does not exist'));
    });

    it('returns 503 with storage in failed[] and checks.storage.status=error', async () => {
        const { status, body } = await callReadyz();
        expect(status).toBe(503);
        expect(body.failed).toEqual(['storage']);
        expect(body.checks.storage.status).toBe('error');
        expect(body.checks.storage.error).toBe('head_bucket_failed');
    });

    it('flags missing S3_BUCKET when STORAGE_PROVIDER=s3 as bucket_not_configured', async () => {
        delete process.env.S3_BUCKET;
        const { status, body } = await callReadyz();
        expect(status).toBe(503);
        expect(body.checks.storage.error).toBe('bucket_not_configured');
    });
});

describe('OI-3 readyz — multiple failures', () => {
    beforeEach(() => {
        mockQueryRaw.mockRejectedValue(new Error('db down'));
        mockPing.mockRejectedValue(new Error('redis down'));
        mockS3Send.mockRejectedValue(new Error('s3 down'));
    });

    it('lists every failed component in failed[]', async () => {
        const { status, body } = await callReadyz();
        expect(status).toBe(503);
        expect(body.failed).toEqual(
            expect.arrayContaining(['database', 'redis', 'storage']),
        );
        expect(body.failed.length).toBe(3);
    });
});

describe('OI-3 readyz — skipped paths', () => {
    beforeEach(() => {
        mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
        mockPing.mockResolvedValue('PONG');
        mockS3Send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    });

    it('redis SKIPPED when REDIS_URL is unset (still 200)', async () => {
        delete process.env.REDIS_URL;
        const { status, body } = await callReadyz();
        expect(status).toBe(200);
        expect(body.status).toBe('ready');
        expect(body.checks.redis.status).toBe('skipped');
    });

    it('storage SKIPPED when STORAGE_PROVIDER=local (still 200)', async () => {
        process.env.STORAGE_PROVIDER = 'local';
        const { status, body } = await callReadyz();
        expect(status).toBe(200);
        expect(body.status).toBe('ready');
        expect(body.checks.storage.status).toBe('skipped');
    });
});

describe('OI-3 readyz — timeout handling', () => {
    beforeEach(() => {
        mockPing.mockResolvedValue('PONG');
        mockS3Send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    });

    it('classifies a hung database query as error=timeout', async () => {
        // Never-resolving promise — the route's Promise.race must
        // win via the 2s timeout, otherwise this test would hang.
        mockQueryRaw.mockImplementation(() => new Promise(() => { /* never resolves */ }));

        const { status, body } = await callReadyz();

        expect(status).toBe(503);
        expect(body.checks.database.status).toBe('error');
        expect(body.checks.database.error).toBe('timeout');
    }, 10_000);

    /**
     * ── WHY THERE IS NO `expect(elapsed).toBeLessThan(...)` ABOVE ── #2246
     *
     * There was: `elapsed < 5000`, commented "Probe must complete within
     * ~check timeout (2s) + a little for jest scheduling." It measured the
     * machine rather than the route, and it failed at **7,042 ms** during
     * `npm run verify:changed`, whose derived population is 657 suites run
     * with `--runInBand`. Alone on an idle tree this file passes in 11.5 s.
     * 3,000 ms of headroom is generous for one suite and short for 657 — and
     * it failed on the command this repo offers as its pre-push check, which
     * trains exactly the habit that check exists to prevent.
     *
     * Two properties were tangled in it, and both are still covered:
     *
     *   - **The probe completes rather than hangs.** Proven by `callReadyz()`
     *     resolving at all: a hung route never returns, and the 10,000 ms jest
     *     timeout on these cases is what reports it. A wall-clock assertion
     *     adds nothing.
     *   - **The route's timeout is ~2s, not 60s.** That is what the bound was
     *     really guarding, and it is a statement about `CHECK_TIMEOUT_MS`.
     *
     * A fake clock was tried first, as the behavioural version of this, and
     * abandoned: `callReadyz` does `jest.resetModules()` and a fresh
     * `require`, and under `useFakeTimers` the probe never settled even after
     * 32 s of fake time. Not worth fighting the harness for a value that can
     * be read directly — and the three cases above already prove the timeout
     * BEHAVES, on the database, redis and storage paths alike. What is left to
     * assert is only its magnitude.
     */
    it('declares a 2s check timeout and applies it to EVERY dependency', () => {
        const route = readFileSync(
            join(__dirname, '..', '..', 'src', 'app', 'api', 'readyz', 'route.ts'),
            'utf8',
        );

        // The value. This is an uptime probe, so its own timeout has to stay
        // well inside the interval that calls it.
        const declared = /^const CHECK_TIMEOUT_MS = (\d+);$/m.exec(route);
        expect(declared).not.toBeNull();
        expect(Number(declared![1])).toBe(2000);

        // And its USE, because a constant nothing passes is just a number.
        // Every `withTimeout` call must take the constant rather than a
        // literal, so a dependency added later cannot quietly get its own
        // budget. The count is asserted too: a refactor that removed the calls
        // would otherwise satisfy "they all use the constant" with none.
        const used = [...route.matchAll(/withTimeout\([^;]*?,\s*([A-Za-z_$][\w$]*|\d+)\s*,/g)]
            .map((m) => m[1]);
        expect(used.length).toBeGreaterThanOrEqual(3);
        expect([...new Set(used)]).toEqual(['CHECK_TIMEOUT_MS']);
    });

    it('classifies a hung redis ping as error=timeout', async () => {
        mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
        mockPing.mockImplementation(() => new Promise(() => { /* never resolves */ }));

        const { status, body } = await callReadyz();
        expect(status).toBe(503);
        expect(body.checks.redis.error).toBe('timeout');
    }, 10_000);

    it('classifies a hung S3 HeadBucket as error=timeout', async () => {
        mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
        mockS3Send.mockImplementation(() => new Promise(() => { /* never resolves */ }));

        const { status, body } = await callReadyz();
        expect(status).toBe(503);
        expect(body.checks.storage.error).toBe('timeout');
    }, 10_000);
});

describe('OI-3 readyz — response shape', () => {
    beforeEach(() => {
        mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
        mockPing.mockResolvedValue('PONG');
        mockS3Send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    });

    it('always carries timestamp, uptime, version, checks, failed, latencyMs', async () => {
        const { body } = await callReadyz();
        expect(typeof body.status).toBe('string');
        expect(typeof body.timestamp).toBe('string');
        expect(typeof body.uptime).toBe('number');
        expect(typeof body.version).toBe('string');
        expect(typeof body.checks).toBe('object');
        expect(Array.isArray(body.failed)).toBe(true);
        expect(typeof body.latencyMs).toBe('number');
        // ISO-8601 timestamp
        expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('issues `HeadBucketCommand` against the configured bucket', async () => {
        await callReadyz();
        expect(mockS3Send).toHaveBeenCalledTimes(1);
        // The command is constructed via `new HeadBucketCommand({ Bucket: ... })`
        // — our mock returns an object with `input.Bucket`.
        const sentCommand = mockS3Send.mock.calls[0][0] as { input: { Bucket: string } };
        expect(sentCommand.input.Bucket).toBe('inflect-test-bucket');
    });
});
