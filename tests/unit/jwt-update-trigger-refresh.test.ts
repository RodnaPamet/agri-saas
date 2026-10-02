/**
 * Unit test — JWT membership refresh on `useSession().update()`.
 *
 * The `jwt` callback used to load tenant/org membership claims ONLY at
 * sign-in (`account && user`). That froze the claims: a membership the
 * user gained afterwards — most commonly a tenant they just created
 * (where they're granted OWNER) — stayed invisible to the Edge
 * tenant-access gate until a full re-login, so navigating into the new
 * tenant bounced to /no-tenant.
 *
 * The fix reloads the claims when the callback fires with
 * `trigger === 'update'` (what `useSession().update()` triggers). This
 * test locks that contract: an update-triggered callback re-reads the
 * DB and surfaces the freshly-created tenant in `token.memberships`.
 */

const findUnique = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { user: {
            // #1237: the email lookup is `findFirst` now — an `in`
            // predicate is not valid on `findUnique`. Same double.
            findFirst: (...a: unknown[]) => findUnique(...a), findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

import { authOptions } from '@/auth';

type JwtCb = NonNullable<NonNullable<typeof authOptions.callbacks>['jwt']>;

const jwtCallback = authOptions.callbacks!.jwt as JwtCb;

describe('jwt callback — membership refresh on update trigger', () => {
    beforeEach(() => findUnique.mockReset());

    it('re-reads memberships (incl. a newly-created OWNER tenant) on trigger=update', async () => {
        findUnique.mockResolvedValue({
            id: 'user-1',
            sessionVersion: 3,
            tenantMemberships: [
                {
                    tenantId: 't-new',
                    role: 'OWNER',
                    tenant: { id: 't-new', slug: 'pwc-nis2' },
                },
            ],
            orgMemberships: [
                {
                    organizationId: 'o-1',
                    role: 'ORG_ADMIN',
                    organization: { id: 'o-1', slug: 'my-org' },
                },
            ],
        });

        // A stale token: signed in before the tenant existed, so it
        // carries no memberships.
        const staleToken = {
            email: 'owner@example.com',
            userId: 'user-1',
            memberships: [],
            orgMemberships: [],
        };

        const result = await jwtCallback({
            token: staleToken as never,
            trigger: 'update',
        } as never);

        // At least the membership reload hit the DB (the throttled
        // sessionVersion check may add a second, unrelated read).
        expect(findUnique).toHaveBeenCalled();
        expect(result.memberships).toEqual([
            { slug: 'pwc-nis2', role: 'OWNER', tenantId: 't-new' },
        ]);
        // Primary/back-compat claims track the (only) membership.
        expect(result.tenantSlug).toBe('pwc-nis2');
        expect(result.role).toBe('OWNER');
        expect(result.orgMemberships).toEqual([
            { slug: 'my-org', role: 'ORG_ADMIN', organizationId: 'o-1' },
        ]);
    });

    it('does NOT re-read the DB on a normal (non-update) subsequent request', async () => {
        const token = {
            email: 'owner@example.com',
            userId: 'user-1',
            memberships: [{ slug: 'acme', role: 'OWNER', tenantId: 't-acme' }],
        };

        const result = await jwtCallback({ token: token as never } as never);

        expect(findUnique).not.toHaveBeenCalled();
        // Claims untouched.
        expect(result.memberships).toEqual([
            { slug: 'acme', role: 'OWNER', tenantId: 't-acme' },
        ]);
    });
});
