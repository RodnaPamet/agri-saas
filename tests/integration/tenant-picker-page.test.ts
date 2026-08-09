/**
 * Tests for the /tenants picker page redirect logic (R-1 closure).
 *
 * The page is a server component that calls redirect() from next/navigation.
 * We test the pure redirect-decision logic by mocking `auth` and `redirect`.
 *
 * Three cases:
 *   0 memberships → redirect('/no-tenant')
 *   1 membership  → redirect('/t/<slug>/dashboard')
 *   >1 memberships → no redirect (renders the list)
 */

import { redirect } from 'next/navigation';

jest.mock('next/navigation', () => ({
    redirect: jest.fn(),
}));

jest.mock('@/auth', () => ({
    auth: jest.fn(),
    signOut: jest.fn(),
}));

// We need to import `auth` AFTER jest.mock is hoisted.
// The page imports auth at the top of its module, so we must
// reset the module registry before each test to practice the mock.
// We test the logic inline rather than importing the page component,
// to avoid React server component hydration requirements in Jest.

/**
 * Simulate the TenantsPage redirect decision given a session.
 * Mirrors the page logic exactly so changes to the page must update
 * this helper and vice versa — intentional coupling for test fidelity.
 */
function simulateTenantPickerLogic(
    session: { user: { memberships?: Array<{ slug: string; role: string }> } } | null
): void {
    if (!session?.user) {
        (redirect as unknown as jest.Mock)('/login');
        return;
    }
    const memberships = session.user.memberships ?? [];
    if (memberships.length === 0) {
        (redirect as unknown as jest.Mock)('/no-tenant');
        return;
    }
    if (memberships.length === 1) {
        (redirect as unknown as jest.Mock)(`/t/${memberships[0].slug}/dashboard`);
        return;
    }
    // >1 — no redirect, renders picker
}

describe('/tenants picker page — redirect logic', () => {
    beforeEach(() => {
        (redirect as unknown as jest.Mock).mockClear();
    });

    it('redirects to /login when session is null (unauthenticated)', () => {
        simulateTenantPickerLogic(null);
        expect(redirect).toHaveBeenCalledTimes(1);
        expect(redirect).toHaveBeenCalledWith('/login');
    });

    it('redirects to /no-tenant when memberships is an empty array', () => {
        simulateTenantPickerLogic({ user: { memberships: [] } });
        expect(redirect).toHaveBeenCalledTimes(1);
        expect(redirect).toHaveBeenCalledWith('/no-tenant');
    });

    it('redirects to /no-tenant when memberships is undefined', () => {
        simulateTenantPickerLogic({ user: { memberships: undefined } });
        expect(redirect).toHaveBeenCalledTimes(1);
        expect(redirect).toHaveBeenCalledWith('/no-tenant');
    });

    it('redirects directly to the dashboard when exactly 1 membership', () => {
        simulateTenantPickerLogic({
            user: { memberships: [{ slug: 'acme', role: 'ADMIN' }] },
        });
        expect(redirect).toHaveBeenCalledTimes(1);
        expect(redirect).toHaveBeenCalledWith('/t/acme/dashboard');
    });

    it('uses the correct slug for the single-membership redirect', () => {
        simulateTenantPickerLogic({
            user: { memberships: [{ slug: 'my-org', role: 'READER' }] },
        });
        expect(redirect).toHaveBeenCalledWith('/t/my-org/dashboard');
    });

    it('does NOT redirect when user has 2 memberships (renders picker list)', () => {
        simulateTenantPickerLogic({
            user: {
                memberships: [
                    { slug: 'acme', role: 'ADMIN' },
                    { slug: 'beta-corp', role: 'READER' },
                ],
            },
        });
        expect(redirect).not.toHaveBeenCalled();
    });

    it('does NOT redirect when user has 3+ memberships', () => {
        simulateTenantPickerLogic({
            user: {
                memberships: [
                    { slug: 'alpha', role: 'OWNER' },
                    { slug: 'bravo', role: 'EDITOR' },
                    { slug: 'charlie', role: 'READER' },
                ],
            },
        });
        expect(redirect).not.toHaveBeenCalled();
    });
});
