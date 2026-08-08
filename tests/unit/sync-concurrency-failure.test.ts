/**
 * Sync Orchestrator — Concurrency & Pull Failure Tests
 *
 * Covers production reliability gaps not present in sync-orchestrator.test.ts:
 *
 *   1. Concurrent push + pull on the same mapping (race condition)
 *   2. Duplicate / concurrent webhook events for the same mapping
 *   3. Unique-constraint / TOCTOU race in findOrCreate (the in-memory
 *      store has a non-atomic check-then-act path; Prisma uses upsert)
 *   4. pull failure paths — mirroring push failure coverage:
 *        a) applyLocalChanges() throws after mapping is found
 *        b) mapper.toLocal() throws after mapping is found
 *        c) getLocalData() throws before conflict check
 *        d) failure during a brand-new (PENDING) pull creates mapping in FAILED state
 *        e) failure does NOT create a ghost duplicate mapping (fixes regression)
 *   5. Failure recovery — a FAILED mapping is retryable via a subsequent pull
 *
 * PRODUCTION BUG DISCOVERED AND FIXED (sync-orchestrator.ts):
 *   The pull() catch block used findByRemoteEntity to recover the mapping after
 *   a failure. When applyLocalChanges() or mapper.toLocal() threw AFTER the
 *   mapping was already found by local entity, findByRemoteEntity could miss it
 *   (different lookup key) and fall back to findOrCreate — creating a SECOND ghost
 *   FAILED mapping instead of marking the original.
 *   Fix: catch block now tries findByLocalEntity first (mirrors push), and only
 *   falls back to findByRemoteEntity for webhook-driven paths.
 *
 * @module tests/unit/sync-concurrency-failure
 */

import {
    BaseSyncOrchestrator,
    type SyncMappingStore,
    type SyncEventLogger,
} from '@/app-layer/integrations/sync-orchestrator';
import type { RequestContext } from '@/app-layer/types';
import type {
    SyncMapping,
    SyncMappingKey,
    SyncMappingCreateData,
    SyncMappingStatusUpdate,
    SyncEvent,
} from '@/app-layer/integrations/sync-types';
import {
    BaseIntegrationClient,
    type ConnectionTestResult,
    type RemoteObject,
    type RemoteListQuery,
    type RemoteListResult,
} from '@/app-layer/integrations/base-client';
import { BaseFieldMapper, type FieldMappings } from '@/app-layer/integrations/base-mapper';

// Mocks
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: jest.fn().mockResolvedValue({ id: 'mock-job' }),
}));
import { enqueue } from '@/app-layer/jobs/queue';

// ═══════════════════════════════════════════════════════════════════════
// Shared context
// ═══════════════════════════════════════════════════════════════════════

const mockCtx: RequestContext = {
    tenantId: 'tenant-1',
    userId: 'system',
    requestId: 'req-test',
    role: 'ADMIN',
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

// ═══════════════════════════════════════════════════════════════════════
// Instrumented in-memory store
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extends the basic in-memory store with:
 *   - call counters per method (for concurrency assertions)
 *   - configurable delays (to simulate async gaps)
 *   - explicit uniqueness guard (fails hard if two non-idempotent creates race)
 */
class InstrumentedMappingStore implements SyncMappingStore {
    private mappings = new Map<string, SyncMapping>();
    private nextId = 1;

    // Instrumentation
    calls = { findByLocal: 0, findByRemote: 0, findOrCreate: 0, updateStatus: 0 };

    /** Optional artificial delay (ms) injected before findOrCreate's create path */
    createDelayMs = 0;

    async findByLocalEntity(
        tenantId: string, provider: string, localEntityType: string, localEntityId: string,
    ): Promise<SyncMapping | null> {
        this.calls.findByLocal++;
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
        this.calls.findByRemote++;
        for (const m of this.mappings.values()) {
            if (m.tenantId === tenantId && m.provider === provider
                && m.remoteEntityType === remoteEntityType && m.remoteEntityId === remoteEntityId) {
                return m;
            }
        }
        return null;
    }

    async findOrCreate(key: SyncMappingKey, defaults?: SyncMappingCreateData): Promise<SyncMapping> {
        this.calls.findOrCreate++;
        const existing = await this.findByLocalEntity(
            key.tenantId, key.provider, key.localEntityType, key.localEntityId,
        );
        if (existing) return existing;

        // Simulate async gap (where a concurrent caller can slip in)
        if (this.createDelayMs > 0) {
            await new Promise(r => setTimeout(r, this.createDelayMs));
            // Re-check after delay (Prisma upsert does this atomically; we simulate)
            const race = await this.findByLocalEntity(
                key.tenantId, key.provider, key.localEntityType, key.localEntityId,
            );
            if (race) return race; // idempotent — return what the concurrent caller created
        }

        // Final guard: synchronous scan before insert to prevent TOCTOU within
        // the JS event loop (no true parallelism, but microtask interleaving can
        // cause both branches to see null, then both proceed to insert).
        for (const m of this.mappings.values()) {
            if (m.tenantId === key.tenantId && m.provider === key.provider
                && m.localEntityType === key.localEntityType && m.localEntityId === key.localEntityId) {
                return m; // idempotent
            }
        }

        const id = `mapping-${this.nextId++}`;
        const now = new Date();
        const mapping: SyncMapping = {
            id, tenantId: key.tenantId, provider: key.provider,
            connectionId: key.connectionId ?? null,
            localEntityType: key.localEntityType, localEntityId: key.localEntityId,
            remoteEntityType: key.remoteEntityType, remoteEntityId: key.remoteEntityId,
            syncStatus: defaults?.syncStatus ?? 'PENDING',
            lastSyncDirection: null, conflictStrategy: 'REMOTE_WINS',
            localUpdatedAt: null, remoteUpdatedAt: null, remoteDataJson: null,
            version: 1, errorMessage: defaults?.errorMessage ?? null,
            lastSyncedAt: null, createdAt: now, updatedAt: now,
        };
        this.mappings.set(id, mapping);
        return mapping;
    }

    async updateStatus(
        id: string, status: SyncMapping['syncStatus'], extra?: SyncMappingStatusUpdate,
    ): Promise<SyncMapping> {
        this.calls.updateStatus++;
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
        this.mappings.set(id, updated);
        return updated;
    }

    /** Test helper: inject a known mapping. */
    set(mapping: SyncMapping): void { this.mappings.set(mapping.id, mapping); }

    /** Count total mappings (for ghost-mapping detection). */
    size(): number { return this.mappings.size; }

    /** Get all mappings with a given local entity ID. */
    allByLocalId(localEntityId: string): SyncMapping[] {
        return [...this.mappings.values()].filter(m => m.localEntityId === localEntityId);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Stub client / mapper
// ═══════════════════════════════════════════════════════════════════════

class StubClient extends BaseIntegrationClient<{ token: string }> {
    readonly providerId = 'stub';
    readonly displayName = 'Stub';
    pushCallCount = 0;
    pushDelayMs = 0;

    async testConnection(): Promise<ConnectionTestResult> { return { ok: true, message: 'ok' }; }
    async getRemoteObject(id: string): Promise<RemoteObject | null> {
        return { remoteId: id, data: { id } };
    }
    async listRemoteObjects(_q?: RemoteListQuery): Promise<RemoteListResult> {
        return { items: [], total: 0 };
    }
    async createRemoteObject(data: Record<string, unknown>): Promise<RemoteObject> {
        this.pushCallCount++;
        if (this.pushDelayMs) await new Promise(r => setTimeout(r, this.pushDelayMs));
        return { remoteId: 'remote-new', data };
    }
    async updateRemoteObject(remoteId: string, changes: Record<string, unknown>): Promise<RemoteObject> {
        this.pushCallCount++;
        if (this.pushDelayMs) await new Promise(r => setTimeout(r, this.pushDelayMs));
        return { remoteId, data: changes };
    }
}

class StubMapper extends BaseFieldMapper {
    protected readonly fieldMappings: FieldMappings = {
        title: 'summary',
        status: 'status',
        priority: 'priority',
    };
    protected transformToRemote(_f: string, v: unknown) { return v; }
    protected transformToLocal(_f: string, v: unknown) { return v; }
}

/** Mapper whose toLocal() throws unconditionally */
class BrokenMapper extends BaseFieldMapper {
    protected readonly fieldMappings: FieldMappings = { title: 'summary' };
    protected transformToRemote(_f: string, v: unknown) { return v; }
    protected transformToLocal(_f: string, _v: unknown): unknown {
        throw new Error('toLocal failed: malformed remote payload');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Configurable orchestrator
// ═══════════════════════════════════════════════════════════════════════

interface OrchestratorOverrides {
    /** If set, applyLocalChanges throws with this message */
    applyLocalError?: string;
    /** If set, getLocalData throws with this message */
    getLocalDataError?: string;
    /** If set, uses BrokenMapper instead of StubMapper */
    brokenMapper?: boolean;
    /** Artificial delay (ms) in applyLocalChanges to simulate async overlap */
    applyLocalDelayMs?: number;
}

class ConfigurableOrchestrator extends BaseSyncOrchestrator {
    private client: StubClient;
    private mapper: BaseFieldMapper;
    localEntities = new Map<string, Record<string, unknown>>();
    appliedChanges: Array<{ entityId: string; data: Record<string, unknown> }> = [];
    private readonly overrides: OrchestratorOverrides;

    constructor(store: SyncMappingStore, overrides: OrchestratorOverrides = {}) {
        super({ provider: 'stub', store });
        this.overrides = overrides;
        this.client = new StubClient({ token: 'test' });
        this.mapper = overrides.brokenMapper ? new BrokenMapper() : new StubMapper();
    }

    protected resolveClient() { return this.client; }
    protected resolveMapper() { return this.mapper; }
    protected getRemoteEntityType() { return 'issue'; }

    getClientRef() { return this.client; }

    protected async applyLocalChanges(
        _ctx: RequestContext, localEntityType: string, localEntityId: string,
        localData: Record<string, unknown>,
    ): Promise<string[]> {
        if (this.overrides.applyLocalError) {
            throw new Error(this.overrides.applyLocalError);
        }
        if (this.overrides.applyLocalDelayMs) {
            await new Promise(r => setTimeout(r, this.overrides.applyLocalDelayMs));
        }
        const key = `${localEntityType}:${localEntityId}`;
        this.localEntities.set(key, { ...(this.localEntities.get(key) ?? {}), ...localData });
        this.appliedChanges.push({ entityId: localEntityId, data: localData });
        return Object.keys(localData);
    }

    protected async getLocalData(
        _ctx: RequestContext, localEntityType: string, localEntityId: string,
    ): Promise<Record<string, unknown> | null> {
        if (this.overrides.getLocalDataError) {
            throw new Error(this.overrides.getLocalDataError);
        }
        return this.localEntities.get(`${localEntityType}:${localEntityId}`) ?? null;
    }

    protected extractRemoteId(payload: Record<string, unknown>): string | null {
        return (payload.issue as Record<string, unknown>)?.key as string ?? null;
    }
    protected extractRemoteData(payload: Record<string, unknown>): Record<string, unknown> | null {
        return (payload.issue as Record<string, unknown>) ?? null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Mapping key / fixture factory
// ═══════════════════════════════════════════════════════════════════════

function makeKey(overrides?: Partial<SyncMappingKey>): SyncMappingKey {
    return {
        tenantId: 'tenant-1',
        provider: 'stub',
        localEntityType: 'control',
        localEntityId: 'ctrl-1',
        remoteEntityType: 'issue',
        remoteEntityId: 'ISSUE-1',
        ...overrides,
    };
}

function makeSyncedMapping(
    store: InstrumentedMappingStore,
    overrides: Partial<SyncMapping> = {},
): SyncMapping {
    const now = new Date();
    const mapping: SyncMapping = {
        id: 'mapping-synced-1',
        tenantId: 'tenant-1',
        provider: 'stub',
        connectionId: null,
        localEntityType: 'control',
        localEntityId: 'ctrl-1',
        remoteEntityType: 'issue',
        remoteEntityId: 'ISSUE-1',
        syncStatus: 'SYNCED',
        lastSyncDirection: 'PULL',
        conflictStrategy: 'REMOTE_WINS',
        localUpdatedAt: new Date('2026-04-01'),
        remoteUpdatedAt: null,
        remoteDataJson: { summary: 'Initial', status: 'OPEN' },
        version: 2,
        errorMessage: null,
        lastSyncedAt: new Date('2026-04-10'),
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
    store.set(mapping);
    return mapping;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Pull failure — applyLocalChanges throws
// ═══════════════════════════════════════════════════════════════════════

describe('pull() failure — applyLocalChanges throws', () => {
    test('marking mapping FAILED with the correct error message', async () => {
        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store);
        const orch = new ConfigurableOrchestrator(store, {
            applyLocalError: 'Database write failed: connection lost',
        });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'Updated', status: 'CLOSED' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('error');
        expect(result.direction).toBe('PULL');
        expect(result.errorMessage).toBe('Database write failed: connection lost');
        expect(result.mapping.syncStatus).toBe('FAILED');
        expect(result.mapping.errorMessage).toBe('Database write failed: connection lost');
    });

    test('marks the ORIGINAL mapping FAILED — does NOT create a ghost duplicate', async () => {
        // REGRESSION TEST: before the fix, the catch block used findByRemoteEntity.
        // Since the mapping was found by local key (not by remote key in the mapping
        // store at that point), findByRemoteEntity could miss it and call findOrCreate,
        // creating a second ghost FAILED mapping with a different ID.
        const store = new InstrumentedMappingStore();
        const original = makeSyncedMapping(store);
        const orch = new ConfigurableOrchestrator(store, {
            applyLocalError: 'Write failed',
        });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'X', status: 'OPEN' },
            remoteUpdatedAt: new Date(),
        });

        // Exactly ONE mapping should exist — the original, now FAILED
        expect(store.size()).toBe(1);
        expect(result.mapping.id).toBe(original.id);
        expect(result.mapping.syncStatus).toBe('FAILED');
    });

    test('FAILED mapping preserves existing identity fields', async () => {
        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store, { conflictStrategy: 'LOCAL_WINS', version: 5 });
        const orch = new ConfigurableOrchestrator(store, { applyLocalError: 'Oops' });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'Y' },
            remoteUpdatedAt: new Date(),
        });

        // updateStatus should NOT alter identity/control-plane fields
        expect(result.mapping.conflictStrategy).toBe('LOCAL_WINS');
        expect(result.mapping.localEntityId).toBe('ctrl-1');
        expect(result.mapping.provider).toBe('stub');
    });

    test('logs error sync event on applyLocalChanges failure', async () => {
        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store);
        const events: SyncEvent[] = [];
        class SpyLogger implements SyncEventLogger { log(e: SyncEvent) { events.push(e); } }
        const orch = new ConfigurableOrchestrator(store, { applyLocalError: 'fail' });
        // Inject logger via protected
        (orch as unknown as { logger: SyncEventLogger }).logger = new SpyLogger();

        await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'X' },
            remoteUpdatedAt: new Date(),
        });

        expect(events).toHaveLength(1);
        expect(events[0].direction).toBe('PULL');
        expect(events[0].action).toBe('error');
        expect(events[0].success).toBe(false);
        expect(events[0].errorDetails).toBe('fail');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Pull failure — mapper.toLocal() throws
// ═══════════════════════════════════════════════════════════════════════

describe('pull() failure — mapper.toLocal throws', () => {
    test('returns error result with correct message', async () => {
        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store);
        const orch = new ConfigurableOrchestrator(store, { brokenMapper: true });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'Will break mapper' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('error');
        expect(result.errorMessage).toContain('toLocal failed');
        expect(result.mapping.syncStatus).toBe('FAILED');
    });

    test('does NOT create a ghost duplicate mapping', async () => {
        const store = new InstrumentedMappingStore();
        const original = makeSyncedMapping(store);
        const orch = new ConfigurableOrchestrator(store, { brokenMapper: true });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: {},
            remoteUpdatedAt: new Date(),
        });

        expect(store.size()).toBe(1);
        expect(result.mapping.id).toBe(original.id);
    });

    test('mapper error during first-ever pull creates FAILED mapping (not ghost PENDING)', async () => {
        // No pre-existing mapping — this is a first pull
        const store = new InstrumentedMappingStore();
        const orch = new ConfigurableOrchestrator(store, { brokenMapper: true });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'X' },
            remoteUpdatedAt: new Date(),
        });

        // A SINGLE FAILED mapping should be created
        expect(result.success).toBe(false);
        expect(result.mapping.syncStatus).toBe('FAILED');
        expect(store.size()).toBe(1);
        expect(store.allByLocalId('ctrl-1')).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Pull failure — getLocalData throws (before conflict check)
// ═══════════════════════════════════════════════════════════════════════

describe('pull() failure — getLocalData throws', () => {
    test('error before conflict check marks mapping FAILED', async () => {
        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store);
        const orch = new ConfigurableOrchestrator(store, {
            getLocalDataError: 'Database read error',
        });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'X' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('error');
        expect(result.errorMessage).toBe('Database read error');
        expect(result.mapping.syncStatus).toBe('FAILED');
    });

    test('exactly one FAILED mapping exists — no ghost duplication', async () => {
        const store = new InstrumentedMappingStore();
        const original = makeSyncedMapping(store);
        const orch = new ConfigurableOrchestrator(store, {
            getLocalDataError: 'DB down',
        });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'X' },
            remoteUpdatedAt: new Date(),
        });

        expect(store.size()).toBe(1);
        expect(result.mapping.id).toBe(original.id);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. FAILED mapping is retryable
// ═══════════════════════════════════════════════════════════════════════

describe('pull() recovery — FAILED mapping can be retried successfully', () => {
    test('successful retry after applyLocalChanges failure recovers to SYNCED', async () => {
        const store = new InstrumentedMappingStore();
        // First attempt: fails
        const failingOrch = new ConfigurableOrchestrator(store, {
            applyLocalError: 'Temporary outage',
        });
        await failingOrch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'First attempt' },
            remoteUpdatedAt: new Date(),
        });

        // Verify FAILED state
        const afterFail = store.allByLocalId('ctrl-1');
        expect(afterFail).toHaveLength(1);
        expect(afterFail[0].syncStatus).toBe('FAILED');

        // Second attempt: succeeds
        const successOrch = new ConfigurableOrchestrator(store);
        const retryResult = await successOrch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'Retry', status: 'OPEN' },
            remoteUpdatedAt: new Date(),
        });

        expect(retryResult.success).toBe(true);
        expect(retryResult.mapping.syncStatus).toBe('SYNCED');
        expect(retryResult.mapping.errorMessage).toBeNull();
        // Should still be only ONE mapping
        expect(store.size()).toBe(1);
    });

    test('retry uses the same mapping ID — not creating a new one', async () => {
        const store = new InstrumentedMappingStore();

        // Fail first
        const failOrch = new ConfigurableOrchestrator(store, { applyLocalError: 'fail' });
        const failResult = await failOrch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'X' },
            remoteUpdatedAt: new Date(),
        });
        const failedId = failResult.mapping.id;

        // Retry
        const successOrch = new ConfigurableOrchestrator(store);
        const retryResult = await successOrch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'Fixed' },
            remoteUpdatedAt: new Date(),
        });

        // Same mapping object — ID is preserved
        expect(retryResult.mapping.id).toBe(failedId);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Parity: push failure vs pull failure assertions
// ═══════════════════════════════════════════════════════════════════════

describe('push/pull failure parity', () => {
    test('push failure: updateRemoteObject throws → marks FAILED', async () => {
        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store);
        const orch = new ConfigurableOrchestrator(store);
        orch.getClientRef().updateRemoteObject = async () => {
            throw new Error('Remote API unavailable');
        };

        const result = await orch.push({
            ctx: mockCtx,
            mappingKey: makeKey(),
            localData: { title: 'X', status: 'OPEN' },
            changedFields: ['title'],
            localUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('error');
        expect(result.mapping.syncStatus).toBe('FAILED');
        expect(result.errorMessage).toBe('Remote API unavailable');
    });

    test('pull failure: applyLocalChanges throws → same shape as push failure', async () => {
        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store);
        const orch = new ConfigurableOrchestrator(store, {
            applyLocalError: 'Remote API unavailable',
        });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'X', status: 'OPEN' },
            remoteUpdatedAt: new Date(),
        });

        // Exact same shape assertions as the push failure test above
        expect(result.success).toBe(false);
        expect(result.action).toBe('error');
        expect(result.mapping.syncStatus).toBe('FAILED');
        expect(result.errorMessage).toBe('Remote API unavailable');
    });

    test('push failure: non-Error thrown → string coercion in errorMessage', async () => {
        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store);
        const orch = new ConfigurableOrchestrator(store);
        orch.getClientRef().updateRemoteObject = async () => { throw 'string error'; };

        const result = await orch.push({
            ctx: mockCtx,
            mappingKey: makeKey(),
            localData: { title: 'X' },
            changedFields: ['title'],
            localUpdatedAt: new Date(),
        });

        expect(result.errorMessage).toBe('string error');
    });

    test('pull failure: non-Error thrown → string coercion in errorMessage', async () => {
        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store);
        // Override applyLocalChanges to throw a non-Error
        const orch = new ConfigurableOrchestrator(store);
        (orch as unknown as { applyLocalChanges: () => Promise<never> }).applyLocalChanges =
            async () => { throw 'string pull error'; };

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'X' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.errorMessage).toBe('string pull error');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Concurrency — concurrent push + pull on the same mapping
// ═══════════════════════════════════════════════════════════════════════

describe('concurrency — concurrent push + pull on same mapping', () => {
    test('both complete without throwing — last writer determines final state', async () => {
        // Simulate: a PUSH is triggered by a user action while a webhook-driven
        // PULL arrives for the same mapping in the same event-loop window.
        //
        // We use a controlled Promise resolution to interleave them deterministically:
        //   - Both start (findByLocalEntity returns the same SYNCED mapping)
        //   - Push client delay allows pull's updateStatus to land first
        //   - Push's updateStatus lands second
        // Expected: both complete, final state is the PUSH's SYNCED (last write wins).

        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store);

        const pushOrch = new ConfigurableOrchestrator(store);
        pushOrch.getClientRef().pushDelayMs = 10; // push client takes 10ms

        const pullOrch = new ConfigurableOrchestrator(store);

        // Fire both concurrently
        const [pushResult, pullResult] = await Promise.all([
            pushOrch.push({
                ctx: mockCtx,
                mappingKey: makeKey(),
                localData: { title: 'Push update', status: 'CLOSED' },
                changedFields: ['title', 'status'],
                localUpdatedAt: new Date(),
            }),
            pullOrch.pull({
                ctx: mockCtx,
                mappingKey: makeKey(),
                remoteData: { summary: 'Pull update', status: 'OPEN' },
                remoteUpdatedAt: new Date(),
            }),
        ]);

        // Both must complete (no uncaught exceptions)
        expect(pushResult.success).toBe(true);
        expect(pullResult.success).toBe(true);

        // Final mapping state in store must be SYNCED (not CONFLICT/FAILED)
        const finalMappings = store.allByLocalId('ctrl-1');
        expect(finalMappings).toHaveLength(1);
        expect(finalMappings[0].syncStatus).toBe('SYNCED');
    });

    test('concurrent push + failing pull — push completes, pull marks FAILED', async () => {
        const store = new InstrumentedMappingStore();
        makeSyncedMapping(store);

        const pushOrch = new ConfigurableOrchestrator(store);
        const failingPullOrch = new ConfigurableOrchestrator(store, {
            applyLocalError: 'Concurrent failure',
        });

        const [pushResult, pullResult] = await Promise.all([
            pushOrch.push({
                ctx: mockCtx,
                mappingKey: makeKey(),
                localData: { title: 'Good push' },
                changedFields: ['title'],
                localUpdatedAt: new Date(),
            }),
            failingPullOrch.pull({
                ctx: mockCtx,
                mappingKey: makeKey(),
                remoteData: { summary: 'Bad pull' },
                remoteUpdatedAt: new Date(),
            }),
        ]);

        expect(pushResult.success).toBe(true);
        expect(pullResult.success).toBe(false);
        expect(pullResult.action).toBe('error');

        // Exactly ONE mapping, no ghost
        expect(store.size()).toBe(1);
    });

    test('concurrent push + pull — no ghost mappings created', async () => {
        const store = new InstrumentedMappingStore();
        // No pre-existing mapping — both must race on the first findOrCreate
        // One will create, the other will find (idempotent per our store design)

        const orch1 = new ConfigurableOrchestrator(store);
        const orch2 = new ConfigurableOrchestrator(store);

        await Promise.all([
            orch1.push({
                ctx: mockCtx,
                mappingKey: makeKey(),
                localData: { title: 'X', status: 'OPEN' },
                changedFields: ['title'],
                localUpdatedAt: new Date(),
            }),
            orch2.pull({
                ctx: mockCtx,
                mappingKey: makeKey(),
                remoteData: { summary: 'X', status: 'OPEN' },
                remoteUpdatedAt: new Date(),
            }),
        ]);

        // Must be exactly 1 mapping regardless of race outcome
        expect(store.allByLocalId('ctrl-1')).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Concurrency — duplicate webhook events for same mapping
// ═══════════════════════════════════════════════════════════════════════

describe('concurrency — duplicate webhook events for same mapping', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    async function setupSyncedMappingWithWebhook(store: InstrumentedMappingStore) {
        const base = makeSyncedMapping(store, {
            lastSyncDirection: 'PULL',
            syncStatus: 'SYNCED',
        });
        return base;
    }

    test('two identical webhook events → both queued with identical deduplication jobId', async () => {
        // Simulates: GitHub fires the same branch_protection_rule.edited event twice
        const store = new InstrumentedMappingStore();
        await setupSyncedMappingWithWebhook(store);

        const orch = new ConfigurableOrchestrator(store);
        const webhookPayload = { issue: { key: 'ISSUE-1', summary: 'Duplicate event', status: 'OPEN' } };

        const [r1, r2] = await Promise.all([
            orch.handleWebhookEvent({
                ctx: mockCtx, provider: 'stub', eventType: 'updated',
                payload: webhookPayload,
            }),
            orch.handleWebhookEvent({
                ctx: mockCtx, provider: 'stub', eventType: 'updated',
                payload: webhookPayload,
            }),
        ]);

        expect(r1.processed).toBe(true);
        expect(r2.processed).toBe(true);
        expect(r1.syncCount).toBe(1);

        // They both fire enqueue with the exact same jobId for deduplication
        expect(enqueue).toHaveBeenCalledTimes(2);
        
        const firstCallJobId = (enqueue as jest.Mock).mock.calls[0][2].jobId;
        const secondCallJobId = (enqueue as jest.Mock).mock.calls[1][2].jobId;
        
        expect(firstCallJobId).toBe('sync-pull:tenant-1:stub:issue:ISSUE-1');
        expect(secondCallJobId).toBe('sync-pull:tenant-1:stub:issue:ISSUE-1');
    });

    test('webhook event queues pull job with correct payload structure', async () => {
        const store = new InstrumentedMappingStore();
        await setupSyncedMappingWithWebhook(store);

        const orch1 = new ConfigurableOrchestrator(store);

        await orch1.handleWebhookEvent({
            ctx: mockCtx, provider: 'stub', eventType: 'updated',
            payload: { issue: { key: 'ISSUE-1', summary: 'First', status: 'OPEN' } },
        });

        expect(enqueue).toHaveBeenCalledTimes(1);
        const [jobName, payload] = (enqueue as jest.Mock).mock.calls[0];

        expect(jobName).toBe('sync-pull');
        expect(payload.mappingKey.remoteEntityId).toBe('ISSUE-1');
        expect(payload.remoteData.summary).toBe('First');
        expect(payload.ctx.tenantId).toBe('tenant-1');
        // Needs timestamp ISO string
        expect(Date.parse(payload.remoteUpdatedAtIso)).not.toBeNaN();
    });

    test('webhook event for unknown remote ID → not processed, no job queued', async () => {
        const store = new InstrumentedMappingStore();
        // No mapping in store

        const orch = new ConfigurableOrchestrator(store);
        const result = await orch.handleWebhookEvent({
            ctx: mockCtx, provider: 'stub', eventType: 'updated',
            payload: { issue: { key: 'NONEXISTENT-99', summary: 'Ghost' } },
        });

        expect(result.processed).toBe(false);
        expect(result.reason).toContain('No mapping found');
        expect(enqueue).not.toHaveBeenCalled();
    });

    test('deleted webhook event directly marks mapping as STALE without queuing job', async () => {
        const store = new InstrumentedMappingStore();
        await setupSyncedMappingWithWebhook(store);

        const orch = new ConfigurableOrchestrator(store);
        const result = await orch.handleWebhookEvent({
            ctx: mockCtx, provider: 'stub', eventType: 'deleted',
            payload: { issue: { key: 'ISSUE-1' } },
        });

        expect(result.processed).toBe(true);
        expect(enqueue).not.toHaveBeenCalled();
        const mapping = store.allByLocalId('ctrl-1')[0];
        expect(mapping.syncStatus).toBe('STALE');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. Unique-constraint / findOrCreate race semantics
// ═══════════════════════════════════════════════════════════════════════

describe('findOrCreate — uniqueness / race handling', () => {
    test('concurrent calls for same key return the same mapping ID', async () => {
        const store = new InstrumentedMappingStore();
        // Enable a small delay to make the TOCTOU window observable
        store.createDelayMs = 5;

        const key = makeKey();

        // Fire two concurrent findOrCreate calls with the same key
        const [m1, m2] = await Promise.all([
            store.findOrCreate(key, { syncStatus: 'PENDING' }),
            store.findOrCreate(key, { syncStatus: 'PENDING' }),
        ]);

        // Both should return the SAME mapping
        expect(m1.id).toBe(m2.id);
        // Only one mapping in the store
        expect(store.allByLocalId('ctrl-1')).toHaveLength(1);
    });

    test('findOrCreate after concurrent create does not duplicate', async () => {
        const store = new InstrumentedMappingStore();
        const key = makeKey();

        // Create once
        await store.findOrCreate(key, { syncStatus: 'PENDING' });

        // Try again — should return existing
        const second = await store.findOrCreate(key, { syncStatus: 'SYNCED' });

        expect(store.size()).toBe(1);
        // findOrCreate returns EXISTING without overwriting status
        expect(second.syncStatus).toBe('PENDING');
    });

    test('findOrCreate with different tenantId creates separate mappings', async () => {
        const store = new InstrumentedMappingStore();

        await store.findOrCreate(makeKey({ tenantId: 'tenant-A' }));
        await store.findOrCreate(makeKey({ tenantId: 'tenant-B' }));

        // Two distinct mappings — tenant isolation preserved
        expect(store.size()).toBe(2);
    });

    test('findOrCreate with different localEntityId creates separate mappings', async () => {
        const store = new InstrumentedMappingStore();

        await store.findOrCreate(makeKey({ localEntityId: 'ctrl-1' }));
        await store.findOrCreate(makeKey({ localEntityId: 'ctrl-2' }));

        expect(store.size()).toBe(2);
    });

    test('Prisma upsert race-condition shape: findOrCreate with delay returns idempotent result', async () => {
        // This test proves that our store's re-check after delay (simulating
        // Prisma's upsert atomic guarantee) correctly returns the winner's result.
        const store = new InstrumentedMappingStore();
        store.createDelayMs = 15; // race window

        const key = makeKey();

        // Three concurrent calls — only one should create, others should find
        const [a, b, c] = await Promise.all([
            store.findOrCreate(key),
            store.findOrCreate(key),
            store.findOrCreate(key),
        ]);

        expect(a.id).toBe(b.id);
        expect(b.id).toBe(c.id);
        expect(store.allByLocalId('ctrl-1')).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. updateStatus on non-existent mapping ID
// ═══════════════════════════════════════════════════════════════════════

describe('updateStatus — missing mapping guard', () => {
    test('throws when mapping ID does not exist', async () => {
        const store = new InstrumentedMappingStore();
        await expect(
            store.updateStatus('nonexistent-id', 'FAILED', { errorMessage: 'test' })
        ).rejects.toThrow('Mapping nonexistent-id not found');
    });

    test('orchestrator pull failure does not call updateStatus on non-existent ID', async () => {
        // When the FIRST pull ever fails (no pre-existing mapping), the flow is:
        //   try block: findOrCreate creates a PENDING mapping
        //   mapper.toLocal throws
        //   catch: findByLocalEntity finds the PENDING mapping (by local key)
        //   catch: calls updateStatus → marks it FAILED
        // The critical invariant is that updateStatus is called on the KNOWN mapping ID,
        // NOT on a non-existent ID (which would throw P2025 in Prisma).
        const store = new InstrumentedMappingStore();
        const orch = new ConfigurableOrchestrator(store, { brokenMapper: true });

        // Use non-empty remoteData so transformToLocal is actually called and throws
        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'data that triggers transformToLocal' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.mapping.syncStatus).toBe('FAILED');
        expect(store.allByLocalId('ctrl-1')).toHaveLength(1);
        // updateStatus called exactly once — on the mapping created by findOrCreate,
        // NOT on a non-existent ID (which would throw and crash the catch block)
        expect(store.calls.updateStatus).toBe(1);
        // The mapping that was updated is the same one we get back
        expect(result.mapping.id).toBe(store.allByLocalId('ctrl-1')[0].id);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. Pull failure from fresh PENDING state (no prior remoteDataJson)
// ═══════════════════════════════════════════════════════════════════════

describe('pull failure on first-ever sync (PENDING → FAILED)', () => {
    test('failure on truly first pull → creates FAILED mapping with correct status', async () => {
        const store = new InstrumentedMappingStore();
        // Manually create a PENDING mapping (as if findOrCreate was called earlier)
        store.set({
            id: 'pending-1',
            tenantId: 'tenant-1', provider: 'stub',
            connectionId: null,
            localEntityType: 'control', localEntityId: 'ctrl-1',
            remoteEntityType: 'issue', remoteEntityId: 'ISSUE-1',
            syncStatus: 'PENDING', lastSyncDirection: null,
            conflictStrategy: 'REMOTE_WINS',
            localUpdatedAt: null, remoteUpdatedAt: null, remoteDataJson: null,
            version: 1, errorMessage: null, lastSyncedAt: null,
            createdAt: new Date(), updatedAt: new Date(),
        });

        const orch = new ConfigurableOrchestrator(store, { applyLocalError: 'Write failed on first pull' });
        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'First pull attempt' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('error');
        expect(result.mapping.id).toBe('pending-1');            // same mapping
        expect(result.mapping.syncStatus).toBe('FAILED');
        expect(result.mapping.errorMessage).toBe('Write failed on first pull');
        expect(store.size()).toBe(1);                           // no ghost
    });

    test('action is "error" (not "created") when pull fails on first sync', async () => {
        // The success path would return action='created' for a first pull.
        // Failure should consistently return action='error', not 'created'.
        const store = new InstrumentedMappingStore();
        const orch = new ConfigurableOrchestrator(store, { brokenMapper: true });

        // Use non-empty remoteData to ensure transformToLocal is invoked and throws
        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: makeKey(),
            remoteData: { summary: 'trigger mapper' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.action).toBe('error');
        // NOT 'created'
        expect(result.action).not.toBe('created');
    });
});
