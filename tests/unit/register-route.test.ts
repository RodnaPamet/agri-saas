/**
 * Unit tests for POST /api/auth/register.
 *
 * The route is the ONLY self-service tenant-membership creation path
 * (allowlisted in tests/guardrails/no-auto-join.test.ts). These tests pin
 * the properties that make it safe: the creator owns the workspace they
 * just created, all four rows are written through the single transaction
 * client (not the singleton), the response shape
 * tests/e2e/fixtures.ts depends on is stable, and the HIBP screen still
 * runs before anything is written.
 *
 * The real-DB proof that a partial failure ROLLS BACK and leaves nothing
 * behind — and that the freed email can be retried — lives in
 * tests/integration/register-atomicity.test.ts; these mocked unit tests
 * can only assert the transaction is USED, not that Postgres honours it.
 *
 * bcrypt is CPU-heavy under the parallel full-suite run; 60s headroom.
 */
jest.setTimeout(60_000);

// tx-scoped spies: these stand in for the transaction client's model
// delegates, and are DISTINCT jest.fn() instances from the singleton's
// (see below) — that distinctness is what lets "writes ... inside ONE
// transaction" actually prove which client did the writing, instead of
// two call sites sharing one spy and looking identical either way.
const mockUserCreate = jest.fn();
const mockUserFindUnique = jest.fn();
const mockMembershipCreate = jest.fn();
const mockOnboardingCreate = jest.fn();
const mockTenantCreate = jest.fn();
const mockTransaction = jest.fn();

// Singleton-scoped `create` spies. Each throws unconditionally: the route
// must never create Tenant/User/TenantMembership/TenantOnboarding rows
// directly on the singleton client — those four rows belong inside the
// transaction. A route that (by bug or regression) wrote one of them via
// `prisma.<model>.create` instead of `tx.<model>.create` throws here,
// which the route's own try/catch turns into a 500 — so the "ONE
// transaction" test's `res.status` assertion catches the bypass instead
// of silently passing because the same spy would have recorded the call
// either way.
const throwIfCalledOnSingleton = (model: string) =>
    jest.fn((..._args: unknown[]): never => {
        throw new Error(
            `${model}.create was called on the SINGLETON prisma client, not the transaction's tx client`,
        );
    });
const mockSingletonTenantCreate = throwIfCalledOnSingleton('tenant');
const mockSingletonUserCreate = throwIfCalledOnSingleton('user');
const mockSingletonMembershipCreate = throwIfCalledOnSingleton('tenantMembership');
const mockSingletonOnboardingCreate = throwIfCalledOnSingleton('tenantOnboarding');

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: {
            findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
            create: (...a: unknown[]) => mockSingletonUserCreate(...a),
        },
        tenant: { create: (...a: unknown[]) => mockSingletonTenantCreate(...a) },
        tenantMembership: { create: (...a: unknown[]) => mockSingletonMembershipCreate(...a) },
        tenantOnboarding: { create: (...a: unknown[]) => mockSingletonOnboardingCreate(...a) },
        $transaction: (...a: unknown[]) => mockTransaction(...a),
    },
}));

jest.mock('@/lib/security/password-check', () => ({
    __esModule: true,
    checkPasswordAgainstHIBP: jest.fn(async () => ({ breached: false })),
}));

jest.mock('@/lib/auth/email-verification', () => ({
    __esModule: true,
    issueEmailVerification: jest.fn(async () => undefined),
}));

jest.mock('@/lib/auth', () => ({
    __esModule: true,
    signToken: jest.fn(() => 'signed-token'),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/register/route';

function registerRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'register', ...body }),
    });
}

const VALID = {
    email: 'founder@example.com',
    password: 'a-long-unbreached-passphrase-1', // pragma: allowlist secret
    name: 'Founder',
    orgName: 'Acme Farms',
};

beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindUnique.mockResolvedValue(null);
    mockUserCreate.mockResolvedValue({ id: 'user-1', email: VALID.email, name: VALID.name });
    mockMembershipCreate.mockResolvedValue({ role: 'OWNER' });
    mockTenantCreate.mockResolvedValue({ id: 'tenant-1', slug: 'acme-farms-x', name: 'Acme Farms' });
    mockOnboardingCreate.mockResolvedValue({});
    // Default: run the transaction callback against a tx client built
    // from the tx-scoped spies above (distinct from the singleton's,
    // which throw — see the mock setup at the top of this file).
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
            user: { create: mockUserCreate },
            tenant: { create: mockTenantCreate },
            tenantMembership: { create: mockMembershipCreate },
            tenantOnboarding: { create: mockOnboardingCreate },
        }),
    );
});

it('grants the registering user OWNER of the workspace they created', async () => {
    const res = await POST(registerRequest(VALID) as never, {} as never);
    expect(res.status).toBe(200);

    expect(mockMembershipCreate).toHaveBeenCalledTimes(1);
    const arg = mockMembershipCreate.mock.calls[0][0] as { data: { role: string } };
    expect(arg.data.role).toBe('OWNER');
});

it('writes tenant, user, membership and onboarding inside ONE transaction', async () => {
    const res = await POST(registerRequest(VALID) as never, {} as never);

    // A route that bypassed the transaction and wrote a row via the
    // singleton client would hit `throwIfCalledOnSingleton`, which the
    // route's own try/catch turns into a 500 — so this assertion is what
    // actually catches a bypass; the call-count assertions below would
    // stay green even on a 500 (zero tx calls also satisfies "not >1").
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // Every row-creating call must have happened via the tx client passed
    // into $transaction: these are DISTINCT jest.fn()s from the
    // singleton's create spies (which throw), so a stray direct write
    // would surface as the 500 above, not a passing count here.
    expect(mockTenantCreate).toHaveBeenCalledTimes(1);
    expect(mockUserCreate).toHaveBeenCalledTimes(1);
    expect(mockMembershipCreate).toHaveBeenCalledTimes(1);
    expect(mockOnboardingCreate).toHaveBeenCalledTimes(1);
});

it('returns the response shape tests/e2e/fixtures.ts depends on', async () => {
    const res = await POST(registerRequest(VALID) as never, {} as never);
    const body = await res.json();

    expect(body.tenant).toEqual({ id: 'tenant-1', name: 'Acme Farms', slug: 'acme-farms-x' });
    expect(body.user).toEqual(
        expect.objectContaining({ id: 'user-1', email: VALID.email, role: 'OWNER' }),
    );
    expect(body).toHaveProperty('emailVerificationRequired');
});

it('still screens the password against HIBP', async () => {
    const { checkPasswordAgainstHIBP } = jest.requireMock('@/lib/security/password-check');
    (checkPasswordAgainstHIBP as jest.Mock).mockResolvedValueOnce({ breached: true });

    const res = await POST(registerRequest(VALID) as never, {} as never);

    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
});
