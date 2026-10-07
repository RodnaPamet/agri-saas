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
            findFirst: (...a: unknown[]) => mockUserFindUnique(...a),
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

// Typed with the full outcome UNION, not left to inference. Inferred from the
// initial implementation alone the type is `{ok: boolean; skipped: boolean}`,
// so `mockResolvedValue({ok: false, skipped: false, codes: [...]})` fails to
// typecheck — and it failed in CI while passing locally, because an
// incremental `tsconfig.tsbuildinfo` had never re-read these files.
type TurnstileOutcomeShape =
    | { ok: true; skipped: false }
    | { ok: true; skipped: true }
    | { ok: false; skipped: false; codes: string[] }
    | { ok: true; skipped: false; degraded: true };
const mockVerifyTurnstile = jest.fn(
    async (): Promise<TurnstileOutcomeShape> => ({ ok: true, skipped: true }),
);
jest.mock('@/lib/security/turnstile', () => ({
    __esModule: true,
    verifyTurnstile: (...a: unknown[]) => mockVerifyTurnstile(...(a as [])),
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

// ─── P3.5c — bot screening on the signup path ───

describe('Turnstile screening (P3.5c)', () => {
    beforeEach(() => {
        mockVerifyTurnstile.mockResolvedValue({ ok: true, skipped: true });
    });

    it('refuses the signup when Turnstile rejects the token', async () => {
        // EXECUTED, not grepped. #1166 records what a structural-only check is
        // worth: the HIBP reject branch was deleted from two routes by a PR
        // about Playwright apt stalls, and the readFileSync-plus-regex
        // guardrail stayed green against the remains for a day.
        mockVerifyTurnstile.mockResolvedValue({
            ok: false,
            skipped: false,
            codes: ['invalid-input-response'],
        });

        const res = await POST(registerRequest(VALID) as never, {} as never);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('turnstile_failed');
        // The codes travel to the client so it can reset the widget — a token
        // is single-use, so a blind retry always fails.
        expect(body.codes).toEqual(['invalid-input-response']);
    });

    it('writes nothing when Turnstile rejects', async () => {
        mockVerifyTurnstile.mockResolvedValue({ ok: false, skipped: false, codes: ['x'] });
        await POST(registerRequest(VALID) as never, {} as never);
        // Screening runs BEFORE the transaction and before bcrypt. A screen
        // that refused after the expensive work would still refuse the signup
        // but would have already paid for it, which is most of what a flood
        // costs.
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('proceeds when screening is dormant — the live configuration today', async () => {
        mockVerifyTurnstile.mockResolvedValue({ ok: true, skipped: true });
        const res = await POST(registerRequest(VALID) as never, {} as never);
        expect(res.status).toBe(200);
    });

    it('proceeds when Cloudflare is unreachable, which is deliberate', async () => {
        // The documented fail-open on TRANSPORT failure. An attacker cannot
        // reach this branch at will: a forged token gets an explicit
        // rejection, which refuses. See the module docblock.
        mockVerifyTurnstile.mockResolvedValue({ ok: true, skipped: false, degraded: true });
        const res = await POST(registerRequest(VALID) as never, {} as never);
        expect(res.status).toBe(200);
    });
});
