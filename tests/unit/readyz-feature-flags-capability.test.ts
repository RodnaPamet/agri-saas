/**
 * #2009 / #2291 — `/api/readyz` reports whether every gated flag key has a row.
 *
 * Fifth instance of the argument `capabilities.satellite`, `basemap`, `email`
 * and `platformConsole` already carry, with a fifth kind of silence — and this
 * one is silent twice over by design. A missing `FeatureFlag` row is OFF, and
 * `assertFeatureEnabled` 404s rather than 403s for anti-enumeration, so a
 * surface whose key was never inserted is indistinguishable from one that does
 * not exist. #2009's instance 3 ran that way for months.
 *
 * Measured 2026-10-24: two of six referenced keys had no row. With
 * `social.public-profile` ENABLED, `/f/{handle}` rendered while every
 * photograph on it 404'd, because `social.farm-media` gates the media route.
 *
 * ## These tests exist for the SEAM, not the logic
 *
 * `feature-flags-capability.test.ts` covers the helper and its three states.
 * What it cannot see is whether anybody calls it and whether its answer reaches
 * the response — two tests covering both sides of a seam and neither covering
 * the seam is how a dropped invalidation shipped green in P5.9
 * (`a-seam-is-a-new-collector`).
 *
 * The load-bearing assertion here is a NEGATIVE one: `incomplete` must still
 * return 200/ready. This endpoint is the GCP uptime check's target, and #2009
 * is explicit that refusing to serve over a missing flag row "turns a dark
 * feature into an outage".
 */
export {};

const featureFlagFindMany = jest.fn();
const tenantFindUnique = jest.fn();

/**
 * The stub lives on the `@prisma/client` mock, because `readyz` constructs its
 * OWN raw client and passes it to the capability. That is the seam: the
 * capability takes its reader as a parameter so it cannot drag `@/lib/prisma`
 * (and `Prisma.dmmf`) into this module graph.
 */
jest.mock('@prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
        featureFlag: { findMany: (...a: unknown[]) => featureFlagFindMany(...a) },
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
            featureFlag: { findMany: (...a: unknown[]) => featureFlagFindMany(...a) },
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
    capabilities: {
        featureFlags: {
            state: string;
            missingRows: string[];
            referenced: number;
            orphanRows: number;
        };
    };
}

async function probe(): Promise<{ status: number; body: ProbeBody }> {
    const { GET } = loadRouteFresh();
    const res = await GET();
    return { status: res.status, body: await res.json() };
}

const rows = (keys: string[]) => keys.map((key) => ({ key }));

/** The live set as of 2026-10-24, after both missing rows were inserted. */
const ALL_SIX = [
    'integrations.google',
    'notifications.sse',
    'social.farm-media',
    'social.farm-registration',
    'social.person-blocks',
    'social.public-profile',
];

describe('GET /api/readyz — capabilities.featureFlags is REPORTED, never GATING', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        process.env.REDIS_URL = 'redis://localhost:6379';
        pingMock.mockResolvedValue('PONG');
        tenantFindUnique.mockResolvedValue({ id: 't1', deletedAt: null });
        featureFlagFindMany.mockResolvedValue(rows(ALL_SIX));
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('reports complete when every referenced key has a row', async () => {
        // The positive control for the seam. Without it, the negative
        // assertions below are satisfied by a route that never calls the
        // capability at all — which is exactly what the sibling suites do,
        // since their Prisma mock carries no `featureFlag`.
        const { status, body } = await probe();

        expect(body.capabilities.featureFlags.state).toBe('complete');
        expect(body.capabilities.featureFlags.missingRows).toEqual([]);
        expect(body.capabilities.featureFlags.referenced).toBeGreaterThanOrEqual(6);
        expect(status).toBe(200);
    });

    it('the capability is actually CALLED, selecting only the key', async () => {
        // Proves the seam rather than inferring it from a plausible value, and
        // pins the projection: selecting `enabled` too would invite collapsing
        // "has a row" into "is on", which #2009 says must stay distinct.
        await probe();

        expect(featureFlagFindMany).toHaveBeenCalledTimes(1);
        expect(featureFlagFindMany).toHaveBeenCalledWith({ select: { key: true } });
    });

    it('INCOMPLETE still returns 200 / ready — the whole point of the placement', async () => {
        // Reproduces the measured production state and asserts the thing that
        // must never change. #2009: a container that refuses to serve because a
        // flag row is missing turns a dark feature into an outage, and this
        // endpoint is what the uptime check reads from six regions.
        featureFlagFindMany.mockResolvedValue(
            rows([
                'notifications.sse',
                'social.farm-registration',
                'social.person-blocks',
                'social.public-profile',
            ]),
        );

        const { status, body } = await probe();

        expect(body.capabilities.featureFlags.state).toBe('incomplete');
        expect(body.capabilities.featureFlags.missingRows)
            .toEqual(['integrations.google', 'social.farm-media']);
        // The two assertions that make this a REPORT and not a gate.
        expect(status).toBe(200);
        expect(body.status).toBe('ready');
        expect(body.failed).toEqual([]);
    });

    it('an unreadable table is unknown, and still 200', async () => {
        // The false-alarm direction. During a database incident the signal that
        // should fire is `checks.database`, not a claim that somebody
        // misconfigured the flag console.
        featureFlagFindMany.mockRejectedValue(new Error('connection terminated'));

        const { status, body } = await probe();

        expect(body.capabilities.featureFlags.state).toBe('unknown');
        expect(body.capabilities.featureFlags.missingRows).toEqual([]);
        expect(status).toBe(200);
    });

    it('a flag row nobody gates on does not make the verdict incomplete', async () => {
        // A retired flag is not a fault, and reddening on one would report the
        // operator's own tidy-up as a problem.
        featureFlagFindMany.mockResolvedValue(rows([...ALL_SIX, 'social.retired']));

        const { body } = await probe();

        expect(body.capabilities.featureFlags.state).toBe('complete');
        expect(body.capabilities.featureFlags.orphanRows).toBe(1);
    });

    it('never 503s on the capability, whatever the table says', async () => {
        // Belt and braces across every state, because the placement is the
        // property and a future refactor that folded this into `checks` would
        // pass every assertion above except this one.
        for (const value of [rows([]), rows(ALL_SIX), rows(['x.y'])]) {
            featureFlagFindMany.mockResolvedValue(value);
            const { status } = await probe();
            expect(status).toBe(200);
        }
    });
});
