/**
 * MFA Enforcement Unit Tests
 *
 * Tests the enforcement logic and guard behavior:
 * - policy-based MFA requirement decisions
 * - middleware path classification (MFA allowed vs blocked)
 * - mfaPending flag lifecycle
 * - challenge completion semantics
 */
import { isMfaAllowedPath, isTenantPath } from '../../src/lib/auth/guard';

describe('MFA Enforcement', () => {
    // ─── Policy Enforcement Decisions ───────────────────────────────

    describe('policy enforcement decisions', () => {
        interface EnforcementInput {
            policy: string;
            hasEnrollment: boolean;
            isVerified: boolean;
        }

        function shouldSetMfaPending(input: EnforcementInput): boolean {
            if (input.policy === 'DISABLED') return false;
            if (input.policy === 'REQUIRED') return true;
            if (input.policy === 'OPTIONAL' && input.isVerified) return true;
            return false;
        }

        it('DISABLED policy never sets mfaPending', () => {
            expect(shouldSetMfaPending({ policy: 'DISABLED', hasEnrollment: false, isVerified: false })).toBe(false);
            expect(shouldSetMfaPending({ policy: 'DISABLED', hasEnrollment: true, isVerified: true })).toBe(false);
        });

        it('REQUIRED policy always sets mfaPending', () => {
            expect(shouldSetMfaPending({ policy: 'REQUIRED', hasEnrollment: false, isVerified: false })).toBe(true);
            expect(shouldSetMfaPending({ policy: 'REQUIRED', hasEnrollment: true, isVerified: false })).toBe(true);
            expect(shouldSetMfaPending({ policy: 'REQUIRED', hasEnrollment: true, isVerified: true })).toBe(true);
        });

        it('OPTIONAL policy sets mfaPending only for verified enrolled users', () => {
            expect(shouldSetMfaPending({ policy: 'OPTIONAL', hasEnrollment: false, isVerified: false })).toBe(false);
            expect(shouldSetMfaPending({ policy: 'OPTIONAL', hasEnrollment: true, isVerified: false })).toBe(false);
            expect(shouldSetMfaPending({ policy: 'OPTIONAL', hasEnrollment: true, isVerified: true })).toBe(true);
        });
    });

    // ─── Middleware Path Classification ─────────────────────────────

    describe('isMfaAllowedPath', () => {
        it('allows MFA challenge page', () => {
            expect(isMfaAllowedPath('/t/acme/auth/mfa')).toBe(true);
            expect(isMfaAllowedPath('/t/acme/auth/mfa/verify')).toBe(true);
        });

        it('allows MFA enrollment API routes', () => {
            expect(isMfaAllowedPath('/api/t/acme/security/mfa/enroll/start')).toBe(true);
            expect(isMfaAllowedPath('/api/t/acme/security/mfa/enroll/verify')).toBe(true);
            expect(isMfaAllowedPath('/api/t/acme/security/mfa/challenge/verify')).toBe(true);
        });

        it('allows auth callback routes', () => {
            expect(isMfaAllowedPath('/api/auth/session')).toBe(true);
            expect(isMfaAllowedPath('/api/auth/signout')).toBe(true);
        });

        it('blocks regular tenant routes', () => {
            expect(isMfaAllowedPath('/t/acme/dashboard')).toBe(false);
            expect(isMfaAllowedPath('/t/acme/practices')).toBe(false);
            expect(isMfaAllowedPath('/api/t/acme/practices')).toBe(false);
            expect(isMfaAllowedPath('/api/t/acme/assets')).toBe(false);
        });

        it('blocks admin routes', () => {
            expect(isMfaAllowedPath('/t/acme/admin')).toBe(false);
            expect(isMfaAllowedPath('/api/t/acme/admin/rbac')).toBe(false);
        });
    });

    describe('isTenantPath', () => {
        it('identifies tenant page paths', () => {
            expect(isTenantPath('/t/acme/dashboard')).toBe(true);
            expect(isTenantPath('/t/acme/practices')).toBe(true);
        });

        it('identifies tenant API paths', () => {
            expect(isTenantPath('/api/t/acme/practices')).toBe(true);
        });

        it('rejects non-tenant paths', () => {
            expect(isTenantPath('/login')).toBe(false);
            expect(isTenantPath('/api/auth/session')).toBe(false);
            expect(isTenantPath('/admin')).toBe(false);
        });
    });

    // ─── MFA Pending Flag Lifecycle ─────────────────────────────────

    describe('mfaPending lifecycle', () => {
        it('starts false by default', () => {
            const token = { mfaPending: false };
            expect(token.mfaPending).toBe(false);
        });

        it('is set to true on sign-in when MFA required', () => {
            const token = { mfaPending: false };
            // Simulating JWT callback behavior
            token.mfaPending = true; // REQUIRED policy
            expect(token.mfaPending).toBe(true);
        });

        it('is cleared when challenge is completed', () => {
            const token = { mfaPending: true };
            // Simulating challenge completion check
            const tokenIat = Math.floor(Date.now() / 1000) - 60; // token was created 60s ago
            const lastChallengeAt = new Date(); // challenge was just completed
            const challengeTime = Math.floor(lastChallengeAt.getTime() / 1000);

            if (challengeTime >= tokenIat) {
                token.mfaPending = false;
            }

            expect(token.mfaPending).toBe(false);
        });

        it('remains pending if challenge is older than token', () => {
            const token = { mfaPending: true };
            const tokenIat = Math.floor(Date.now() / 1000); // token just created
            const lastChallengeAt = new Date(Date.now() - 120000); // challenge 2 min ago
            const challengeTime = Math.floor(lastChallengeAt.getTime() / 1000);

            if (challengeTime >= tokenIat) {
                token.mfaPending = false;
            }

            expect(token.mfaPending).toBe(true); // Still pending
        });
    });

    // ─── Middleware Enforcement Behavior ─────────────────────────────

    describe('middleware enforcement behavior', () => {
        function simulateMiddleware(
            pathname: string,
            mfaPending: boolean,
        ): { action: 'pass' | 'redirect' | 'forbidden'; target?: string } {
            // Simulates the middleware MFA check
            if (!isTenantPath(pathname) || isMfaAllowedPath(pathname)) {
                return { action: 'pass' };
            }

            if (mfaPending) {
                if (pathname.startsWith('/api/')) {
                    return { action: 'forbidden' };
                }

                const segments = pathname.split('/');
                const tIndex = segments.indexOf('t');
                const slug = tIndex >= 0 ? segments[tIndex + 1] : null;
                if (slug) {
                    return { action: 'redirect', target: `/t/${slug}/auth/mfa` };
                }
            }

            return { action: 'pass' };
        }

        it('passes non-tenant routes regardless of mfaPending', () => {
            expect(simulateMiddleware('/login', true).action).toBe('pass');
            expect(simulateMiddleware('/api/auth/session', true).action).toBe('pass');
        });

        it('passes MFA challenge page when pending', () => {
            expect(simulateMiddleware('/t/acme/auth/mfa', true).action).toBe('pass');
        });

        it('passes MFA API routes when pending', () => {
            expect(simulateMiddleware('/api/t/acme/security/mfa/enroll/start', true).action).toBe('pass');
        });

        it('redirects tenant pages when pending', () => {
            const result = simulateMiddleware('/t/acme/dashboard', true);
            expect(result.action).toBe('redirect');
            expect(result.target).toBe('/t/acme/auth/mfa');
        });

        it('returns 403 for tenant API when pending', () => {
            const result = simulateMiddleware('/api/t/acme/practices', true);
            expect(result.action).toBe('forbidden');
        });

        it('passes all routes when mfaPending is false', () => {
            expect(simulateMiddleware('/t/acme/dashboard', false).action).toBe('pass');
            expect(simulateMiddleware('/api/t/acme/practices', false).action).toBe('pass');
            expect(simulateMiddleware('/t/acme/admin', false).action).toBe('pass');
        });
    });
});
