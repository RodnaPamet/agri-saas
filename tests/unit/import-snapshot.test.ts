/**
 * Import Snapshot — Pre-Import Backup & Disaster Recovery Tests
 *
 * Tests:
 *   1. Create: exports tenant data, serializes, writes to storage
 *   2. Create: snapshot record contains all required metadata
 *   3. Create: supports gzip compression (default on)
 *   4. Create: supports uncompressed mode
 *   5. Read: deserializes snapshot from storage back to envelope
 *   6. Delete: removes snapshot from storage
 *   7. Pruning: retains newest N snapshots, deletes oldest
 *   8. Pruning: no-op when under retention limit
 *   9. Pruning: handles delete failures gracefully
 *  10. Roundtrip: create → read produces same envelope
 *  11. Utilities: generateSnapshotId format
 */

import { Readable } from 'stream';
import {
    createPreImportSnapshot,
    readSnapshot,
    deleteSnapshot,
    pruneSnapshots,
    generateSnapshotId,
    MAX_SNAPSHOTS_PER_TENANT,
    type SnapshotRecord,
} from '../../src/app-layer/services/import-snapshot';
import type { StorageProvider } from '../../src/lib/storage/types';
import type { ExportEnvelope } from '../../src/app-layer/services/export-schemas';

// ─── Mock Dependencies ──────────────────────────────────────────────

// Mock export service — configured lazily in beforeEach to avoid hoisting issues
jest.mock('../../src/app-layer/services/export-service', () => ({
    exportTenantData: jest.fn(),
}));

jest.mock('@/lib/db-context', () => ({
    withTenantDb: jest.fn(async (_tenantId: string, cb: (tx: unknown) => Promise<unknown>) => {
        return cb({});
    }),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        child: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }),
    },
}));

// Import after mocks are set up
import { exportTenantData } from '../../src/app-layer/services/export-service';

// Build deterministic mock data (referenced after imports are resolved)
const MOCK_ENVELOPE: ExportEnvelope = {
    formatVersion: '1.0',
    metadata: {
        tenantId: 'tenant-1',
        exportedAt: '2026-04-17T00:00:00.000Z',
        domains: ['FULL_TENANT'],
        app: 'inflect-compliance',
        appVersion: '0.0.0',
    },
    entities: {
        practice: [
            { entityType: 'practice' as const, id: 'ctrl-1', schemaVersion: '1.0', data: { id: 'ctrl-1', name: 'Firewall' } },
        ],
    },
    relationships: [],
    checksum: 'abc123',
};

const mockExportResult = {
    envelope: MOCK_ENVELOPE,
    stats: {
        entityCount: 1,
        relationshipCount: 0,
        domains: ['FULL_TENANT' as const],
        durationMs: 10,
    },
};

// ─── Storage Mock ───────────────────────────────────────────────────

let lastWrittenData: Buffer | null = null;

function makeStorage(overrides: Partial<StorageProvider> = {}): StorageProvider {
    return {
        name: 'local',
        write: jest.fn().mockImplementation(async (_key: string, data: Buffer) => {
            lastWrittenData = data;
            return { sha256: 'mock-hash', sizeBytes: data.length };
        }),
        readStream: jest.fn().mockImplementation(() => {
            if (!lastWrittenData) throw new Error('No data written yet');
            return Readable.from(lastWrittenData);
        }),
        createSignedDownloadUrl: jest.fn(),
        createSignedUploadUrl: jest.fn(),
        head: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
        copy: jest.fn(),
        ...overrides,
    } as unknown as StorageProvider;
}

function makeSnapshot(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
    return {
        snapshotId: 'snap-1234-abcd',
        tenantId: 'tenant-1',
        pathKey: 'tenants/tenant-1/exports/2026/04/uuid_snapshot-snap-1234-abcd.json.gz',
        createdAt: '2026-04-17T00:00:00.000Z',
        entityCount: 1,
        sizeBytes: 100,
        compressed: true,
        reason: 'pre-import',
        ...overrides,
    };
}

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    lastWrittenData = null;
    // Configure the export mock with our test data
    (exportTenantData as jest.Mock).mockResolvedValue(mockExportResult);
});

// ═════════════════════════════════════════════════════════════════════
// 1. Create Snapshot — Happy Path
// ═════════════════════════════════════════════════════════════════════

describe('Import snapshot: create', () => {
    test('creates a snapshot and writes to storage', async () => {
        const storage = makeStorage();

        const result = await createPreImportSnapshot(
            { tenantId: 'tenant-1' },
            storage,
        );

        expect(result.snapshot.tenantId).toBe('tenant-1');
        expect(result.snapshot.entityCount).toBe(1);
        expect(result.snapshot.reason).toBe('pre-import');
        expect(result.snapshot.compressed).toBe(true);
        expect(result.snapshot.sizeBytes).toBeGreaterThan(0);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(storage.write).toHaveBeenCalledTimes(1);
    });

    test('snapshot record has all required fields', async () => {
        const storage = makeStorage();

        const result = await createPreImportSnapshot(
            { tenantId: 'tenant-1', reason: 'manual-backup' },
            storage,
        );

        const snap = result.snapshot;
        expect(snap.snapshotId).toMatch(/^snap-\d+-[a-z0-9]+$/);
        expect(snap.tenantId).toBe('tenant-1');
        expect(snap.pathKey).toContain('tenant-1');
        expect(snap.pathKey).toContain('exports');
        expect(snap.createdAt).toBeTruthy();
        expect(snap.reason).toBe('manual-backup');
        expect(typeof snap.entityCount).toBe('number');
        expect(typeof snap.sizeBytes).toBe('number');
        expect(typeof snap.compressed).toBe('boolean');
    });

    test('creates compressed snapshot by default', async () => {
        const storage = makeStorage();

        const result = await createPreImportSnapshot(
            { tenantId: 'tenant-1' },
            storage,
        );

        expect(result.snapshot.compressed).toBe(true);
        // Verify storage was called with gzip MIME type
        const writeCall = (storage.write as jest.Mock).mock.calls[0];
        expect(writeCall[2]?.mimeType).toBe('application/gzip');
    });

    test('creates uncompressed snapshot when requested', async () => {
        const storage = makeStorage();

        const result = await createPreImportSnapshot(
            { tenantId: 'tenant-1', compress: false },
            storage,
        );

        expect(result.snapshot.compressed).toBe(false);
        const writeCall = (storage.write as jest.Mock).mock.calls[0];
        expect(writeCall[2]?.mimeType).toBe('application/json');
    });

    test('pathKey includes tenant scoping and exports domain', async () => {
        const storage = makeStorage();

        const result = await createPreImportSnapshot(
            { tenantId: 'my-tenant' },
            storage,
        );

        expect(result.snapshot.pathKey).toContain('tenants/my-tenant/exports/');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Read Snapshot
// ═════════════════════════════════════════════════════════════════════

describe('Import snapshot: read', () => {
    test('reads and deserializes snapshot from storage', async () => {
        const storage = makeStorage();

        // Create a snapshot first
        const created = await createPreImportSnapshot(
            { tenantId: 'tenant-1' },
            storage,
        );

        // Read it back
        const envelope = await readSnapshot(created.snapshot, storage);

        expect(envelope.formatVersion).toBe('1.0');
        expect(envelope.metadata.tenantId).toBe('tenant-1');
        expect(envelope.entities.practice).toHaveLength(1);
    });

    test('read handles uncompressed snapshots', async () => {
        const storage = makeStorage();

        const created = await createPreImportSnapshot(
            { tenantId: 'tenant-1', compress: false },
            storage,
        );

        const envelope = await readSnapshot(created.snapshot, storage);
        expect(envelope.formatVersion).toBe('1.0');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Delete Snapshot
// ═════════════════════════════════════════════════════════════════════

describe('Import snapshot: delete', () => {
    test('deletes snapshot from storage', async () => {
        const storage = makeStorage();
        const snapshot = makeSnapshot();

        await deleteSnapshot(snapshot, storage);

        expect(storage.delete).toHaveBeenCalledTimes(1);
        expect(storage.delete).toHaveBeenCalledWith(snapshot.pathKey);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Pruning
// ═════════════════════════════════════════════════════════════════════

describe('Import snapshot: pruning', () => {
    test('prunes oldest snapshots beyond retention limit', async () => {
        const storage = makeStorage();
        const snapshots = Array.from({ length: 15 }, (_, i) =>
            makeSnapshot({
                snapshotId: `snap-${i}`,
                createdAt: new Date(2026, 3, 17, 0, 0, i).toISOString(),
            }),
        );

        const pruned = await pruneSnapshots(snapshots, storage, 10);

        expect(pruned).toBe(5);
        expect(storage.delete).toHaveBeenCalledTimes(5);
    });

    test('no-op when under retention limit', async () => {
        const storage = makeStorage();
        const snapshots = Array.from({ length: 5 }, (_, i) =>
            makeSnapshot({ snapshotId: `snap-${i}` }),
        );

        const pruned = await pruneSnapshots(snapshots, storage, 10);

        expect(pruned).toBe(0);
        expect(storage.delete).not.toHaveBeenCalled();
    });

    test('no-op when exactly at retention limit', async () => {
        const storage = makeStorage();
        const snapshots = Array.from({ length: 10 }, (_, i) =>
            makeSnapshot({ snapshotId: `snap-${i}` }),
        );

        const pruned = await pruneSnapshots(snapshots, storage, 10);

        expect(pruned).toBe(0);
        expect(storage.delete).not.toHaveBeenCalled();
    });

    test('handles delete failures gracefully during pruning', async () => {
        const storage = makeStorage({
            delete: jest.fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error('S3 timeout'))
                .mockResolvedValueOnce(undefined),
        });
        const snapshots = Array.from({ length: 13 }, (_, i) =>
            makeSnapshot({ snapshotId: `snap-${i}` }),
        );

        const pruned = await pruneSnapshots(snapshots, storage, 10);

        // 3 to delete, 1 fails, 2 succeed
        expect(pruned).toBe(2);
        expect(storage.delete).toHaveBeenCalledTimes(3);
    });

    test('uses MAX_SNAPSHOTS_PER_TENANT as default limit', async () => {
        const storage = makeStorage();
        const count = MAX_SNAPSHOTS_PER_TENANT + 3;
        const snapshots = Array.from({ length: count }, (_, i) =>
            makeSnapshot({ snapshotId: `snap-${i}` }),
        );

        const pruned = await pruneSnapshots(snapshots, storage);

        expect(pruned).toBe(3);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Roundtrip — Create → Read
// ═════════════════════════════════════════════════════════════════════

describe('Import snapshot: roundtrip', () => {
    test('create then read produces equivalent envelope', async () => {
        const storage = makeStorage();

        const created = await createPreImportSnapshot(
            { tenantId: 'tenant-1' },
            storage,
        );

        const restored = await readSnapshot(created.snapshot, storage);

        // Compare key fields (not exact object reference)
        expect(restored.formatVersion).toBe(mockExportResult.envelope.formatVersion);
        expect(restored.metadata.tenantId).toBe(mockExportResult.envelope.metadata.tenantId);
        expect(restored.entities.practice).toEqual(mockExportResult.envelope.entities.practice);
        expect(restored.checksum).toBe(mockExportResult.envelope.checksum);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Utilities
// ═════════════════════════════════════════════════════════════════════

describe('Import snapshot: utilities', () => {
    test('generateSnapshotId has correct format', () => {
        const id = generateSnapshotId();
        expect(id).toMatch(/^snap-\d+-[a-z0-9]+$/);
    });

    test('generateSnapshotId produces unique values', () => {
        const ids = new Set(Array.from({ length: 100 }, () => generateSnapshotId()));
        // Should have at least 95 unique IDs (timestamp + random)
        expect(ids.size).toBeGreaterThanOrEqual(95);
    });

    test('generateSnapshotId contains current timestamp', () => {
        const before = Date.now();
        const id = generateSnapshotId();
        const after = Date.now();

        const timestampStr = id.split('-')[1];
        const timestamp = parseInt(timestampStr, 10);
        expect(timestamp).toBeGreaterThanOrEqual(before);
        expect(timestamp).toBeLessThanOrEqual(after);
    });
});
