/**
 * PrismaSyncMappingStore — Unit Tests
 *
 * Verifies the production Prisma-backed SyncMappingStore implementation:
 *   1. findByLocalEntity — lookup by composite unique key
 *   2. findByRemoteEntity — lookup by remote composite unique key
 *   3. findOrCreate — create new sync mappings with safe defaults
 *   4. updateStatus — status transitions with narrowly-typed fields
 *   5. Tenant isolation — every query scoped via withTenantDb
 *   6. Null handling — returns null for missing entities
 *   7. Contract parity — same semantics as the in-memory fake
 *
 * Mocking strategy: we mock `@/lib/db-context` so `withTenantDb` invokes
 * the callback with a fake Prisma client. This tests the store's query
 * construction and result mapping without a real database.
 */

import type { SyncMapping, SyncMappingKey } from '@/app-layer/integrations/sync-types';
import type { SyncMappingStore } from '@/app-layer/integrations/sync-orchestrator';

// ── Mock Prisma model ────────────────────────────────────────────────

const mockIntegrationSyncMapping = {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
};

const mockDb = {
    integrationSyncMapping: mockIntegrationSyncMapping,
};

// ── Mock withTenantDb to capture tenantId and pass fake db ───────────

let capturedTenantIds: string[] = [];

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    withTenantDb: jest.fn(async (tenantId: string, cb: (db: unknown) => Promise<unknown>) => {
        capturedTenantIds.push(tenantId);
        return cb(mockDb);
    }),
}));

jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: { integrationSyncMapping: mockIntegrationSyncMapping },
}));

// Import AFTER mocks are set up
import { PrismaSyncMappingStore } from '@/app-layer/integrations/prisma-sync-store';

// ── Fixtures ─────────────────────────────────────────────────────────

function makePrismaRow(overrides?: Partial<SyncMapping>) {
    const now = new Date();
    return {
        id: 'sm-1',
        tenantId: 'tenant-1',
        provider: 'github',
        connectionId: 'conn-1',
        localEntityType: 'practice',
        localEntityId: 'ctrl-1',
        remoteEntityType: 'branch_protection',
        remoteEntityId: 'main',
        syncStatus: 'PENDING',
        lastSyncDirection: null,
        conflictStrategy: 'REMOTE_WINS',
        localUpdatedAt: null,
        remoteUpdatedAt: null,
        remoteDataJson: null,
        version: 1,
        errorMessage: null,
        lastSyncedAt: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function makeKey(overrides?: Partial<SyncMappingKey>): SyncMappingKey {
    return {
        tenantId: 'tenant-1',
        provider: 'github',
        connectionId: 'conn-1',
        localEntityType: 'practice',
        localEntityId: 'ctrl-1',
        remoteEntityType: 'branch_protection',
        remoteEntityId: 'main',
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe('PrismaSyncMappingStore', () => {
    let store: PrismaSyncMappingStore;

    beforeEach(() => {
        store = new PrismaSyncMappingStore();
        capturedTenantIds = [];
        jest.clearAllMocks();
    });

    // ── findByLocalEntity ────────────────────────────────────────────

    describe('findByLocalEntity', () => {
        it('returns mapped SyncMapping when row exists', async () => {
            const row = makePrismaRow();
            mockIntegrationSyncMapping.findUnique.mockResolvedValue(row);

            const result = await store.findByLocalEntity('tenant-1', 'github', 'practice', 'ctrl-1');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('sm-1');
            expect(result!.tenantId).toBe('tenant-1');
            expect(result!.provider).toBe('github');
            expect(result!.localEntityType).toBe('practice');
            expect(result!.localEntityId).toBe('ctrl-1');
            expect(result!.syncStatus).toBe('PENDING');
            expect(result!.conflictStrategy).toBe('REMOTE_WINS');
            expect(result!.version).toBe(1);
        });

        it('returns null when no row exists', async () => {
            mockIntegrationSyncMapping.findUnique.mockResolvedValue(null);

            const result = await store.findByLocalEntity('tenant-1', 'github', 'practice', 'ctrl-999');

            expect(result).toBeNull();
        });

        it('uses the correct composite unique key in where clause', async () => {
            mockIntegrationSyncMapping.findUnique.mockResolvedValue(null);

            await store.findByLocalEntity('tenant-1', 'github', 'practice', 'ctrl-1');

            expect(mockIntegrationSyncMapping.findUnique).toHaveBeenCalledWith({
                where: {
                    tenantId_provider_localEntityType_localEntityId: {
                        tenantId: 'tenant-1',
                        provider: 'github',
                        localEntityType: 'practice',
                        localEntityId: 'ctrl-1',
                    },
                },
            });
        });

        it('enforces tenant isolation via withTenantDb', async () => {
            mockIntegrationSyncMapping.findUnique.mockResolvedValue(null);

            await store.findByLocalEntity('tenant-42', 'github', 'practice', 'ctrl-1');

            expect(capturedTenantIds).toEqual(['tenant-42']);
        });
    });

    // ── findByRemoteEntity ───────────────────────────────────────────

    describe('findByRemoteEntity', () => {
        it('returns mapped SyncMapping when row exists', async () => {
            const row = makePrismaRow({ remoteEntityId: 'main' });
            mockIntegrationSyncMapping.findUnique.mockResolvedValue(row);

            const result = await store.findByRemoteEntity('tenant-1', 'github', 'branch_protection', 'main');

            expect(result).not.toBeNull();
            expect(result!.remoteEntityType).toBe('branch_protection');
            expect(result!.remoteEntityId).toBe('main');
        });

        it('returns null when no row exists', async () => {
            mockIntegrationSyncMapping.findUnique.mockResolvedValue(null);

            const result = await store.findByRemoteEntity('tenant-1', 'github', 'branch_protection', 'nonexistent');

            expect(result).toBeNull();
        });

        it('uses the correct composite unique key in where clause', async () => {
            mockIntegrationSyncMapping.findUnique.mockResolvedValue(null);

            await store.findByRemoteEntity('tenant-1', 'github', 'branch_protection', 'main');

            expect(mockIntegrationSyncMapping.findUnique).toHaveBeenCalledWith({
                where: {
                    tenantId_provider_remoteEntityType_remoteEntityId: {
                        tenantId: 'tenant-1',
                        provider: 'github',
                        remoteEntityType: 'branch_protection',
                        remoteEntityId: 'main',
                    },
                },
            });
        });

        it('enforces tenant isolation via withTenantDb', async () => {
            mockIntegrationSyncMapping.findUnique.mockResolvedValue(null);

            await store.findByRemoteEntity('tenant-99', 'github', 'branch_protection', 'main');

            expect(capturedTenantIds).toEqual(['tenant-99']);
        });
    });

    // ── findOrCreate ─────────────────────────────────────────────────

    describe('findOrCreate', () => {
        it('creates a new mapping with correct fields', async () => {
            const row = makePrismaRow({ syncStatus: 'PENDING' });
            mockIntegrationSyncMapping.upsert.mockResolvedValue(row);

            const result = await store.findOrCreate(makeKey(), { syncStatus: 'PENDING' });

            expect(result.id).toBe('sm-1');
            expect(result.syncStatus).toBe('PENDING');
            expect(result.tenantId).toBe('tenant-1');
            expect(result.provider).toBe('github');
        });

        it('passes identity from key and only syncStatus/errorMessage to create', async () => {
            const row = makePrismaRow({ syncStatus: 'FAILED' });
            mockIntegrationSyncMapping.upsert.mockResolvedValue(row);

            await store.findOrCreate(makeKey(), {
                syncStatus: 'FAILED',
                errorMessage: 'Network error',
            });

            const call = mockIntegrationSyncMapping.upsert.mock.calls[0][0];

            // Where clause uses the composite key
            expect(call.where.tenantId_provider_localEntityType_localEntityId).toEqual({
                tenantId: 'tenant-1',
                provider: 'github',
                localEntityType: 'practice',
                localEntityId: 'ctrl-1',
            });

            // Create includes key fields + narrow defaults only
            expect(call.create.tenantId).toBe('tenant-1');
            expect(call.create.provider).toBe('github');
            expect(call.create.connectionId).toBe('conn-1');
            expect(call.create.localEntityType).toBe('practice');
            expect(call.create.localEntityId).toBe('ctrl-1');
            expect(call.create.remoteEntityType).toBe('branch_protection');
            expect(call.create.remoteEntityId).toBe('main');
            expect(call.create.syncStatus).toBe('FAILED');
            expect(call.create.errorMessage).toBe('Network error');

            // Create must NOT contain control-plane fields
            expect(call.create).not.toHaveProperty('conflictStrategy');
            expect(call.create).not.toHaveProperty('version');
            expect(call.create).not.toHaveProperty('lastSyncDirection');

            // Update is empty — findOrCreate returns existing unchanged
            expect(call.update).toEqual({});
        });

        it('handles connectionId=undefined by setting null', async () => {
            const row = makePrismaRow({ connectionId: null });
            mockIntegrationSyncMapping.upsert.mockResolvedValue(row);

            await store.findOrCreate(makeKey({ connectionId: undefined }), { syncStatus: 'PENDING' });

            const call = mockIntegrationSyncMapping.upsert.mock.calls[0][0];
            expect(call.create.connectionId).toBeNull();
        });

        it('enforces tenant isolation via withTenantDb', async () => {
            mockIntegrationSyncMapping.upsert.mockResolvedValue(makePrismaRow());

            await store.findOrCreate(makeKey({ tenantId: 'tenant-7' }));

            expect(capturedTenantIds).toEqual(['tenant-7']);
        });

        it('does not pass conflictStrategy or version in create payload', async () => {
            mockIntegrationSyncMapping.upsert.mockResolvedValue(makePrismaRow());

            // Even if someone tries to sneak in extra fields via type assertion,
            // the store only reads syncStatus and errorMessage from defaults
            await store.findOrCreate(makeKey(), { syncStatus: 'PENDING' });

            const call = mockIntegrationSyncMapping.upsert.mock.calls[0][0];
            expect(call.create).not.toHaveProperty('conflictStrategy');
            expect(call.create).not.toHaveProperty('version');
            expect(call.create).not.toHaveProperty('lastSyncDirection');
            expect(call.create).not.toHaveProperty('remoteDataJson');
        });
    });

    // ── updateStatus ─────────────────────────────────────────────────

    describe('updateStatus', () => {
        it('updates status with extra fields when tenantId is provided', async () => {
            const row = makePrismaRow({ syncStatus: 'SYNCED', version: 2 });
            mockIntegrationSyncMapping.update.mockResolvedValue(row);

            const result = await store.updateStatus('sm-1', 'SYNCED', {
                tenantId: 'tenant-1',
                lastSyncDirection: 'PUSH',
                version: 2,
                lastSyncedAt: new Date('2025-01-01'),
                errorMessage: null,
            });

            expect(result.syncStatus).toBe('SYNCED');
            expect(result.version).toBe(2);
        });

        it('passes correct data to Prisma update when tenantId is present', async () => {
            mockIntegrationSyncMapping.update.mockResolvedValue(makePrismaRow());

            const syncedAt = new Date('2025-06-01');
            await store.updateStatus('sm-1', 'FAILED', {
                tenantId: 'tenant-1',
                errorMessage: 'Network timeout',
                lastSyncedAt: syncedAt,
            });

            expect(mockIntegrationSyncMapping.update).toHaveBeenCalledWith({
                where: { id: 'sm-1' },
                data: {
                    syncStatus: 'FAILED',
                    errorMessage: 'Network timeout',
                    lastSyncedAt: syncedAt,
                },
            });
        });

        it('enforces tenant isolation when tenantId is in extra', async () => {
            mockIntegrationSyncMapping.update.mockResolvedValue(makePrismaRow());

            await store.updateStatus('sm-1', 'SYNCED', { tenantId: 'tenant-5' });

            expect(capturedTenantIds).toEqual(['tenant-5']);
        });

        it('falls back to global prisma when tenantId not provided', async () => {
            const row = makePrismaRow({ syncStatus: 'CONFLICT' });
            mockIntegrationSyncMapping.update.mockResolvedValue(row);

            const result = await store.updateStatus('sm-1', 'CONFLICT', {
                errorMessage: 'Both sides modified',
            });

            // Should NOT go through withTenantDb
            expect(capturedTenantIds).toEqual([]);
            expect(result.syncStatus).toBe('CONFLICT');
        });

        it('only passes defined extra fields in data payload', async () => {
            mockIntegrationSyncMapping.update.mockResolvedValue(makePrismaRow());

            await store.updateStatus('sm-1', 'STALE', {
                tenantId: 'tenant-1',
                errorMessage: 'Remote deleted',
            });

            const call = mockIntegrationSyncMapping.update.mock.calls[0][0];
            expect(call.data.syncStatus).toBe('STALE');
            expect(call.data.errorMessage).toBe('Remote deleted');
            expect(call.data).not.toHaveProperty('lastSyncDirection');
            expect(call.data).not.toHaveProperty('version');
        });
    });

    // ── Mapping correctness ──────────────────────────────────────────

    describe('row-to-domain mapping', () => {
        it('maps all Prisma row fields to SyncMapping domain object', async () => {
            const now = new Date();
            const lastSynced = new Date('2025-03-01');
            const row = makePrismaRow({
                id: 'sm-42',
                tenantId: 'tenant-1',
                provider: 'github',
                connectionId: 'conn-5',
                localEntityType: 'practice',
                localEntityId: 'ctrl-7',
                remoteEntityType: 'branch_protection',
                remoteEntityId: 'develop',
                syncStatus: 'SYNCED',
                lastSyncDirection: 'PULL',
                conflictStrategy: 'LOCAL_WINS',
                localUpdatedAt: now,
                remoteUpdatedAt: now,
                remoteDataJson: { enabled: true },
                version: 3,
                errorMessage: null,
                lastSyncedAt: lastSynced,
                createdAt: now,
                updatedAt: now,
            });
            mockIntegrationSyncMapping.findUnique.mockResolvedValue(row);

            const result = await store.findByLocalEntity('tenant-1', 'github', 'practice', 'ctrl-7');

            expect(result).toEqual({
                id: 'sm-42',
                tenantId: 'tenant-1',
                provider: 'github',
                connectionId: 'conn-5',
                localEntityType: 'practice',
                localEntityId: 'ctrl-7',
                remoteEntityType: 'branch_protection',
                remoteEntityId: 'develop',
                syncStatus: 'SYNCED',
                lastSyncDirection: 'PULL',
                conflictStrategy: 'LOCAL_WINS',
                localUpdatedAt: now,
                remoteUpdatedAt: now,
                remoteDataJson: { enabled: true },
                version: 3,
                errorMessage: null,
                lastSyncedAt: lastSynced,
                createdAt: now,
                updatedAt: now,
            });
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Contract Parity: PrismaSyncMappingStore implements SyncMappingStore
// ═══════════════════════════════════════════════════════════════════════

describe('PrismaSyncMappingStore — interface compliance', () => {
    it('implements all SyncMappingStore methods', () => {
        const store = new PrismaSyncMappingStore();
        const iface: SyncMappingStore = store;

        expect(typeof iface.findByLocalEntity).toBe('function');
        expect(typeof iface.findByRemoteEntity).toBe('function');
        expect(typeof iface.findOrCreate).toBe('function');
        expect(typeof iface.updateStatus).toBe('function');
    });

    it('is assignable to SyncMappingStore without casts', () => {
        // This is a compile-time check: if this line compiles, the contract holds
        const store: SyncMappingStore = new PrismaSyncMappingStore();
        expect(store).toBeDefined();
    });
});
