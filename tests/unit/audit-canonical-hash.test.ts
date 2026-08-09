/**
 * Audit Canonical Hash — Unit Tests
 *
 * Validates the deterministic hashing and canonical JSON serialization
 * that underpins the immutable audit hash chain.
 *
 * These tests are critical for ensuring hash stability across deployments.
 * If any test breaks, it means the hash contract has changed and existing
 * hash chains would be invalidated.
 */
import {
    canonicalJsonStringify,
    computeEntryHash,
    buildHashPayload,
    toCanonicalTimestamp,
    HASH_FIELDS,
} from '../../src/lib/audit/canonical-hash';
import { buildAuditEntry } from '../../src/lib/audit/event-builder';

describe('Canonical JSON Serialization', () => {
    test('sorts object keys lexicographically', () => {
        const input = { z: 1, a: 2, m: 3 };
        const result = canonicalJsonStringify(input);
        expect(result).toBe('{"a":2,"m":3,"z":1}');
    });

    test('sorts keys recursively in nested objects', () => {
        const input = { b: { z: 1, a: 2 }, a: { y: 3, x: 4 } };
        const result = canonicalJsonStringify(input);
        expect(result).toBe('{"a":{"x":4,"y":3},"b":{"a":2,"z":1}}');
    });

    test('preserves array order', () => {
        const input = { items: [3, 1, 2] };
        const result = canonicalJsonStringify(input);
        expect(result).toBe('{"items":[3,1,2]}');
    });

    test('serializes null as null', () => {
        const input = { a: null, b: 'test' };
        const result = canonicalJsonStringify(input);
        expect(result).toBe('{"a":null,"b":"test"}');
    });

    test('serializes standalone null', () => {
        expect(canonicalJsonStringify(null)).toBe('null');
    });

    test('serializes strings with proper escaping', () => {
        const input = { msg: 'hello "world"' };
        const result = canonicalJsonStringify(input);
        expect(result).toBe('{"msg":"hello \\"world\\""}');
    });

    test('serializes booleans correctly', () => {
        const input = { active: true, deleted: false };
        const result = canonicalJsonStringify(input);
        expect(result).toBe('{"active":true,"deleted":false}');
    });

    test('serializes numbers without unnecessary precision', () => {
        const input = { count: 42, score: 3.14 };
        const result = canonicalJsonStringify(input);
        expect(result).toBe('{"count":42,"score":3.14}');
    });

    test('omits undefined values', () => {
        const input = { a: 1, b: undefined, c: 3 };
        const result = canonicalJsonStringify(input);
        expect(result).toBe('{"a":1,"c":3}');
    });

    test('handles empty objects', () => {
        expect(canonicalJsonStringify({})).toBe('{}');
    });

    test('handles empty arrays', () => {
        expect(canonicalJsonStringify([])).toBe('[]');
    });

    test('handles deeply nested structures', () => {
        const input = {
            c: {
                b: {
                    a: [{ z: 1, a: 0 }],
                },
            },
        };
        const result = canonicalJsonStringify(input);
        expect(result).toBe('{"c":{"b":{"a":[{"a":0,"z":1}]}}}');
    });

    test('produces identical output regardless of input key order', () => {
        const a = { tenantId: 't1', actorType: 'USER', eventType: 'TEST' };
        const b = { eventType: 'TEST', tenantId: 't1', actorType: 'USER' };
        expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    });
});

describe('Hash Computation', () => {
    const baseInput = {
        tenantId: 'tenant-abc',
        actorType: 'USER' as const,
        actorUserId: 'user-123',
        eventType: 'CONTROL_UPDATED',
        entityType: 'Practice',
        entityId: 'ctrl-456',
        occurredAt: '2026-03-24T00:00:00.000Z',
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'Practice',
            operation: 'updated',
            changedFields: ['status'],
        },
        previousHash: null,
        version: 1,
    };

    test('same input always produces same hash (determinism)', () => {
        const hash1 = computeEntryHash(baseInput);
        const hash2 = computeEntryHash(baseInput);
        expect(hash1).toBe(hash2);
    });

    test('produces a 64-character hex string', () => {
        const hash = computeEntryHash(baseInput);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test('different input key order produces same hash', () => {
        // Create equivalent input with different property insertion order
        const reordered = {
            version: 1,
            previousHash: null,
            detailsJson: {
                operation: 'updated',
                category: 'entity_lifecycle',
                entityName: 'Practice',
                changedFields: ['status'],
            },
            occurredAt: '2026-03-24T00:00:00.000Z',
            entityId: 'ctrl-456',
            entityType: 'Practice',
            eventType: 'CONTROL_UPDATED',
            actorUserId: 'user-123',
            actorType: 'USER' as const,
            tenantId: 'tenant-abc',
        };
        expect(computeEntryHash(reordered)).toBe(computeEntryHash(baseInput));
    });

    test('hash changes when tenantId changes', () => {
        const modified = { ...baseInput, tenantId: 'tenant-xyz' };
        expect(computeEntryHash(modified)).not.toBe(computeEntryHash(baseInput));
    });

    test('hash changes when eventType changes', () => {
        const modified = { ...baseInput, eventType: 'CONTROL_CREATED' };
        expect(computeEntryHash(modified)).not.toBe(computeEntryHash(baseInput));
    });

    test('hash changes when actorUserId changes', () => {
        const modified = { ...baseInput, actorUserId: 'user-789' };
        expect(computeEntryHash(modified)).not.toBe(computeEntryHash(baseInput));
    });

    test('hash changes when actorUserId goes from value to null', () => {
        const modified = { ...baseInput, actorUserId: null };
        expect(computeEntryHash(modified)).not.toBe(computeEntryHash(baseInput));
    });

    test('hash changes when previousHash changes', () => {
        const modified = { ...baseInput, previousHash: 'abc123' };
        expect(computeEntryHash(modified)).not.toBe(computeEntryHash(baseInput));
    });

    test('hash changes when occurredAt changes', () => {
        const modified = { ...baseInput, occurredAt: '2026-03-24T01:00:00.000Z' };
        expect(computeEntryHash(modified)).not.toBe(computeEntryHash(baseInput));
    });

    test('hash changes when detailsJson changes', () => {
        const modified = {
            ...baseInput,
            detailsJson: {
                ...baseInput.detailsJson,
                changedFields: ['status', 'effectiveness'],
            },
        };
        expect(computeEntryHash(modified)).not.toBe(computeEntryHash(baseInput));
    });

    test('hash changes when version changes', () => {
        const modified = { ...baseInput, version: 2 };
        expect(computeEntryHash(modified)).not.toBe(computeEntryHash(baseInput));
    });

    test('null fields are handled correctly (not omitted)', () => {
        const withNull = { ...baseInput, actorUserId: null, entityId: null };
        const hash = computeEntryHash(withNull);
        // Should produce a valid hash (not error)
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('Hash Chain', () => {
    test('previousHash chaining produces verifiable sequence', () => {
        const entry1Input = {
            tenantId: 'tenant-abc',
            actorType: 'USER' as const,
            actorUserId: 'user-1',
            eventType: 'ASSET_CREATED',
            entityType: 'Asset',
            entityId: 'asset-1',
            occurredAt: '2026-03-24T00:00:00.000Z',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Asset',
                operation: 'created',
            },
            previousHash: null,
            version: 1,
        };

        const hash1 = computeEntryHash(entry1Input);

        const entry2Input = {
            tenantId: 'tenant-abc',
            actorType: 'USER' as const,
            actorUserId: 'user-1',
            eventType: 'ASSET_UPDATED',
            entityType: 'Asset',
            entityId: 'asset-1',
            occurredAt: '2026-03-24T00:01:00.000Z',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Asset',
                operation: 'updated',
                changedFields: ['name'],
            },
            previousHash: hash1,
            version: 1,
        };

        const hash2 = computeEntryHash(entry2Input);

        // Verify chain: recompute hash1 and check hash2.previousHash matches
        expect(computeEntryHash(entry1Input)).toBe(hash1);
        expect(entry2Input.previousHash).toBe(hash1);

        // Verify hash2 is deterministic
        expect(computeEntryHash(entry2Input)).toBe(hash2);

        // Chain integrity: hash2 depends on hash1
        expect(hash1).not.toBe(hash2);

        // Tamper test: if we change entry1, hash1 changes, breaking the chain
        const tamperedEntry1 = { ...entry1Input, eventType: 'ASSET_DELETED' };
        const tamperedHash1 = computeEntryHash(tamperedEntry1);
        expect(tamperedHash1).not.toBe(hash1);
        // The chain is now broken because entry2.previousHash != tamperedHash1
    });

    test('per-tenant chains are independent', () => {
        const inputA = {
            tenantId: 'tenant-A',
            actorType: 'USER' as const,
            actorUserId: 'user-1',
            eventType: 'ASSET_CREATED',
            entityType: 'Asset',
            entityId: 'asset-1',
            occurredAt: '2026-03-24T00:00:00.000Z',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Asset',
                operation: 'created',
            },
            previousHash: null,
            version: 1,
        };

        const inputB = { ...inputA, tenantId: 'tenant-B' };

        const hashA = computeEntryHash(inputA);
        const hashB = computeEntryHash(inputB);

        // Different tenants, same data → different hashes
        expect(hashA).not.toBe(hashB);
    });
});

describe('buildHashPayload', () => {
    test('includes exactly the fields defined in HASH_FIELDS', () => {
        const input = {
            tenantId: 't1',
            actorType: 'USER',
            actorUserId: 'u1',
            eventType: 'TEST',
            entityType: 'Entity',
            entityId: 'e1',
            occurredAt: '2026-01-01T00:00:00.000Z',
            detailsJson: { category: 'custom' },
            previousHash: null,
            version: 1,
        };

        const payload = buildHashPayload(input);
        const keys = Object.keys(payload).sort();

        expect(keys).toEqual([...HASH_FIELDS]);
    });
});

describe('toCanonicalTimestamp', () => {
    test('formats Date object to ISO-8601 UTC with milliseconds', () => {
        const date = new Date('2026-03-24T12:30:45.123Z');
        expect(toCanonicalTimestamp(date)).toBe('2026-03-24T12:30:45.123Z');
    });

    test('formats ISO string input consistently', () => {
        expect(toCanonicalTimestamp('2026-03-24T12:30:45Z')).toBe('2026-03-24T12:30:45.000Z');
    });

    test('preserves millisecond precision', () => {
        const ts = toCanonicalTimestamp('2026-03-24T00:00:00.999Z');
        expect(ts).toBe('2026-03-24T00:00:00.999Z');
    });

    test('Date and equivalent string produce same output', () => {
        const date = new Date('2026-06-15T08:00:00.000Z');
        const str = '2026-06-15T08:00:00.000Z';
        expect(toCanonicalTimestamp(date)).toBe(toCanonicalTimestamp(str));
    });
});

describe('buildAuditEntry (event builder)', () => {
    test('produces a valid entry with computed hash', () => {
        const entry = buildAuditEntry({
            tenantId: 'tenant-1',
            actorUserId: 'user-1',
            actorType: 'USER',
            eventType: 'CONTROL_CREATED',
            entityType: 'Practice',
            entityId: 'ctrl-1',
            occurredAt: '2026-03-24T00:00:00.000Z',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Practice',
                operation: 'created',
            },
            previousHash: null,
        });

        expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.data.tenantId).toBe('tenant-1');
        expect(entry.data.userId).toBe('user-1');
        expect(entry.data.actorType).toBe('USER');
        expect(entry.data.entity).toBe('Practice');
        expect(entry.data.entityId).toBe('ctrl-1');
        expect(entry.data.action).toBe('CONTROL_CREATED');
        expect(entry.data.details).toBeNull(); // legacy field
        expect(entry.data.detailsJson).toEqual({
            category: 'entity_lifecycle',
            entityName: 'Practice',
            operation: 'created',
        });
        expect(entry.data.previousHash).toBeNull();
        expect(entry.data.entryHash).toBe(entry.entryHash);
        expect(entry.data.version).toBe(1);
    });

    test('throws on invalid detailsJson', () => {
        expect(() => {
            buildAuditEntry({
                tenantId: 't1',
                actorUserId: 'u1',
                actorType: 'USER',
                eventType: 'TEST',
                entityType: 'Entity',
                entityId: 'e1',
                occurredAt: '2026-03-24T00:00:00.000Z',
                detailsJson: {
                    category: 'entity_lifecycle',
                    // missing required: entityName, operation
                } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                previousHash: null,
            });
        }).toThrow();
    });

    test('hash is deterministic across calls', () => {
        const input = {
            tenantId: 'tenant-1',
            actorUserId: 'user-1',
            actorType: 'USER' as const,
            eventType: 'RISK_DELETED',
            entityType: 'Risk',
            entityId: 'risk-1',
            occurredAt: '2026-03-24T12:00:00.000Z',
            detailsJson: {
                category: 'entity_lifecycle' as const,
                entityName: 'Risk',
                operation: 'deleted' as const,
            },
            previousHash: 'abc123def456',
        };

        const entry1 = buildAuditEntry(input);
        const entry2 = buildAuditEntry(input);
        expect(entry1.entryHash).toBe(entry2.entryHash);
    });

    test('sets entityId to "unknown" when null', () => {
        const entry = buildAuditEntry({
            tenantId: 't1',
            actorUserId: null,
            actorType: 'SYSTEM',
            eventType: 'BATCH_PURGE',
            entityType: 'Evidence',
            entityId: null,
            occurredAt: '2026-03-24T00:00:00.000Z',
            detailsJson: {
                category: 'data_lifecycle',
                operation: 'purged',
                recordCount: 10,
            },
            previousHash: null,
        });

        expect(entry.data.entityId).toBe('unknown');
        expect(entry.data.userId).toBeNull();
        expect(entry.data.actorType).toBe('SYSTEM');
    });

    test('uses default version 1 when not specified', () => {
        const entry = buildAuditEntry({
            tenantId: 't1',
            actorUserId: 'u1',
            actorType: 'USER',
            eventType: 'TEST',
            entityType: 'Entity',
            entityId: 'e1',
            occurredAt: '2026-03-24T00:00:00.000Z',
            detailsJson: { category: 'custom' },
            previousHash: null,
        });

        expect(entry.data.version).toBe(1);
    });

    test('respects explicit version override', () => {
        const entry = buildAuditEntry({
            tenantId: 't1',
            actorUserId: 'u1',
            actorType: 'USER',
            eventType: 'TEST',
            entityType: 'Entity',
            entityId: 'e1',
            occurredAt: '2026-03-24T00:00:00.000Z',
            detailsJson: { category: 'custom' },
            previousHash: null,
            version: 2,
        });

        expect(entry.data.version).toBe(2);
    });
});
