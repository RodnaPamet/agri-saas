/**
 * `/api/auth/me` returns the coarse permission tier (#1768).
 *
 * ## Why the server owes a client this
 *
 * `agrent-ios` was mirroring this server's role ladder on the phone to decide
 * whether to render a write control — it knew MECHANISATOR was out and asked
 * whether READER was too. A second copy of an authorisation rule drifts the
 * moment a role's level changes, and a PERMISSIVE drift shows a farmer a
 * button whose request is refused after they have typed a treatment into it.
 *
 * ## Derived, not listed
 *
 * Every case drives `computePermissions` — the function the usecases gate on —
 * rather than asserting literals. A literal table here would be a THIRD copy
 * of the ladder, which is the defect this field exists to remove.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

const findUnique = jest.fn();
// Both export shapes, and the flag models stubbed: the handler also runs
// `resolveFlags`, which imports the NAMED export. A mock supplying only
// `default` leaves the client undefined inside the resolver — the precedent is
// `tests/unit/auth-me-role-null.test.ts`.
jest.mock('@/lib/prisma', () => {
    const client = {
        user: { findUnique: (args: unknown) => findUnique(args) },
        featureFlag: { findMany: jest.fn(async () => []) },
        featureFlagCohortMember: { findMany: jest.fn(async () => []) },
    };
    return { __esModule: true, default: client, prisma: client };
});
jest.mock('@/lib/redis', () => ({ getRedis: () => null }));
jest.mock('@/lib/observability/logger', () => ({
    ...jest.requireActual('@/lib/observability/logger'),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from 'next/server';
import type { Role } from '@prisma/client';

import { GET } from '@/app/api/auth/me/route';
import { computePermissions } from '@/lib/tenant-context';

const ALL_ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'MECHANISATOR'];

type Coarse = {
    canRead: boolean;
    canWrite: boolean;
    canAdmin: boolean;
    canAudit: boolean;
    canExport: boolean;
};
type MeBody = {
    user?: { role?: string | null; permissions?: Coarse | null };
    tenant?: unknown;
};

function userRow(role: Role | null) {
    return {
        id: 'u-1',
        email: 'farmer@example.test',
        name: 'Иван',
        image: null,
        bottomTabOrder: null,
        deletionRequestedAt: null,
        suspendedAt: null,
        tenantMemberships: role
            ? [{ role, tenant: { id: 't-1', name: 'Ферма', slug: 'ferma' } }]
            : [],
    };
}

function req(): NextRequest {
    return new NextRequest('https://app.agrent.bg/api/auth/me', { method: 'GET' });
}

async function callMe(role: Role | null): Promise<MeBody> {
    findUnique.mockResolvedValue(userRow(role));
    const res = await GET(req(), { params: Promise.resolve({}) });
    return (await res.json()) as MeBody;
}

beforeEach(() => {
    auth.mockReset();
    findUnique.mockReset();
    auth.mockResolvedValue({ user: { id: 'u-1', email: 'farmer@example.test' } });
});

describe('every role gets the tier the usecases actually gate on', () => {
    it.each(ALL_ROLES)('%s matches computePermissions exactly', async (role) => {
        const body = await callMe(role);

        // Compared against the real function, not a table. If the ladder
        // changes, this moves with it — a literal table would be the third
        // copy of the rule and would drift exactly like the client's did.
        expect(body.user?.permissions).toEqual(computePermissions(role));
    });

    it('returns all five fields, not a curated subset', async () => {
        const body = await callMe('EDITOR');

        // #1768 named four; the whole object is returned because a hand-picked
        // subset is a second list to maintain. A tier added server-side must
        // appear here without anyone remembering to add it.
        expect(Object.keys(body.user!.permissions!).sort()).toEqual(
            ['canAdmin', 'canAudit', 'canExport', 'canRead', 'canWrite'],
        );
        expect(Object.keys(body.user!.permissions!).sort())
            .toEqual(Object.keys(computePermissions('EDITOR')).sort());
    });

    it('DISCRIMINATES between roles — it is not one constant answer', async () => {
        // The control. Without it, a handler returning a fixed object would
        // satisfy nothing above only by luck, and a handler returning
        // `computePermissions('OWNER')` for everyone would satisfy the
        // per-role cases for OWNER alone while looking green overall.
        const reader = (await callMe('READER')).user?.permissions;
        const owner = (await callMe('OWNER')).user?.permissions;

        expect(reader).not.toEqual(owner);
        expect(reader?.canWrite).toBe(false);
        expect(owner?.canWrite).toBe(true);
    });

    it('the three roles that cannot write report canWrite false', async () => {
        // The concrete question agrent-ios asked, answered on the wire.
        for (const role of ALL_ROLES.filter((r) => !computePermissions(r).canWrite)) {
            const body = await callMe(role);
            expect({ role, canWrite: body.user?.permissions?.canWrite })
                .toEqual({ role, canWrite: false });
        }
    });
});

describe('no membership means no referent', () => {
    it('permissions is NULL, not a set of falses', async () => {
        const body = await callMe(null);

        // Same rule as `role`, and agreeing with it: a role with no tenant has
        // no referent, so neither does its tier. An all-false object would
        // read as "you are permitted nothing" where the truth is "you have no
        // farm" — and `tenant: null` beside it already says which.
        expect(body.user?.permissions).toBeNull();
        expect(body.user?.role).toBeNull();
        expect(body.tenant).toBeNull();
    });

    it('role and permissions are null TOGETHER, always', async () => {
        // The spec states they agree. Asserted as a conjunction so a change
        // that nulled one without the other fails here rather than confusing
        // a client that trusted the sentence.
        for (const role of [null, ...ALL_ROLES] as (Role | null)[]) {
            const body = await callMe(role);
            expect((body.user?.role === null) === (body.user?.permissions === null)).toBe(true);
        }
    });
});

describe('it costs nothing', () => {
    it('adds no query to the launch request', async () => {
        await callMe('OWNER');

        // `auth-me-avatar-url.test.ts` owns this property for the whole route;
        // asserted here too because every field added to this payload is a
        // chance to break it, and the values are a pure function of the `role`
        // the existing select already returns.
        expect(findUnique).toHaveBeenCalledTimes(1);
    });

    it('does not widen the membership select', async () => {
        await callMe('OWNER');

        // Nothing new is read: `role` was already selected for the adjacent
        // field. If this ever needs a column the select does not have, the
        // query-count property above is what pays for it.
        const select = findUnique.mock.calls[0][0].select;
        expect(select.tenantMemberships.select.role).toBe(true);
    });
});
