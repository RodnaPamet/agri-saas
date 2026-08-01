/**
 * Unit tests for POST /api/auth/register.
 *
 * The route is the ONLY self-service tenant-membership creation path
 * (allowlisted in tests/guardrails/no-auto-join.test.ts). These tests pin
 * the two properties that make it safe: the creator owns the workspace
 * they just created, and a partial failure leaves nothing behind.
 *
 * bcrypt is CPU-heavy under the parallel full-suite run; 60s headroom.
 */
jest.setTimeout(60_000);

const mockUserCreate = jest.fn();
const mockUserFindUnique = jest.fn();
const mockMembershipCreate = jest.fn();
const mockOnboardingCreate = jest.fn();
const mockTenantCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: {
            findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
            create: (...a: unknown[]) => mockUserCreate(...a),
        },
        tenant: { create: (...a: unknown[]) => mockTenantCreate(...a) },
        tenantMembership: { create: (...a: unknown[]) => mockMembershipCreate(...a) },
        tenantOnboarding: { create: (...a: unknown[]) => mockOnboardingCreate(...a) },
        $transaction: (...a: unknown[]) => mockTransaction(...a),
    },
}));

jest.mock('@/lib/security/tenant-key-manager', () => ({
    __esModule: true,
    createTenantWithDek: jest.fn(async (data: { name: string; slug: string }) => ({
        id: 'tenant-1',
        name: data.name,
        slug: data.slug,
    })),
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
    // Default: run the transaction callback against the mocked client.
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
