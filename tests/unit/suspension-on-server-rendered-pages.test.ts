/**
 * A suspended account cannot have a page rendered for it (#1657).
 *
 * P5.9 put the check in `getSessionOrThrow`, #1652 routed nine API routes
 * through it — and NO page reached it, because a server component does not call
 * a ctx resolver. The tenant subtree's gate, `getTenantServerContext`, takes the
 * `userId` as a parameter: a helper handed an id cannot ask whether that id is
 * allowed to be here.
 *
 * Four pages rendered farm data directly off a bare `auth()`:
 * `t/{slug}/(app)/admin/billing`, `.../admin/rbac`, `t/{slug}/(app)/layout` and
 * the `/tenants` picker.
 *
 * ## The assertion that is not about a status code
 *
 * `redirect()` works by THROWING, with a `digest` of `NEXT_REDIRECT;…`. The
 * tenant layout wrapped its context call in `try { … } catch { notFound() }`,
 * so a redirect raised inside would have been caught and turned into a 404 —
 * the "your farm does not exist" answer the owner's ruling explicitly rejected,
 * arriving by accident. `the layout's catch` below is the case that covers it,
 * and it is the one a status-code test could not express.
 */
const isAccountSuspended = jest.fn();
jest.mock('@/lib/auth/suspension', () => ({
    ...jest.requireActual('@/lib/auth/suspension'),
    isAccountSuspended: (userId: string) => isAccountSuspended(userId),
}));

const resolveTenantContext = jest.fn();
jest.mock('@/lib/tenant-context', () => ({
    ...jest.requireActual('@/lib/tenant-context'),
    resolveTenantContext: (...a: unknown[]) => resolveTenantContext(...a),
}));

import {
    SUSPENDED_PATH,
    isNextControlFlow,
    redirectIfSuspended,
} from '@/lib/auth/suspension-page';
import { getTenantServerContext } from '@/lib/server/tenant-context.server';

/** What `next/navigation`'s redirect throws, by its only stable surface. */
const redirectError = (to: string): Error & { digest: string } =>
    Object.assign(new Error('NEXT_REDIRECT'), {
        digest: `NEXT_REDIRECT;replace;${to};307;`,
    });

beforeEach(() => {
    jest.clearAllMocks();
    isAccountSuspended.mockResolvedValue(false);
    resolveTenantContext.mockResolvedValue({
        tenant: { id: 'tn-1', slug: 'ferma', name: 'Ферма', currencySymbol: '€' },
        role: 'OWNER',
        permissions: {},
        appPermissions: {},
    });
});

describe('redirectIfSuspended', () => {
    it('sends a suspended account to /suspended', async () => {
        isAccountSuspended.mockResolvedValue(true);
        await expect(redirectIfSuspended('u-1')).rejects.toMatchObject({
            digest: expect.stringContaining(`NEXT_REDIRECT;replace;${SUSPENDED_PATH}`),
        });
    });

    it('returns quietly for an active account', async () => {
        await expect(redirectIfSuspended('u-1')).resolves.toBeUndefined();
    });

    it('asks about the id it was given', async () => {
        await redirectIfSuspended('u-9');
        expect(isAccountSuspended).toHaveBeenCalledWith('u-9');
    });
});

describe('getTenantServerContext', () => {
    it('redirects a suspended member rather than resolving the tenant', async () => {
        isAccountSuspended.mockResolvedValue(true);
        await expect(
            getTenantServerContext({ tenantSlug: 'ferma', userId: 'u-1' }),
        ).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT') });
    });

    it('checks BEFORE the membership lookup, and that order is the answer', async () => {
        // Not only "no wasted query". `resolveTenantContext` THROWS for a
        // non-member, and the layout turns that into `notFound()` — so a check
        // placed after it would answer "no such farm" to a suspended member,
        // which is exactly the 404 the ruling rejected.
        isAccountSuspended.mockResolvedValue(true);
        await expect(
            getTenantServerContext({ tenantSlug: 'ferma', userId: 'u-1' }),
        ).rejects.toBeDefined();
        expect(resolveTenantContext).not.toHaveBeenCalled();
    });

    it('still resolves for an active member — the control', async () => {
        // Without this, a check that refused everyone would satisfy both tests
        // above.
        const ctx = await getTenantServerContext({
            tenantSlug: 'ferma',
            userId: 'u-1',
        });
        expect(ctx.tenant.id).toBe('tn-1');
        expect(isAccountSuspended).toHaveBeenCalledWith('u-1');
    });
});

describe('isNextControlFlow — the layout catch guard', () => {
    it('recognises a redirect and a not-found', () => {
        expect(isNextControlFlow(redirectError('/suspended'))).toBe(true);
        expect(
            isNextControlFlow(Object.assign(new Error('x'), { digest: 'NEXT_NOT_FOUND' })),
        ).toBe(true);
    });

    it('does NOT claim an ordinary error, which is what keeps the catch useful', () => {
        // The tenant layout still has to answer `notFound()` for a non-member.
        // A predicate that returned true for everything would re-throw a
        // membership failure as a 500.
        expect(isNextControlFlow(new Error('db is down'))).toBe(false);
        expect(isNextControlFlow({ digest: 'SOMETHING_ELSE' })).toBe(false);
        expect(isNextControlFlow(null)).toBe(false);
        expect(isNextControlFlow(undefined)).toBe(false);
        expect(isNextControlFlow('NEXT_REDIRECT')).toBe(false);
    });
});

describe("the layout's catch, as source", () => {
    // The layout is an async RSC that awaits `params`, `headers()` and three
    // tenant reads; invoking it here would be a test about its mocks. The
    // property that matters is one line, so it is asserted on the source — and
    // the BEHAVIOUR of the predicate it calls is executed above, which is the
    // half a source assertion cannot reach.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = readFileSync(
        `${process.cwd()}/src/app/t/[tenantSlug]/layout.tsx`,
        'utf8',
    );

    it('re-throws control flow instead of swallowing it into notFound()', () => {
        expect(src).toContain('if (isNextControlFlow(error)) throw error;');
    });

    it('still falls through to notFound() for everything else', () => {
        // The guard must not have become an unconditional re-throw: a
        // non-member has to keep getting a 404.
        expect(src).toMatch(/if \(isNextControlFlow\(error\)\) throw error;\s*\n\s*notFound\(\);/);
    });
});
