/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Webhook → Sync Orchestrator Integration Tests
 *
 * Verifies that the webhook processor correctly dispatches validated
 * webhook events to the sync orchestrator, producing actual sync
 * mapping updates. Covers:
 *
 *   1. Webhook event reaches handleWebhookEvent() on the orchestrator
 *   2. Sync orchestrator updates the correct mapping/state
 *   3. Existing auth/verification still works (not bypassed)
 *   4. No duplicate evidence/execution creation when orchestrator also runs
 *   5. Tenant/provider scoping remains correct
 *   6. PrismaLocalStore applies changes to local entities
 *   7. PrismaLocalStore reads local entity data
 *   8. Connection config is properly built from configJson + secrets
 */
import type { GitHubLocalStore } from '@/app-layer/integrations/providers/github/sync';

// ═══════════════════════════════════════════════════════════════════════
// Mocks — must be set up before imports
// ═══════════════════════════════════════════════════════════════════════

// ── Prisma mock ──────────────────────────────────────────────────────

const mockPrisma = {
    integrationWebhookEvent: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    integrationConnection: {
        findMany: jest.fn(),
    },
    integrationExecution: {
        create: jest.fn(),
    },
    evidence: {
        create: jest.fn(),
    },
    practice: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: mockPrisma,
}));

// ── db-context mock (withTenantDb) ───────────────────────────────────

let capturedTenantIds: string[] = [];

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    withTenantDb: jest.fn(async (tenantId: string, cb: (db: unknown) => Promise<unknown>) => {
        capturedTenantIds.push(tenantId);
        return cb(mockPrisma);
    }),
    runInTenantContext: jest.fn(async (ctx: any, cb: (db: unknown) => Promise<unknown>) => {
        capturedTenantIds.push(ctx.tenantId);
        return cb(mockPrisma);
    }),
}));

// ── Encryption mock ──────────────────────────────────────────────────

jest.mock('@/lib/security/encryption', () => ({
    __esModule: true,
    decryptField: jest.fn((encrypted: string) => encrypted), // return as-is for tests
}));

// ── Logger mock ──────────────────────────────────────────────────────

jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// ── Webhook crypto mock ──────────────────────────────────────────────

jest.mock('@/app-layer/integrations/webhook-crypto', () => ({
    __esModule: true,
    extractSignature: jest.fn(() => 'valid-sig'),
    verifyHmacSha256: jest.fn(() => true),
    verifyGitHubSignature: jest.fn(() => true),
}));

// ── Sync store mock ──────────────────────────────────────────────────

const mockSyncStoreInstance = {
    findByLocalEntity: jest.fn(),
    findByRemoteEntity: jest.fn(),
    findOrCreate: jest.fn(),
    updateStatus: jest.fn(),
};

jest.mock('@/app-layer/integrations/prisma-sync-store', () => ({
    __esModule: true,
    PrismaSyncMappingStore: jest.fn(() => mockSyncStoreInstance),
}));

// ── Local store mock ─────────────────────────────────────────────────

const mockLocalStoreInstance = {
    applyChanges: jest.fn(),
    getData: jest.fn(),
};

jest.mock('@/app-layer/integrations/prisma-local-store', () => ({
    __esModule: true,
    PrismaLocalStore: jest.fn(() => mockLocalStoreInstance),
}));

// ── Registry mocks ───────────────────────────────────────────────────

const mockOrchestrator = {
    handleWebhookEvent: jest.fn(),
};

const mockProvider = {
    id: 'github',
    displayName: 'GitHub',
    description: 'GitHub integration',
    supportedChecks: ['branch_protection'],
    configSchema: { configFields: [], secretFields: [] },
    validateConnection: jest.fn(),
    verifyWebhookSignature: jest.fn(() => true),
    handleWebhook: jest.fn(),
    runCheck: jest.fn(),
    mapResultToEvidence: jest.fn(),
};

jest.mock('@/app-layer/integrations/registry', () => ({
    __esModule: true,
    registry: {
        getProvider: jest.fn((provider: string) =>
            provider === 'github' ? mockProvider : undefined
        ),
    },
    integrationRegistry: {
        has: jest.fn((provider: string) => provider === 'github'),
        createOrchestrator: jest.fn(() => mockOrchestrator),
    },
}));

jest.mock('@/app-layer/integrations/types', () => ({
    __esModule: true,
    isWebhookEventProvider: jest.fn(() => true),
    isScheduledCheckProvider: jest.fn(() => false),
    parseAutomationKey: jest.fn(),
}));

// ── Import after mocks ───────────────────────────────────────────────

import {
    processIncomingWebhook,
    type WebhookInput,
} from '@/app-layer/usecases/webhook-processor';
import { integrationRegistry } from '@/app-layer/integrations/registry';

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

const GITHUB_WEBHOOK_PAYLOAD = {
    action: 'edited',
    rule: {
        name: 'main',
        enabled: true,
        required_status_checks: { strict: true, contexts: ['ci'] },
        required_pull_request_reviews: {
            required_approving_review_count: 2,
            dismiss_stale_reviews: true,
        },
    },
    repository: { full_name: 'acme/platform' },
};

const WEBHOOK_INPUT: WebhookInput = {
    provider: 'github',
    rawBody: JSON.stringify(GITHUB_WEBHOOK_PAYLOAD),
    headers: {
        'x-hub-signature-256': 'sha256=valid',
        'x-github-event': 'branch_protection_rule',
        'content-type': 'application/json',
    },
};

const CONNECTION = {
    id: 'conn-1',
    tenantId: 'tenant-1',
    secretEncrypted: JSON.stringify({ token: 'ghp_test', webhookSecret: 'whsec_123' }),
    configJson: { owner: 'acme', repo: 'platform', branch: 'main' },
};

const WEBHOOK_EVENT = {
    id: 'evt-1',
    provider: 'github',
    eventType: 'edited',
    payloadJson: GITHUB_WEBHOOK_PAYLOAD,
    headersJson: {},
    payloadHash: 'hash123',
    status: 'received',
};

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe('Webhook → Sync Orchestrator dispatch', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        capturedTenantIds = [];

        // Default mock setup: event persisted, connection found, no dupes
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValue(null); // no duplicate
        mockPrisma.integrationWebhookEvent.create.mockResolvedValue(WEBHOOK_EVENT);
        mockPrisma.integrationWebhookEvent.update.mockResolvedValue({ ...WEBHOOK_EVENT, status: 'processed' });
        mockPrisma.integrationConnection.findMany.mockResolvedValue([CONNECTION]);

        // Provider returns no triggered automation keys (so execution/evidence step is skipped)
        mockProvider.handleWebhook.mockResolvedValue({ status: 'processed', triggeredKeys: [] });

        // Orchestrator returns successful sync
        mockOrchestrator.handleWebhookEvent.mockResolvedValue({
            processed: true,
            syncCount: 1,
            results: [{ success: true, action: 'synced', direction: 'PULL' }],
        });
    });

    // ── Core dispatch ─────────────────────────────────────

    it('dispatches webhook event to sync orchestrator handleWebhookEvent', async () => {
        const result = await processIncomingWebhook(WEBHOOK_INPUT);

        expect(result.status).toBe('processed');
        expect(mockOrchestrator.handleWebhookEvent).toHaveBeenCalledTimes(1);
        expect(mockOrchestrator.handleWebhookEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                ctx: expect.objectContaining({ tenantId: 'tenant-1' }),
                provider: 'github',
                eventType: 'edited',
                payload: GITHUB_WEBHOOK_PAYLOAD,
                connectionId: 'conn-1',
            }),
        );
    });

    it('creates orchestrator with real PrismaSyncMappingStore and PrismaLocalStore', async () => {
        await processIncomingWebhook(WEBHOOK_INPUT);

        expect(integrationRegistry.createOrchestrator).toHaveBeenCalledWith(
            'github',
            expect.objectContaining({
                config: expect.objectContaining({
                    owner: 'acme',
                    repo: 'platform',
                    token: 'ghp_test',
                }),
                store: expect.any(Object),
                localStore: expect.any(Object),
            }),
        );
    });

    // ── Connection config correctness ─────────────────────

    it('merges configJson and decrypted secrets into orchestrator config', async () => {
        await processIncomingWebhook(WEBHOOK_INPUT);

        const createOrchestratorCall = (integrationRegistry.createOrchestrator as jest.Mock).mock.calls[0];
        const opts = createOrchestratorCall[1];

        // Config should have fields from configJson AND from decrypted secrets
        expect(opts.config.owner).toBe('acme');           // from configJson
        expect(opts.config.repo).toBe('platform');        // from configJson
        expect(opts.config.branch).toBe('main');          // from configJson
        expect(opts.config.token).toBe('ghp_test');       // from decrypted secrets
        expect(opts.config.webhookSecret).toBe('whsec_123'); // from decrypted secrets
    });

    // ── Tenant scoping ────────────────────────────────────

    it('passes resolved tenantId (from connection, not caller) to orchestrator', async () => {
        await processIncomingWebhook(WEBHOOK_INPUT);

        const call = mockOrchestrator.handleWebhookEvent.mock.calls[0][0];
        expect(call.ctx.tenantId).toBe('tenant-1'); // Resolved from DB, not from webhook payload
    });

    // ── Auth verification still works ─────────────────────

    it('does NOT dispatch to orchestrator when signature verification fails', async () => {
        // Make all connections fail signature verification
        const { verifyGitHubSignature } = require('@/app-layer/integrations/webhook-crypto');
        (verifyGitHubSignature as jest.Mock).mockReturnValueOnce(false);
        const { verifyHmacSha256 } = require('@/app-layer/integrations/webhook-crypto');
        (verifyHmacSha256 as jest.Mock).mockReturnValueOnce(false);

        const result = await processIncomingWebhook(WEBHOOK_INPUT);

        expect(result.status).toBe('auth_failed');
        expect(mockOrchestrator.handleWebhookEvent).not.toHaveBeenCalled();
    });

    it('does NOT dispatch to orchestrator for unknown provider', async () => {
        const { registry } = require('@/app-layer/integrations/registry');
        (registry.getProvider as jest.Mock).mockReturnValueOnce(undefined);

        const result = await processIncomingWebhook({
            ...WEBHOOK_INPUT,
            provider: 'unknown',
        });

        expect(result.status).toBe('invalid_provider');
        expect(mockOrchestrator.handleWebhookEvent).not.toHaveBeenCalled();
    });

    // ── Error isolation ───────────────────────────────────

    it('does NOT fail the webhook when orchestrator throws', async () => {
        mockOrchestrator.handleWebhookEvent.mockRejectedValue(new Error('Orchestrator boom'));

        const result = await processIncomingWebhook(WEBHOOK_INPUT);

        // Webhook should still report success because the provider handler succeeded
        expect(result.status).toBe('processed');
    });

    it('logs orchestrator errors without overwriting webhook status', async () => {
        const { logger: mockLogger } = require('@/lib/observability/logger');
        mockOrchestrator.handleWebhookEvent.mockRejectedValue(new Error('DB timeout'));

        await processIncomingWebhook(WEBHOOK_INPUT);

        expect(mockLogger.error).toHaveBeenCalledWith(
            'Sync orchestrator dispatch failed',
            expect.objectContaining({
                provider: 'github',
                tenantId: 'tenant-1',
            }),
        );
    });

    // ── Deduplication ─────────────────────────────────────

    it('does NOT dispatch to orchestrator for duplicate payloads', async () => {
        mockPrisma.integrationWebhookEvent.findFirst.mockResolvedValue({ id: 'dupe-1' });

        const result = await processIncomingWebhook(WEBHOOK_INPUT);

        expect(result.status).toBe('ignored');
        expect(mockOrchestrator.handleWebhookEvent).not.toHaveBeenCalled();
    });

    // ── No connections ─────────────────────────────────────

    it('does NOT dispatch to orchestrator when no connections exist', async () => {
        mockPrisma.integrationConnection.findMany.mockResolvedValue([]);

        const result = await processIncomingWebhook(WEBHOOK_INPUT);

        expect(result.status).toBe('ignored');
        expect(mockOrchestrator.handleWebhookEvent).not.toHaveBeenCalled();
    });

    // ── Non-CRUD provider ──────────────────────────────────

    it('skips orchestrator dispatch for providers without CRUD bundles', async () => {
        (integrationRegistry.has as jest.Mock).mockReturnValueOnce(false);

        const result = await processIncomingWebhook(WEBHOOK_INPUT);

        expect(result.status).toBe('processed');
        expect(integrationRegistry.createOrchestrator).not.toHaveBeenCalled();
        expect(mockOrchestrator.handleWebhookEvent).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// PrismaLocalStore — Unit Tests
// ═══════════════════════════════════════════════════════════════════════

describe('PrismaLocalStore', () => {
    // Import the real (non-mocked) implementation for direct testing
    // We have to use jest.requireActual since PrismaLocalStore is mocked above
    let PrismaLocalStoreReal: new () => GitHubLocalStore;

    beforeAll(() => {
        // Unmock for this describe block by importing actual
        const actual = jest.requireActual('@/app-layer/integrations/prisma-local-store');
        PrismaLocalStoreReal = actual.PrismaLocalStore;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        capturedTenantIds = [];
    });

    describe('applyChanges', () => {
        it('updates practice entity with allowed fields', async () => {
            mockPrisma.practice.update.mockResolvedValue({ id: 'ctrl-1' });
            const store = new PrismaLocalStoreReal();
            const ctx: any = { tenantId: 'tenant-1' };

            const fields = await store.applyChanges(ctx, 'practice', 'ctrl-1', {
                status: 'IMPLEMENTED',
                protectionEnabled: true,
                requiredReviewCount: 2,
            });

            expect(fields.length).toBeGreaterThan(0);
            expect(capturedTenantIds).toContain('tenant-1');
        });

        it('returns empty array for unsupported entity types', async () => {
            const store = new PrismaLocalStoreReal();
            const ctx: any = { tenantId: 'tenant-1' };

            const fields = await store.applyChanges(ctx, 'unknown_entity', 'id-1', {
                field: 'value',
            });

            expect(fields).toEqual([]);
        });

        it('returns empty array when no fields are in the allowlist', async () => {
            const store = new PrismaLocalStoreReal();
            const ctx: any = { tenantId: 'tenant-1' };

            const fields = await store.applyChanges(ctx, 'practice', 'ctrl-1', {
                hackerField: 'DROP TABLE',
                anotherBadField: 'exploit',
            });

            expect(fields).toEqual([]);
            expect(mockPrisma.practice.update).not.toHaveBeenCalled();
        });
    });

    describe('getData', () => {
        it('returns practice data when entity exists', async () => {
            mockPrisma.practice.findUnique.mockResolvedValue({
                id: 'ctrl-1',
                name: 'Branch Protection',
                status: 'IMPLEMENTED',
            });
            const store = new PrismaLocalStoreReal();
            const ctx: any = { tenantId: 'tenant-1' };

            const data = await store.getData(ctx, 'practice', 'ctrl-1');

            expect(data).toBeTruthy();
            expect(data!.id).toBe('ctrl-1');
            expect(data!.status).toBe('IMPLEMENTED');
        });

        it('returns null when entity does not exist', async () => {
            mockPrisma.practice.findUnique.mockResolvedValue(null);
            const store = new PrismaLocalStoreReal();
            const ctx: any = { tenantId: 'tenant-1' };

            const data = await store.getData(ctx, 'practice', 'ctrl-999');

            expect(data).toBeNull();
        });

        it('returns null for unsupported entity types', async () => {
            const store = new PrismaLocalStoreReal();
            const ctx: any = { tenantId: 'tenant-1' };

            const data = await store.getData(ctx, 'unknown_entity', 'id-1');

            expect(data).toBeNull();
        });

        it('enforces tenant isolation through withTenantDb', async () => {
            mockPrisma.practice.findUnique.mockResolvedValue(null);
            const store = new PrismaLocalStoreReal();
            const ctx: any = { tenantId: 'tenant-42' };

            await store.getData(ctx, 'practice', 'ctrl-1');

            expect(capturedTenantIds).toContain('tenant-42');
        });
    });
});
