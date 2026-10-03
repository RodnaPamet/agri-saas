/**
 * The platform flag console, driven as HTTP handlers.
 *
 * Why an EXECUTING test and not a guard: the two properties that matter here
 * are both invisible to source text. A gate's CALL can be commented out and a
 * file-granular guard stays green on the import and the docblock (measured, on
 * exactly this route shape — see `tests/unit/csp-summary-gate.test.ts`); and
 * "the flip propagates in ≤30s" is a claim about a function being CALLED, which
 * no amount of grepping establishes.
 *
 * Four things are pinned:
 *
 *   1. The gate. 503 with no key configured, 401 with a wrong or missing
 *      header, on every method — a write path that authenticates and a read
 *      path that does not is the usual shape of this mistake.
 *   2. The invalidation. A PUT calls `invalidateFlagCache`, because without it
 *      the 30s table cache decides when a flip is visible and the hardening
 *      line in the roadmap is false.
 *   3. `forcedOff` in the body. The kill switch overrides every row, so a
 *      console that renders `enabled: true` while the deployment serves the
 *      flag off would be worse than no console.
 *   4. The key grammar is the SAME grammar the flag-gating guard holds routes
 *      to. That agreement is the point of `FLAG_KEY_PATTERN` living in
 *      `@/lib/feature-flags`, and it is asserted here by driving the real route
 *      with keys classified by the shared pattern — so a divergence fails
 *      rather than waiting to be noticed.
 */
import type { NextRequest } from 'next/server';
import { FLAG_KEY_PATTERN, FLAG_KEY_MAX_LENGTH } from '@/lib/feature-flags';
import { isPublicPath } from '@/lib/auth/guard';

export {};

const HEADER = 'x-platform-admin-key';
const REAL_KEY = 'p'.repeat(48); // pragma: allowlist secret -- test fixture, never a real credential

const mockFeatureFlag = {
    findMany: jest.fn(),
    upsert: jest.fn(),
};
const mockCohortMember = {
    findMany: jest.fn(),
    groupBy: jest.fn(),
    createMany: jest.fn(),
    deleteMany: jest.fn(),
};
const invalidateSpy = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

interface ReqInit {
    method?: string;
    key?: string;
    body?: unknown;
    /** Raw body text, for the malformed-JSON path. */
    rawBody?: string;
    search?: string;
    path?: string;
}

function makeReq(init: ReqInit = {}): NextRequest {
    const headers = new Headers();
    if (init.key !== undefined) headers.set(HEADER, init.key);
    const path = init.path ?? '/api/admin/feature-flags';
    const url = new URL(`http://localhost:3000${path}${init.search ?? ''}`);
    return {
        method: init.method ?? 'GET',
        headers,
        nextUrl: url,
        url: url.toString(),
        json: async () => {
            if (init.rawBody !== undefined) return JSON.parse(init.rawBody);
            return init.body;
        },
    } as unknown as NextRequest;
}

type Handler = (req: NextRequest) => Promise<Response>;

/** Load both route modules with a chosen platform-key configuration. */
function loadRoutes(key: string | undefined): {
    flags: { GET: Handler; PUT: Handler };
    cohorts: { GET: Handler; POST: Handler; DELETE: Handler };
} {
    jest.resetModules();
    jest.doMock('@/env', () => ({
        env: { PLATFORM_ADMIN_API_KEY: key, PLATFORM_ADMIN_API_KEY_PREVIOUS: undefined },
    }));
    jest.doMock('@/lib/prisma', () => ({
        prisma: { featureFlag: mockFeatureFlag, featureFlagCohortMember: mockCohortMember },
    }));
    // P1.9 — this route appends to the platform audit chain, which opens a
    // prisma transaction. Doubled so the route stays the subject.
    jest.doMock('@/lib/audit/platform-audit-writer', () => ({
        appendPlatformAuditEntry: jest.fn(async () => ({
            id: 'audit-1', entryHash: 'h', previousHash: null, occurredAt: 'now',
        })),
    }));
    jest.doMock('@/lib/feature-flags', () => ({
        ...jest.requireActual('@/lib/feature-flags'),
        invalidateFlagCache: invalidateSpy,
    }));
    return {
        flags: require('@/app/api/admin/feature-flags/route'),
        cohorts: require('@/app/api/admin/feature-flags/cohorts/route'),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FEATURE_FLAGS_FORCE_OFF;
    mockFeatureFlag.findMany.mockResolvedValue([]);
    mockFeatureFlag.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
        ...create,
        updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    }));
    mockCohortMember.findMany.mockResolvedValue([]);
    mockCohortMember.groupBy.mockResolvedValue([]);
    mockCohortMember.createMany.mockResolvedValue({ count: 1 });
    mockCohortMember.deleteMany.mockResolvedValue({ count: 1 });
    invalidateSpy.mockResolvedValue(undefined);
});

describe('the console is REACHABLE, which the handler gate cannot tell you', () => {
    // The sibling half of the gate. Every assertion in this file drives the
    // handler DIRECTLY, so all of them would still pass on a console the Edge
    // 401s before the handler runs — which is how SCIM, the `iflk_` key and
    // three signed webhooks each shipped complete and never once delivered.
    // `isPublicPath` is the real function from `@/lib/auth/guard`.

    it('both routes bypass the Edge session gate', () => {
        expect(isPublicPath('/api/admin/feature-flags')).toBe(true);
        expect(isPublicPath('/api/admin/feature-flags/cohorts')).toBe(true);
    });

    it('and the opening does NOT widen to a neighbouring path', () => {
        // The reason the console's own path is an EXACT entry and only its
        // children get a prefix: a bare `/api/admin/feature-flags` prefix would
        // open everything starting with those bytes. Same hazard as
        // `/api/scim` vs `/api/scimulator`.
        expect(isPublicPath('/api/admin/feature-flagsomething')).toBe(false);
        expect(isPublicPath('/api/admin/feature-flags-export')).toBe(false);
        // Control: the gate is discriminating, not answering false to all.
        expect(isPublicPath('/api/admin/diagnostics')).toBe(false);
        expect(isPublicPath('/api/readyz')).toBe(true);
    });
});

describe('the gate covers every method, read paths included', () => {
    it('503s when no platform key is configured — never falls open', async () => {
        const { flags, cohorts } = loadRoutes(undefined);
        for (const res of [
            await flags.GET(makeReq({ key: REAL_KEY })),
            await flags.PUT(makeReq({ method: 'PUT', key: REAL_KEY, body: { key: 'a', enabled: true } })),
            await cohorts.GET(makeReq({ key: REAL_KEY, path: '/api/admin/feature-flags/cohorts' })),
        ]) {
            expect(res.status).toBe(503);
        }
        // And nothing was read or written on the way to refusing.
        expect(mockFeatureFlag.findMany).not.toHaveBeenCalled();
        expect(mockFeatureFlag.upsert).not.toHaveBeenCalled();
    });

    it.each([
        ['missing header', undefined],
        ['wrong key', 'q'.repeat(48)],
        ['empty key', ''],
        ['right key with a prefix', `x${REAL_KEY}`],
    ])('401s on %s', async (_label, key) => {
        const { flags, cohorts } = loadRoutes(REAL_KEY);
        const reqs: Array<Promise<Response>> = [
            flags.GET(makeReq({ key })),
            flags.PUT(makeReq({ method: 'PUT', key, body: { key: 'social.a', enabled: true } })),
            cohorts.GET(makeReq({ key, path: '/api/admin/feature-flags/cohorts' })),
            cohorts.POST(
                makeReq({
                    method: 'POST',
                    key,
                    path: '/api/admin/feature-flags/cohorts',
                    body: { cohort: 'beta', userId: 'u1' },
                }),
            ),
            cohorts.DELETE(
                makeReq({
                    method: 'DELETE',
                    key,
                    path: '/api/admin/feature-flags/cohorts',
                    search: '?cohort=beta&userId=u1',
                }),
            ),
        ];
        for (const res of await Promise.all(reqs)) expect(res.status).toBe(401);
        expect(mockFeatureFlag.upsert).not.toHaveBeenCalled();
        expect(mockCohortMember.createMany).not.toHaveBeenCalled();
        expect(mockCohortMember.deleteMany).not.toHaveBeenCalled();
    });

    it('lets the right key through — the positive control', async () => {
        const { flags } = loadRoutes(REAL_KEY);
        const res = await flags.GET(makeReq({ key: REAL_KEY }));
        expect(res.status).toBe(200);
        expect(mockFeatureFlag.findMany).toHaveBeenCalledTimes(1);
    });
});

describe('GET reports the raw table and the kill switch', () => {
    const ROWS = [
        { key: 'social.feed', enabled: true, cohorts: ['beta'], description: null, updatedAt: new Date(0) },
        { key: 'social.profiles', enabled: false, cohorts: [], description: 'x', updatedAt: new Date(0) },
    ];

    it('returns the stored state, not a resolved per-caller view', async () => {
        mockFeatureFlag.findMany.mockResolvedValue(ROWS);
        const { flags } = loadRoutes(REAL_KEY);
        const body = await (await flags.GET(makeReq({ key: REAL_KEY }))).json();
        // `social.feed` is enabled AND cohort-gated: off for almost everyone,
        // and the console must still show both halves. A resolved boolean here
        // would hide exactly the state an operator opens this screen to see.
        expect(body.flags).toHaveLength(2);
        expect(body.flags[0]).toMatchObject({ key: 'social.feed', enabled: true, cohorts: ['beta'] });
        expect(body.forcedOff).toBe(false);
    });

    it('surfaces FEATURE_FLAGS_FORCE_OFF beside the rows it overrides', async () => {
        mockFeatureFlag.findMany.mockResolvedValue(ROWS);
        process.env.FEATURE_FLAGS_FORCE_OFF = '1';
        const { flags } = loadRoutes(REAL_KEY);
        const body = await (await flags.GET(makeReq({ key: REAL_KEY }))).json();
        expect(body.forcedOff).toBe(true);
        // The rows are NOT rewritten to false: the stored state is still true,
        // and showing it as false would misreport what a flip-back would do.
        expect(body.flags[0].enabled).toBe(true);
    });

    it('orders by key, so the list is stable between reloads', async () => {
        const { flags } = loadRoutes(REAL_KEY);
        await flags.GET(makeReq({ key: REAL_KEY }));
        expect(mockFeatureFlag.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { key: 'asc' } }),
        );
    });
});

describe('PUT flips a flag and makes the flip visible', () => {
    it('invalidates the table cache — the ≤30s propagation claim', async () => {
        const { flags } = loadRoutes(REAL_KEY);
        const res = await flags.PUT(
            makeReq({ method: 'PUT', key: REAL_KEY, body: { key: 'social.feed', enabled: true } }),
        );
        expect(res.status).toBe(200);
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
    });

    it('omitted cohorts means EVERYONE, written as an empty array not undefined', async () => {
        const { flags } = loadRoutes(REAL_KEY);
        await flags.PUT(makeReq({ method: 'PUT', key: REAL_KEY, body: { key: 'social.feed', enabled: true } }));
        const arg = mockFeatureFlag.upsert.mock.calls[0][0];
        // `undefined` in a Prisma `update` is "leave it alone", so omitting
        // cohorts on a flag that HAS them would quietly keep the old narrowing
        // while the operator believes they just opened it to everyone.
        expect(arg.create.cohorts).toEqual([]);
        expect(arg.update.cohorts).toEqual([]);
    });

    it('an omitted description is left alone; an explicit null clears it', async () => {
        const { flags } = loadRoutes(REAL_KEY);
        await flags.PUT(makeReq({ method: 'PUT', key: REAL_KEY, body: { key: 'social.feed', enabled: false } }));
        expect(mockFeatureFlag.upsert.mock.calls[0][0].update).not.toHaveProperty('description');

        jest.clearAllMocks();
        mockFeatureFlag.upsert.mockResolvedValue({
            key: 'social.feed',
            enabled: false,
            cohorts: [],
            description: null,
            updatedAt: new Date(0),
        });
        await flags.PUT(
            makeReq({
                method: 'PUT',
                key: REAL_KEY,
                body: { key: 'social.feed', enabled: false, description: null },
            }),
        );
        expect(mockFeatureFlag.upsert.mock.calls[0][0].update.description).toBeNull();
    });

    it('never writes updatedByUserId from the request body', async () => {
        const { flags } = loadRoutes(REAL_KEY);
        await flags.PUT(
            makeReq({
                method: 'PUT',
                key: REAL_KEY,
                body: { key: 'social.feed', enabled: true, updatedByUserId: 'attacker' },
            }),
        );
        const arg = mockFeatureFlag.upsert.mock.calls[0][0];
        expect(arg.create).not.toHaveProperty('updatedByUserId');
        expect(arg.update).not.toHaveProperty('updatedByUserId');
    });

    it('400s on a malformed body without writing', async () => {
        const { flags } = loadRoutes(REAL_KEY);
        const res = await flags.PUT(
            makeReq({ method: 'PUT', key: REAL_KEY, body: { key: 'social.feed' } }),
        );
        expect(res.status).toBe(400);
        expect(mockFeatureFlag.upsert).not.toHaveBeenCalled();
        expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('caps the cohort list so one request cannot grow the row without bound', async () => {
        const { flags } = loadRoutes(REAL_KEY);
        const res = await flags.PUT(
            makeReq({
                method: 'PUT',
                key: REAL_KEY,
                body: {
                    key: 'social.feed',
                    enabled: true,
                    cohorts: Array.from({ length: 21 }, (_, i) => `c${i}`),
                },
            }),
        );
        expect(res.status).toBe(400);
        expect(mockFeatureFlag.upsert).not.toHaveBeenCalled();
    });
});

describe('the console accepts exactly the keys the flag-gating guard requires', () => {
    // The agreement test. Each candidate is classified by the SHARED pattern,
    // and the route must answer the same way — so a divergence between the
    // console and `tests/guards/social-routes-flag-gated.test.ts` is a failure
    // here rather than a surface that ships gated on an uncreatable flag.
    const CANDIDATES = [
        'social',
        'social.feed',
        'social.profiles',
        'social.direct-messages',
        'a1.b2.c3',
        'Social.Feed',
        'social..feed',
        'social.',
        '.social',
        'social feed',
        'social_feed',
        'social.FEED',
        '',
        'x'.repeat(FLAG_KEY_MAX_LENGTH),
        'x'.repeat(FLAG_KEY_MAX_LENGTH + 1),
    ];

    it.each(CANDIDATES)('%p', async (key) => {
        const allowedByPattern = FLAG_KEY_PATTERN.test(key) && key.length <= FLAG_KEY_MAX_LENGTH;
        const { flags } = loadRoutes(REAL_KEY);
        const res = await flags.PUT(makeReq({ method: 'PUT', key: REAL_KEY, body: { key, enabled: true } }));
        expect(res.status).toBe(allowedByPattern ? 200 : 400);
    });

    it('the candidate table exercises BOTH verdicts — not all-accept or all-reject', () => {
        // Without this, a pattern mutated to /.*/ (or to /$^/) would leave the
        // table above green: every row would simply agree with the broken
        // pattern. The table has to straddle the boundary to mean anything.
        const accepted = CANDIDATES.filter(
            (k) => FLAG_KEY_PATTERN.test(k) && k.length <= FLAG_KEY_MAX_LENGTH,
        );
        expect(accepted.length).toBeGreaterThan(3);
        expect(CANDIDATES.length - accepted.length).toBeGreaterThan(3);
    });
});

describe('cohort membership is operable, which is what makes cohorts real', () => {
    it('lists cohort SIZES with no argument — an empty cohort is a dead rollout', async () => {
        mockCohortMember.groupBy.mockResolvedValue([
            { cohortKey: 'beta', _count: { _all: 3 } },
            { cohortKey: 'staff', _count: { _all: 0 } },
        ]);
        const { cohorts } = loadRoutes(REAL_KEY);
        const body = await (
            await cohorts.GET(makeReq({ key: REAL_KEY, path: '/api/admin/feature-flags/cohorts' }))
        ).json();
        expect(body.cohorts).toEqual([
            { cohort: 'beta', members: 3 },
            { cohort: 'staff', members: 0 },
        ]);
    });

    it('lists members of one cohort, bounded, and SAYS when it truncated', async () => {
        mockCohortMember.findMany.mockResolvedValue(
            Array.from({ length: 500 }, (_, i) => ({ userId: `u${i}`, createdAt: new Date(0) })),
        );
        const { cohorts } = loadRoutes(REAL_KEY);
        const body = await (
            await cohorts.GET(
                makeReq({ key: REAL_KEY, path: '/api/admin/feature-flags/cohorts', search: '?cohort=beta' }),
            )
        ).json();
        expect(body.members).toHaveLength(500);
        expect(body.truncated).toBe(true);
        expect(mockCohortMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
    });

    it('a short page is not reported as truncated', async () => {
        mockCohortMember.findMany.mockResolvedValue([{ userId: 'u1', createdAt: new Date(0) }]);
        const { cohorts } = loadRoutes(REAL_KEY);
        const body = await (
            await cohorts.GET(
                makeReq({ key: REAL_KEY, path: '/api/admin/feature-flags/cohorts', search: '?cohort=beta' }),
            )
        ).json();
        expect(body.truncated).toBe(false);
    });

    it('adding is idempotent: a re-add reports added:false, not an error', async () => {
        mockCohortMember.createMany.mockResolvedValue({ count: 0 });
        const { cohorts } = loadRoutes(REAL_KEY);
        const res = await cohorts.POST(
            makeReq({
                method: 'POST',
                key: REAL_KEY,
                path: '/api/admin/feature-flags/cohorts',
                body: { cohort: 'beta', userId: 'u1' },
            }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cohort: 'beta', added: false });
        expect(mockCohortMember.createMany).toHaveBeenCalledWith(
            expect.objectContaining({ skipDuplicates: true }),
        );
    });

    it('removal returns the COUNT, so "not a member" is distinguishable from "removed"', async () => {
        mockCohortMember.deleteMany.mockResolvedValue({ count: 0 });
        const { cohorts } = loadRoutes(REAL_KEY);
        const res = await cohorts.DELETE(
            makeReq({
                method: 'DELETE',
                key: REAL_KEY,
                path: '/api/admin/feature-flags/cohorts',
                search: '?cohort=beta&userId=u1',
            }),
        );
        expect(res.status).toBe(200);
        // A delete that removed nothing reporting as a delete is the RLS lesson
        // in miniature — the caller cannot tell the two apart from a 200 alone.
        expect(await res.json()).toEqual({ cohort: 'beta', removed: 0 });
    });

    it('400s a DELETE missing either parameter, rather than deleting a whole cohort', async () => {
        const { cohorts } = loadRoutes(REAL_KEY);
        for (const search of ['', '?cohort=beta', '?userId=u1']) {
            const res = await cohorts.DELETE(
                makeReq({
                    method: 'DELETE',
                    key: REAL_KEY,
                    path: '/api/admin/feature-flags/cohorts',
                    search,
                }),
            );
            expect(res.status).toBe(400);
        }
        expect(mockCohortMember.deleteMany).not.toHaveBeenCalled();
    });

    it('does NOT invalidate the flag cache — membership is not cached', async () => {
        const { cohorts } = loadRoutes(REAL_KEY);
        await cohorts.POST(
            makeReq({
                method: 'POST',
                key: REAL_KEY,
                path: '/api/admin/feature-flags/cohorts',
                body: { cohort: 'beta', userId: 'u1' },
            }),
        );
        // Dropping the whole table's cache on a per-user change would cost every
        // flag read a database round-trip for no gain: `cohortsFor` is read per
        // request by design.
        expect(invalidateSpy).not.toHaveBeenCalled();
    });
});
