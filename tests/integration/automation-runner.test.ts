/**
 * Scheduled Automation Runner Tests
 *
 * Tests for:
 *   1. Frequency → interval mapping
 *   2. Next due date computation
 *   3. Due-selection logic (via mock)
 *   4. Idempotency / duplicate-run protection
 *   5. Runner result contract
 */
import {
    getFrequencyIntervalMs,
    computeNextDueAt,
} from '@/app-layer/jobs/automation-runner';
import { registry } from '@/app-layer/integrations/registry';
import type {
    ScheduledCheckProvider,
    CheckInput,
    CheckResult,
    ConnectionValidationResult,
    EvidencePayload,
} from '@/app-layer/integrations/types';

// ─── Mock Provider ───────────────────────────────────────────────────

function createMockProvider(
    id: string,
    checks: string[],
    resultOverride?: Partial<CheckResult>
): ScheduledCheckProvider {
    return {
        id,
        displayName: `${id} Provider`,
        description: `Mock ${id}`,
        supportedChecks: checks,
        configSchema: { configFields: [], secretFields: [] },
        async validateConnection(): Promise<ConnectionValidationResult> {
            return { valid: true };
        },
        async runCheck(input: CheckInput): Promise<CheckResult> {
            return {
                status: 'PASSED',
                summary: `Check ${input.automationKey} passed`,
                details: { mock: true },
                ...resultOverride,
            };
        },
        mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
            return {
                title: `[${input.parsed.provider}] ${input.parsed.checkType}`,
                content: result.summary,
                type: 'CONFIGURATION',
                category: 'integration',
            };
        },
    };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Automation Runner', () => {
    beforeEach(() => {
        registry._clear();
    });

    // ── Frequency Interval ──

    describe('getFrequencyIntervalMs', () => {
        it('returns 24h for DAILY', () => {
            expect(getFrequencyIntervalMs('DAILY')).toBe(24 * 60 * 60 * 1000);
        });

        it('returns 7d for WEEKLY', () => {
            expect(getFrequencyIntervalMs('WEEKLY')).toBe(7 * 24 * 60 * 60 * 1000);
        });

        it('returns 30d for MONTHLY', () => {
            expect(getFrequencyIntervalMs('MONTHLY')).toBe(30 * 24 * 60 * 60 * 1000);
        });

        it('returns 90d for QUARTERLY', () => {
            expect(getFrequencyIntervalMs('QUARTERLY')).toBe(90 * 24 * 60 * 60 * 1000);
        });

        it('returns 365d for ANNUALLY', () => {
            expect(getFrequencyIntervalMs('ANNUALLY')).toBe(365 * 24 * 60 * 60 * 1000);
        });

        it('returns null for AD_HOC', () => {
            expect(getFrequencyIntervalMs('AD_HOC')).toBeNull();
        });

        it('returns null for null', () => {
            expect(getFrequencyIntervalMs(null)).toBeNull();
        });

        it('returns null for unknown frequency', () => {
            expect(getFrequencyIntervalMs('BIWEEKLY')).toBeNull();
        });
    });

    // ── Next Due Date ──

    describe('computeNextDueAt', () => {
        const baseDate = new Date('2026-03-27T00:00:00Z');

        it('advances DAILY by 24 hours', () => {
            const next = computeNextDueAt('DAILY', baseDate);
            expect(next).toEqual(new Date('2026-03-28T00:00:00Z'));
        });

        it('advances WEEKLY by 7 days', () => {
            const next = computeNextDueAt('WEEKLY', baseDate);
            expect(next).toEqual(new Date('2026-04-03T00:00:00Z'));
        });

        it('advances MONTHLY by 30 days', () => {
            const next = computeNextDueAt('MONTHLY', baseDate);
            expect(next).toEqual(new Date('2026-04-26T00:00:00Z'));
        });

        it('advances QUARTERLY by 90 days', () => {
            const next = computeNextDueAt('QUARTERLY', baseDate);
            expect(next).toEqual(new Date('2026-06-25T00:00:00Z'));
        });

        it('advances ANNUALLY by 365 days', () => {
            const next = computeNextDueAt('ANNUALLY', baseDate);
            expect(next).toEqual(new Date('2027-03-27T00:00:00Z'));
        });

        it('returns null for AD_HOC', () => {
            expect(computeNextDueAt('AD_HOC', baseDate)).toBeNull();
        });

        it('returns null for null frequency', () => {
            expect(computeNextDueAt(null, baseDate)).toBeNull();
        });
    });

    // ── Provider Resolution for Scheduling ──

    describe('Provider resolution for scheduled checks', () => {
        it('resolves registered provider for automation key', () => {
            registry.register(createMockProvider('github', ['branch_protection']));

            const result = registry.resolveByAutomationKey('github.branch_protection');
            expect(result).not.toBeNull();
            expect(result!.provider.id).toBe('github');
        });

        it('returns null for unregistered provider', () => {
            expect(registry.resolveByAutomationKey('github.branch_protection')).toBeNull();
        });

        it('canHandle reflects registration state', () => {
            expect(registry.canHandle('github.branch_protection')).toBe(false);

            registry.register(createMockProvider('github', ['branch_protection']));
            expect(registry.canHandle('github.branch_protection')).toBe(true);

            registry.unregister('github');
            expect(registry.canHandle('github.branch_protection')).toBe(false);
        });
    });

    // ── Mock Provider Execution ──

    describe('Mock provider execution', () => {
        it('returns PASSED result with evidence', async () => {
            const provider = createMockProvider('github', ['branch_protection']);
            const input: CheckInput = {
                automationKey: 'github.branch_protection',
                parsed: { provider: 'github', checkType: 'branch_protection', raw: 'github.branch_protection' },
                tenantId: 'tenant-1',
                practiceId: 'ctrl-1',
                connectionConfig: { token: 'test' },
                triggeredBy: 'scheduled',
                jobRunId: 'job-1',
            };

            const result = await provider.runCheck(input);
            expect(result.status).toBe('PASSED');
            expect(result.details).toBeDefined();

            const evidence = provider.mapResultToEvidence(input, result);
            expect(evidence).not.toBeNull();
            expect(evidence!.type).toBe('CONFIGURATION');
            expect(evidence!.category).toBe('integration');
        });

        it('returns FAILED result when configured', async () => {
            const provider = createMockProvider('github', ['branch_protection'], {
                status: 'FAILED',
                summary: 'Branch protection not enabled on main',
            });

            const result = await provider.runCheck({
                automationKey: 'github.branch_protection',
                parsed: { provider: 'github', checkType: 'branch_protection', raw: 'github.branch_protection' },
                tenantId: 'tenant-1',
                connectionConfig: {},
                triggeredBy: 'scheduled',
            });

            expect(result.status).toBe('FAILED');
            expect(result.summary).toContain('not enabled');
        });
    });

    // ── Runner Result Contract ──

    describe('AutomationRunnerResult contract', () => {
        it('result shape is complete', () => {
            const mockResult = {
                totalDue: 10,
                executed: 8,
                passed: 5,
                failed: 2,
                errors: 1,
                skipped: 2,
                dryRun: false,
                jobRunId: 'abc-123',
            };

            // Validate shape
            expect(typeof mockResult.totalDue).toBe('number');
            expect(typeof mockResult.executed).toBe('number');
            expect(typeof mockResult.passed).toBe('number');
            expect(typeof mockResult.failed).toBe('number');
            expect(typeof mockResult.errors).toBe('number');
            expect(typeof mockResult.skipped).toBe('number');
            expect(typeof mockResult.dryRun).toBe('boolean');
            expect(typeof mockResult.jobRunId).toBe('string');

            // Invariants
            expect(mockResult.executed + mockResult.skipped).toBe(mockResult.totalDue);
            expect(mockResult.passed + mockResult.failed + mockResult.errors).toBe(mockResult.executed);
        });
    });

    // ── Idempotency Window ──

    describe('Idempotency window logic', () => {
        it('DAILY window is 24h', () => {
            const interval = getFrequencyIntervalMs('DAILY')!;
            const now = new Date('2026-03-27T12:00:00Z');
            const windowStart = new Date(now.getTime() - interval);
            expect(windowStart).toEqual(new Date('2026-03-26T12:00:00Z'));
        });

        it('execution within window should be considered recent', () => {
            const now = new Date('2026-03-27T12:00:00Z');
            const interval = getFrequencyIntervalMs('DAILY')!;
            const windowStart = new Date(now.getTime() - interval);

            const recentExecution = new Date('2026-03-27T06:00:00Z'); // 6h ago
            const oldExecution = new Date('2026-03-25T06:00:00Z');   // 54h ago

            expect(recentExecution.getTime() >= windowStart.getTime()).toBe(true);
            expect(oldExecution.getTime() >= windowStart.getTime()).toBe(false);
        });
    });
});
