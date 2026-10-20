/**
 * `/api/auth/me` tells a client who is a platform-tenant admin — #1587 (e).
 *
 * ## Why a client needs to be told at all
 *
 * The platform console (companies, promotions, and the daily price override)
 * is gated server-side by `requirePermission('admin.manage')` plus
 * `assertPlatformSupport`, which 404s rather than 403s so the console does not
 * announce itself to other tenants. That works, and it leaves every client
 * unable to tell whether to render the entry at all — so the phone would have
 * to show «Цени» to every farmer and let almost all of them find a dead end.
 *
 * ## The two things that are easy to get wrong, and are what this asserts
 *
 *   1. **It cannot be read off the membership already in the payload.** That
 *      query is `take: 1` ordered `createdAt: 'asc'`, i.e. the caller's OLDEST
 *      active membership. A superuser who also farms has their own farm there
 *      and the platform tenant nowhere in the response, so a flag derived from
 *      it would be false for exactly the person it exists for.
 *   2. **"Admin" must mean what the GATE means.** The permission is derived
 *      with `appPermissionsFor` + `hasPermission(..., 'admin.manage')` — the
 *      same two calls `requirePermission` ends in — rather than a role
 *      allowlist, which would drift the day a custom role is granted
 *      `admin.manage`.
 *
 * It is a HINT, never a capability: nothing is authorised by this field.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

const findUnique = jest.fn();
const membershipFindFirst = jest.fn();
jest.mock('@/lib/prisma', () => {
    const client = {
        user: { findUnique: (args: unknown) => findUnique(args) },
        tenantMembership: { findFirst: (args: unknown) => membershipFindFirst(args) },
        featureFlag: { findMany: jest.fn(async () => []) },
        featureFlagCohortMember: { findMany: jest.fn(async () => []) },
    };
    return { __esModule: true, default: client, prisma: client };
});
jest.mock('@/lib/redis', () => ({ getRedis: () => null }));

const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({
    get env() {
        return mockEnv;
    },
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/auth/me/route';

const USER_ID = 'user-1587';
const ROUTE_CTX = { params: Promise.resolve({}) } as never;

/** The caller's own farm, which is NOT the platform tenant. */
const OWN_FARM = {
    role: 'OWNER',
    tenant: { id: 't-own', name: 'Pobeda', slug: 'pobeda' },
    customRole: null,
};

async function callMe(): Promise<{ platformAdmin?: boolean }> {
    auth.mockResolvedValue({ user: { id: USER_ID } });
    findUnique.mockResolvedValue({
        id: USER_ID,
        email: 'owner@example.test',
        name: 'Owner',
        image: null,
        bottomTabOrder: null,
        deletionRequestedAt: null,
        deletionRequestedBy: null,
        terminatedAt: null,
        pseudonymisedAt: null,
        suspendedAt: null,
        // The payload's membership is the caller's OWN farm — deliberately
        // not the platform tenant, which is property (1).
        tenantMemberships: [OWN_FARM],
    });
    const res = await GET(new NextRequest('https://app.agrent.bg/api/auth/me') as never, ROUTE_CTX);
    return (await res.json()) as { platformAdmin?: boolean };
}

beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    membershipFindFirst.mockResolvedValue(null);
});

describe('platformAdmin', () => {
    it('is false, and costs NO QUERY, when no platform tenant is configured', async () => {
        // `PLATFORM_TENANT_SLUG` is unset in production today, and while it is
        // unset the console 404s for everyone — so there is nothing to ask.
        // The call count is the assertion: this is the launch request, and a
        // lookup per launch for a feature nobody can reach is pure cost.
        const body = await callMe();
        expect(body.platformAdmin).toBe(false);
        expect(membershipFindFirst).not.toHaveBeenCalled();
    });

    it('is true for an admin of the platform tenant that is NOT their first farm', async () => {
        mockEnv.PLATFORM_TENANT_SLUG = 'agrent-platform';
        membershipFindFirst.mockResolvedValue({ role: 'ADMIN', customRole: null });

        const body = await callMe();
        expect(body.platformAdmin).toBe(true);

        // Found by SLUG, not by position. Without this the flag could be
        // reading `tenantMemberships[0]` — which is the caller's own farm in
        // this fixture, and would make the assertion above pass for the wrong
        // reason.
        const where = membershipFindFirst.mock.calls[0][0].where;
        expect(where.tenant.slug).toBe('agrent-platform');
        expect(where.userId).toBe(USER_ID);
        expect(where.status).toBe('ACTIVE');
        // A soft-deleted tenant is not a tenant — the #1389 rule the payload's
        // own membership query already follows.
        expect(where.tenant.deletedAt).toBeNull();
    });

    it('is false for a member of the platform tenant WITHOUT admin.manage', async () => {
        mockEnv.PLATFORM_TENANT_SLUG = 'agrent-platform';
        membershipFindFirst.mockResolvedValue({ role: 'READER', customRole: null });
        expect((await callMe()).platformAdmin).toBe(false);
    });

    it('is false when the caller is not a member of the platform tenant', async () => {
        mockEnv.PLATFORM_TENANT_SLUG = 'agrent-platform';
        membershipFindFirst.mockResolvedValue(null);
        expect((await callMe()).platformAdmin).toBe(false);
    });

    it('honours a CUSTOM role that grants admin.manage', async () => {
        // The reason the derivation reuses `appPermissionsFor` instead of
        // listing roles: a custom role with a base of READER and
        // `admin.manage` granted is an admin to `requirePermission`, and a
        // role allowlist would call them a farmer.
        mockEnv.PLATFORM_TENANT_SLUG = 'agrent-platform';
        membershipFindFirst.mockResolvedValue({
            role: 'READER',
            customRole: {
                baseRole: 'READER',
                permissionsJson: { admin: { manage: true } },
            },
        });
        expect((await callMe()).platformAdmin).toBe(true);
    });

    it('does NOT let a custom role REMOVE it from a base that has it', async () => {
        // The other direction, because `parsePermissionsJson` takes a base
        // role: an OWNER whose custom role says nothing about `admin` must
        // not silently lose the console.
        mockEnv.PLATFORM_TENANT_SLUG = 'agrent-platform';
        membershipFindFirst.mockResolvedValue({
            role: 'OWNER',
            customRole: { baseRole: 'OWNER', permissionsJson: {} },
        });
        // `parsePermissionsJson` starts from the BASE ROLE's defaults and
        // overrides only the domains and actions the JSON names, so an empty
        // object keeps everything OWNER has. Asserted as `true` rather than
        // as "a boolean": a `typeof` check here would pass whatever the
        // function did, including losing the permission entirely, which is
        // the failure the test is named after.
        expect((await callMe()).platformAdmin).toBe(true);
    });
});
