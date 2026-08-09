/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/integrations.ts
 *
 * Wave 3 of GAP-02. Integration secrets are the keys that unlock
 * external systems (Datadog, Slack, Jira, etc.). A bug in this
 * usecase has three blast radii:
 *   1. Secrets persisted in plaintext (encryption regression).
 *   2. Non-admin users mutating connections (RBAC regression).
 *   3. Provider validation bypass — typo'd provider name silently
 *      attaches a non-functional connection.
 *
 * Behaviours protected:
 *   1. canAdmin gate on upsert / remove.
 *   2. Provider validation rejects unknown providers.
 *   3. Secrets always encrypted via encryptField — plaintext never
 *      reaches the DB column.
 *   4. CREATED / UPDATED / DISABLED audit events.
 *   5. runAutomationForPractice: notFound / badRequest paths.
 *   6. handleIncomingWebhook persists raw event; "ignored" if no
 *      handler; status flip to "processed" on the happy path.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/integrations/registry', () => ({
    registry: {
        getProvider: jest.fn(),
        resolveByAutomationKey: jest.fn(),
        getWebhookProvider: jest.fn(),
        listProviders: jest.fn().mockReturnValue([]),
        listAllAutomationKeys: jest.fn().mockReturnValue([]),
    },
}));

jest.mock('@/app-layer/integrations/types', () => ({
    parseAutomationKey: jest.fn(),
    isScheduledCheckProvider: jest.fn(() => true),
}));

jest.mock('@/lib/security/encryption', () => ({
    encryptField: jest.fn((s: string) => `ENC(${s})`),
    decryptField: jest.fn((s: string) => s.replace(/^ENC\((.*)\)$/, '$1')),
}));

jest.mock('@/lib/prisma', () => ({
    prisma: {
        integrationWebhookEvent: {
            create: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    upsertIntegrationConnection,
    removeIntegrationConnection,
    runAutomationForPractice,
    handleIncomingWebhook,
} from '@/app-layer/usecases/integrations';
import { runInTenantContext } from '@/lib/db-context';
import { registry } from '@/app-layer/integrations/registry';
import { encryptField } from '@/lib/security/encryption';
import { logEvent } from '@/app-layer/events/audit';
import { prisma } from '@/lib/prisma';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockGetProvider = registry.getProvider as jest.MockedFunction<typeof registry.getProvider>;
const mockResolveKey = registry.resolveByAutomationKey as jest.MockedFunction<typeof registry.resolveByAutomationKey>;
const mockGetWebhookProvider = registry.getWebhookProvider as jest.MockedFunction<typeof registry.getWebhookProvider>;
const mockEncrypt = encryptField as jest.MockedFunction<typeof encryptField>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;
const mockWebhookCreate = prisma.integrationWebhookEvent.create as jest.MockedFunction<typeof prisma.integrationWebhookEvent.create>;
const mockWebhookUpdate = prisma.integrationWebhookEvent.update as jest.MockedFunction<typeof prisma.integrationWebhookEvent.update>;

beforeEach(() => {
    jest.clearAllMocks();
    // Opaque encrypt — the assertion below ("plaintext never reaches
    // the DB") would be tautological if the mock leaked the input back
    // into its output.
    mockEncrypt.mockImplementation(() => 'ENCRYPTED_BLOB_OPAQUE');
});

describe('upsertIntegrationConnection — RBAC + secret encryption', () => {
    const validInput = {
        provider: 'datadog',
        name: 'prod-datadog',
        configJson: { region: 'us1' },
        secrets: { apiKey: 'secret-api-key', appKey: 'secret-app-key' },
    };

    it('rejects EDITOR (canAdmin gate)', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        await expect(
            upsertIntegrationConnection(makeRequestContext('EDITOR'), validInput),
        ).rejects.toThrow(/Admin only/);
    });

    it('rejects READER + AUDITOR', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        await expect(
            upsertIntegrationConnection(makeRequestContext('READER'), validInput),
        ).rejects.toThrow();
        await expect(
            upsertIntegrationConnection(makeRequestContext('AUDITOR'), validInput),
        ).rejects.toThrow();
    });

    it('rejects unknown provider with badRequest', async () => {
        mockGetProvider.mockReturnValue(undefined);
        await expect(
            upsertIntegrationConnection(makeRequestContext('ADMIN'), {
                provider: 'typo-provider', name: 'x',
            }),
        ).rejects.toThrow(/Unknown provider/);
        // Regression: a typo'd provider name silently saved would create
        // a "ghost" connection that never executes — admin would think
        // the integration was wired and miss real failures.
    });

    it('encrypts secrets via encryptField (plaintext never reaches DB)', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        let createArgs: any;
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    create: jest.fn().mockImplementation((args: any) => {
                        createArgs = args;
                        return Promise.resolve({ id: 'conn-1', provider: 'datadog', name: 'prod-datadog' });
                    }),
                },
            } as never),
        );

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), validInput);

        // The encryptField is called with a JSON string of the secrets.
        expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify(validInput.secrets));
        // Regression: a refactor that persisted `secrets` directly
        // would write API keys in plaintext to the DB column. We assert
        // the opaque blob landed AND the plaintext does not.
        expect(createArgs.data.secretEncrypted).toBe('ENCRYPTED_BLOB_OPAQUE');
        expect(JSON.stringify(createArgs.data)).not.toContain('secret-api-key');
        expect(JSON.stringify(createArgs.data)).not.toContain('secret-app-key');
    });

    it('omits encryption call when no secrets are provided', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    create: jest.fn().mockResolvedValue({ id: 'c1' }),
                },
            } as never),
        );

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            provider: 'datadog',
            name: 'prod',
            configJson: {},
        });

        expect(mockEncrypt).not.toHaveBeenCalled();
    });

    it('emits CREATED audit on new connection', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    create: jest.fn().mockResolvedValue({ id: 'c1', provider: 'datadog' }),
                },
            } as never),
        );

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), validInput);

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'INTEGRATION_CONNECTION_CREATED' }),
        );
    });

    it('emits UPDATED audit when id is provided + connection exists', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue({ id: 'c1' }),
                    update: jest.fn().mockResolvedValue({ id: 'c1' }),
                },
            } as never),
        );

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            ...validInput,
            id: 'c1',
        });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'INTEGRATION_CONNECTION_UPDATED' }),
        );
    });

    it('throws notFound when updating a connection that is not in the tenant', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    update: jest.fn(),
                },
            } as never),
        );

        await expect(
            upsertIntegrationConnection(makeRequestContext('ADMIN'), {
                ...validInput,
                id: 'tenant-B-conn',
            }),
        ).rejects.toThrow(/not found/);
        // Regression: a missing tenantId on the WHERE would let an admin
        // in tenant A overwrite a connection in tenant B by id.
    });
});

describe('removeIntegrationConnection', () => {
    it('rejects EDITOR (canAdmin gate)', async () => {
        await expect(
            removeIntegrationConnection(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow();
    });

    it('throws notFound on cross-tenant id', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue(null),
                },
            } as never),
        );

        await expect(
            removeIntegrationConnection(makeRequestContext('ADMIN'), 'tenant-B-conn'),
        ).rejects.toThrow(/not found/);
    });

    it('soft-disables (isEnabled=false) and emits DISABLED audit', async () => {
        let updateArgs: any;
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 'c1', provider: 'datadog', name: 'prod',
                    }),
                    update: jest.fn().mockImplementation((args: any) => {
                        updateArgs = args;
                        return Promise.resolve({});
                    }),
                },
            } as never),
        );

        await removeIntegrationConnection(makeRequestContext('ADMIN'), 'c1');

        expect(updateArgs.data.isEnabled).toBe(false);
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'INTEGRATION_CONNECTION_DISABLED' }),
        );
    });
});

describe('runAutomationForPractice — failure paths', () => {
    it('throws notFound when the practice does not exist', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                practice: { findFirst: jest.fn().mockResolvedValue(null) },
            } as never),
        );

        await expect(
            runAutomationForPractice(makeRequestContext('EDITOR'), 'missing'),
        ).rejects.toThrow(/Practice not found/);
    });

    it('throws badRequest when the practice has no automationKey', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                practice: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 'c1', automationKey: null, tenantId: 'tenant-1',
                    }),
                },
            } as never),
        );

        await expect(
            runAutomationForPractice(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow(/no automationKey/);
    });

    it('throws badRequest when no provider matches the automationKey', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                practice: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 'c1', automationKey: 'datadog:no-such-check', tenantId: 'tenant-1',
                    }),
                },
            } as never),
        );
        mockResolveKey.mockReturnValue(null);

        await expect(
            runAutomationForPractice(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow(/No provider/);
    });

    it('throws badRequest when no active connection exists for the resolved provider', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                practice: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 'c1', automationKey: 'datadog:check', tenantId: 'tenant-1', name: 'X',
                    }),
                },
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue(null),
                },
            } as never),
        );
        mockResolveKey.mockReturnValue({
            provider: { runCheck: jest.fn(), mapResultToEvidence: jest.fn() } as any,
            parsed: { provider: 'datadog' } as any,
        } as never);

        await expect(
            runAutomationForPractice(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow(/No active connection/);
    });
});

describe('handleIncomingWebhook', () => {
    it('persists the raw event row before doing anything else', async () => {
        mockWebhookCreate.mockResolvedValueOnce({ id: 'evt-1' } as never);
        mockGetWebhookProvider.mockReturnValue({} as never);
        mockWebhookUpdate.mockResolvedValueOnce({} as never);

        await handleIncomingWebhook('tenant-1', 'datadog', {
            eventType: 'alert',
            headers: { 'x-source': 'datadog' },
            body: { id: 'a1' },
        });

        // Regression: any refactor that processed BEFORE persisting the
        // event row would lose the audit trail on early errors — we
        // would not be able to replay or debug a webhook that crashed
        // mid-flight.
        expect(mockWebhookCreate).toHaveBeenCalled();
        const createArgs = mockWebhookCreate.mock.calls[0][0] as any;
        expect(createArgs.data.status).toBe('received');
        expect(createArgs.data.provider).toBe('datadog');
    });

    it('marks the event "ignored" when no webhook provider is registered', async () => {
        mockWebhookCreate.mockResolvedValueOnce({ id: 'evt-1' } as never);
        mockGetWebhookProvider.mockReturnValue(null);

        const result = await handleIncomingWebhook('tenant-1', 'unknown-provider', {
            headers: {}, body: {},
        });

        expect(result.status).toBe('ignored');
        expect(mockWebhookUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'evt-1' },
                data: expect.objectContaining({ status: 'ignored' }),
            }),
        );
    });

    it('marks the event "processed" on the happy path', async () => {
        mockWebhookCreate.mockResolvedValueOnce({ id: 'evt-1' } as never);
        mockGetWebhookProvider.mockReturnValue({} as never);

        const result = await handleIncomingWebhook('tenant-1', 'datadog', {
            headers: {}, body: {},
        });

        expect(result.status).toBe('processed');
    });
});
