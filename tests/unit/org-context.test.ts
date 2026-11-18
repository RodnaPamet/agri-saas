/**
 * Epic O-2 — `getOrgCtx` resolver unit contract.
 *
 * Mocks the session helper (`getSessionOrThrow`) and the Prisma
 * client at the module boundary so the test exercises the resolver's
 * branching directly without needing a live DB. The integration-side
 * coverage (where the full schema + RLS + memberships must align)
 * lives in `tests/integration/org-bootstrap.test.ts`.
 *
 * Failure-shape contract asserted here:
 *   - badRequest    (400) when slug is empty / whitespace
 *   - notFound      (404) when slug doesn't resolve to an Organization
 *   - notFound      (404) when slug resolves but the user is not a
 *                   member — collapsed for anti-enumeration. External
 *                   callers cannot distinguish "no such org" from
 *                   "not a member".
 *   - unauthorized  (401) when no session — covered by mocking
 *                   getSessionOrThrow to throw, since the resolver
 *                   delegates to it as the very first step.
 */

const sessionMock = jest.fn();
const orgFindUniqueMock = jest.fn();
const orgMembershipFindUniqueMock = jest.fn();

jest.mock('@/lib/auth', () => ({
    __esModule: true,
    getSessionOrThrow: () => sessionMock(),
}));

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        organization: { findUnique: (...args: unknown[]) => orgFindUniqueMock(...args) },
        orgMembership: { findUnique: (...args: unknown[]) => orgMembershipFindUniqueMock(...args) },
    },
    prisma: {
        organization: { findUnique: (...args: unknown[]) => orgFindUniqueMock(...args) },
        orgMembership: { findUnique: (...args: unknown[]) => orgMembershipFindUniqueMock(...args) },
    },
}));

// Observability writers + readers are no-ops in tests. The logger
// pulls from the AsyncLocalStorage via `getRequestContext`; mock it
// so the new `logger.warn('org-ctx.access_denied', ...)` calls in
// the resolver don't trip on unmocked context internals.
jest.mock('@/lib/observability/context', () => ({
    __esModule: true,
    mergeRequestContext: () => undefined,
    getRequestContext: () => null,
    setRequestContext: () => undefined,
}));

import { getOrgCtx } from '@/app-layer/context';

beforeEach(() => {
    sessionMock.mockReset();
    orgFindUniqueMock.mockReset();
    orgMembershipFindUniqueMock.mockReset();
});

function happySession() {
    sessionMock.mockResolvedValue({
        userId: 'user-1',
        tenantId: 'tenant-irrelevant',
        email: 'ciso@example.com',
        role: 'AUDITOR',
    });
}

describe('Epic O-2 — getOrgCtx', () => {
    it('returns a typed OrgContext on the happy path', async () => {
        happySession();
        orgFindUniqueMock.mockResolvedValue({ id: 'org-1', slug: 'acme-org' });
        orgMembershipFindUniqueMock.mockResolvedValue({ role: 'ORG_ADMIN' });

        const ctx = await getOrgCtx({ orgSlug: 'acme-org' });

        expect(ctx.userId).toBe('user-1');
        expect(ctx.organizationId).toBe('org-1');
        expect(ctx.orgSlug).toBe('acme-org');
        expect(ctx.orgRole).toBe('ORG_ADMIN');
        // permissions field is pre-derived by the resolver
        expect(ctx.permissions.canViewPortfolio).toBe(true);
        expect(ctx.permissions.canManageTenants).toBe(true);
        expect(ctx.permissions.canDrillDown).toBe(true);
        expect(typeof ctx.requestId).toBe('string');
        expect(ctx.requestId.length).toBeGreaterThan(0);
    });

    it('ORG_READER context carries the reader permission map', async () => {
        happySession();
        orgFindUniqueMock.mockResolvedValue({ id: 'org-1', slug: 'acme-org' });
        orgMembershipFindUniqueMock.mockResolvedValue({ role: 'ORG_READER' });

        const ctx = await getOrgCtx({ orgSlug: 'acme-org' });

        expect(ctx.orgRole).toBe('ORG_READER');
        expect(ctx.permissions.canViewPortfolio).toBe(true);
        expect(ctx.permissions.canExportReports).toBe(true);
        expect(ctx.permissions.canDrillDown).toBe(false);
        expect(ctx.permissions.canManageTenants).toBe(false);
        expect(ctx.permissions.canManageMembers).toBe(false);
    });

    // ── Error branches ──────────────────────────────────────────────

    it('throws unauthorized when no session is present (delegates to getSessionOrThrow)', async () => {
        // The auth helper itself throws the unauthorized error; we just
        // assert that getOrgCtx propagates and never reaches the DB.
        sessionMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));

        await expect(getOrgCtx({ orgSlug: 'acme-org' })).rejects.toMatchObject({
            message: 'Unauthorized',
        });
        expect(orgFindUniqueMock).not.toHaveBeenCalled();
        expect(orgMembershipFindUniqueMock).not.toHaveBeenCalled();
    });

    it('throws badRequest when slug is empty', async () => {
        happySession();

        await expect(getOrgCtx({ orgSlug: '' })).rejects.toMatchObject({
            status: 400,
        });
        expect(orgFindUniqueMock).not.toHaveBeenCalled();
    });

    it('throws badRequest when slug is whitespace-only', async () => {
        happySession();

        await expect(getOrgCtx({ orgSlug: '   ' })).rejects.toMatchObject({
            status: 400,
        });
        expect(orgFindUniqueMock).not.toHaveBeenCalled();
    });

    it('throws notFound when the org slug does not resolve', async () => {
        happySession();
        orgFindUniqueMock.mockResolvedValue(null);

        await expect(getOrgCtx({ orgSlug: 'no-such-org' })).rejects.toMatchObject({
            status: 404,
        });
        // The membership lookup must NOT run if the org doesn't exist.
        expect(orgMembershipFindUniqueMock).not.toHaveBeenCalled();
    });

    it('collapses non-membership to 404 for anti-enumeration (no 403 leak)', async () => {
        happySession();
        orgFindUniqueMock.mockResolvedValue({ id: 'org-1', slug: 'acme-org' });
        orgMembershipFindUniqueMock.mockResolvedValue(null);

        await expect(getOrgCtx({ orgSlug: 'acme-org' })).rejects.toMatchObject({
            status: 404,
        });
    });

    it('externally-visible 404 message is identical for "no such org" and "not a member"', async () => {
        // Same caller, two different DB states — same external message.
        // This is the load-bearing anti-enumeration property: an
        // attacker cannot probe a slug and learn whether it exists by
        // diffing the response.
        happySession();

        // Path 1: org slug doesn't resolve at all.
        orgFindUniqueMock.mockResolvedValueOnce(null);
        let msgNoOrg = '';
        try {
            await getOrgCtx({ orgSlug: 'no-such-org' });
        } catch (err) {
            msgNoOrg = (err as Error).message;
        }

        // Path 2: org exists but caller has no membership.
        orgFindUniqueMock.mockResolvedValueOnce({ id: 'org-1', slug: 'acme-org' });
        orgMembershipFindUniqueMock.mockResolvedValueOnce(null);
        let msgNoMember = '';
        try {
            await getOrgCtx({ orgSlug: 'acme-org' });
        } catch (err) {
            msgNoMember = (err as Error).message;
        }

        expect(msgNoOrg).toBe(msgNoMember);
        expect(msgNoOrg).not.toContain('acme-org');
        expect(msgNoOrg).not.toContain('no-such-org');
    });

    it('looks up the membership using the (organizationId, userId) compound key', async () => {
        happySession();
        orgFindUniqueMock.mockResolvedValue({ id: 'org-1', slug: 'acme-org' });
        orgMembershipFindUniqueMock.mockResolvedValue({ role: 'ORG_ADMIN' });

        await getOrgCtx({ orgSlug: 'acme-org' });

        expect(orgMembershipFindUniqueMock).toHaveBeenCalledTimes(1);
        const arg = orgMembershipFindUniqueMock.mock.calls[0][0];
        expect(arg.where).toEqual({
            organizationId_userId: {
                organizationId: 'org-1',
                userId: 'user-1',
            },
        });
    });
});

describe('#3198 — the org layer refuses a session that still owes a second factor', () => {
    it.each([
        ['the session-wide flag', { mfaPending: true }],
        ['a pending farm', { mfaPendingTenantIds: ['tenant-b'] }],
    ])('throws MFA_REQUIRED on %s, before any org lookup', async (_label, pending) => {
        sessionMock.mockResolvedValue({
            userId: 'user-1', tenantId: 'tenant-a', role: 'ADMIN', ...pending,
        });

        await expect(getOrgCtx({ orgSlug: 'acme-org' })).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
        expect(orgFindUniqueMock).not.toHaveBeenCalled();
    });

    it('control: an empty pending list is not a refusal', async () => {
        sessionMock.mockResolvedValue({
            userId: 'user-1', tenantId: 'tenant-a', role: 'ADMIN', mfaPending: false, mfaPendingTenantIds: [],
        });
        orgFindUniqueMock.mockResolvedValue({ id: 'org-1', slug: 'acme-org' });
        orgMembershipFindUniqueMock.mockResolvedValue({ role: 'ORG_ADMIN' });

        await expect(getOrgCtx({ orgSlug: 'acme-org' })).resolves.toMatchObject({ organizationId: 'org-1' });
    });
});
