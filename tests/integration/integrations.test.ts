/**
 * Integration Framework Tests
 *
 * Tests the provider registry, automationKey parsing, and contract validation.
 * These are unit tests that don't require a database connection.
 */
import {
    parseAutomationKey,
    isScheduledCheckProvider,
    isWebhookEventProvider,
} from '@/app-layer/integrations/types';
import type {
    IntegrationProvider,
    ScheduledCheckProvider,
    WebhookEventProvider,
    CheckInput,
    CheckResult,
    ConnectionValidationResult,
    WebhookPayload,
    WebhookProcessResult,
    EvidencePayload,
} from '@/app-layer/integrations/types';
import type { RequestContext } from '@/app-layer/types';
import { registry } from '@/app-layer/integrations/registry';

// ─── Mock Providers ──────────────────────────────────────────────────

function createMockScheduledProvider(id: string, checks: string[]): ScheduledCheckProvider {
    return {
        id,
        displayName: `${id} Provider`,
        description: `Mock ${id} provider`,
        supportedChecks: checks,
        configSchema: {
            configFields: [
                { key: 'org', label: 'Organization', type: 'string', required: true },
            ],
            secretFields: [
                { key: 'token', label: 'API Token', type: 'string', required: true },
            ],
        },
        async validateConnection(): Promise<ConnectionValidationResult> {
            return { valid: true };
        },
        async runCheck(input: CheckInput): Promise<CheckResult> {
            return {
                status: 'PASSED',
                summary: `Check ${input.automationKey} passed`,
                details: { provider: id, checkType: input.parsed.checkType },
            };
        },
        mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
            if (result.status === 'PASSED') {
                return {
                    title: `${input.automationKey} check passed`,
                    content: result.summary,
                    type: 'CONFIGURATION',
                };
            }
            return null;
        },
    };
}

function createMockWebhookProvider(id: string, checks: string[]): WebhookEventProvider {
    return {
        id,
        displayName: `${id} Webhook`,
        description: `Mock ${id} webhook provider`,
        supportedChecks: checks,
        configSchema: { configFields: [], secretFields: [] },
        async validateConnection(): Promise<ConnectionValidationResult> {
            return { valid: true };
        },
        verifyWebhookSignature(): boolean {
            return true;
        },
        async handleWebhook(
            _ctx: RequestContext,
            _payload: WebhookPayload,
        ): Promise<WebhookProcessResult> {
            return { status: 'processed' };
        },
    };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Integration Framework', () => {
    beforeEach(() => {
        registry._clear();
    });

    // ── automationKey Parsing ──

    describe('parseAutomationKey', () => {
        it('parses valid key: provider.check_type', () => {
            const result = parseAutomationKey('github.branch_protection');
            expect(result).toEqual({
                provider: 'github',
                checkType: 'branch_protection',
                raw: 'github.branch_protection',
            });
        });

        it('parses key with nested dots', () => {
            const result = parseAutomationKey('aws.s3.bucket_encryption');
            expect(result).toEqual({
                provider: 'aws',
                checkType: 's3.bucket_encryption',
                raw: 'aws.s3.bucket_encryption',
            });
        });

        it('returns null for empty string', () => {
            expect(parseAutomationKey('')).toBeNull();
        });

        it('returns null for key without dot', () => {
            expect(parseAutomationKey('github')).toBeNull();
        });

        it('returns null for key starting with dot', () => {
            expect(parseAutomationKey('.branch_protection')).toBeNull();
        });

        it('returns null for key ending with dot', () => {
            expect(parseAutomationKey('github.')).toBeNull();
        });

        it('returns null for non-string input', () => {
            expect(parseAutomationKey(null as unknown as string)).toBeNull();
            expect(parseAutomationKey(undefined as unknown as string)).toBeNull();
        });
    });

    // ── Provider Registry ──

    describe('ProviderRegistry', () => {
        it('registers and retrieves a provider', () => {
            const provider = createMockScheduledProvider('github', ['branch_protection']);
            registry.register(provider);

            expect(registry.getProvider('github')).toBe(provider);
        });

        it('lists all registered providers', () => {
            registry.register(createMockScheduledProvider('github', ['branch_protection']));
            registry.register(createMockScheduledProvider('aws', ['s3_encryption']));

            const providers = registry.listProviders();
            expect(providers).toHaveLength(2);
            expect(registry.listProviderIds()).toEqual(['github', 'aws']);
        });

        it('resolves provider by automationKey', () => {
            registry.register(createMockScheduledProvider('github', ['branch_protection', 'repo_security']));

            const result = registry.resolveByAutomationKey('github.branch_protection');
            expect(result).not.toBeNull();
            expect(result!.provider.id).toBe('github');
            expect(result!.parsed.checkType).toBe('branch_protection');
        });

        it('returns null for unknown provider prefix', () => {
            registry.register(createMockScheduledProvider('github', ['branch_protection']));

            expect(registry.resolveByAutomationKey('gitlab.merge_checks')).toBeNull();
        });

        it('returns null for unsupported check type', () => {
            registry.register(createMockScheduledProvider('github', ['branch_protection']));

            expect(registry.resolveByAutomationKey('github.unknown_check')).toBeNull();
        });

        it('lists all automation keys across providers', () => {
            registry.register(createMockScheduledProvider('github', ['branch_protection', 'repo_security']));
            registry.register(createMockScheduledProvider('aws', ['s3_encryption', 'iam_mfa']));

            const keys = registry.listAllAutomationKeys();
            expect(keys).toEqual([
                'github.branch_protection',
                'github.repo_security',
                'aws.s3_encryption',
                'aws.iam_mfa',
            ]);
        });

        it('canHandle returns true for supported keys', () => {
            registry.register(createMockScheduledProvider('github', ['branch_protection']));

            expect(registry.canHandle('github.branch_protection')).toBe(true);
            expect(registry.canHandle('github.unknown')).toBe(false);
            expect(registry.canHandle('gitlab.xyz')).toBe(false);
        });

        it('throws when registering provider without id', () => {
            const badProvider = { id: '', displayName: 'Bad' } as IntegrationProvider;
            expect(() => registry.register(badProvider)).toThrow('non-empty string id');
        });

        it('unregisters a provider', () => {
            registry.register(createMockScheduledProvider('github', ['branch_protection']));
            expect(registry.getProvider('github')).toBeDefined();

            registry.unregister('github');
            expect(registry.getProvider('github')).toBeUndefined();
        });
    });

    // ── Type Guards ──

    describe('Type Guards', () => {
        it('isScheduledCheckProvider detects runCheck method', () => {
            const scheduled = createMockScheduledProvider('github', ['branch_protection']);
            const base: IntegrationProvider = {
                id: 'base',
                displayName: 'Base',
                description: '',
                supportedChecks: [],
                configSchema: { configFields: [], secretFields: [] },
                validateConnection: async () => ({ valid: true }),
            };

            expect(isScheduledCheckProvider(scheduled)).toBe(true);
            expect(isScheduledCheckProvider(base)).toBe(false);
        });

        it('isWebhookEventProvider detects handleWebhook method', () => {
            const webhook = createMockWebhookProvider('github', ['push']);
            const scheduled = createMockScheduledProvider('github', ['branch_protection']);

            expect(isWebhookEventProvider(webhook)).toBe(true);
            expect(isWebhookEventProvider(scheduled)).toBe(false);
        });
    });

    // ── Webhook Provider Registry ──

    describe('Webhook Provider Lookup', () => {
        it('finds webhook provider by ID', () => {
            registry.register(createMockWebhookProvider('github', ['push']));

            const provider = registry.getWebhookProvider('github');
            expect(provider).not.toBeNull();
            expect(provider!.id).toBe('github');
        });

        it('returns null for non-webhook provider', () => {
            registry.register(createMockScheduledProvider('github', ['branch_protection']));

            const provider = registry.getWebhookProvider('github');
            expect(provider).toBeNull();
        });
    });

    // ── Scheduled Provider Registry ──

    describe('Scheduled Provider Lookup', () => {
        it('finds scheduled provider by ID', () => {
            registry.register(createMockScheduledProvider('github', ['branch_protection']));

            const provider = registry.getScheduledProvider('github');
            expect(provider).not.toBeNull();
        });

        it('returns null for non-scheduled provider', () => {
            registry.register(createMockWebhookProvider('github', ['push']));

            const provider = registry.getScheduledProvider('github');
            expect(provider).toBeNull();
        });
    });

    // ── CheckResult Contract ──

    describe('CheckResult Contract', () => {
        it('mock provider returns valid CheckResult', async () => {
            const provider = createMockScheduledProvider('github', ['branch_protection']);
            const input: CheckInput = {
                automationKey: 'github.branch_protection',
                parsed: { provider: 'github', checkType: 'branch_protection', raw: 'github.branch_protection' },
                tenantId: 'test-tenant',
                practiceId: 'ctrl-1',
                connectionConfig: { org: 'acme', token: 'secret' },
                triggeredBy: 'manual',
            };

            const result = await provider.runCheck(input);

            expect(result.status).toMatch(/^(PASSED|FAILED|ERROR)$/);
            expect(typeof result.summary).toBe('string');
            expect(typeof result.details).toBe('object');
        });

        it('mapResultToEvidence returns valid payload for PASSED', () => {
            const provider = createMockScheduledProvider('github', ['branch_protection']);
            const input: CheckInput = {
                automationKey: 'github.branch_protection',
                parsed: { provider: 'github', checkType: 'branch_protection', raw: 'github.branch_protection' },
                tenantId: 'test-tenant',
                connectionConfig: {},
                triggeredBy: 'manual',
            };
            const result: CheckResult = {
                status: 'PASSED',
                summary: 'Branch protection enabled',
                details: { branches: ['main'] },
            };

            const evidence = provider.mapResultToEvidence(input, result);
            expect(evidence).not.toBeNull();
            expect(evidence!.title).toContain('branch_protection');
            expect(evidence!.type).toMatch(/^(DOCUMENT|SCREENSHOT|LOG|CONFIGURATION|REPORT)$/);
        });

        it('mapResultToEvidence returns null for ERROR', () => {
            const provider = createMockScheduledProvider('github', ['branch_protection']);
            const input: CheckInput = {
                automationKey: 'github.branch_protection',
                parsed: { provider: 'github', checkType: 'branch_protection', raw: 'github.branch_protection' },
                tenantId: 'test-tenant',
                connectionConfig: {},
                triggeredBy: 'manual',
            };
            const result: CheckResult = {
                status: 'ERROR',
                summary: 'API error',
                details: {},
                errorMessage: 'Rate limited',
            };

            const evidence = provider.mapResultToEvidence(input, result);
            expect(evidence).toBeNull();
        });
    });

    // ── Connection Validation Contract ──

    describe('ConnectionValidationResult Contract', () => {
        it('validateConnection returns valid result', async () => {
            const provider = createMockScheduledProvider('github', []);
            const result = await provider.validateConnection({}, {});

            expect(typeof result.valid).toBe('boolean');
            if (!result.valid) {
                expect(typeof result.error).toBe('string');
            }
        });
    });
});
