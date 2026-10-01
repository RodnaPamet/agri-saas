/**
 * GET /api/auth/me — `role` and `tenant` answer the SAME question, so they are
 * asserted TOGETHER (#1190).
 *
 * The defect this pins was not a wrong value in isolation; it was two fields in
 * one payload disagreeing. `tenant` was correctly `null` for a user with no
 * active membership while `role` fell back to `'READER'` — a real role granting
 * `view` on evidence/tasks/reports/knowledge plus evidence `download` — so the
 * server answered "who am I" with view access for a principal who has none.
 * Reading either field alone looked defensible, which is why the assertion
 * below reads BOTH in one expression and why both rows of the table run it.
 *
 * It EXECUTES the route rather than grepping it: a guard matching `?? 'READER'`
 * in source would have proved the token is gone and nothing about what the
 * handler returns.
 *
 * The membership query is NOT under test here and is deliberately unchanged —
 * `status: 'ACTIVE'`, `orderBy: { createdAt: 'asc' }`, `take: 1` is the
 * "primary (oldest) membership" convention `src/auth.ts` uses for the
 * `tenantSlug` claim. The mock stands in for that query's RESULT.
 *
 * No `as any` and no file-level eslint-disable: `withApiErrorHandling` types
 * its context parameter as `unknown`, so the handler is callable directly. The
 * lint ceilings in this repo have single digits of headroom — a test double
 * that needs no cast costs neither a warning nor a suppression.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

const findUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { user: { findUnique: () => findUnique() } },
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/auth/me/route';

/**
 * A NextRequest, not a bare Request: `withApiErrorHandling` reads
 * `nextUrl.pathname` for its request-id logging, so a plain Request throws
 * before the handler runs — a failure about the harness, not the route.
 */
function req() {
    return new NextRequest('https://app.agrent.bg/api/auth/me', { method: 'GET' });
}

const TENANT = { id: 'tenant-1', name: 'Acme Farm', slug: 'acme' };

interface MeBody {
    user: { role: string | null };
    tenant: { id: string; name: string; slug: string } | null;
}

async function callMe(memberships: unknown[]): Promise<MeBody> {
    auth.mockResolvedValue({ user: { id: 'user-1' } });
    findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'operator@example.com',
        name: 'Operator',
        bottomTabOrder: null,
        tenantMemberships: memberships,
    });
    const res = await GET(req(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    return (await res.json()) as MeBody;
}

/**
 * Both membership states, driven from ONE table so the paired assertion runs
 * on each. A single-case test would pass against a handler that answers `null`
 * unconditionally; the second row is the discriminator that makes the first
 * row's `null` mean "no membership" rather than "never populated".
 */
const CASES: Array<{
    name: string;
    memberships: unknown[];
    expectedRole: string | null;
    expectedTenantSlug: string | null;
}> = [
    {
        name: 'no active membership',
        memberships: [],
        expectedRole: null,
        expectedTenantSlug: null,
    },
    {
        name: 'one active membership',
        memberships: [{ role: 'EDITOR', tenant: TENANT }],
        expectedRole: 'EDITOR',
        expectedTenantSlug: 'acme',
    },
];

describe('GET /api/auth/me — role and tenant never disagree (#1190)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        auth.mockReset();
        findUnique.mockReset();
    });

    it('a user with NO active membership gets role: null AND tenant: null', async () => {
        const body = await callMe([]);

        // One expression over BOTH fields. Asserted as a pair because the
        // defect WAS the pair disagreeing — `expect(role).toBeNull()` beside
        // `expect(tenant).toBeNull()` passes for each field in isolation and
        // says nothing about them agreeing.
        expect({ role: body.user.role, tenant: body.tenant }).toEqual({
            role: null,
            tenant: null,
        });

        // And explicitly NOT the fabricated role, so the regression this
        // closes is named in the failure output.
        expect(body.user.role).not.toBe('READER');
    });

    it.each(CASES)(
        'role and tenant are populated or null TOGETHER: $name',
        async ({ memberships, expectedRole, expectedTenantSlug }) => {
            const body = await callMe(memberships);

            expect(body.user.role).toBe(expectedRole);
            expect(body.tenant?.slug ?? null).toBe(expectedTenantSlug);

            // The invariant, derived rather than restated: a role exists
            // exactly when a tenant does. A fallback on either side breaks
            // this for the empty row whatever value it invents.
            expect(body.user.role === null).toBe(body.tenant === null);
        },
    );

    // CONTROL — the membership's own role is what reaches the wire, so the
    // null above is the ABSENCE of a membership and not a handler that has
    // stopped reading the field at all.
    it('CONTROL: an active membership reports ITS role, not a default', async () => {
        const body = await callMe([{ role: 'MECHANISATOR', tenant: TENANT }]);
        expect(body.user.role).toBe('MECHANISATOR');
        expect(body.tenant).toEqual(TENANT);
    });
});
