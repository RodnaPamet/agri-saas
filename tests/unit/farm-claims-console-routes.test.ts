/**
 * The session-authenticated farm-claim review routes — #2963.
 *
 * P3.9 shipped the usecase and two keyed routes, all Edge-reachable, and no
 * way in for a person: measured 2026-11-10, one claim PENDING since
 * 2026-10-13, because reviewing it meant holding `PLATFORM_ADMIN_API_KEY` and
 * composing a request by hand. #2706 established the session-gated sibling as
 * the answer rather than pasting a credential into a form.
 *
 * Four properties, and the first two are the ones that would be silent:
 *
 *   1. `reviewedBy` comes from the SESSION. The keyed sibling reads it from
 *      the body, so whoever holds the key can type any name into the audit
 *      trail — the weakness #2735 exists to fix.
 *   2. a body that SUPPLIES `reviewedBy` cannot override it. Asserting (1)
 *      alone would pass for a route that merely defaulted it.
 *   3. both gates run — `admin.manage` AND `assertPlatformSupport`. The second
 *      is what stops an ADMIN of any farm verifying ANOTHER farm's identity,
 *      because `FarmIdentityClaim` has no `tenantId` to scope by.
 *   4. all seven outcomes keep their own status, and the map matches the keyed
 *      route's. Two doors answering differently for one outcome is how a
 *      client comes to believe two things about one claim.
 */
import type { NextRequest } from 'next/server';

const permissionKeys: string[] = [];
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission:
        (key: string, handler: unknown) =>
        async (req: unknown, routeArgs: { params: unknown }) => {
            permissionKeys.push(key);
            // RESOLVES `params` before calling the handler, exactly as the real
            // wrapper does — GAP-05 moved that await into `requirePermission`
            // so handlers read `params.foo` directly. A mock that passed the
            // Promise through would hand the handler an unawaited object and
            // every id would be `undefined`, which reads as a routing bug
            // rather than a test harness one.
            const params = await routeArgs.params;
            return (handler as (r: unknown, a: unknown, ctx: unknown) => Promise<unknown>)(
                req,
                { ...routeArgs, params },
                { userId: 'u-reviewer', tenantId: 't-platform', tenantSlug: 'platform' },
            );
        },
}));

const assertPlatformSupport = jest.fn();
jest.mock('@/lib/auth/platform-support', () => ({
    assertPlatformSupport: (...a: unknown[]) => assertPlatformSupport(...a),
    isPlatformTenant: () => true,
}));

const verifyFarmClaim = jest.fn();
const disputeFarmClaim = jest.fn();
const listFarmClaims = jest.fn();
jest.mock('@/app-layer/usecases/farm-identity-review', () => ({
    verifyFarmClaim: (...a: unknown[]) => verifyFarmClaim(...a),
    disputeFarmClaim: (...a: unknown[]) => disputeFarmClaim(...a),
    listFarmClaims: (...a: unknown[]) => listFarmClaims(...a),
}));

/**
 * `withApiErrorHandling` reads `req.headers.get(...)` and
 * `req.nextUrl.pathname`, so a bare `{ url, json }` object throws a TypeError
 * inside the wrapper before any handler runs — which is how my first draft
 * made the two REJECTION cases pass for the wrong reason. Same shape as
 * `admin-feature-flags-console`'s `makeReq`.
 */
function makeReq(path: string, body?: unknown, method = 'GET'): NextRequest {
    const url = new URL(`http://localhost:3000${path}`);
    return {
        method,
        headers: new Headers(),
        nextUrl: url,
        url: url.toString(),
        json: async () => body,
    } as unknown as NextRequest;
}

function post(body: unknown): NextRequest {
    return makeReq('/api/t/platform/admin/farm-claims/c-1/verify', body, 'POST');
}

function get(query = ''): NextRequest {
    return makeReq(`/api/t/platform/admin/farm-claims${query}`);
}

// A PROMISE, because that is what the exported handler's type takes: the
// transparent-await shim is gone (GAP-05) and `requirePermission` owns the
// resolution. This repo's convention for invoking a wrapped route.
const params = { params: Promise.resolve({ tenantSlug: 'platform', claimId: 'c-1' }) };
const queueParams = { params: Promise.resolve({ tenantSlug: 'platform' }) };

beforeEach(() => {
    permissionKeys.length = 0;
    assertPlatformSupport.mockReset();
    verifyFarmClaim.mockReset();
    disputeFarmClaim.mockReset();
    listFarmClaims.mockReset().mockResolvedValue([]);
});

describe('POST verify', () => {
    it('passes `reviewedBy` from the SESSION, never the body', async () => {
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/farm-claims/[claimId]/verify/route'
        );
        verifyFarmClaim.mockResolvedValue({ result: 'VERIFIED' });

        await POST(post({ eik: '123456789' }), params);

        expect(verifyFarmClaim).toHaveBeenCalledWith({
            claimId: 'c-1',
            eik: '123456789',
            reviewedBy: 'u-reviewer',
        });
    });

    it('IGNORES a `reviewedBy` supplied in the body', async () => {
        // The half that makes the assertion above mean something: a route that
        // merely DEFAULTED the field would satisfy it and still let a caller
        // override. `Body` has no such field, so zod strips it.
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/farm-claims/[claimId]/verify/route'
        );
        verifyFarmClaim.mockResolvedValue({ result: 'VERIFIED' });

        await POST(post({ eik: '123456789', reviewedBy: 'somebody-else' }), params);

        const arg = verifyFarmClaim.mock.calls[0]![0] as { reviewedBy: string };
        expect(arg.reviewedBy).toBe('u-reviewer');
    });

    it('runs BOTH gates', async () => {
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/farm-claims/[claimId]/verify/route'
        );
        verifyFarmClaim.mockResolvedValue({ result: 'VERIFIED' });

        await POST(post({ eik: '123456789' }), params);

        expect(permissionKeys).toEqual(['admin.manage']);
        // `admin.manage` is necessary and NOT sufficient: every tenant's admin
        // holds it, and the claim has no `tenantId` to scope by.
        expect(assertPlatformSupport).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['VERIFIED', 200],
        ['ALREADY_VERIFIED', 200],
        ['EIK_MISMATCH', 422],
        ['EIK_INVALID', 400],
        ['NOT_FOUND', 404],
        ['DISPUTED_COLLISION', 409],
        ['ALREADY_DISPUTED', 409],
    ])('maps %s to %i', async (result, status) => {
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/farm-claims/[claimId]/verify/route'
        );
        verifyFarmClaim.mockResolvedValue({ result });

        const res = await POST(post({ eik: '123456789' }), params);

        expect(res.status).toBe(status);
        await expect(res.json()).resolves.toEqual({ result });
    });

    it('refuses a body with no ЕИК rather than calling the usecase', async () => {
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/farm-claims/[claimId]/verify/route'
        );

        // A RESPONSE, not a rejection: `withApiErrorHandling` catches a coded
        // error and renders it, which is its whole job — so what a client sees
        // is a 400, and that is what this asserts.
        const res = await POST(post({}), params);
        expect(res.status).toBe(400);
        // NOT CALLED is the assertion. A route that called the usecase with an
        // empty string would get `EIK_INVALID` back and look like it had
        // validated, while having asked the database about nothing.
        expect(verifyFarmClaim).not.toHaveBeenCalled();
    });
});

describe('GET the queue', () => {
    it('defaults to PENDING — the queue is work outstanding', async () => {
        const { GET } = await import('@/app/api/t/[tenantSlug]/admin/farm-claims/route');
        await GET(get(), queueParams);
        expect(listFarmClaims).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'PENDING' }),
        );
    });

    it('honours an explicit status', async () => {
        const { GET } = await import('@/app/api/t/[tenantSlug]/admin/farm-claims/route');
        await GET(get('?status=DISPUTED'), queueParams);
        expect(listFarmClaims).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'DISPUTED' }),
        );
    });

    it('REFUSES an unrecognised status rather than ignoring it', async () => {
        const { GET } = await import('@/app/api/t/[tenantSlug]/admin/farm-claims/route');
        // Ignoring it would answer with the default queue under a filter the
        // caller asked for and did not get, so a reviewer looking for DISPUTED
        // claims would read a list of PENDING ones as "there are none".
        // The STATUS plus "the usecase was not called". My first draft wrote
        // `rejects.toThrow()` with no shape, and it passed — on a TypeError
        // from my own malformed fake request, before the handler ran at all. A
        // rejection assertion with no shape is satisfied by any error,
        // including one that means the test never reached the code.
        const res = await GET(get('?status=REJECTED'), queueParams);
        expect(res.status).toBe(400);
        expect(listFarmClaims).not.toHaveBeenCalled();
    });

    it('refuses MORE THAN ONE status rather than truncating', async () => {
        const { GET } = await import('@/app/api/t/[tenantSlug]/admin/farm-claims/route');
        const res = await GET(
            get('?status=PENDING,DISPUTED'), queueParams,
        );
        expect(res.status).toBe(400);
        expect(listFarmClaims).not.toHaveBeenCalled();
    });

    it('runs BOTH gates', async () => {
        const { GET } = await import('@/app/api/t/[tenantSlug]/admin/farm-claims/route');
        await GET(get(), queueParams);
        expect(permissionKeys).toEqual(['admin.manage']);
        expect(assertPlatformSupport).toHaveBeenCalledTimes(1);
    });

    it('returns what the usecase gave, and the usecase holds no ЕИК', async () => {
        const { GET } = await import('@/app/api/t/[tenantSlug]/admin/farm-claims/route');
        const row = {
            id: 'c-1', tenantId: 't-1', tenantName: 'Acme', tenantSlug: 'acme',
            status: 'PENDING', claimedByUserId: 'u-1',
            createdAt: new Date('2026-10-13T00:00:00Z'),
            verifiedAt: null, disputedAt: null,
        };
        listFarmClaims.mockResolvedValue([row]);

        const res = await GET(get(), queueParams);
        const body = (await res.json()) as { claims: Record<string, unknown>[] };

        expect(body.claims).toHaveLength(1);
        // No ЕИК and no HASH. The hash is not plaintext but it IS a stable
        // per-identity token, so handing it to a console would let anyone who
        // can read a screenshot correlate two farms' claims — the usecase's
        // own docblock says so, and this asserts the route adds neither back.
        const keys = Object.keys(body.claims[0]!);
        expect(keys).not.toContain('eik');
        expect(keys).not.toContain('eikHash');
        // The control: the row really did arrive, so the absences above are
        // absences in a populated object rather than in an empty one.
        expect(body.claims[0]!.id).toBe('c-1');
    });
});

describe('POST dispute — the refusal path', () => {
    const disputePath = '@/app/api/t/[tenantSlug]/admin/farm-claims/[claimId]/dispute/route';

    function disputeReq(body: unknown): NextRequest {
        return makeReq('/api/t/platform/admin/farm-claims/c-1/dispute', body, 'POST');
    }

    it('exists at all — the asymmetry this closes', async () => {
        // The reason this route was added (owner ruling 2026-11-10): the page
        // wired only `verify`, so approving was a field and a button while
        // refusing meant a terminal. `disputeFarmClaim`'s own docblock argues
        // against exactly that — it does not require an ЕИК because
        // "demanding one would make the refusal path harder than the approval
        // path" — and a console that made refusal harder nudges a reviewer
        // toward approval, which is the opposite of what identity
        // verification wants.
        const { POST } = await import(disputePath);
        expect(typeof POST).toBe('function');
    });

    it('passes `reviewedBy` from the SESSION and the reason from the body', async () => {
        const { POST } = await import(disputePath);
        disputeFarmClaim.mockResolvedValue({ result: 'DISPUTED' });

        await POST(disputeReq({ reason: 'ЕИК belongs to a different company' }), params);

        expect(disputeFarmClaim).toHaveBeenCalledWith({
            claimId: 'c-1',
            reason: 'ЕИК belongs to a different company',
            reviewedBy: 'u-reviewer',
        });
    });

    it('REQUIRES a reason, and does not call the usecase without one', async () => {
        const { POST } = await import(disputePath);

        const res = await POST(disputeReq({}), params);

        expect(res.status).toBe(400);
        // Both this and `verify`'s collision case leave `status = DISPUTED`,
        // so a reasonless dispute produces a row that cannot say which
        // happened — and the next reviewer inherits a verdict with no grounds.
        expect(disputeFarmClaim).not.toHaveBeenCalled();
    });

    it('refuses a blank reason, not just a missing one', async () => {
        const { POST } = await import(disputePath);
        const res = await POST(disputeReq({ reason: '   ' }), params);
        expect(res.status).toBe(400);
        expect(disputeFarmClaim).not.toHaveBeenCalled();
    });

    it.each([
        ['DISPUTED', 200],
        ['NOT_FOUND', 404],
        ['ALREADY_VERIFIED', 409],
    ])('maps %s to %i, matching the keyed route', async (result, status) => {
        const { POST } = await import(disputePath);
        disputeFarmClaim.mockResolvedValue({ result });
        const res = await POST(disputeReq({ reason: 'why' }), params);
        expect(res.status).toBe(status);
    });

    it('runs BOTH gates', async () => {
        const { POST } = await import(disputePath);
        disputeFarmClaim.mockResolvedValue({ result: 'DISPUTED' });
        await POST(disputeReq({ reason: 'why' }), params);
        expect(permissionKeys).toEqual(['admin.manage']);
        expect(assertPlatformSupport).toHaveBeenCalledTimes(1);
    });

    it('does NOT accept a `reviewedBy` from the body', async () => {
        const { POST } = await import(disputePath);
        disputeFarmClaim.mockResolvedValue({ result: 'DISPUTED' });
        await POST(disputeReq({ reason: 'why', reviewedBy: 'somebody-else' }), params);
        const arg = disputeFarmClaim.mock.calls[0]![0] as { reviewedBy: string };
        expect(arg.reviewedBy).toBe('u-reviewer');
    });
});
