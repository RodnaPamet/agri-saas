/**
 * Unit Test: Epic A.3 brute-force protection integrated into
 * authenticateWithPassword.
 *
 * Proves that the credentials chokepoint:
 *   - records a progressive failure on each bad verify
 *   - applies the correct delay from LOGIN_PROGRESSIVE_POLICY
 *   - locks out at 10 failures and returns `rate_limited` +
 *     retryAfterSeconds (without bcrypt-verify'ing anything)
 *   - resets the counter on a successful verify so the next login
 *     starts clean
 *   - routes are identifier-isolated: one user's failures don't
 *     slow down another
 *
 * All external side effects (DB, audit log, Upstash) are mocked so
 * the test exercises the in-memory progressive store + the delay
 * branch without any network/DB churn.
 */

// ── Env setup: enable rate limits, disable test-mode shortcut ───────
const originalTestMode = process.env.AUTH_TEST_MODE;
const originalRateLimitEnabled = process.env.RATE_LIMIT_ENABLED;

beforeAll(() => {
    process.env.AUTH_TEST_MODE = '0';
    process.env.RATE_LIMIT_ENABLED = '1';
});

afterAll(() => {
    if (originalTestMode === undefined) delete process.env.AUTH_TEST_MODE;
    else process.env.AUTH_TEST_MODE = originalTestMode;
    if (originalRateLimitEnabled === undefined) {
        delete process.env.RATE_LIMIT_ENABLED;
    } else {
        process.env.RATE_LIMIT_ENABLED = originalRateLimitEnabled;
    }
});

// ── Module mocks ─────────────────────────────────────────────────────

// Upstash per-identifier check — make it a no-op pass so ONLY the
// progressive layer decides.
jest.mock('@/lib/auth/credential-rate-limit', () => ({
    checkCredentialsAttempt: jest.fn(async () => ({ ok: true })),
    resetCredentialsBackoff: jest.fn(async () => undefined),
}));

// Audit emission — avoid DB writes.
jest.mock('@/lib/auth/security-events', () => ({
    recordLoginFailure: jest.fn(async () => undefined),
    recordLoginSuccess: jest.fn(async () => undefined),
}));

// Password primitives — deterministic, no bcrypt cost.
jest.mock('@/lib/auth/passwords', () => ({
    verifyPassword: jest.fn(),
    dummyVerify: jest.fn(async () => undefined),
    needsRehash: jest.fn(() => false),
    hashPassword: jest.fn(async () => 'hashed'),
    BCRYPT_COST: 12,
}));

// Prisma — simulate "user exists with a password hash".
const fakeUser = {
    id: 'user-1',
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: '$2a$12$abcdefghijklmnopqrstuvwxyzABCDE1234567890abc',
    emailVerified: new Date(),
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: {
            findUnique: jest.fn(async () => fakeUser),
            findFirst: jest.fn(async () => fakeUser),
            update: jest.fn(async () => fakeUser),
        },
    },
    prisma: {
        user: {
            findUnique: jest.fn(async () => fakeUser),
            findFirst: jest.fn(async () => fakeUser),
            update: jest.fn(async () => fakeUser),
        },
    },
}));

// env shim — avoids loading the real zod env schema (which requires
// many vars and aborts in minimal test scenarios).
jest.mock('@/env', () => ({
    env: {
        AUTH_TEST_MODE: '0',
        RATE_LIMIT_ENABLED: '1',
        AUTH_REQUIRE_EMAIL_VERIFICATION: '0',
    },
}));

import { authenticateWithPassword } from '@/lib/auth/credentials';
import { verifyPassword } from '@/lib/auth/passwords';
import { clearAllRateLimits } from '@/lib/security/rate-limit';

// ── Tests ────────────────────────────────────────────────────────────

describe('authenticateWithPassword — Epic A.3 progressive brute-force', () => {
    const email = 'alice@example.com';
    const password = 'correct-horse-battery-staple'; // pragma: allowlist secret -- xkcd test fixture, not a real credential

    beforeEach(() => {
        clearAllRateLimits();
        jest.clearAllMocks();
    });

    it('first two bad attempts run immediately (no delay)', async () => {
        (verifyPassword as jest.Mock).mockResolvedValue(false);

        const started = Date.now();
        await authenticateWithPassword({ email, password });
        await authenticateWithPassword({ email, password });
        const elapsed = Date.now() - started;

        // Generous ceiling — just asserting it's not anywhere near 5s.
        expect(elapsed).toBeLessThan(1500);
    });

    it('fourth attempt (after 3 failures) eats the 5s tier delay', async () => {
        // Policy reads as "after N failures, next attempt delays M".
        // So 3 failures → 4th attempt waits 5s. evaluateProgressiveRateLimit
        // is called pre-verify with the CURRENT count; the 4th invocation
        // sees count=3 and picks tier 1.
        (verifyPassword as jest.Mock).mockResolvedValue(false);

        await authenticateWithPassword({ email, password }); // fail 1
        await authenticateWithPassword({ email, password }); // fail 2
        await authenticateWithPassword({ email, password }); // fail 3

        const started = Date.now();
        const result = await authenticateWithPassword({ email, password }); // 4th
        const elapsed = Date.now() - started;

        expect(result.ok).toBe(false);
        // 5s ± tolerance — allow for event-loop jitter.
        expect(elapsed).toBeGreaterThanOrEqual(4_900);
        expect(elapsed).toBeLessThan(7_000);
    }, 15_000);

    it('locks out at 10 failures and returns rate_limited without verifying', async () => {
        (verifyPassword as jest.Mock).mockResolvedValue(false);

        // Use a bypass path for the first 9 failures: pre-populate the
        // counter by calling the function 9 times. To keep test latency
        // sane, we use a tighter policy via a fresh key — but since the
        // integration test pins the real policy, we skip the delayed
        // tiers by short-circuiting through recordProgressiveFailure.
        const { recordProgressiveFailure, LOGIN_PROGRESSIVE_POLICY } =
            await import('@/lib/security/rate-limit');

        // Emulate 10 failures for this identifier.
        const { progressiveKey } = await getKeyFor(email);
        for (let i = 0; i < 10; i++) {
            await recordProgressiveFailure(progressiveKey, LOGIN_PROGRESSIVE_POLICY);
        }

        const result = await authenticateWithPassword({ email, password });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('rate_limited');
            expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        }
        // No real verify attempt should have happened — lockout
        // short-circuits before verifyPassword.
        expect(verifyPassword).not.toHaveBeenCalled();
    });

    it('successful login resets the progressive counter', async () => {
        const { recordProgressiveFailure, LOGIN_PROGRESSIVE_POLICY, evaluateProgressiveRateLimit } =
            await import('@/lib/security/rate-limit');
        const { progressiveKey } = await getKeyFor(email);

        // Pre-load 2 failures so the identifier is "warm" but not delayed.
        for (let i = 0; i < 2; i++) {
            await recordProgressiveFailure(progressiveKey, LOGIN_PROGRESSIVE_POLICY);
        }
        expect(
            (await evaluateProgressiveRateLimit(
                progressiveKey,
                LOGIN_PROGRESSIVE_POLICY,
            )).failureCount,
        ).toBe(2);

        // Successful verify.
        (verifyPassword as jest.Mock).mockResolvedValue(true);
        const result = await authenticateWithPassword({ email, password });
        expect(result.ok).toBe(true);

        // Counter cleared.
        expect(
            (await evaluateProgressiveRateLimit(
                progressiveKey,
                LOGIN_PROGRESSIVE_POLICY,
            )).failureCount,
        ).toBe(0);
    });

    it('two different identifiers have independent progressive counters', async () => {
        (verifyPassword as jest.Mock).mockResolvedValue(false);

        const { recordProgressiveFailure, evaluateProgressiveRateLimit, LOGIN_PROGRESSIVE_POLICY } =
            await import('@/lib/security/rate-limit');

        const aliceKey = (await getKeyFor('alice@example.com')).progressiveKey;
        const bobKey = (await getKeyFor('bob@example.com')).progressiveKey;

        for (let i = 0; i < 10; i++) {
            await recordProgressiveFailure(aliceKey, LOGIN_PROGRESSIVE_POLICY);
        }
        expect(
            (await evaluateProgressiveRateLimit(aliceKey, LOGIN_PROGRESSIVE_POLICY))
                .allowed,
        ).toBe(false);
        expect(
            (await evaluateProgressiveRateLimit(bobKey, LOGIN_PROGRESSIVE_POLICY))
                .allowed,
        ).toBe(true);
    });

    it('never includes password material in the AuthResult', async () => {
        (verifyPassword as jest.Mock).mockResolvedValue(false);
        const result = await authenticateWithPassword({ email, password });
        expect(JSON.stringify(result)).not.toContain(password);
    });
});

/**
 * Helper to derive the progressive key the way credentials.ts does.
 * Duplicated here to keep the integration assertions black-box and
 * to avoid exporting an internal from credentials.ts solely for
 * testing.
 */
async function getKeyFor(email: string): Promise<{ progressiveKey: string }> {
    const encoder = new TextEncoder();
    const buf = await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(email.trim().toLowerCase()),
    );
    const hex = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return { progressiveKey: `login-progressive:${hex}` };
}
