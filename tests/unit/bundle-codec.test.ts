/**
 * Bundle Codec — Serialization & Compression Tests
 *
 * Tests:
 *   1. Serialize: raw JSON output when compress=false
 *   2. Serialize: gzip'd output when compress=true (default)
 *   3. Deserialize: auto-detects and decompresses gzip
 *   4. Deserialize: handles raw JSON transparently
 *   5. Roundtrip: compress → decompress preserves data
 *   6. Detection: isGzipped identifies magic bytes correctly
 *   7. Stats: compression ratio reported correctly
 *   8. Errors: invalid input handled gracefully
 */

import {
    serializeBundle,
    deserializeBundle,
    isGzipped,
} from '../../src/app-layer/services/bundle-codec';
import {
    EXPORT_FORMAT_VERSION,
    APP_IDENTIFIER,
    type ExportEnvelope,
} from '../../src/app-layer/services/export-schemas';

// ─── Fixtures ───────────────────────────────────────────────────────

function makeEnvelope(entityCount = 1): ExportEnvelope {
    const practices = Array.from({ length: entityCount }, (_, i) => ({
        entityType: 'practice' as const,
        id: `ctrl-${i}`,
        schemaVersion: '1.0',
        data: {
            name: `Practice ${i}`,
            tenantId: 'tenant-1',
            status: 'ACTIVE',
            description: 'A reasonably long description to make compression meaningful. '.repeat(3),
        },
    }));

    return {
        formatVersion: EXPORT_FORMAT_VERSION,
        metadata: {
            tenantId: 'tenant-1',
            exportedAt: new Date().toISOString(),
            domains: ['CONTROLS'],
            app: APP_IDENTIFIER,
            appVersion: '1.0.0',
        },
        entities: { practice: practices },
        relationships: [],
    };
}

// ═════════════════════════════════════════════════════════════════════
// 1. Serialize — Raw JSON
// ═════════════════════════════════════════════════════════════════════

describe('Bundle codec: serialize raw', () => {
    test('compress=false produces valid JSON buffer', () => {
        const envelope = makeEnvelope();
        const result = serializeBundle(envelope, { compress: false });

        expect(result.compressed).toBe(false);
        expect(result.compressionRatio).toBe(0);
        expect(result.rawSize).toBe(result.outputSize);

        // Should be parseable JSON
        const parsed = JSON.parse(result.data.toString('utf-8'));
        expect(parsed.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    });

    test('indent option produces formatted JSON', () => {
        const envelope = makeEnvelope();
        const minified = serializeBundle(envelope, { compress: false, indent: 0 });
        const pretty = serializeBundle(envelope, { compress: false, indent: 2 });

        // Pretty-printed is larger
        expect(pretty.outputSize).toBeGreaterThan(minified.outputSize);
    });

    test('raw output does NOT start with gzip magic', () => {
        const envelope = makeEnvelope();
        const result = serializeBundle(envelope, { compress: false });
        expect(isGzipped(result.data)).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Serialize — Gzip Compressed
// ═════════════════════════════════════════════════════════════════════

describe('Bundle codec: serialize compressed', () => {
    test('default options produce gzip output', () => {
        const envelope = makeEnvelope();
        const result = serializeBundle(envelope);

        expect(result.compressed).toBe(true);
        expect(isGzipped(result.data)).toBe(true);
    });

    test('compress=true produces smaller output for repetitive data', () => {
        const envelope = makeEnvelope(10); // 10 similar entities
        const result = serializeBundle(envelope, { compress: true });

        expect(result.outputSize).toBeLessThan(result.rawSize);
        expect(result.compressionRatio).toBeGreaterThan(0);
    });

    test('compression stats are accurate', () => {
        const envelope = makeEnvelope(5);
        const result = serializeBundle(envelope, { compress: true });

        // Ratio = 1 - (compressed/raw)
        const expectedRatio = Number((1 - result.outputSize / result.rawSize).toFixed(3));
        expect(result.compressionRatio).toBe(expectedRatio);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Deserialize — Auto-detect
// ═════════════════════════════════════════════════════════════════════

describe('Bundle codec: deserialize', () => {
    test('auto-detects and decompresses gzip', () => {
        const envelope = makeEnvelope();
        const { data } = serializeBundle(envelope, { compress: true });

        const parsed = deserializeBundle(data);
        expect(parsed.formatVersion).toBe(EXPORT_FORMAT_VERSION);
        expect(parsed.metadata.tenantId).toBe('tenant-1');
    });

    test('handles raw JSON buffer transparently', () => {
        const envelope = makeEnvelope();
        const { data } = serializeBundle(envelope, { compress: false });

        const parsed = deserializeBundle(data);
        expect(parsed.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    });

    test('throws on corrupted gzip', () => {
        // Create a buffer that starts with gzip magic but is not valid gzip
        const corrupted = Buffer.from([0x1f, 0x8b, 0x00, 0x00, 0xff, 0xff]);
        expect(() => deserializeBundle(corrupted)).toThrow();
    });

    test('throws on invalid JSON', () => {
        const invalid = Buffer.from('not valid json {{{', 'utf-8');
        expect(() => deserializeBundle(invalid)).toThrow(/Failed to parse bundle JSON/);
    });

    test('throws on empty buffer with gzip magic', () => {
        const minimal = Buffer.from([0x1f, 0x8b]);
        expect(() => deserializeBundle(minimal)).toThrow();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Roundtrip — Compress → Decompress
// ═════════════════════════════════════════════════════════════════════

describe('Bundle codec: roundtrip', () => {
    test('compressed roundtrip preserves all fields', () => {
        const original = makeEnvelope(3);
        const { data } = serializeBundle(original, { compress: true });
        const restored = deserializeBundle(data);

        expect(restored.formatVersion).toBe(original.formatVersion);
        expect(restored.metadata.tenantId).toBe(original.metadata.tenantId);
        expect(restored.metadata.domains).toEqual(original.metadata.domains);
        expect(restored.entities.practice).toHaveLength(3);
        expect(restored.relationships).toEqual([]);
    });

    test('raw roundtrip preserves all fields', () => {
        const original = makeEnvelope(2);
        const { data } = serializeBundle(original, { compress: false });
        const restored = deserializeBundle(data);

        expect(restored.formatVersion).toBe(original.formatVersion);
        expect(restored.entities.practice).toHaveLength(2);
    });

    test('entity data survives roundtrip exactly', () => {
        const original = makeEnvelope(1);
        const { data } = serializeBundle(original, { compress: true });
        const restored = deserializeBundle(data);

        const originalCtrl = original.entities.practice![0];
        const restoredCtrl = restored.entities.practice![0];

        expect(restoredCtrl.id).toBe(originalCtrl.id);
        expect(restoredCtrl.entityType).toBe(originalCtrl.entityType);
        expect(restoredCtrl.data).toEqual(originalCtrl.data);
    });

    test('checksum field preserved through roundtrip', () => {
        const original = makeEnvelope();
        original.checksum = 'abc123hash';
        const { data } = serializeBundle(original, { compress: true });
        const restored = deserializeBundle(data);

        expect(restored.checksum).toBe('abc123hash');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. isGzipped — Detection
// ═════════════════════════════════════════════════════════════════════

describe('Bundle codec: isGzipped detection', () => {
    test('detects gzip magic bytes', () => {
        const gzipped = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
        expect(isGzipped(gzipped)).toBe(true);
    });

    test('rejects non-gzip buffer', () => {
        const json = Buffer.from('{"test": true}', 'utf-8');
        expect(isGzipped(json)).toBe(false);
    });

    test('rejects empty buffer', () => {
        expect(isGzipped(Buffer.alloc(0))).toBe(false);
    });

    test('rejects single byte', () => {
        expect(isGzipped(Buffer.from([0x1f]))).toBe(false);
    });

    test('rejects buffer with only first magic byte', () => {
        expect(isGzipped(Buffer.from([0x1f, 0x00]))).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Edge Cases
// ═════════════════════════════════════════════════════════════════════

describe('Bundle codec: edge cases', () => {
    test('empty entities envelope compresses and decompresses', () => {
        const envelope = makeEnvelope(0);
        envelope.entities = {};
        const { data } = serializeBundle(envelope, { compress: true });
        const restored = deserializeBundle(data);

        expect(restored.entities).toEqual({});
    });

    test('large bundle achieves significant compression', () => {
        const envelope = makeEnvelope(100);
        const result = serializeBundle(envelope, { compress: true });

        // With 100 repetitive entities, expect >50% compression
        expect(result.compressionRatio).toBeGreaterThan(0.5);
    });

    test('compression ratio is 0 for uncompressed output', () => {
        const envelope = makeEnvelope();
        const result = serializeBundle(envelope, { compress: false });
        expect(result.compressionRatio).toBe(0);
    });
});
