/**
 * GitHub Branch Protection Provider Tests
 *
 * Tests with mock GitHub API responses for:
 *   1. Protected branch → PASS
 *   2. Missing protection → FAIL
 *   3. Partial protection (no reviews) → FAIL
 *   4. API auth error → ERROR
 *   5. Network error → ERROR
 *   6. Connection validation
 *   7. Evidence mapping
 *   8. Webhook signature verification
 *   9. Integration with provider registry
 */
import {
    GitHubProvider,
    evaluateBranchProtection,
    fetchBranchProtection,
    type GitHubBranchProtection,
    type FetchFn,
} from '@/app-layer/integrations/providers/github';
import type { CheckInput, ParsedAutomationKey } from '@/app-layer/integrations/types';
import { registry } from '@/app-layer/integrations/registry';
import { computeHmacSha256 } from '@/app-layer/integrations/webhook-crypto';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Mock Data ───────────────────────────────────────────────────────

const FULL_PROTECTION: GitHubBranchProtection = {
    url: 'https://api.github.com/repos/acme/api/branches/main/protection',
    required_status_checks: {
        strict: true,
        contexts: ['ci/build', 'ci/test'],
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
    },
    restrictions: null,
    required_linear_history: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
};

const PARTIAL_PROTECTION: GitHubBranchProtection = {
    url: 'https://api.github.com/repos/acme/api/branches/main/protection',
    required_status_checks: null,
    enforce_admins: null,
    required_pull_request_reviews: null,
    restrictions: null,
    required_linear_history: null,
    allow_force_pushes: { enabled: true },
    allow_deletions: { enabled: true },
};

const PARSED_KEY: ParsedAutomationKey = {
    provider: 'github',
    checkType: 'branch_protection',
    raw: 'github.branch_protection',
};

function makeCheckInput(overrides?: Partial<CheckInput>): CheckInput {
    return {
        automationKey: 'github.branch_protection',
        parsed: PARSED_KEY,
        tenantId: 'tenant-1',
        practiceId: 'ctrl-1',
        connectionConfig: {
            owner: 'acme',
            repo: 'api',
            branch: 'main',
            token: 'ghp_test123',
        },
        triggeredBy: 'manual',
        ...overrides,
    };
}

// ─── Mock Fetch Factory ──────────────────────────────────────────────

function createMockFetch(status: number, body: unknown): FetchFn {
    return async () => ({
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        ok: status >= 200 && status < 300,
    } as Response);
}

function createErrorFetch(error: string): FetchFn {
    return async () => { throw new Error(error); };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('GitHub Branch Protection Provider', () => {

    // ── Pure Evaluation Logic ──

    describe('evaluateBranchProtection', () => {
        it('PASS: full protection enabled', () => {
            const result = evaluateBranchProtection('acme', 'api', 'main', FULL_PROTECTION, 200);
            expect(result.status).toBe('PASSED');
            expect(result.details.protectionEnabled).toBe(true);
            expect(result.details.requiredReviews).toBe(true);
            expect(result.details.requiredStatusChecks).toBe(true);
            expect(result.details.enforceAdmins).toBe(true);
            expect(result.details.allowForcePushes).toBe(false);
            expect(result.details.reviewCount).toBe(2);
        });

        it('FAIL: no protection at all (404)', () => {
            const result = evaluateBranchProtection('acme', 'api', 'main', null, 404);
            expect(result.status).toBe('FAILED');
            expect(result.details.protectionEnabled).toBe(false);
            expect(result.summary).toContain('NOT enabled');
        });

        it('FAIL: partial protection (no reviews, no status checks)', () => {
            const result = evaluateBranchProtection('acme', 'api', 'main', PARTIAL_PROTECTION, 200);
            expect(result.status).toBe('FAILED');
            expect(result.details.protectionEnabled).toBe(true);
            expect(result.details.requiredReviews).toBe(false);
            expect(result.details.requiredStatusChecks).toBe(false);
        });

        it('FAIL: has reviews but no status checks', () => {
            const withReviewsOnly: GitHubBranchProtection = {
                ...PARTIAL_PROTECTION,
                required_pull_request_reviews: {
                    required_approving_review_count: 1,
                    dismiss_stale_reviews: false,
                    require_code_owner_reviews: false,
                },
            };
            const result = evaluateBranchProtection('acme', 'api', 'main', withReviewsOnly, 200);
            expect(result.status).toBe('FAILED');
            expect(result.details.requiredReviews).toBe(true);
            expect(result.details.requiredStatusChecks).toBe(false);
        });

        it('includes repo and branch in summary', () => {
            const result = evaluateBranchProtection('acme', 'api', 'main', FULL_PROTECTION, 200);
            expect(result.summary).toContain('acme/api:main');
        });

        it('includes repo and branch in details', () => {
            const result = evaluateBranchProtection('acme', 'api', 'develop', FULL_PROTECTION, 200);
            expect(result.details.repository).toBe('acme/api');
            expect(result.details.branch).toBe('develop');
        });
    });

    // ── API Client ──

    describe('fetchBranchProtection', () => {
        it('returns protection data on 200', async () => {
            const mockFetch = createMockFetch(200, FULL_PROTECTION);
            const result = await fetchBranchProtection('acme', 'api', 'main', 'token', mockFetch);
            expect(result.status).toBe(200);
            expect(result.protection).not.toBeNull();
            expect(result.protection!.required_pull_request_reviews).not.toBeNull();
        });

        it('returns null protection on 404 (not enabled)', async () => {
            const mockFetch = createMockFetch(404, { message: 'Not Found' });
            const result = await fetchBranchProtection('acme', 'api', 'main', 'token', mockFetch);
            expect(result.status).toBe(404);
            expect(result.protection).toBeNull();
        });

        it('returns error on 401 (bad auth)', async () => {
            const mockFetch = createMockFetch(401, { message: 'Bad credentials' });
            const result = await fetchBranchProtection('acme', 'api', 'main', 'bad-token', mockFetch);
            expect(result.status).toBe(401);
            expect(result.error).toContain('401');
        });

        it('returns error on network failure', async () => {
            const mockFetch = createErrorFetch('ECONNREFUSED');
            const result = await fetchBranchProtection('acme', 'api', 'main', 'token', mockFetch);
            expect(result.status).toBe(0);
            expect(result.error).toContain('ECONNREFUSED');
        });
    });

    // ── Provider runCheck ──

    describe('GitHubProvider.runCheck', () => {
        it('PASS: returns PASSED for fully protected branch', async () => {
            const provider = new GitHubProvider(createMockFetch(200, FULL_PROTECTION));
            const result = await provider.runCheck(makeCheckInput());
            expect(result.status).toBe('PASSED');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        it('FAIL: returns FAILED for unprotected branch', async () => {
            const provider = new GitHubProvider(createMockFetch(404, {}));
            const result = await provider.runCheck(makeCheckInput());
            expect(result.status).toBe('FAILED');
        });

        it('ERROR: returns ERROR for auth failure', async () => {
            const provider = new GitHubProvider(createMockFetch(401, { message: 'Bad credentials' }));
            const result = await provider.runCheck(makeCheckInput());
            expect(result.status).toBe('ERROR');
            expect(result.errorMessage).toBeDefined();
        });

        it('ERROR: returns ERROR for missing config', async () => {
            const provider = new GitHubProvider(createMockFetch(200, FULL_PROTECTION));
            const result = await provider.runCheck(makeCheckInput({
                connectionConfig: {},
            }));
            expect(result.status).toBe('ERROR');
            expect(result.summary).toContain('Missing');
        });

        it('defaults branch to main when not specified', async () => {
            let calledUrl = '';
            const captureFetch: FetchFn = async (url) => {
                calledUrl = url;
                return { status: 200, json: async () => FULL_PROTECTION, ok: true } as Response;
            };

            const provider = new GitHubProvider(captureFetch);
            await provider.runCheck(makeCheckInput({
                connectionConfig: { owner: 'acme', repo: 'api', token: 'test' },
            }));
            expect(calledUrl).toContain('/main/protection');
        });
    });

    // ── Evidence Mapping ──

    describe('GitHubProvider.mapResultToEvidence', () => {
        const provider = new GitHubProvider();
        const input = makeCheckInput();

        it('creates evidence for PASSED check', () => {
            const result = evaluateBranchProtection('acme', 'api', 'main', FULL_PROTECTION, 200);
            const evidence = provider.mapResultToEvidence(input, result);
            expect(evidence).not.toBeNull();
            expect(evidence!.type).toBe('CONFIGURATION');
            expect(evidence!.title).toContain('✅');
            expect(evidence!.title).toContain('acme/api:main');
            expect(evidence!.content).toContain('PASSED');
            expect(evidence!.content).toContain('Required reviews: ✅');
        });

        it('creates evidence for FAILED check', () => {
            const result = evaluateBranchProtection('acme', 'api', 'main', null, 404);
            const evidence = provider.mapResultToEvidence(input, result);
            expect(evidence).not.toBeNull();
            expect(evidence!.title).toContain('❌');
            expect(evidence!.content).toContain('FAILED');
        });

        it('returns null for ERROR (no noisy evidence)', () => {
            const errorResult = {
                status: 'ERROR' as const,
                summary: 'API error',
                details: {},
                errorMessage: 'auth failed',
            };
            const evidence = provider.mapResultToEvidence(input, errorResult);
            expect(evidence).toBeNull();
        });
    });

    // ── Connection Validation ──

    describe('GitHubProvider.validateConnection', () => {
        it('valid: returns true for accessible repo', async () => {
            const provider = new GitHubProvider(createMockFetch(200, { id: 1, full_name: 'acme/api' }));
            const result = await provider.validateConnection(
                { owner: 'acme', repo: 'api' },
                { token: 'ghp_valid' }
            );
            expect(result.valid).toBe(true);
        });

        it('invalid: rejects missing owner', async () => {
            const provider = new GitHubProvider();
            const result = await provider.validateConnection({}, { token: 'test' });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('owner');
        });

        it('invalid: rejects missing token', async () => {
            const provider = new GitHubProvider();
            const result = await provider.validateConnection({ owner: 'acme', repo: 'api' }, {});
            expect(result.valid).toBe(false);
            expect(result.error).toContain('token');
        });

        it('invalid: reports auth failure', async () => {
            const provider = new GitHubProvider(createMockFetch(401, { message: 'Bad credentials' }));
            const result = await provider.validateConnection(
                { owner: 'acme', repo: 'api' },
                { token: 'ghp_expired' }
            );
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Invalid or expired');
        });

        it('invalid: reports repo not found', async () => {
            const provider = new GitHubProvider(createMockFetch(404, {}));
            const result = await provider.validateConnection(
                { owner: 'acme', repo: 'nonexistent' },
                { token: 'ghp_valid' }
            );
            expect(result.valid).toBe(false);
            expect(result.error).toContain('not found');
        });
    });

    // ── Webhook Verification ──

    describe('GitHubProvider.verifyWebhookSignature', () => {
        const provider = new GitHubProvider();
        const secret = 'webhook-secret-123';
        const body = '{"action":"edited"}';

        it('accepts valid sha256 signature', () => {
            const hmac = computeHmacSha256(body, secret, 'hex');
            const isValid = provider.verifyWebhookSignature({
                provider: 'github',
                headers: { 'x-hub-signature-256': `sha256=${hmac}` },
                body,
                receivedAt: new Date(),
            }, secret);
            expect(isValid).toBe(true);
        });

        it('rejects invalid signature', () => {
            const isValid = provider.verifyWebhookSignature({
                provider: 'github',
                headers: { 'x-hub-signature-256': 'sha256=invalid' },
                body,
                receivedAt: new Date(),
            }, secret);
            expect(isValid).toBe(false);
        });

        it('rejects missing signature header', () => {
            const isValid = provider.verifyWebhookSignature({
                provider: 'github',
                headers: {},
                body,
                receivedAt: new Date(),
            }, secret);
            expect(isValid).toBe(false);
        });
    });

    // ── Webhook Handling ──

    describe('GitHubProvider.handleWebhook', () => {
        const provider = new GitHubProvider();
        const ctx = { tenantId: 'tenant-1', userId: 'sys', requestId: 'test-req-1', role: 'ADMIN' as const, permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true }, appPermissions: getPermissionsForRole('ADMIN') };

        it('triggers branch_protection check on rule edit', async () => {
            const result = await provider.handleWebhook(ctx, {
                provider: 'github',
                eventType: 'branch_protection_rule',
                headers: {},
                body: { action: 'edited' },
                receivedAt: new Date(),
            }, {});
            expect(result.status).toBe('processed');
            expect(result.triggeredKeys).toContain('github.branch_protection');
        });

        it('ignores unrelated events', async () => {
            const result = await provider.handleWebhook(ctx, {
                provider: 'github',
                eventType: 'push',
                headers: {},
                body: { ref: 'refs/heads/main' },
                receivedAt: new Date(),
            }, {});
            expect(result.status).toBe('ignored');
        });
    });

    // ── Registry Integration ──

    describe('Registry integration', () => {
        beforeEach(() => {
            registry._clear();
        });

        it('registers and resolves github provider', () => {
            registry.register(new GitHubProvider());
            const resolution = registry.resolveByAutomationKey('github.branch_protection');
            expect(resolution).not.toBeNull();
            expect(resolution!.provider.id).toBe('github');
        });

        it('lists github.branch_protection in automation keys', () => {
            registry.register(new GitHubProvider());
            const keys = registry.listAllAutomationKeys();
            expect(keys).toContain('github.branch_protection');
        });

        it('provider metadata is accessible', () => {
            registry.register(new GitHubProvider());
            const providers = registry.listProviders();
            const github = providers.find(p => p.id === 'github');
            expect(github).toBeDefined();
            expect(github!.displayName).toBe('GitHub');
            expect(github!.supportedChecks).toContain('branch_protection');
            expect(github!.configSchema.configFields.length).toBeGreaterThan(0);
            expect(github!.configSchema.secretFields.length).toBeGreaterThan(0);
        });
    });
});
