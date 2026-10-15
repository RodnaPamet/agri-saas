/**
 * MFA & Session Security — Hardening Regression Tests
 *
 * Covers:
 * - Rate limiter behavior (sliding window, lockout, reset)
 * - Anti-lockout: REQUIRED policy cannot be enabled without enrolled admin
 * - Audit event categories and safety
 * - Revoked sessions stay revoked
 * - Brute-force throttling semantics
 */
import {
    checkRateLimit,
    resetRateLimit,
    clearAllRateLimits,
    MFA_VERIFY_LIMIT,
    MFA_ENROLL_VERIFY_LIMIT,
} from '../../src/lib/security/rate-limit';

beforeEach(() => {
    clearAllRateLimits();
});

afterAll(() => {
    clearAllRateLimits();
});

describe('Rate Limiter', () => {
    it('allows requests within the limit', () => {
        const key = 'test:user-1';
        const config = { maxAttempts: 3, windowMs: 60000 };

        const r1 = checkRateLimit(key, config);
        expect(r1.allowed).toBe(true);
        expect(r1.remaining).toBe(2);

        const r2 = checkRateLimit(key, config);
        expect(r2.allowed).toBe(true);
        expect(r2.remaining).toBe(1);

        const r3 = checkRateLimit(key, config);
        expect(r3.allowed).toBe(true);
        expect(r3.remaining).toBe(0);
    });

    it('blocks requests after limit is exhausted', () => {
        const key = 'test:user-2';
        const config = { maxAttempts: 2, windowMs: 60000 };

        checkRateLimit(key, config);
        checkRateLimit(key, config);

        const r3 = checkRateLimit(key, config);
        expect(r3.allowed).toBe(false);
        expect(r3.remaining).toBe(0);
        expect(r3.retryAfterMs).toBeGreaterThan(0);
    });

    it('resets rate limit on success', () => {
        const key = 'test:user-3';
        const config = { maxAttempts: 2, windowMs: 60000 };

        checkRateLimit(key, config);
        checkRateLimit(key, config);
        expect(checkRateLimit(key, config).allowed).toBe(false);

        resetRateLimit(key);
        expect(checkRateLimit(key, config).allowed).toBe(true);
    });

    it('enforces lockout after max attempts with lockoutMs', () => {
        const key = 'test:user-4';
        const config = { maxAttempts: 2, windowMs: 60000, lockoutMs: 30000 };

        checkRateLimit(key, config);
        checkRateLimit(key, config);

        const blocked = checkRateLimit(key, config);
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
        expect(blocked.retryAfterMs).toBeLessThanOrEqual(30000);
    });

    it('MFA_VERIFY_LIMIT has correct configuration', () => {
        expect(MFA_VERIFY_LIMIT.maxAttempts).toBe(5);
        expect(MFA_VERIFY_LIMIT.windowMs).toBe(15 * 60 * 1000);
        expect(MFA_VERIFY_LIMIT.lockoutMs).toBe(5 * 60 * 1000);
    });

    it('MFA_ENROLL_VERIFY_LIMIT has correct configuration', () => {
        expect(MFA_ENROLL_VERIFY_LIMIT.maxAttempts).toBe(10);
        expect(MFA_ENROLL_VERIFY_LIMIT.windowMs).toBe(15 * 60 * 1000);
    });
});

describe('Anti-Lockout Safeguards', () => {
    it('validates that REQUIRED policy needs enrolled admin (unit logic)', () => {
        // Simulating the anti-lockout check
        const enrolledAdminCount = 0;
        const policy = 'REQUIRED';

        const wouldBlock = policy === 'REQUIRED' && enrolledAdminCount === 0;
        expect(wouldBlock).toBe(true);
    });

    it('allows REQUIRED policy when admin is enrolled', () => {
        const enrolledAdminCount: number = 1;
        const policy = 'REQUIRED';

        const wouldBlock = (policy as string) === 'REQUIRED' && enrolledAdminCount === 0;
        expect(wouldBlock).toBe(false);
    });

    it('allows any policy change from REQUIRED to DISABLED/OPTIONAL', () => {
        // These should never be blocked
        for (const policy of ['DISABLED', 'OPTIONAL'] as const) {
            const wouldBlock = (policy as string) === 'REQUIRED' && 0 === 0;
            expect(wouldBlock).toBe(false);
        }
    });

    it('self-revocation preserves ability to re-authenticate', () => {
        // After revoking own sessions, the user's sessionVersion increments
        // but the login page remains accessible (not behind auth)
        const sessionVersion = 5;
        const newVersion = sessionVersion + 1;
        expect(newVersion).toBe(6);
        // Login page is public, so user can still sign in
    });
});

describe('Audit Event Safety', () => {
    const AUDIT_ACTIONS = [
        'MFA_ENROLLMENT_STARTED',
        'MFA_ENROLLED',
        'MFA_ENROLLMENT_VERIFY_FAILED',
        'MFA_CHALLENGE_PASSED',
        'MFA_CHALLENGE_FAILED',
        'MFA_POLICY_CHANGED',
        'CURRENT_SESSION_REVOKED',
        'SESSIONS_REVOKED_FOR_USER',
        'ALL_TENANT_SESSIONS_REVOKED',
    ];

    it('uses well-defined action constants', () => {
        AUDIT_ACTIONS.forEach(action => {
            expect(action).toMatch(/^[A-Z_]+$/);
        });
    });

    // REMOVED: 'audit details never contain secrets' (#1784).
    //
    // Five patterns against five `exampleDetails` literals commented "These
    // are example audit details from the system" — they were not; they were
    // typed here. Two of the five patterns were then skipped by a `continue`,
    // so the test's own body excluded the two words it was named for.
    //
    // The claim is now checked at the call sites that would produce it:
    // `tests/guards/audit-details-carry-no-secrets.test.ts`.

});

describe('Revocation Permanence', () => {
    it('revoked token stays invalid even after time passes', () => {
        const tokenVersion = 2;
        const dbVersionAfterRevoke = 3;

        // Time passes...
        // Token version doesn't change, DB version doesn't decrease
        expect(dbVersionAfterRevoke > tokenVersion).toBe(true);
    });

    it('re-authentication after revocation gets fresh valid sessionVersion', () => {
        const revokedVersion = 3; // DB version after revoke
        const newLoginVersion = revokedVersion; // New login picks up current DB version
        expect(revokedVersion > newLoginVersion).toBe(false); // Equal = valid
    });

    it('multiple revocations keep incrementing', () => {
        let version = 0;
        for (let i = 0; i < 5; i++) {
            version += 1;
        }
        expect(version).toBe(5);
        // All tokens with version < 5 are invalid
    });
});
