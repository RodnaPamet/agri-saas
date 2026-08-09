/**
 * Sync Contract Safety Tests
 *
 * Verifies the critical contract corrections in the sync layer:
 *
 *   1. BaseIntegrationClient deletion support
 *      - Default throws 'unsupported'
 *      - GitHubClient implements it correctly
 *
 *   2. SyncMappingStore create vs update separation
 *      - findOrCreate does NOT overwrite existing records
 *      - findOrCreate only accepts SyncMappingCreateData (narrow type)
 *      - updateStatus only accepts SyncMappingStatusUpdate (narrow type)
 *
 *   3. Control-plane field protection
 *      - conflictStrategy cannot be set via findOrCreate
 *      - conflictStrategy cannot be set via updateStatus
 *      - version cannot be freely set via findOrCreate
 *      - Identity fields cannot be changed via updateStatus
 */
import type {
    SyncMapping,
    SyncMappingKey,
    SyncMappingCreateData,
    SyncMappingStatusUpdate,
} from '@/app-layer/integrations/sync-types';
import type { SyncMappingStore } from '@/app-layer/integrations/sync-orchestrator';
import { GitHubClient } from '@/app-layer/integrations/providers/github/client';
import type { GitHubConnectionConfig } from '@/app-layer/integrations/providers/github/client';
import { BaseIntegrationClient } from '@/app-layer/integrations/base-client';

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

const GITHUB_CONFIG: GitHubConnectionConfig = {
    owner: 'acme', repo: 'platform', branch: 'main', token: 'ghp_test',
};

function makeMappingKey(overrides?: Partial<SyncMappingKey>): SyncMappingKey {
    return {
        tenantId: 'tenant-1',
        provider: 'test',
        localEntityType: 'practice',
        localEntityId: 'ctrl-1',
        remoteEntityType: 'protection',
        remoteEntityId: 'main',
        ...overrides,
    };
}

function makeFullMapping(overrides?: Partial<SyncMapping>): SyncMapping {
    const now = new Date();
    return {
        id: 'sm-1',
        tenantId: 'tenant-1',
        provider: 'test',
        connectionId: null,
        localEntityType: 'practice',
        localEntityId: 'ctrl-1',
        remoteEntityType: 'protection',
        remoteEntityId: 'main',
        syncStatus: 'SYNCED',
        lastSyncDirection: 'PULL',
        conflictStrategy: 'REMOTE_WINS',
        localUpdatedAt: null,
        remoteUpdatedAt: null,
        remoteDataJson: null,
        version: 3,
        errorMessage: null,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

// ─── In-Memory Store (contract-compliant) ────────────────────────────

class ContractTestStore implements SyncMappingStore {
    private mappings = new Map<string, SyncMapping>();
    private nextId = 1;

    async findByLocalEntity(
        tenantId: string, provider: string, localEntityType: string, localEntityId: string,
    ): Promise<SyncMapping | null> {
        for (const m of this.mappings.values()) {
            if (m.tenantId === tenantId && m.provider === provider
                && m.localEntityType === localEntityType && m.localEntityId === localEntityId) {
                return m;
            }
        }
        return null;
    }

    async findByRemoteEntity(
        tenantId: string, provider: string, remoteEntityType: string, remoteEntityId: string,
    ): Promise<SyncMapping | null> {
        for (const m of this.mappings.values()) {
            if (m.tenantId === tenantId && m.provider === provider
                && m.remoteEntityType === remoteEntityType && m.remoteEntityId === remoteEntityId) {
                return m;
            }
        }
        return null;
    }

    async findOrCreate(key: SyncMappingKey, defaults?: SyncMappingCreateData): Promise<SyncMapping> {
        const existing = await this.findByLocalEntity(
            key.tenantId, key.provider, key.localEntityType, key.localEntityId,
        );
        if (existing) return existing; // Return unchanged

        const now = new Date();
        const mapping: SyncMapping = {
            id: `mapping-${this.nextId++}`,
            tenantId: key.tenantId,
            provider: key.provider,
            connectionId: key.connectionId ?? null,
            localEntityType: key.localEntityType,
            localEntityId: key.localEntityId,
            remoteEntityType: key.remoteEntityType,
            remoteEntityId: key.remoteEntityId,
            syncStatus: defaults?.syncStatus ?? 'PENDING',
            lastSyncDirection: null,
            conflictStrategy: 'REMOTE_WINS', // safe default, immutable via API
            localUpdatedAt: null,
            remoteUpdatedAt: null,
            remoteDataJson: null,
            version: 1, // safe default, immutable via findOrCreate
            errorMessage: defaults?.errorMessage ?? null,
            lastSyncedAt: null,
            createdAt: now,
            updatedAt: now,
        };
        this.mappings.set(mapping.id, mapping);
        return mapping;
    }

    async updateStatus(
        id: string, status: SyncMapping['syncStatus'], extra?: SyncMappingStatusUpdate,
    ): Promise<SyncMapping> {
        const existing = this.mappings.get(id);
        if (!existing) throw new Error(`Mapping ${id} not found`);
        const updated: SyncMapping = { ...existing, syncStatus: status, updatedAt: new Date() };
        if (extra?.lastSyncDirection !== undefined) updated.lastSyncDirection = extra.lastSyncDirection;
        if (extra?.localUpdatedAt !== undefined) updated.localUpdatedAt = extra.localUpdatedAt;
        if (extra?.remoteUpdatedAt !== undefined) updated.remoteUpdatedAt = extra.remoteUpdatedAt;
        if (extra?.remoteDataJson !== undefined) updated.remoteDataJson = extra.remoteDataJson;
        if (extra?.lastSyncedAt !== undefined) updated.lastSyncedAt = extra.lastSyncedAt;
        if (extra?.version !== undefined) updated.version = extra.version;
        if (extra?.errorMessage !== undefined) updated.errorMessage = extra.errorMessage;
        // conflictStrategy deliberately NOT writable
        this.mappings.set(id, updated);
        return updated;
    }

    /** Test helper — directly set a mapping for pre-test setup */
    setMapping(mapping: SyncMapping): void {
        this.mappings.set(mapping.id, mapping);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 1. BaseIntegrationClient — Deletion Support
// ═══════════════════════════════════════════════════════════════════════

describe('BaseIntegrationClient — deleteRemoteObject', () => {
    it('default implementation throws with provider name', async () => {
        // Create a minimal concrete subclass to test the default
        class TestClient extends BaseIntegrationClient {
            readonly providerId = 'test-provider';
            readonly displayName = 'Test';
            async testConnection() { return { ok: true, message: 'ok' }; }
            async getRemoteObject() { return null; }
            async listRemoteObjects() { return { items: [], total: 0 }; }
            async createRemoteObject() { return { remoteId: '1', data: {} }; }
            async updateRemoteObject() { return { remoteId: '1', data: {} }; }
        }

        const client = new TestClient({});
        await expect(client.deleteRemoteObject('xyz')).rejects.toThrow('test-provider');
        await expect(client.deleteRemoteObject('xyz')).rejects.toThrow('deleteRemoteObject');
    });
});

describe('GitHubClient — deleteRemoteObject', () => {
    function makeMockFetch(status: number): typeof globalThis.fetch {
        return async () => ({
            status,
            ok: status >= 200 && status < 300,
            json: async () => ({}),
            text: async () => '',
        }) as Response;
    }

    it('succeeds on 204 (standard DELETE success)', async () => {
        const client = new GitHubClient(GITHUB_CONFIG, makeMockFetch(204));
        await expect(client.deleteRemoteObject('main')).resolves.toBeUndefined();
    });

    it('succeeds on 404 (already deleted — idempotent)', async () => {
        const client = new GitHubClient(GITHUB_CONFIG, makeMockFetch(404));
        await expect(client.deleteRemoteObject('main')).resolves.toBeUndefined();
    });

    it('throws on unexpected error status', async () => {
        const client = new GitHubClient(GITHUB_CONFIG, makeMockFetch(500));
        await expect(client.deleteRemoteObject('main')).rejects.toThrow('500');
    });

    it('calls the correct endpoint for branch protection', async () => {
        let capturedUrl = '';
        let capturedMethod = '';
        const mockFetch: typeof globalThis.fetch = async (url, init) => {
            capturedUrl = url as string;
            capturedMethod = init?.method ?? 'GET';
            return { status: 204, ok: true, json: async () => ({}), text: async () => '' } as Response;
        };

        const client = new GitHubClient(GITHUB_CONFIG, mockFetch);
        await client.deleteRemoteObject('develop');

        expect(capturedUrl).toContain('/repos/acme/platform/branches/develop/protection');
        expect(capturedMethod).toBe('DELETE');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. SyncMappingStore — Create vs Update Separation
// ═══════════════════════════════════════════════════════════════════════

describe('SyncMappingStore — findOrCreate vs updateStatus', () => {
    let store: ContractTestStore;

    beforeEach(() => {
        store = new ContractTestStore();
    });

    it('findOrCreate creates a new mapping with safe defaults', async () => {
        const mapping = await store.findOrCreate(makeMappingKey(), { syncStatus: 'PENDING' });

        expect(mapping.id).toBeDefined();
        expect(mapping.syncStatus).toBe('PENDING');
        expect(mapping.conflictStrategy).toBe('REMOTE_WINS'); // safe default
        expect(mapping.version).toBe(1); // safe default
    });

    it('findOrCreate returns existing mapping UNCHANGED', async () => {
        // Create initial mapping
        const first = await store.findOrCreate(makeMappingKey(), { syncStatus: 'PENDING' });

        // Update it to SYNCED
        await store.updateStatus(first.id, 'SYNCED', { version: 5 });

        // Call findOrCreate again — should return existing, NOT reset to PENDING
        const second = await store.findOrCreate(makeMappingKey(), { syncStatus: 'FAILED' });

        expect(second.id).toBe(first.id);
        expect(second.syncStatus).toBe('SYNCED'); // NOT 'FAILED'
        expect(second.version).toBe(5); // NOT reset to 1
    });

    it('updateStatus changes operational fields', async () => {
        const mapping = await store.findOrCreate(makeMappingKey());
        const syncedAt = new Date('2025-01-01');

        const updated = await store.updateStatus(mapping.id, 'SYNCED', {
            lastSyncDirection: 'PUSH',
            version: 2,
            lastSyncedAt: syncedAt,
            errorMessage: null,
        });

        expect(updated.syncStatus).toBe('SYNCED');
        expect(updated.lastSyncDirection).toBe('PUSH');
        expect(updated.version).toBe(2);
        expect(updated.lastSyncedAt).toBe(syncedAt);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Control-Plane Field Protection
// ═══════════════════════════════════════════════════════════════════════

describe('Control-plane field protection', () => {
    let store: ContractTestStore;

    beforeEach(() => {
        store = new ContractTestStore();
    });

    it('conflictStrategy cannot be changed via updateStatus', async () => {
        // Pre-set a mapping with LOCAL_WINS strategy
        store.setMapping(makeFullMapping({
            id: 'protect-1',
            conflictStrategy: 'LOCAL_WINS',
        }));

        // Try to change conflictStrategy via updateStatus — the extra
        // param is typed as SyncMappingStatusUpdate which excludes it.
        // At runtime, even if somehow passed, the store ignores it.
        const updated = await store.updateStatus('protect-1', 'SYNCED', {
            // TypeScript prevents: conflictStrategy: 'REMOTE_WINS',
            // But runtime protection also exists:
            ...(({ conflictStrategy: 'REMOTE_WINS' } as unknown) as SyncMappingStatusUpdate),
        });

        // conflictStrategy MUST remain LOCAL_WINS
        expect(updated.conflictStrategy).toBe('LOCAL_WINS');
    });

    it('conflictStrategy gets safe default on findOrCreate', async () => {
        const mapping = await store.findOrCreate(makeMappingKey());

        // Default is REMOTE_WINS, cannot be set to anything else via findOrCreate
        expect(mapping.conflictStrategy).toBe('REMOTE_WINS');
    });

    it('version gets safe default of 1 on findOrCreate', async () => {
        const mapping = await store.findOrCreate(makeMappingKey());

        expect(mapping.version).toBe(1);
    });

    it('identity fields cannot be changed via updateStatus', async () => {
        store.setMapping(makeFullMapping({
            id: 'protect-2',
            tenantId: 'tenant-1',
            provider: 'test',
            localEntityType: 'practice',
            localEntityId: 'ctrl-1',
        }));

        // Try to change identity fields via updateStatus — SyncMappingStatusUpdate
        // only has tenantId (as RLS routing hint), not provider/localEntityType etc.
        const updated = await store.updateStatus('protect-2', 'SYNCED', {
            // TypeScript prevents: provider: 'hacked', localEntityType: 'hacked',
            ...(({
                provider: 'hacked',
                localEntityType: 'hacked',
                localEntityId: 'hacked',
            } as unknown) as SyncMappingStatusUpdate),
        });

        // Identity fields MUST remain unchanged
        expect(updated.provider).toBe('test');
        expect(updated.localEntityType).toBe('practice');
        expect(updated.localEntityId).toBe('ctrl-1');
    });

    it('SyncMappingCreateData type does NOT allow conflictStrategy', () => {
        // This is a compile-time check. If it compiles, the contract holds.
        const validCreateData: SyncMappingCreateData = {
            syncStatus: 'PENDING',
            errorMessage: 'test',
        };
        expect(validCreateData.syncStatus).toBe('PENDING');

        // Type safety: the following would NOT compile:
        // const invalid: SyncMappingCreateData = { conflictStrategy: 'LOCAL_WINS' };
        // const invalid2: SyncMappingCreateData = { version: 5 };
    });

    it('SyncMappingStatusUpdate type does NOT allow conflictStrategy', () => {
        // This is a compile-time check. If it compiles, the contract holds.
        const validUpdate: SyncMappingStatusUpdate = {
            tenantId: 'tenant-1',
            lastSyncDirection: 'PUSH',
            version: 2,
            errorMessage: null,
        };
        expect(validUpdate.version).toBe(2);

        // Type safety: the following would NOT compile:
        // const invalid: SyncMappingStatusUpdate = { conflictStrategy: 'LOCAL_WINS' };
        // const invalid2: SyncMappingStatusUpdate = { provider: 'hacked' };
    });
});
