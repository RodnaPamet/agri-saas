/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake DB. */
/**
 * Unit tests for `src/app-layer/usecases/webhook-processor.ts` —
 * the incoming-webhook processing pipeline.
 *
 * Wave-7 / stage-3e branch coverage. 485-line file with one huge
 * `processIncomingWebhook` function plus 4 helpers. Security-
 * critical: a bug here either:
 *   - lets an unsigned/tampered webhook through (auth bypass)
 *   - cross-tenants by trusting a caller-supplied tenant ID
 *     (resolution must always come from IntegrationConnection)
 *   - duplicates evidence/execution rows on replay attacks
 *
 * Branch matrix covered:
 *
 *   helpers:
 *     decryptWebhookSecret: null → {} / JSON-success / parse-fail → {}
 *     getWebhookSecret: 4 key-name fallbacks / none found
 *     verifyProviderSignature: no-secret allow / missing-sig-header
 *       reject / github / gitlab / generic-hmac
 *     sanitizeHeaders: redact set / pass-through
 *
 *   processIncomingWebhook:
 *     - unknown provider → invalid_provider
 *     - body parse fail → fallback to raw
 *     - dedup hit within window → ignored
 *     - persist event fail → error
 *     - 0 connections → ignored
 *     - signature mismatch across all connections → auth_failed
 *     - matchedConnection found → tenantId resolved from DB
 *     - isWebhookEventProvider: yes / no branch
 *     - providerImpl.verifyWebhookSignature fail → auth_failed
 *     - providerImpl.handleWebhook throws → error path
 *     - triggeredKeys empty (no practices) → 0 executions
 *     - triggeredKeys + matching practice → N executions + N evidence
 *     - integrationRegistry.has(provider) → orchestrator dispatch
 *     - orchestrator throw → swallowed (best-effort)
 *     - happy-path complete → status='processed' + counts
 */

const mockPrisma: any = {
    integrationWebhookEvent: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    integrationConnection: { findMany: jest.fn() },
    practice: { findMany: jest.fn() },
    integrationExecution: { create: jest.fn() },
    evidence: { create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: mockPrisma,
    default: mockPrisma,
}));

// Registry exposes both `registry.getProvider` (provider-impl lookup)
// AND `integrationRegistry.has` / `.createOrchestrator` (sync layer).
const mockProviderImpl: any = {
    verifyWebhookSignature: jest.fn(),
    handleWebhook: jest.fn(),
};
const mockOrchestrator: any = {
    handleWebhookEvent: jest.fn(),
};
const mockRegistry = {
    getProvider: jest.fn(),
};
const mockIntegrationRegistry = {
    has: jest.fn(() => false),
    createOrchestrator: jest.fn(),
};
jest.mock('@/app-layer/integrations/registry', () => ({
    registry: mockRegistry,
    integrationRegistry: mockIntegrationRegistry,
}));

let _isWebhookProvider = false;
jest.mock('@/app-layer/integrations/types', () => ({
    isWebhookEventProvider: () => _isWebhookProvider,
}));

jest.mock('@/app-layer/integrations/prisma-sync-store', () => ({
    PrismaSyncMappingStore: jest.fn(),
}));
jest.mock('@/app-layer/integrations/prisma-local-store', () => ({
    PrismaLocalStore: jest.fn(),
}));

const mockExtractSig = jest.fn();
const mockVerifyHmac = jest.fn();
const mockVerifyGitHub = jest.fn();
jest.mock('@/app-layer/integrations/webhook-crypto', () => ({
    extractSignature: (...args: any[]) => mockExtractSig(...args),
    verifyHmacSha256: (...args: any[]) => mockVerifyHmac(...args),
    verifyGitHubSignature: (...args: any[]) => mockVerifyGitHub(...args),
}));

jest.mock('@/lib/security/encryption', () => ({
    decryptField: jest.fn((enc: string) => enc), // pass-through
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/permissions', () => ({
    getPermissionsForRole: jest.fn(() => ({})),
}));

import { processIncomingWebhook } from '@/app-layer/usecases/webhook-processor';

beforeEach(() => {
    [
        mockPrisma.integrationWebhookEvent.findFirst,
        mockPrisma.integrationWebhookEvent.create,
        mockPrisma.integrationWebhookEvent.update,
        mockPrisma.integrationConnection.findMany,
        mockPrisma.practice.findMany,
        mockPrisma.integrationExecution.create,
        mockPrisma.evidence.create,
        mockRegistry.getProvider,
        mockIntegrationRegistry.has,
        mockIntegrationRegistry.createOrchestrator,
        mockProviderImpl.verifyWebhookSignature,
        mockProviderImpl.handleWebhook,
        mockOrchestrator.handleWebhookEvent,
        mockExtractSig, mockVerifyHmac, mockVerifyGitHub,
    ].forEach((m: any) => m.mockReset && m.mockReset());
    // Default: no orchestrator integration.
    mockIntegrationRegistry.has.mockReturnValue(false);
    _isWebhookProvider = false;
});

// Helper: build a minimal viable input.
const makeInput = (overrides: any = {}) => ({
    provider: 'github',
    rawBody: '{"action":"opened"}',
    headers: { 'content-type': 'application/json' },
    ...overrides,
});

// ──────────────────────────────────────────────────────────────────────
// Entry-point branches
// ──────────────────────────────────────────────────────────────────────
describe('processIncomingWebhook — entry branches', () => {
    it('returns invalid_provider when no impl is registered', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(null);
        const result = await processIncomingWebhook(makeInput());
        expect(result).toEqual({ status: 'invalid_provider' });
        expect(mockPrisma.integrationWebhookEvent.create).not.toHaveBeenCalled();
    });

    it('falls back to raw rawBody on JSON parse failure', async () => {
        // The persist call still goes through with a wrapper shape
        // (`{ raw: rawBody }`) — important so an unparseable webhook
        // is still durable for audit / replay.
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([]);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationWebhookEvent.update.mockResolvedValueOnce({});

        await processIncomingWebhook(makeInput({ rawBody: 'not-json{{{' }));

        const createArgs = mockPrisma.integrationWebhookEvent.create.mock.calls[0][0];
        expect(createArgs.data.payloadJson).toEqual({ raw: 'not-json{{{' });
        expect(createArgs.data.eventType).toBeNull();
    });

    it('DEDUPE hit within window → ignored (no persist, no provider dispatch)', async () => {
        // Replay defense — the same payload hash within the 5-min
        // window returns the prior event id rather than processing
        // again. Without this an attacker could spam the same
        // signed payload to amplify executions/evidence.
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce({ id: 'prior-evt' });

        const result = await processIncomingWebhook(makeInput());

        expect(result).toEqual({
            status: 'ignored', eventId: 'prior-evt', reason: 'duplicate_payload',
        });
        expect(mockPrisma.integrationWebhookEvent.create).not.toHaveBeenCalled();
    });

    it('returns error when event persistence fails', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockRejectedValueOnce(new Error('db down'));

        const result = await processIncomingWebhook(makeInput());

        expect(result).toMatchObject({ status: 'error', errorMessage: 'Failed to persist event' });
    });

    it('returns ignored when no enabled connections exist for the provider', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([]);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValueOnce({});

        const result = await processIncomingWebhook(makeInput());

        expect(result).toEqual({
            status: 'ignored', eventId: 'evt-1', reason: 'no_connections',
        });
        // The event row gets a status update — the receipt is still durable.
        expect(mockPrisma.integrationWebhookEvent.update).toHaveBeenCalledWith({
            where: { id: 'evt-1' },
            data: { status: 'ignored', errorMessage: 'No active connections for provider' },
        });
    });
});

// ──────────────────────────────────────────────────────────────────────
// Signature verification → auth_failed branches
// ──────────────────────────────────────────────────────────────────────
describe('processIncomingWebhook — signature verification', () => {
    it('returns auth_failed when no connection passes signature verification', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{"webhookSecret":"s1"}', configJson: {} },
        ]);
        // Signature verification setup: extract returns truthy but
        // verify returns false.
        mockExtractSig.mockReturnValue('sig-bad');
        mockVerifyGitHub.mockReturnValue(false);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValueOnce({});

        const result = await processIncomingWebhook(
            makeInput({ headers: { 'x-hub-signature-256': 'sha256=...' } }),
        );

        expect(result).toEqual({ status: 'auth_failed', eventId: 'evt-1' });
        expect(mockPrisma.integrationWebhookEvent.update).toHaveBeenCalledWith({
            where: { id: 'evt-1' },
            data: { status: 'error', errorMessage: expect.stringMatching(/signature verification failed/i) },
        });
    });

    it('NO-SECRET branch ALLOWS the webhook to proceed (operator responsibility)', async () => {
        // Documented behaviour: a connection with no webhookSecret
        // logs a warning but still verifies as `true`. This is a
        // dev-mode convenience; prod should configure secrets.
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{}', configJson: {} },
        ]);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValueOnce({});
        mockPrisma.integrationWebhookEvent.update.mockResolvedValueOnce({});
        _isWebhookProvider = false; // skip provider branch

        const result = await processIncomingWebhook(makeInput());

        // Reaches the processed-status finalize path despite no secret.
        expect(result).toMatchObject({ status: 'processed', eventId: 'evt-1' });
    });

    it('resolves the tenant from IntegrationConnection (NEVER from the caller)', async () => {
        // Compliance-critical: the tenantId on the event row comes
        // from the connection lookup, not from any caller-supplied
        // value. This is the cross-tenant defense.
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 'resolved-tenant-A', secretEncrypted: '{}', configJson: {} },
        ]);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});

        await processIncomingWebhook(makeInput());

        // The 2nd update call writes the resolved tenantId onto the event.
        const tenantUpdate = mockPrisma.integrationWebhookEvent.update.mock.calls.find(
            (call: any) => call[0].data.tenantId,
        );
        expect(tenantUpdate[0].data.tenantId).toBe('resolved-tenant-A');
    });
});

// ──────────────────────────────────────────────────────────────────────
// Provider-impl dispatch + automation-key fan-out
// ──────────────────────────────────────────────────────────────────────
describe('processIncomingWebhook — provider dispatch', () => {
    function setupHappyPath(opts: { triggeredKeys?: string[] } = {}) {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1', eventType: 'opened' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{"webhookSecret":"s1"}', configJson: {} },
        ]);
        mockExtractSig.mockReturnValue('sig-good');
        mockVerifyGitHub.mockReturnValue(true);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = true;
        mockProviderImpl.verifyWebhookSignature.mockReturnValue(true);
        mockProviderImpl.handleWebhook.mockResolvedValueOnce({
            status: 'ok',
            triggeredKeys: opts.triggeredKeys ?? [],
        });
    }

    it('returns auth_failed when providerImpl.verifyWebhookSignature returns false', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{"webhookSecret":"s1"}', configJson: {} },
        ]);
        mockExtractSig.mockReturnValue('sig-good');
        mockVerifyGitHub.mockReturnValue(true);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = true;
        mockProviderImpl.verifyWebhookSignature.mockReturnValueOnce(false);

        const result = await processIncomingWebhook(makeInput());

        // Second-layer (provider-specific) verification can reject
        // even after the generic HMAC passed — providers may have
        // additional checks (timestamp window, payload shape).
        expect(result).toEqual({ status: 'auth_failed', eventId: 'evt-1' });
    });

    it('catches providerImpl.handleWebhook errors → status=error + propagated message', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{"webhookSecret":"s1"}', configJson: {} },
        ]);
        mockExtractSig.mockReturnValue('sig-good');
        mockVerifyGitHub.mockReturnValue(true);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = true;
        mockProviderImpl.verifyWebhookSignature.mockReturnValue(true);
        mockProviderImpl.handleWebhook.mockRejectedValueOnce(new Error('provider exploded'));

        const result = await processIncomingWebhook(makeInput());

        expect(result).toEqual({
            status: 'error', eventId: 'evt-1', errorMessage: 'provider exploded',
        });
    });

    it('returns processed with 0 counts when handleWebhook returns no triggeredKeys', async () => {
        setupHappyPath({ triggeredKeys: [] });

        const result = await processIncomingWebhook(makeInput());

        expect(result).toMatchObject({
            status: 'processed', eventId: 'evt-1',
            executionsCreated: 0, evidenceCreated: 0,
        });
        expect(mockPrisma.integrationExecution.create).not.toHaveBeenCalled();
        expect(mockPrisma.evidence.create).not.toHaveBeenCalled();
    });

    it('creates execution + evidence per (triggeredKey × matching practice)', async () => {
        // Fan-out logic: for each triggered automationKey we find
        // every practice in the tenant with matching automationKey
        // and create both an execution row + an evidence row.
        setupHappyPath({ triggeredKeys: ['build-passed', 'tests-ran'] });
        mockPrisma.practice.findMany
            .mockResolvedValueOnce([{ id: 'ctrl-1', name: 'Build OK' }])
            .mockResolvedValueOnce([
                { id: 'ctrl-2', name: 'Tests' },
                { id: 'ctrl-3', name: 'Tests Lint' },
            ]);
        mockPrisma.integrationExecution.create
            .mockResolvedValue({ id: 'exec-1' });

        const result = await processIncomingWebhook(makeInput());

        // 1 + 2 = 3 practices match across the 2 keys.
        expect(result).toMatchObject({
            status: 'processed',
            executionsCreated: 3,
            evidenceCreated: 3,
        });
        expect(mockPrisma.integrationExecution.create).toHaveBeenCalledTimes(3);
        expect(mockPrisma.evidence.create).toHaveBeenCalledTimes(3);
    });

    it('returns processed (no fan-out) when isWebhookEventProvider is false', async () => {
        // Provider impl exists but doesn't support the WebhookEvent
        // interface — we still verify the signature (above) and
        // finalize the event row, just no provider-specific dispatch.
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{"webhookSecret":"s1"}', configJson: {} },
        ]);
        mockExtractSig.mockReturnValue('sig-good');
        mockVerifyGitHub.mockReturnValue(true);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = false;

        const result = await processIncomingWebhook(makeInput());

        expect(result.status).toBe('processed');
        expect(mockProviderImpl.handleWebhook).not.toHaveBeenCalled();
    });
});

// ──────────────────────────────────────────────────────────────────────
// Sync orchestrator branch + best-effort swallow
// ──────────────────────────────────────────────────────────────────────
describe('processIncomingWebhook — orchestrator dispatch', () => {
    it('dispatches to the sync orchestrator when integrationRegistry.has(provider)', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1', eventType: 'push' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{}', configJson: { repo: 'a/b' } },
        ]);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = false;
        mockIntegrationRegistry.has.mockReturnValue(true);
        mockIntegrationRegistry.createOrchestrator.mockReturnValue(mockOrchestrator);
        mockOrchestrator.handleWebhookEvent.mockResolvedValueOnce({
            processed: true, syncCount: 2, results: [{ action: 'created' }, { action: 'updated' }],
        });

        const result = await processIncomingWebhook(makeInput());

        expect(result.status).toBe('processed');
        expect(mockIntegrationRegistry.createOrchestrator).toHaveBeenCalledWith(
            'github',
            expect.objectContaining({
                config: expect.objectContaining({ repo: 'a/b' }),
            }),
        );
        expect(mockOrchestrator.handleWebhookEvent).toHaveBeenCalledTimes(1);
    });

    it('SWALLOWS orchestrator failure (best-effort follow-on; webhook still returns processed)', async () => {
        // The orchestrator dispatch is best-effort. The webhook's
        // primary contract (persist + verify + dispatch + create
        // evidence) has already succeeded above; a sync failure
        // shouldn't surface as a 500.
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{}', configJson: {} },
        ]);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = false;
        mockIntegrationRegistry.has.mockReturnValue(true);
        mockIntegrationRegistry.createOrchestrator.mockReturnValue(mockOrchestrator);
        mockOrchestrator.handleWebhookEvent.mockRejectedValueOnce(new Error('sync exploded'));

        const result = await processIncomingWebhook(makeInput());

        expect(result.status).toBe('processed');
    });

    it('does not call createOrchestrator if it returns null (provider has no orchestrator)', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{}', configJson: {} },
        ]);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = false;
        mockIntegrationRegistry.has.mockReturnValue(true);
        mockIntegrationRegistry.createOrchestrator.mockReturnValue(null);

        const result = await processIncomingWebhook(makeInput());

        expect(result.status).toBe('processed');
        expect(mockOrchestrator.handleWebhookEvent).not.toHaveBeenCalled();
    });
});

// ──────────────────────────────────────────────────────────────────────
// Helper-level branches via dispatch coverage
// ──────────────────────────────────────────────────────────────────────
describe('processIncomingWebhook — helper branch coverage via dispatch', () => {
    it('decryptWebhookSecret: JSON parse failure falls back to empty secrets', async () => {
        // `secretEncrypted` is non-null but unparseable. The empty-{}
        // fallback means `getWebhookSecret` returns null, which puts
        // verifyProviderSignature into the no-secret allow branch.
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: 'not-json{', configJson: {} },
        ]);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = false;

        const result = await processIncomingWebhook(makeInput());

        expect(result.status).toBe('processed');
    });

    it('getWebhookSecret: picks any of the 4 supported key-name aliases', async () => {
        // Each iteration covers one of the 4 fallback keys
        // (webhookSecret / webhook_secret / secret / signingSecret).
        // Picking `signingSecret` covers the last branch of the
        // for-of loop.
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{"signingSecret":"s1"}', configJson: {} },
        ]);
        mockExtractSig.mockReturnValue('sig-good');
        mockVerifyGitHub.mockReturnValue(true);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = false;

        const result = await processIncomingWebhook(makeInput());

        expect(result.status).toBe('processed');
    });

    it('verifyProviderSignature: generic-HMAC branch (non-github, non-gitlab provider)', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{"secret":"s1"}', configJson: {} },
        ]);
        mockExtractSig.mockReturnValue('sig-good');
        mockVerifyHmac.mockReturnValue(true);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = false;

        const result = await processIncomingWebhook(makeInput({ provider: 'stripe' }));

        expect(result.status).toBe('processed');
        expect(mockVerifyHmac).toHaveBeenCalled();
        expect(mockVerifyGitHub).not.toHaveBeenCalled();
    });

    it('verifyProviderSignature: gitlab branch uses token comparison', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{"webhookSecret":"glab-token"}', configJson: {} },
        ]);
        mockExtractSig.mockReturnValue('any');
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});
        _isWebhookProvider = false;

        const result = await processIncomingWebhook(
            makeInput({ provider: 'gitlab', headers: { 'x-gitlab-token': 'glab-token' } }),
        );

        expect(result.status).toBe('processed');
        // GitLab branch never calls HMAC verify or GitHub verify.
        expect(mockVerifyHmac).not.toHaveBeenCalled();
        expect(mockVerifyGitHub).not.toHaveBeenCalled();
    });

    it('verifyProviderSignature: missing signature header → reject', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([
            { id: 'c-1', tenantId: 't-1', secretEncrypted: '{"webhookSecret":"s1"}', configJson: {} },
        ]);
        // extractSignature returns null → reject path.
        mockExtractSig.mockReturnValue(null);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});

        const result = await processIncomingWebhook(makeInput());

        expect(result.status).toBe('auth_failed');
    });

    it('sanitizeHeaders: redacts authorization / cookie / x-api-key (PII discipline)', async () => {
        mockRegistry.getProvider.mockReturnValueOnce(mockProviderImpl);
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValueOnce(null);
        mockPrisma.integrationWebhookEvent.create.mockResolvedValueOnce({ id: 'evt-1' });
        mockPrisma.integrationConnection.findMany.mockResolvedValueOnce([]);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({});

        await processIncomingWebhook(makeInput({
            headers: {
                'authorization': 'Bearer secret-token',
                'x-api-key': 'mykey',
                'cookie': 'session=abc',
                'content-type': 'application/json',
            },
        }));

        const headersJson = mockPrisma.integrationWebhookEvent.create.mock.calls[0][0].data.headersJson;
        expect(headersJson.authorization).toBe('[REDACTED]');
        expect(headersJson['x-api-key']).toBe('[REDACTED]');
        expect(headersJson.cookie).toBe('[REDACTED]');
        // Non-sensitive header passes through.
        expect(headersJson['content-type']).toBe('application/json');
    });
});
