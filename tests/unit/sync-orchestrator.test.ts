/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Sync Orchestrator Tests
 *
 * Covers:
 *   1. In-memory sync mapping store (persistence)
 *   2. Conflict detection (updated_at comparison + data diffing)
 *   3. remote_wins resolution
 *   4. local_wins resolution
 *   5. manual conflict result
 *   6. Push flow (local → remote)
 *   7. Pull flow (remote → local)
 *   8. Webhook-triggered pull entrypoint
 *   9. Error handling
 */
import {
    BaseSyncOrchestrator,
    type SyncMappingStore,
    type SyncEventLogger,
    shallowEqual,
    findConflictingFields,
} from '@/app-layer/integrations/sync-orchestrator';
import type { RequestContext } from '@/app-layer/types';
import type {
    SyncMapping,
    SyncMappingKey,
    SyncMappingCreateData,
    SyncMappingStatusUpdate,
    SyncEvent,
    ConflictStrategy,
} from '@/app-layer/integrations/sync-types';
import {
    BaseIntegrationClient,
    type ConnectionTestResult,
    type RemoteObject,
    type RemoteListQuery,
    type RemoteListResult,
} from '@/app-layer/integrations/base-client';
import { BaseFieldMapper, type FieldMappings } from '@/app-layer/integrations/base-mapper';

// ═══════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════

// Mocks
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: jest.fn().mockResolvedValue({ id: 'mock-job' }),
}));
import { enqueue } from '@/app-layer/jobs/queue';
import type { Role } from '@prisma/client';

export const mockCtx: RequestContext = {
    tenantId: 'tenant-1',
    userId: 'system',
    requestId: 'req-1',
    role: 'ADMIN' as Role,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: {
        controls: { view: true, create: true, edit: true },
        evidence: { view: true, upload: true, edit: true, download: true },
        policies: { view: true, create: true, edit: true, approve: true },
        tasks: { view: true, create: true, edit: true, assign: true },
        vendors: { view: true, create: true, edit: true },
        tests: { view: true, create: true, execute: true },
        frameworks: { view: true, install: true },
        audits: { view: true, manage: true, freeze: true, share: true },
        reports: { view: true, export: true },
        admin: { view: true, manage: true, members: true, sso: true, scim: true, tenant_lifecycle: true, owner_management: true },
    },
};

// ── In-Memory Sync Mapping Store ──

class InMemoryMappingStore implements SyncMappingStore {
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
        if (existing) {
            // findOrCreate returns existing unchanged
            return existing;
        }

        const id = `mapping-${this.nextId++}`;
        const now = new Date();
        const mapping: SyncMapping = {
            id,
            tenantId: key.tenantId,
            provider: key.provider,
            connectionId: key.connectionId ?? null,
            localEntityType: key.localEntityType,
            localEntityId: key.localEntityId,
            remoteEntityType: key.remoteEntityType,
            remoteEntityId: key.remoteEntityId,
            syncStatus: defaults?.syncStatus ?? 'PENDING',
            lastSyncDirection: null,
            conflictStrategy: 'REMOTE_WINS',
            localUpdatedAt: null,
            remoteUpdatedAt: null,
            remoteDataJson: null,
            version: 1,
            errorMessage: defaults?.errorMessage ?? null,
            lastSyncedAt: null,
            createdAt: now,
            updatedAt: now,
        };
        this.mappings.set(id, mapping);
        return mapping;
    }

    async updateStatus(
        id: string, status: SyncMapping['syncStatus'], extra?: SyncMappingStatusUpdate,
    ): Promise<SyncMapping> {
        const existing = this.mappings.get(id);
        if (!existing) throw new Error(`Mapping ${id} not found`);
        const updated: SyncMapping = {
            ...existing,
            syncStatus: status,
            updatedAt: new Date(),
        };
        // Apply only the narrowly-typed operational fields
        if (extra?.lastSyncDirection !== undefined) updated.lastSyncDirection = extra.lastSyncDirection;
        if (extra?.localUpdatedAt !== undefined) updated.localUpdatedAt = extra.localUpdatedAt;
        if (extra?.remoteUpdatedAt !== undefined) updated.remoteUpdatedAt = extra.remoteUpdatedAt;
        if (extra?.remoteDataJson !== undefined) updated.remoteDataJson = extra.remoteDataJson;
        if (extra?.lastSyncedAt !== undefined) updated.lastSyncedAt = extra.lastSyncedAt;
        if (extra?.version !== undefined) updated.version = extra.version;
        if (extra?.errorMessage !== undefined) updated.errorMessage = extra.errorMessage;
        // conflictStrategy intentionally NOT writable here
        this.mappings.set(id, updated);
        return updated;
    }

    // Test helper
    setMapping(mapping: SyncMapping): void {
        this.mappings.set(mapping.id, mapping);
    }
}

// ── Stub Client ──

class StubClient extends BaseIntegrationClient<{ token: string }> {
    readonly providerId = 'stub';
    readonly displayName = 'Stub';
    lastPushed: { remoteId: string; changes: Record<string, unknown> } | null = null;

    async testConnection(): Promise<ConnectionTestResult> { return { ok: true, message: 'ok' }; }
    async getRemoteObject(remoteId: string): Promise<RemoteObject | null> {
        return { remoteId, data: { id: remoteId } };
    }
    async listRemoteObjects(_q?: RemoteListQuery): Promise<RemoteListResult> {
        return { items: [], total: 0 };
    }
    async createRemoteObject(data: Record<string, unknown>): Promise<RemoteObject> {
        this.lastPushed = { remoteId: 'remote-new', changes: data };
        return { remoteId: 'remote-new', data };
    }
    async updateRemoteObject(remoteId: string, changes: Record<string, unknown>): Promise<RemoteObject> {
        this.lastPushed = { remoteId, changes };
        return { remoteId, data: changes };
    }
}

// ── Stub Mapper ──

class StubMapper extends BaseFieldMapper {
    protected readonly fieldMappings: FieldMappings = {
        title: 'summary',
        status: 'status',
        priority: 'priority',
    };
    protected transformToRemote(_f: string, v: unknown) { return v; }
    protected transformToLocal(_f: string, v: unknown) { return v; }
}

// ── Stub Orchestrator ──

class StubOrchestrator extends BaseSyncOrchestrator {
    private client: StubClient;
    private mapper: StubMapper;
    localEntities = new Map<string, Record<string, unknown>>();
    appliedChanges: Array<{ type: string; id: string; data: Record<string, unknown> }> = [];

    constructor(store: SyncMappingStore, logger?: SyncEventLogger, strategy?: ConflictStrategy) {
        super({ provider: 'stub', store, logger });
        this.client = new StubClient({ token: 'test' });
        this.mapper = new StubMapper();
    }

    protected resolveClient() { return this.client; }
    protected resolveMapper() { return this.mapper; }
    protected getRemoteEntityType() { return 'issue'; }

    getStubClient() { return this.client; }

    protected async applyLocalChanges(
        _ctx: RequestContext, localEntityType: string, localEntityId: string,
        localData: Record<string, unknown>,
    ): Promise<string[]> {
        const key = `${localEntityType}:${localEntityId}`;
        const existing = this.localEntities.get(key) ?? {};
        this.localEntities.set(key, { ...existing, ...localData });
        this.appliedChanges.push({ type: localEntityType, id: localEntityId, data: localData });
        return Object.keys(localData);
    }

    protected async getLocalData(
        _ctx: RequestContext, localEntityType: string, localEntityId: string,
    ): Promise<Record<string, unknown> | null> {
        return this.localEntities.get(`${localEntityType}:${localEntityId}`) ?? null;
    }

    protected extractRemoteId(payload: Record<string, unknown>): string | null {
        return (payload.issue as Record<string, unknown>)?.key as string ?? null;
    }

    protected extractRemoteData(payload: Record<string, unknown>): Record<string, unknown> | null {
        return (payload.issue as Record<string, unknown>) ?? null;
    }
}

// ── Event Logger Spy ──

class SpyEventLogger implements SyncEventLogger {
    events: SyncEvent[] = [];
    log(event: SyncEvent) { this.events.push(event); }
}

// ─── Helpers ──

function makeMappingKey(overrides?: Partial<SyncMappingKey>): SyncMappingKey {
    return {
        tenantId: 'tenant-1',
        provider: 'stub',
        localEntityType: 'task',
        localEntityId: 'task-1',
        remoteEntityType: 'issue',
        remoteEntityId: 'PROJ-1',
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe('In-Memory Sync Mapping Store', () => {
    let store: InMemoryMappingStore;

    beforeEach(() => { store = new InMemoryMappingStore(); });

    test('findOrCreate creates a new mapping', async () => {
        const mapping = await store.findOrCreate(makeMappingKey(), { syncStatus: 'PENDING' });
        expect(mapping.id).toBeDefined();
        expect(mapping.tenantId).toBe('tenant-1');
        expect(mapping.provider).toBe('stub');
        expect(mapping.syncStatus).toBe('PENDING');
    });

    test('findOrCreate returns existing unchanged', async () => {
        const first = await store.findOrCreate(makeMappingKey(), { syncStatus: 'PENDING' });
        const second = await store.findOrCreate(makeMappingKey(), { syncStatus: 'SYNCED' });
        expect(second.id).toBe(first.id);
        // findOrCreate does NOT overwrite existing — returns as-is
        expect(second.syncStatus).toBe('PENDING');
    });

    test('findByLocalEntity returns match', async () => {
        await store.findOrCreate(makeMappingKey());
        const found = await store.findByLocalEntity('tenant-1', 'stub', 'task', 'task-1');
        expect(found).not.toBeNull();
        expect(found!.localEntityId).toBe('task-1');
    });

    test('findByRemoteEntity returns match', async () => {
        await store.findOrCreate(makeMappingKey());
        const found = await store.findByRemoteEntity('tenant-1', 'stub', 'issue', 'PROJ-1');
        expect(found).not.toBeNull();
        expect(found!.remoteEntityId).toBe('PROJ-1');
    });

    test('updateStatus changes status and extras', async () => {
        const mapping = await store.findOrCreate(makeMappingKey());
        const updated = await store.updateStatus(mapping.id, 'FAILED', { errorMessage: 'timeout' });
        expect(updated.syncStatus).toBe('FAILED');
        expect(updated.errorMessage).toBe('timeout');
    });
});

describe('Push flow (local → remote)', () => {
    let store: InMemoryMappingStore;
    let logger: SpyEventLogger;
    let orch: StubOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        logger = new SpyEventLogger();
        orch = new StubOrchestrator(store, logger);
    });

    test('push creates mapping and marks SYNCED', async () => {
        const result = await orch.push({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            localData: { title: 'Fix bug', status: 'OPEN' },
            changedFields: ['title'],
            localUpdatedAt: new Date(),
        });

        expect(result.success).toBe(true);
        expect(result.direction).toBe('PUSH');
        expect(result.mapping.syncStatus).toBe('SYNCED');
        expect(result.mapping.lastSyncDirection).toBe('PUSH');
    });

    test('push sends mapped partial data to client', async () => {
        await orch.push({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            localData: { title: 'Fix bug', status: 'OPEN', priority: 'HIGH' },
            changedFields: ['title'],
            localUpdatedAt: new Date(),
        });

        const client = orch.getStubClient();
        expect(client.lastPushed).not.toBeNull();
        expect(client.lastPushed!.changes).toEqual({ summary: 'Fix bug' });
    });

    test('push logs a sync event', async () => {
        await orch.push({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            localData: { title: 'X' },
            changedFields: ['title'],
            localUpdatedAt: new Date(),
        });

        expect(logger.events).toHaveLength(1);
        expect(logger.events[0].direction).toBe('PUSH');
        expect(logger.events[0].success).toBe(true);
    });

    test('push increments version', async () => {
        const r1 = await orch.push({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            localData: { title: 'V1' },
            changedFields: ['title'],
            localUpdatedAt: new Date(),
        });
        expect(r1.mapping.version).toBe(2); // initial 1 + 1

        const r2 = await orch.push({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            localData: { title: 'V2' },
            changedFields: ['title'],
            localUpdatedAt: new Date(),
        });
        expect(r2.mapping.version).toBe(3);
    });
});

describe('Pull flow (remote → local)', () => {
    let store: InMemoryMappingStore;
    let logger: SpyEventLogger;
    let orch: StubOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        logger = new SpyEventLogger();
        orch = new StubOrchestrator(store, logger);
    });

    test('pull applies mapped remote data to local entity', async () => {
        const result = await orch.pull({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            remoteData: { summary: 'Remote title', status: 'Done' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(true);
        expect(result.direction).toBe('PULL');
        expect(result.mapping.syncStatus).toBe('SYNCED');
        expect(result.mapping.lastSyncDirection).toBe('PULL');

        // Verify local entity was updated via applyLocalChanges
        expect(orch.appliedChanges).toHaveLength(1);
        expect(orch.appliedChanges[0].data).toEqual({
            title: 'Remote title',
            status: 'Done',
        });
    });

    test('pull stores remote data for future conflict detection', async () => {
        const remoteData = { summary: 'Title', status: 'Open' };
        const result = await orch.pull({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            remoteData,
            remoteUpdatedAt: new Date(),
        });

        expect(result.mapping.remoteDataJson).toEqual(remoteData);
    });
});

describe('Conflict detection', () => {
    let store: InMemoryMappingStore;
    let orch: StubOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        orch = new StubOrchestrator(store);
    });

    test('no conflict on first sync (PENDING status)', async () => {
        const mapping = await store.findOrCreate(makeMappingKey(), { syncStatus: 'PENDING' });
        const result = await orch.checkForConflict(
            mapping,
            { title: 'Local' },
            'PULL',
            { summary: 'Remote' },
        );
        expect(result.hasConflict).toBe(false);
    });

    test('no conflict when only remote changed (local not modified)', async () => {
        const lastSynced = new Date('2024-01-01');
        const base = await store.findOrCreate(makeMappingKey());
        const mapping = await store.updateStatus(base.id, 'SYNCED', {
            lastSyncedAt: lastSynced,
            localUpdatedAt: new Date('2023-12-31'), // BEFORE last sync
            remoteDataJson: { summary: 'Old' },
        });

        const result = await orch.checkForConflict(
            mapping,
            { title: 'Same' },
            'PULL',
            { summary: 'New remote' },
        );
        expect(result.hasConflict).toBe(false);
    });

    test('conflict when both local and remote changed since last sync', async () => {
        const lastSynced = new Date('2024-01-01');
        const base = await store.findOrCreate(makeMappingKey());
        const mapping = await store.updateStatus(base.id, 'SYNCED', {
            lastSyncedAt: lastSynced,
            localUpdatedAt: new Date('2024-01-02'), // AFTER last sync
            remoteDataJson: { summary: 'Old remote', status: 'Open' },
        });

        const result = await orch.checkForConflict(
            mapping,
            { title: 'Changed local', status: 'CLOSED' },
            'PULL',
            { summary: 'Changed remote', status: 'Done' }, // Different from cached
        );
        expect(result.hasConflict).toBe(true);
        expect(result.details).toBeDefined();
        expect(result.details!.reason).toContain('Both local and remote');
        expect(result.details!.conflictingFields.length).toBeGreaterThan(0);
    });
});

describe('Conflict resolution: remote_wins', () => {
    let store: InMemoryMappingStore;
    let orch: StubOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        orch = new StubOrchestrator(store);
    });

    test('remote_wins strategy during pull applies remote data', async () => {
        // Set up a synced mapping with local changes and REMOTE_WINS strategy
        const lastSynced = new Date('2024-01-01');
        const now = new Date();
        const key = makeMappingKey();
        store.setMapping({
            id: 'conflict-rw-1', tenantId: key.tenantId, provider: key.provider,
            connectionId: null, localEntityType: key.localEntityType, localEntityId: key.localEntityId,
            remoteEntityType: key.remoteEntityType, remoteEntityId: key.remoteEntityId,
            syncStatus: 'SYNCED', lastSyncDirection: 'PULL',
            conflictStrategy: 'REMOTE_WINS',
            lastSyncedAt: lastSynced, localUpdatedAt: new Date('2024-01-02'),
            remoteUpdatedAt: null, remoteDataJson: { summary: 'Old', status: 'Open' },
            version: 1, errorMessage: null, createdAt: now, updatedAt: now,
        });

        // Set local data
        orch.localEntities.set('task:task-1', { title: 'Local changed', status: 'IN_PROGRESS' });

        const result = await orch.pull({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            remoteData: { summary: 'Remote changed', status: 'Done' },
            remoteUpdatedAt: new Date('2024-01-03'),
        });

        // remote_wins: pull should succeed, applying remote data
        expect(result.success).toBe(true);
        expect(result.action).not.toBe('conflict');
        expect(orch.appliedChanges.length).toBeGreaterThan(0);
    });
});

describe('Conflict resolution: local_wins', () => {
    let store: InMemoryMappingStore;
    let orch: StubOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        orch = new StubOrchestrator(store);
    });

    test('local_wins strategy during pull skips applying remote data', async () => {
        const lastSynced = new Date('2024-01-01');
        const now = new Date();
        const key = makeMappingKey();
        store.setMapping({
            id: 'conflict-lw-1', tenantId: key.tenantId, provider: key.provider,
            connectionId: null, localEntityType: key.localEntityType, localEntityId: key.localEntityId,
            remoteEntityType: key.remoteEntityType, remoteEntityId: key.remoteEntityId,
            syncStatus: 'SYNCED', lastSyncDirection: 'PULL',
            conflictStrategy: 'LOCAL_WINS',
            lastSyncedAt: lastSynced, localUpdatedAt: new Date('2024-01-02'),
            remoteUpdatedAt: null, remoteDataJson: { summary: 'Old', status: 'Open' },
            version: 1, errorMessage: null, createdAt: now, updatedAt: now,
        });

        orch.localEntities.set('task:task-1', { title: 'Local changed', status: 'IN_PROGRESS' });

        const result = await orch.pull({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            remoteData: { summary: 'Remote changed', status: 'Done' },
            remoteUpdatedAt: new Date('2024-01-03'),
        });

        expect(result.success).toBe(true);
        expect(result.action).toBe('skipped');
        expect(orch.appliedChanges).toHaveLength(0); // Nothing applied to local
    });
});

describe('Conflict resolution: manual', () => {
    let store: InMemoryMappingStore;
    let orch: StubOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        orch = new StubOrchestrator(store);
    });

    test('manual strategy returns conflict status without applying', async () => {
        const lastSynced = new Date('2024-01-01');
        const now = new Date();
        const key = makeMappingKey();
        store.setMapping({
            id: 'conflict-m-1', tenantId: key.tenantId, provider: key.provider,
            connectionId: null, localEntityType: key.localEntityType, localEntityId: key.localEntityId,
            remoteEntityType: key.remoteEntityType, remoteEntityId: key.remoteEntityId,
            syncStatus: 'SYNCED', lastSyncDirection: 'PULL',
            conflictStrategy: 'MANUAL',
            lastSyncedAt: lastSynced, localUpdatedAt: new Date('2024-01-02'),
            remoteUpdatedAt: null, remoteDataJson: { summary: 'Old', status: 'Open' },
            version: 1, errorMessage: null, createdAt: now, updatedAt: now,
        });

        orch.localEntities.set('task:task-1', { title: 'Local changed', status: 'IN_PROGRESS' });

        const result = await orch.pull({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            remoteData: { summary: 'Remote changed', status: 'Done' },
            remoteUpdatedAt: new Date('2024-01-03'),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('conflict');
        expect(result.mapping.syncStatus).toBe('CONFLICT');
        expect(result.conflict).toBeDefined();
        expect(result.conflict!.strategy).toBe('MANUAL');
        expect(orch.appliedChanges).toHaveLength(0);
    });
});

describe('Webhook-triggered pull', () => {
    let store: InMemoryMappingStore;
    let logger: SpyEventLogger;
    let orch: StubOrchestrator;

    beforeEach(async () => {
        store = new InMemoryMappingStore();
        logger = new SpyEventLogger();
        orch = new StubOrchestrator(store, logger);

        // Pre-create a mapping for the remote entity
        const base = await store.findOrCreate({
            tenantId: 'tenant-1',
            provider: 'stub',
            localEntityType: 'task',
            localEntityId: 'task-1',
            remoteEntityType: 'issue',
            remoteEntityId: 'PROJ-1',
        });
        await store.updateStatus(base.id, 'SYNCED');
    });

    test('webhook triggers pull and applies changes', async () => {
        const result = await orch.handleWebhookEvent({ ctx: mockCtx,
            provider: 'stub',
            eventType: 'updated',
            payload: { issue: { key: 'PROJ-1', summary: 'Webhook title', status: 'In Progress' } },
            
        });

        expect(result.processed).toBe(true);
        expect(result.syncCount).toBe(1);
        expect(enqueue).toHaveBeenCalled();
    });

    test('webhook returns not processed for unknown remote ID', async () => {
        const result = await orch.handleWebhookEvent({ ctx: mockCtx,
            provider: 'stub',
            eventType: 'updated',
            payload: { issue: { key: 'UNKNOWN-99', summary: 'X' } },
            
        });

        expect(result.processed).toBe(false);
        expect(result.reason).toContain('No mapping found');
    });

    test('webhook handles missing remote ID in payload', async () => {
        const result = await orch.handleWebhookEvent({ ctx: mockCtx,
            provider: 'stub',
            eventType: 'updated',
            payload: { noIssue: true },
            
        });

        expect(result.processed).toBe(false);
        expect(result.reason).toContain('Could not extract remote ID');
    });

    test('webhook handles deletion events', async () => {
        const result = await orch.handleWebhookEvent({ ctx: mockCtx,
            provider: 'stub',
            eventType: 'deleted',
            payload: { issue: { key: 'PROJ-1' } },
            
        });

        expect(result.processed).toBe(true);
        const mapping = await store.findByRemoteEntity('tenant-1', 'stub', 'issue', 'PROJ-1');
        expect(mapping!.syncStatus).toBe('STALE');
    });
});

describe('Error handling', () => {
    test('push handles client errors gracefully', async () => {
        const store = new InMemoryMappingStore();
        const orch = new StubOrchestrator(store);

        // Make the client throw
        const client = orch.getStubClient();
        client.updateRemoteObject = async () => { throw new Error('Network timeout'); };
        client.createRemoteObject = async () => { throw new Error('Network timeout'); };

        const result = await orch.push({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            localData: { title: 'X' },
            changedFields: ['title'],
            localUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('error');
        expect(result.errorMessage).toContain('Network timeout');
        expect(result.mapping.syncStatus).toBe('FAILED');
    });
});

describe('Utility functions', () => {
    test('shallowEqual returns true for identical objects', () => {
        expect(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
    });

    test('shallowEqual returns false for different objects', () => {
        expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
        expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    test('findConflictingFields identifies differing mapped fields', () => {
        const mapper = new StubMapper();
        const conflicts = findConflictingFields(
            { title: 'Local', status: 'OPEN', priority: 'HIGH' },
            { summary: 'Remote', status: 'Done', priority: 'HIGH' },
            mapper,
            ['title', 'status', 'priority'],
        );
        // title and status differ; priority is the same
        expect(conflicts).toContain('title');
        expect(conflicts).toContain('status');
        expect(conflicts).not.toContain('priority');
    });
});

describe('Utility functions — deep equality', () => {
    test('shallowEqual handles nested objects (deep comparison)', () => {
        const a = { top: 'same', nested: { count: 2, strict: true } };
        const b = { top: 'same', nested: { count: 2, strict: true } };
        expect(shallowEqual(a, b)).toBe(true);
    });

    test('shallowEqual detects nested differences', () => {
        const a = { nested: { count: 2 } };
        const b = { nested: { count: 3 } };
        expect(shallowEqual(a, b)).toBe(false);
    });

    test('shallowEqual handles arrays in values', () => {
        const a = { contexts: ['ci', 'lint'] };
        const b = { contexts: ['ci', 'lint'] };
        expect(shallowEqual(a, b)).toBe(true);

        const c = { contexts: ['ci'] };
        expect(shallowEqual(a, c)).toBe(false);
    });

    test('shallowEqual handles null vs object', () => {
        expect(shallowEqual({ a: null }, { a: null })).toBe(true);
        expect(shallowEqual({ a: null }, { a: {} })).toBe(false);
    });

    test('shallowEqual returns true for reference equality', () => {
        const obj = { a: 1, b: { c: 2 } };
        expect(shallowEqual(obj, obj)).toBe(true);
    });

    test('findConflictingFields handles nested remote data', () => {
        // Simulate GitHub-like nested protection data:
        // mapper maps 'status' <-> 'status', 'priority' <-> 'priority'
        const mapper = new StubMapper();
        const conflicts = findConflictingFields(
            { title: 'Same', status: 'OPEN', priority: 'HIGH' },
            { summary: 'Same', status: 'OPEN', priority: 'LOW' },
            mapper,
            ['title', 'status', 'priority'],
        );
        // title maps to summary='Same', which maps back to title='Same' — no conflict
        expect(conflicts).not.toContain('title');
        // status is same — no conflict
        expect(conflicts).not.toContain('status');
        // priority changed
        expect(conflicts).toContain('priority');
    });
});

describe('Push conflict detection', () => {
    let store: InMemoryMappingStore;
    let orch: StubOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        orch = new StubOrchestrator(store);
    });

    test('no conflict on PUSH when last direction was PULL', async () => {
        const base = await store.findOrCreate(makeMappingKey());
        const mapping = await store.updateStatus(base.id, 'SYNCED', {
            lastSyncedAt: new Date('2024-01-01'),
            lastSyncDirection: 'PULL',
            localUpdatedAt: new Date('2024-01-02'),
        });

        const result = await orch.checkForConflict(
            mapping,
            { title: 'Changed after pull' },
            'PUSH',
        );
        expect(result.hasConflict).toBe(false);
    });

    test('no conflict on PUSH when last direction was PUSH (no remote data)', async () => {
        const base = await store.findOrCreate(makeMappingKey());
        const mapping = await store.updateStatus(base.id, 'SYNCED', {
            lastSyncedAt: new Date('2024-01-01'),
            lastSyncDirection: 'PUSH',
            localUpdatedAt: new Date('2024-01-02'),
        });

        const result = await orch.checkForConflict(
            mapping,
            { title: 'Another push' },
            'PUSH',
        );
        // No incoming remote data on a push, so no conflict possible
        expect(result.hasConflict).toBe(false);
    });

    test('push with REMOTE_WINS conflict skips pushing', async () => {
        // Create a SYNCED mapping with both sides changed
        const lastSynced = new Date('2024-01-01');
        const now = new Date();
        const key = makeMappingKey();
        store.setMapping({
            id: 'push-rw-1', tenantId: key.tenantId, provider: key.provider,
            connectionId: null, localEntityType: key.localEntityType, localEntityId: key.localEntityId,
            remoteEntityType: key.remoteEntityType, remoteEntityId: key.remoteEntityId,
            syncStatus: 'SYNCED', lastSyncDirection: 'PUSH',
            conflictStrategy: 'REMOTE_WINS',
            lastSyncedAt: lastSynced, localUpdatedAt: new Date('2024-01-02'),
            remoteUpdatedAt: null, remoteDataJson: { summary: 'Old', status: 'Open' },
            version: 1, errorMessage: null, createdAt: now, updatedAt: now,
        });

        // Push should succeed (no incoming remote data to compare against)
        const result = await orch.push({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            localData: { title: 'New local', status: 'DONE' },
            changedFields: ['title', 'status'],
            localUpdatedAt: new Date('2024-01-02'),
        });

        expect(result.success).toBe(true);
    });
});

describe('Pull error handling', () => {
    test('pull handles applyLocalChanges failure gracefully', async () => {
        const store = new InMemoryMappingStore();
        const orch = new StubOrchestrator(store);

        // Override applyLocalChanges to throw
        (orch as any).applyLocalChanges = async () => {
            throw new Error('Database write failed');
        };

        const result = await orch.pull({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            remoteData: { summary: 'Remote title', status: 'Open' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('error');
        expect(result.errorMessage).toContain('Database write failed');
        expect(result.mapping.syncStatus).toBe('FAILED');
    });

    test('pull handles mapper failure gracefully', async () => {
        const store = new InMemoryMappingStore();
        const orch = new StubOrchestrator(store);

        // Override getMapper to return a broken mapper
        (orch as any).getMapper = () => ({
            toLocal: () => { throw new Error('Mapping error'); },
            getMappedLocalFields: () => ['title'],
        });

        const result = await orch.pull({ ctx: mockCtx,
            mappingKey: makeMappingKey(),
            remoteData: { summary: 'X' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('error');
        expect(result.errorMessage).toContain('Mapping error');
    });
});

describe('Webhook audit logging', () => {
    test('webhook deletion logs with triggeredBy webhook', async () => {
        const store = new InMemoryMappingStore();
        const logger = new SpyEventLogger();
        const orch = new StubOrchestrator(store, logger);

        const base = await store.findOrCreate({
            tenantId: 'tenant-1',
            provider: 'stub',
            localEntityType: 'task', localEntityId: 'task-1',
            remoteEntityType: 'issue', remoteEntityId: 'PROJ-1',
        });
        await store.updateStatus(base.id, 'SYNCED');

        await orch.handleWebhookEvent({ ctx: mockCtx,
            provider: 'stub',
            eventType: 'deleted',
            payload: { issue: { key: 'PROJ-1' } },
            
        });

        expect(logger.events).toHaveLength(1);
        expect(logger.events[0].triggeredBy).toBe('webhook');
        expect(logger.events[0].direction).toBe('PULL');
    });
});

describe('Orchestrator instance caching', () => {
    class CountingOrchestrator extends BaseSyncOrchestrator {
        clientResolves = 0;
        mapperResolves = 0;
        
        protected resolveClient(): BaseIntegrationClient {
            this.clientResolves++;
            return new StubClient({ token: 'cached' });
        }
        protected resolveMapper(): BaseFieldMapper {
            this.mapperResolves++;
            return new StubMapper();
        }
        protected getRemoteEntityType() { return 'test'; }
        protected extractRemoteId() { return null; }
        protected extractRemoteData() { return null; }
        protected async applyLocalChanges() { return []; }
        protected async getLocalData() { return null; }

        // Expose protected methods for testing
        public testGetClient() { return this.getClient(); }
        public testGetMapper() { return this.getMapper(); }
    }

    test('mapper and client resolve exactly once per operation instance', () => {
        const store = new InMemoryMappingStore();
        const orch = new CountingOrchestrator({ provider: 'test', store });

        // First calls trigger resolution
        orch.testGetClient();
        orch.testGetMapper();
        expect(orch.clientResolves).toBe(1);
        expect(orch.mapperResolves).toBe(1);

        // Subsequent calls use cached values on the same instance
        orch.testGetClient();
        orch.testGetClient();
        orch.testGetMapper();
        
        // Count should not increment
        expect(orch.clientResolves).toBe(1);
        expect(orch.mapperResolves).toBe(1);
    });

    test('caching does not cross-contaminate orchestrator instances', () => {
        const store = new InMemoryMappingStore();
        
        const orchA = new CountingOrchestrator({ provider: 'test', store });
        const orchB = new CountingOrchestrator({ provider: 'test', store });

        orchA.testGetClient();
        expect(orchA.clientResolves).toBe(1);
        expect(orchB.clientResolves).toBe(0);

        orchB.testGetClient();
        expect(orchB.clientResolves).toBe(1);
    });
});
