/**
 * #1669 — `/api/readyz` reports whether the platform console is reachable.
 *
 * Fourth instance of the argument `capabilities.satellite`,
 * `capabilities.basemap` and `capabilities.email` already carry, with a fourth
 * kind of silence: `assertPlatformSupport` is fail-closed, so an unset
 * `PLATFORM_TENANT_SLUG` makes every route behind it unreachable rather than
 * open. That direction is correct and it produces no signal, so "deliberately
 * closed" and "never configured" are indistinguishable from outside — and on
 * the `agrent` VM they have been indistinguishable since #12 merged.
 *
 * ## These tests exist for the SEAM, not the logic
 *
 * `platform-console-capability.test.ts` covers the helper and its four states,
 * mutation-proved. What that file cannot see is whether anybody calls it, and
 * whether its answer reaches the response. Two tests covering both sides of a
 * seam and neither covering the seam is how a dropped invalidation shipped
 * green in P5.9 (`a-seam-is-a-new-collector`).
 *
 * So these drive the REAL route handler and read the REAL body, and the
 * load-bearing assertion is a NEGATIVE one: `misconfigured` must still return
 * 200/ready. This endpoint is the GCP uptime check's target, and a capability
 * that could 503 it would page somebody for a configuration nit — the inverse
 * of the #1143 lesson, where the probe passed while the wrong app served it.
 */
export {};

const tenantFindUnique = jest.fn();

/**
 * The tenant stub lives on the `@prisma/client` mock, because `readyz`
 * constructs its OWN raw client and passes it to the capability. That is the
 * seam being tested: the capability takes its reader as a parameter so it
 * cannot drag `@/lib/prisma` (and `Prisma.dmmf`) into this module graph.
 */
jest.mock('@prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
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
            tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
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
    checks: Record<string, unknown>;
    capabilities: { platformConsole: { state: string } };
}

async function probe(): Promise<{ status: number; body: ProbeBody }> {
    const { GET } = loadRouteFresh();
    const res = await GET();
    return { status: res.status, body: await res.json() };
}

describe('GET /api/readyz — capabilities.platformConsole is REPORTED, never GATING', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        process.env.REDIS_URL = 'redis://localhost:6379';
        delete process.env.PLATFORM_TENANT_SLUG;
        pingMock.mockResolvedValue('PONG');
        tenantFindUnique.mockResolvedValue({ id: 't1', deletedAt: null });
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('reports unconfigured when the slug is unset — the live VM state', async () => {
        const { status, body } = await probe();

        expect(body.capabilities.platformConsole).toEqual({ state: 'unconfigured' });
        // Still ready. A self-hosted deployment has no platform tenant and must
        // not be reported unhealthy for it.
        expect(status).toBe(200);
        expect(body.status).toBe('ready');
    });

    it('reports reachable when the slug resolves to a live tenant', async () => {
        process.env.PLATFORM_TENANT_SLUG = 'agrent-platform';

        const { status, body } = await probe();

        expect(body.capabilities.platformConsole).toEqual({ state: 'reachable' });
        expect(status).toBe(200);
    });

    it('reports misconfigured for a slug naming no tenant, and STAYS 200/ready', async () => {
        // THE LOAD-BEARING NEGATIVE. This endpoint is the uptime check's
        // target: a capability that 503'd here would page an operator for a
        // typo'd env var, and the alert policy fires on sustained failure from
        // more than one region.
        process.env.PLATFORM_TENANT_SLUG = 'typo-platfrom';
        tenantFindUnique.mockResolvedValue(null);

        const { status, body } = await probe();

        expect(body.capabilities.platformConsole).toEqual({ state: 'misconfigured' });
        expect(status).toBe(200);
        expect(body.status).toBe('ready');
        // And it is nowhere near the verdict machinery.
        expect(body.failed).not.toContain('platformConsole');
        expect(Object.keys(body.checks)).not.toContain('platformConsole');
    });

    it('never echoes the slug into the response', async () => {
        process.env.PLATFORM_TENANT_SLUG = 'secret-looking-slug';

        const { body } = await probe();

        // This body is served to an unauthenticated prober from six GCP
        // regions. Same rule as `basemap`'s branch and `email`'s provider: a
        // closed enum, never the configured value.
        expect(JSON.stringify(body)).not.toContain('secret-looking-slug');
    });

    it('a capability lookup failure does not fail the probe', async () => {
        process.env.PLATFORM_TENANT_SLUG = 'agrent-platform';
        tenantFindUnique.mockRejectedValue(new Error('too many connections'));

        const { status, body } = await probe();

        // `unknown`, and still ready — the real signal during a database
        // incident is `checks.database`, which this endpoint already fails on.
        expect(body.capabilities.platformConsole).toEqual({ state: 'unknown' });
        expect(status).toBe(200);
    });

    it('the other capabilities are still reported alongside it', async () => {
        // A new key must not displace its siblings: the response shape is read
        // by operators and by `infra/alerts/external-uptime.yml`'s matcher.
        //
        // This is an exact-set assertion, so ADDING a capability lands here by
        // design — `featureFlags` (#2291) is the first to do so. That is the
        // ratchet working: a fifth reading on the endpoint the uptime check
        // probes should cost a visible line, not arrive unnoticed.
        const { body } = await probe();

        expect(Object.keys(body.capabilities).sort())
            .toEqual([
                'basemap',
                'email',
                'featureFlags',
                'lookupKey',
                'platformConsole',
                'satellite',
            ]);
    });
});
