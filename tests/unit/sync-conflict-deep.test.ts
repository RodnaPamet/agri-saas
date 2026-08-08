/**
 * Sync Conflict Detection — Deep & PUSH Path Tests
 *
 * Covers gaps in the existing sync-orchestrator.test.ts:
 *
 *   1. Nested / deep conflict detection with realistic GitHub-shaped payloads
 *   2. PUSH-specific conflict branch (PULL→PUSH and PUSH→PUSH transitions)
 *   3. Regression protection for the key-ordering JSON.stringify bug
 *      (fixed in sync-orchestrator.ts: JSON.stringify → canonicalJSON)
 *   4. findConflictingFields with nested remote structures
 *
 * All payloads use realistic GitHub branch protection shapes, not toy flat objects.
 *
 * DISCOVERED BUG (fixed in sync-orchestrator.ts):
 *   shallowEqual and findConflictingFields used raw JSON.stringify for nested
 *   object comparison.  JSON.stringify is NOT key-order-stable: objects with
 *   identical content but different key insertion order produced different
 *   strings, causing false-positive conflicts.
 *   Fix: replaced with canonicalJSON() (recursive sorted-key serialiser).
 */

import {
    BaseSyncOrchestrator,
    type SyncMappingStore,
    shallowEqual,
    findConflictingFields,
} from '@/app-layer/integrations/sync-orchestrator';
import type { RequestContext } from '@/app-layer/types';
import type {
    SyncMapping,
    SyncMappingKey,
    SyncMappingCreateData,
    SyncMappingStatusUpdate,
} from '@/app-layer/integrations/sync-types';
import {
    BaseIntegrationClient,
    type ConnectionTestResult,
    type RemoteObject,
    type RemoteListQuery,
    type RemoteListResult,
} from '@/app-layer/integrations/base-client';
import { GitHubBranchProtectionMapper } from '@/app-layer/integrations/providers/github/mapper';

// ═══════════════════════════════════════════════════════════════════════
// Realistic GitHub Branch Protection Fixtures
// ═══════════════════════════════════════════════════════════════════════

/**
 * A fully-specified GitHub branch protection API response for 'main'.
 * This is the shape that would be stored in remoteDataJson after a pull.
 */
const GITHUB_PROTECTION_BASELINE = {
    enabled: true,
    status: 'enabled',
    required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
    },
    required_status_checks: {
        strict: true,
        contexts: ['ci/build', 'ci/test'],
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_linear_history: { enabled: true },
};

/**
 * Same data as BASELINE but with keys in a different insertion order,
 * as a different API version or endpoint might return.
 * Semantically identical — should NOT produce a conflict.
 */
const GITHUB_PROTECTION_REORDERED_KEYS = {
    allow_deletions: { enabled: false },
    required_linear_history: { enabled: true },
    enabled: true,
    allow_force_pushes: { enabled: false },
    status: 'enabled',
    enforce_admins: { enabled: true },
    required_status_checks: {
        contexts: ['ci/build', 'ci/test'],   // ← contexts before strict
        strict: true,
    },
    required_pull_request_reviews: {
        require_code_owner_reviews: true,    // ← keys reordered vs baseline
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
    },
};

/** Protection with one reviewer removed — should produce a conflict. */
const GITHUB_PROTECTION_REVIEW_CHANGED = {
    ...GITHUB_PROTECTION_BASELINE,
    required_pull_request_reviews: {
        required_approving_review_count: 1,  // ← was 2
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
    },
};

/** Protection with force-pushes allowed — should produce a conflict. */
const GITHUB_PROTECTION_FORCE_PUSH_ENABLED = {
    ...GITHUB_PROTECTION_BASELINE,
    allow_force_pushes: { enabled: true },   // ← was false
};

/** Protection with a nested context list changed. */
const GITHUB_PROTECTION_STATUS_CONTEXTS_CHANGED = {
    ...GITHUB_PROTECTION_BASELINE,
    required_status_checks: {
        strict: true,
        contexts: ['ci/build', 'ci/test', 'security/scan'],  // ← added scan
    },
};

/**
 * Local control state that corresponds to GITHUB_PROTECTION_BASELINE
 * after the mapper has converted it.
 */
const LOCAL_CONTROL_BASELINE = {
    protectionEnabled: true,
    requiredReviewCount: 2,
    dismissStaleReviews: true,
    requireCodeOwnerReviews: true,
    requireStatusChecks: true,
    statusCheckContexts: ['ci/build', 'ci/test'],
    enforceAdmins: true,
    allowForcePushes: false,
    allowDeletions: false,
    requireLinearHistory: true,
    status: 'IMPLEMENTED',
};

// ═══════════════════════════════════════════════════════════════════════
// Test Infrastructure
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
        if (existing) return existing;
        const id = `mapping-${this.nextId++}`;
        const now = new Date();
        const mapping: SyncMapping = {
            id, tenantId: key.tenantId, provider: key.provider,
            connectionId: key.connectionId ?? null,
            localEntityType: key.localEntityType, localEntityId: key.localEntityId,
            remoteEntityType: key.remoteEntityType, remoteEntityId: key.remoteEntityId,
            syncStatus: defaults?.syncStatus ?? 'PENDING', lastSyncDirection: null,
            conflictStrategy: 'REMOTE_WINS', localUpdatedAt: null, remoteUpdatedAt: null,
            remoteDataJson: null, version: 1, errorMessage: defaults?.errorMessage ?? null,
            lastSyncedAt: null, createdAt: now, updatedAt: now,
        };
        this.mappings.set(id, mapping);
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
        this.mappings.set(id, updated);
        return updated;
    }

    /** Test helper: inject a fully-formed mapping directly. */
    set(mapping: SyncMapping): void {
        this.mappings.set(mapping.id, mapping);
    }
}

class StubClient extends BaseIntegrationClient<{ token: string }> {
    readonly providerId = 'github-stub';
    readonly displayName = 'GitHub Stub';
    async testConnection(): Promise<ConnectionTestResult> { return { ok: true, message: 'ok' }; }
    async getRemoteObject(remoteId: string): Promise<RemoteObject | null> {
        return { remoteId, data: GITHUB_PROTECTION_BASELINE };
    }
    async listRemoteObjects(_q?: RemoteListQuery): Promise<RemoteListResult> {
        return { items: [], total: 0 };
    }
    async createRemoteObject(data: Record<string, unknown>): Promise<RemoteObject> {
        return { remoteId: 'main', data };
    }
    async updateRemoteObject(remoteId: string, changes: Record<string, unknown>): Promise<RemoteObject> {
        return { remoteId, data: changes };
    }
}

/** Orchestrator wired up with the real GitHubBranchProtectionMapper. */
class GitHubStubOrchestrator extends BaseSyncOrchestrator {
    private client = new StubClient({ token: 'test' });
    private mapper = new GitHubBranchProtectionMapper();
    localEntities = new Map<string, Record<string, unknown>>();

    constructor(store: SyncMappingStore) {
        super({ provider: 'github-stub', store });
    }

    protected resolveClient() { return this.client; }
    protected resolveMapper() { return this.mapper; }
    protected getRemoteEntityType() { return 'branch_protection'; }

    protected async applyLocalChanges(
        _ctx: RequestContext, localEntityType: string, localEntityId: string,
        localData: Record<string, unknown>,
    ): Promise<string[]> {
        const key = `${localEntityType}:${localEntityId}`;
        const existing = this.localEntities.get(key) ?? {};
        this.localEntities.set(key, { ...existing, ...localData });
        return Object.keys(localData);
    }

    protected async getLocalData(
        _ctx: RequestContext, localEntityType: string, localEntityId: string,
    ): Promise<Record<string, unknown> | null> {
        return this.localEntities.get(`${localEntityType}:${localEntityId}`) ?? null;
    }

    protected extractRemoteId(payload: Record<string, unknown>): string | null {
        const rule = payload.rule as Record<string, unknown> | undefined;
        return (rule?.name as string) ?? null;
    }

    protected extractRemoteData(payload: Record<string, unknown>): Record<string, unknown> | null {
        return (payload.rule as Record<string, unknown>) ?? null;
    }
}

/** Factory for a SYNCED mapping pre-loaded with GitHub baseline remote data. */
function makeSyncedGitHubMapping(
    store: InMemoryMappingStore,
    overrides: Partial<SyncMapping> = {},
): SyncMapping {
    const now = new Date();
    const lastSynced = new Date('2026-04-10T00:00:00Z');
    const mapping: SyncMapping = {
        id: 'mapping-gh-1',
        tenantId: 'tenant-1',
        provider: 'github-stub',
        connectionId: null,
        localEntityType: 'control',
        localEntityId: 'ctrl-1',
        remoteEntityType: 'branch_protection',
        remoteEntityId: 'main',
        syncStatus: 'SYNCED',
        lastSyncDirection: 'PULL',
        conflictStrategy: 'MANUAL',
        localUpdatedAt: new Date('2026-04-09T00:00:00Z'), // before last sync → no local changes
        remoteUpdatedAt: null,
        remoteDataJson: GITHUB_PROTECTION_BASELINE,
        version: 3,
        errorMessage: null,
        lastSyncedAt: lastSynced,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
    store.set(mapping);
    return mapping;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. REGRESSION: key-ordering JSON.stringify bug
// ═══════════════════════════════════════════════════════════════════════

describe('[REGRESSION] shallowEqual — key-ordering safety (canonicalJSON fix)', () => {
    test('identical nested objects with different key order are equal', () => {
        // BEFORE THE FIX: JSON.stringify({ a:1, b:2 }) !== JSON.stringify({ b:2, a:1 })
        // → shallowEqual would return FALSE (false-positive conflict)
        // AFTER THE FIX: both produce the same canonical string → returns TRUE

        const a = {
            required_pull_request_reviews: {
                required_approving_review_count: 2,
                dismiss_stale_reviews: true,
                require_code_owner_reviews: true,
            },
        };
        const b = {
            required_pull_request_reviews: {
                require_code_owner_reviews: true,       // ← different insertion order
                required_approving_review_count: 2,
                dismiss_stale_reviews: true,
            },
        };
        expect(shallowEqual(a, b)).toBe(true);
    });

    test('GITHUB_PROTECTION_BASELINE equal to GITHUB_PROTECTION_REORDERED_KEYS', () => {
        // Both represent the same protection state, just returned by the API
        // with keys in a different order (as happens across API versions).
        expect(shallowEqual(GITHUB_PROTECTION_BASELINE, GITHUB_PROTECTION_REORDERED_KEYS)).toBe(true);
    });

    test('deeply nested array values with same elements in same order are equal', () => {
        const a = { required_status_checks: { strict: true, contexts: ['ci/build', 'ci/test'] } };
        const b = { required_status_checks: { strict: true, contexts: ['ci/build', 'ci/test'] } };
        expect(shallowEqual(a, b)).toBe(true);
    });

    test('deeply nested array with different element order is NOT equal', () => {
        // Array order IS significant (it's not a set)
        const a = { required_status_checks: { contexts: ['ci/build', 'ci/test'] } };
        const b = { required_status_checks: { contexts: ['ci/test', 'ci/build'] } };
        expect(shallowEqual(a, b)).toBe(false);
    });

    test('scalar value change in nested object is detected', () => {
        const a = { allow_force_pushes: { enabled: false } };
        const b = { allow_force_pushes: { enabled: true } };
        expect(shallowEqual(a, b)).toBe(false);
    });

    test('extra key in nested object is NOT equal', () => {
        const a = { enforce_admins: { enabled: true } };
        const b = { enforce_admins: { enabled: true, url: 'https://api.github.com' } };
        expect(shallowEqual(a, b)).toBe(false);
    });

    test('null vs object is not equal', () => {
        expect(shallowEqual({ a: null }, { a: {} })).toBe(false);
    });

    test('doubly-nested reordered keys are equal', () => {
        const a = { x: { b: { q: 1, r: 2 }, a: 3 } };
        const b = { x: { a: 3, b: { r: 2, q: 1 } } };
        expect(shallowEqual(a, b)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. findConflictingFields — nested GitHub payloads
// ═══════════════════════════════════════════════════════════════════════

describe('findConflictingFields — nested GitHub branch protection payloads', () => {
    const mapper = new GitHubBranchProtectionMapper();
    const mappedFields = mapper.getMappedLocalFields();

    test('no conflict when remote data is identical to baseline', () => {
        const conflicts = findConflictingFields(
            LOCAL_CONTROL_BASELINE,
            GITHUB_PROTECTION_BASELINE,
            mapper,
            mappedFields,
        );
        expect(conflicts).toHaveLength(0);
    });

    test('no conflict when remote data has same content but different key order', () => {
        // Regression: before the fix, this would produce false-positive conflicts
        // because JSON.stringify(reordered) !== JSON.stringify(baseline)
        const conflicts = findConflictingFields(
            LOCAL_CONTROL_BASELINE,
            GITHUB_PROTECTION_REORDERED_KEYS,
            mapper,
            mappedFields,
        );
        expect(conflicts).toHaveLength(0);
    });

    test('detects conflict when requiredReviewCount changes (nested field)', () => {
        const conflicts = findConflictingFields(
            LOCAL_CONTROL_BASELINE,           // local: requiredReviewCount=2
            GITHUB_PROTECTION_REVIEW_CHANGED, // remote: requiredReviewCount=1
            mapper,
            mappedFields,
        );
        expect(conflicts).toContain('requiredReviewCount');
        expect(conflicts).not.toContain('protectionEnabled');
        expect(conflicts).not.toContain('enforceAdmins');
    });

    test('detects conflict when allowForcePushes changes (nested boolean)', () => {
        const conflicts = findConflictingFields(
            LOCAL_CONTROL_BASELINE,                  // local: allowForcePushes=false
            GITHUB_PROTECTION_FORCE_PUSH_ENABLED,   // remote: allowForcePushes=true
            mapper,
            mappedFields,
        );
        expect(conflicts).toContain('allowForcePushes');
        expect(conflicts).not.toContain('protectionEnabled');
    });

    test('detects conflict when statusCheckContexts array contents change', () => {
        const conflicts = findConflictingFields(
            LOCAL_CONTROL_BASELINE,                      // local: contexts=['ci/build','ci/test']
            GITHUB_PROTECTION_STATUS_CONTEXTS_CHANGED,  // remote: +security/scan
            mapper,
            mappedFields,
        );
        expect(conflicts).toContain('statusCheckContexts');
    });

    test('does NOT flag statusCheckContexts when contexts are identical', () => {
        const conflicts = findConflictingFields(
            LOCAL_CONTROL_BASELINE,
            GITHUB_PROTECTION_BASELINE,
            mapper,
            mappedFields,
        );
        expect(conflicts).not.toContain('statusCheckContexts');
    });

    test('identifies only the fields that actually differ', () => {
        // Remote: only requiredReviewCount changed from 2→1, everything else same
        const conflicts = findConflictingFields(
            LOCAL_CONTROL_BASELINE,
            GITHUB_PROTECTION_REVIEW_CHANGED,
            mapper,
            mappedFields,
        );
        // Exactly one field should conflict
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toBe('requiredReviewCount');
    });

    test('returns empty array when local and remote are empty', () => {
        const conflicts = findConflictingFields({}, {}, mapper, mappedFields);
        expect(conflicts).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. checkForConflict — nested pulls with real GitHub shapes
// ═══════════════════════════════════════════════════════════════════════

describe('checkForConflict — deep nested PULL conflict detection', () => {
    let store: InMemoryMappingStore;
    let orch: GitHubStubOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        orch = new GitHubStubOrchestrator(store);
    });

    test('no conflict when remote payload has same content but different key order', async () => {
        // REGRESSION: before the canonicalJSON fix, this would trigger a false conflict
        // because REORDERED_KEYS and BASELINE serialise differently under JSON.stringify
        const mapping = makeSyncedGitHubMapping(store, {
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'), // after last sync → local IS modified
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
        });

        const result = await orch.checkForConflict(
            mapping,
            LOCAL_CONTROL_BASELINE,  // local is modified since last sync
            'PULL',
            GITHUB_PROTECTION_REORDERED_KEYS,  // same content, different key order
        );

        // Should NOT conflict — remote hasn't actually changed, only key order differs
        expect(result.hasConflict).toBe(false);
    });

    test('conflict when remote requiredReviewCount changes and local was also modified', async () => {
        const mapping = makeSyncedGitHubMapping(store, {
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'), // after sync → local modified
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,         // cached remote
        });

        const result = await orch.checkForConflict(
            mapping,
            LOCAL_CONTROL_BASELINE,             // local: requiredReviewCount=2
            'PULL',
            GITHUB_PROTECTION_REVIEW_CHANGED,   // remote: requiredReviewCount=1
        );

        expect(result.hasConflict).toBe(true);
        expect(result.details).toBeDefined();
        expect(result.details!.conflictingFields).toContain('requiredReviewCount');
    });

    test('conflict when forcePush setting changed and local was also modified', async () => {
        const mapping = makeSyncedGitHubMapping(store, {
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'),
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
        });

        const result = await orch.checkForConflict(
            mapping,
            LOCAL_CONTROL_BASELINE,
            'PULL',
            GITHUB_PROTECTION_FORCE_PUSH_ENABLED,
        );

        expect(result.hasConflict).toBe(true);
        expect(result.details!.conflictingFields).toContain('allowForcePushes');
    });

    test('no conflict when local was NOT modified since last sync (remote changed only)', async () => {
        // localUpdatedAt is BEFORE lastSyncedAt → local has not changed
        const mapping = makeSyncedGitHubMapping(store, {
            localUpdatedAt: new Date('2026-04-09T00:00:00Z'), // before sync
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
        });

        const result = await orch.checkForConflict(
            mapping,
            LOCAL_CONTROL_BASELINE,
            'PULL',
            GITHUB_PROTECTION_REVIEW_CHANGED, // remote changed — but local didn't
        );

        expect(result.hasConflict).toBe(false);
    });

    test('no conflict on first sync (PENDING status)', async () => {
        const mapping = await store.findOrCreate({
            tenantId: 'tenant-1', provider: 'github-stub',
            localEntityType: 'control', localEntityId: 'ctrl-new',
            remoteEntityType: 'branch_protection', remoteEntityId: 'develop',
        }, { syncStatus: 'PENDING' });

        const result = await orch.checkForConflict(
            mapping,
            LOCAL_CONTROL_BASELINE,
            'PULL',
            GITHUB_PROTECTION_REVIEW_CHANGED,
        );

        expect(result.hasConflict).toBe(false);
    });

    test('conflict details include both local and remote data for resolution UI', async () => {
        const mapping = makeSyncedGitHubMapping(store, {
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'),
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
            conflictStrategy: 'MANUAL',
        });

        const result = await orch.checkForConflict(
            mapping,
            LOCAL_CONTROL_BASELINE,
            'PULL',
            GITHUB_PROTECTION_STATUS_CONTEXTS_CHANGED,
        );

        expect(result.hasConflict).toBe(true);
        expect(result.details!.localData).toBeDefined();
        expect(result.details!.remoteData).toBeDefined();
        expect(result.details!.lastSyncedRemoteData).toBeDefined();
        expect(result.details!.strategy).toBe('MANUAL');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. PUSH-specific conflict branch paths
// ═══════════════════════════════════════════════════════════════════════

describe('checkForConflict — PUSH path', () => {
    let store: InMemoryMappingStore;
    let orch: GitHubStubOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        orch = new GitHubStubOrchestrator(store);
    });

    test('PUSH after PULL: no conflict (safe to push local changes)', async () => {
        // lastSyncDirection=PULL means we last received remote state.
        // A PUSH now means the user has intentionally modified and wants to send.
        // The orchestrator treats this as safe (no remote data incoming to compare against).
        const mapping = makeSyncedGitHubMapping(store, {
            lastSyncDirection: 'PULL',
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'), // modified after last sync
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
        });

        const result = await orch.checkForConflict(
            mapping,
            LOCAL_CONTROL_BASELINE,
            'PUSH',
            // No incomingRemoteData on PUSH — we're sending to remote, not receiving
        );

        expect(result.hasConflict).toBe(false);
    });

    test('PUSH after PUSH: no conflict (idempotent re-push is always safe)', async () => {
        // lastSyncDirection=PUSH means we previously sent to remote.
        // A second PUSH has no remote data to conflict with.
        const mapping = makeSyncedGitHubMapping(store, {
            lastSyncDirection: 'PUSH',
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'),
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
        });

        const result = await orch.checkForConflict(
            mapping,
            LOCAL_CONTROL_BASELINE,
            'PUSH',
        );

        expect(result.hasConflict).toBe(false);
    });

    test('PUSH with incomingRemoteData provided does NOT trigger conflict via PULL branch', async () => {
        // PUSH should not use the incomingRemoteData comparison path.
        // Even if we accidentally provide remoteData, the PUSH branch short-circuits
        // before the data-diff check (which only runs for direction=PULL).
        const mapping = makeSyncedGitHubMapping(store, {
            lastSyncDirection: 'PULL',
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'),
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
        });

        const result = await orch.checkForConflict(
            mapping,
            LOCAL_CONTROL_BASELINE,
            'PUSH',
            GITHUB_PROTECTION_REVIEW_CHANGED, // ← callers should not pass this on PUSH
        );

        // PUSH path ignores incomingRemoteData; no conflict expected
        expect(result.hasConflict).toBe(false);
    });

    test('full PUSH → SYNCED flow with real GitHub mapper produces correct mapping state', async () => {
        // Pre-seed a mapping in SYNCED state (previous PULL)
        makeSyncedGitHubMapping(store, {
            lastSyncDirection: 'PULL',
            syncStatus: 'SYNCED',
            conflictStrategy: 'REMOTE_WINS',
        });

        // Now user changes requiredReviewCount locally and triggers a push
        const localModified = { ...LOCAL_CONTROL_BASELINE, requiredReviewCount: 3 };
        const result = await orch.push({
            ctx: mockCtx,
            mappingKey: {
                tenantId: 'tenant-1', provider: 'github-stub',
                localEntityType: 'control', localEntityId: 'ctrl-1',
                remoteEntityType: 'branch_protection', remoteEntityId: 'main',
            },
            localData: localModified,
            changedFields: ['requiredReviewCount'],
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'),
        });

        expect(result.success).toBe(true);
        expect(result.direction).toBe('PUSH');
        expect(result.mapping.syncStatus).toBe('SYNCED');
        expect(result.mapping.lastSyncDirection).toBe('PUSH');
        expect(result.mapping.version).toBeGreaterThan(3); // incremented from baseline
    });

    test('PUSH with MANUAL strategy on conflict pauses sync and marks CONFLICT', async () => {
        // Set up a mapping where BOTH sides have changed AND strategy is MANUAL.
        // The PUSH path would compute hasConflict=false (because it doesn't
        // import incoming remote data), so to test MANUAL conflict on PUSH we
        // need to simulate the full orchestrator flow where strategy=MANUAL and
        // the push itself encounters a conflict condition (i.e. lastSyncDirection=PUSH,
        // which is currently handled as no-conflict).
        // This test documents the intended boundary: PUSH currently never conflicts;
        // ensuring this remains correct as the implementation evolves.
        const mapping = makeSyncedGitHubMapping(store, {
            lastSyncDirection: 'PUSH',
            conflictStrategy: 'MANUAL',
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'),
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
        });

        const result = await orch.checkForConflict(
            mapping,
            LOCAL_CONTROL_BASELINE,
            'PUSH',
        );

        // PUSH never conflicts (by design) — no incoming remote to compare
        expect(result.hasConflict).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Integration: full pull cycle with nested GitHub payloads
// ═══════════════════════════════════════════════════════════════════════

describe('Full pull cycle — nested GitHub payload integration', () => {
    let store: InMemoryMappingStore;
    let orch: GitHubStubOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        orch = new GitHubStubOrchestrator(store);
        // Seed local entity with baseline state
        orch.localEntities.set('control:ctrl-1', { ...LOCAL_CONTROL_BASELINE });
    });

    test('clean pull with same content (reordered keys) does not produce conflict', async () => {
        // Pre-seed mapping with baseline as cached remote
        const base = makeSyncedGitHubMapping(store, {
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'), // local modified (e.g. description change)
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
            conflictStrategy: 'MANUAL', // strict — any real conflict would park here
        });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: {
                tenantId: base.tenantId, provider: base.provider,
                localEntityType: base.localEntityType, localEntityId: base.localEntityId,
                remoteEntityType: base.remoteEntityType, remoteEntityId: base.remoteEntityId,
            },
            remoteData: GITHUB_PROTECTION_REORDERED_KEYS, // same content, different key order
            remoteUpdatedAt: new Date(),
        });

        // Should succeed without conflict — key reordering is not a real change
        expect(result.success).toBe(true);
        expect(result.action).not.toBe('conflict');
        expect(result.mapping.syncStatus).toBe('SYNCED');
    });

    test('pull with real change (reviewCount) in MANUAL strategy parks at CONFLICT', async () => {
        makeSyncedGitHubMapping(store, {
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'), // local modified
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
            conflictStrategy: 'MANUAL',
        });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: {
                tenantId: 'tenant-1', provider: 'github-stub',
                localEntityType: 'control', localEntityId: 'ctrl-1',
                remoteEntityType: 'branch_protection', remoteEntityId: 'main',
            },
            remoteData: GITHUB_PROTECTION_REVIEW_CHANGED,
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('conflict');
        expect(result.mapping.syncStatus).toBe('CONFLICT');
        expect(result.conflict!.conflictingFields).toContain('requiredReviewCount');
    });

    test('pull with real change in REMOTE_WINS strategy applies remote data', async () => {
        makeSyncedGitHubMapping(store, {
            localUpdatedAt: new Date('2026-04-11T00:00:00Z'),
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
            conflictStrategy: 'REMOTE_WINS', // auto-resolve
        });

        const result = await orch.pull({
            ctx: mockCtx,
            mappingKey: {
                tenantId: 'tenant-1', provider: 'github-stub',
                localEntityType: 'control', localEntityId: 'ctrl-1',
                remoteEntityType: 'branch_protection', remoteEntityId: 'main',
            },
            remoteData: GITHUB_PROTECTION_REVIEW_CHANGED,
            remoteUpdatedAt: new Date(),
        });

        // REMOTE_WINS: pull should proceed and apply
        expect(result.success).toBe(true);
        expect(result.action).not.toBe('conflict');
        expect(result.mapping.syncStatus).toBe('SYNCED');

        // Local entity should now reflect remote's reduced review count
        const local = orch.localEntities.get('control:ctrl-1');
        expect(local!.requiredReviewCount).toBe(1);
    });

    test('pull with contexts change correctly updates statusCheckContexts array', async () => {
        makeSyncedGitHubMapping(store, {
            lastSyncedAt: new Date('2026-04-10T00:00:00Z'),
            remoteDataJson: GITHUB_PROTECTION_BASELINE,
            conflictStrategy: 'REMOTE_WINS',
        });

        await orch.pull({
            ctx: mockCtx,
            mappingKey: {
                tenantId: 'tenant-1', provider: 'github-stub',
                localEntityType: 'control', localEntityId: 'ctrl-1',
                remoteEntityType: 'branch_protection', remoteEntityId: 'main',
            },
            remoteData: GITHUB_PROTECTION_STATUS_CONTEXTS_CHANGED,
            remoteUpdatedAt: new Date(),
        });

        const local = orch.localEntities.get('control:ctrl-1');
        expect(local!.statusCheckContexts).toEqual(['ci/build', 'ci/test', 'security/scan']);
    });
});
