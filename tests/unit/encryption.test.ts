/**
 * Tests for the data protection encryption abstraction.
 *
 * Covers:
 * - AES-256-GCM encrypt/decrypt roundtrip
 * - Tamper detection (modified ciphertext, truncated payload)
 * - Versioned payload format parsing
 * - HMAC-SHA256 deterministic lookup hashes
 * - Edge cases: empty strings, unicode, emoji
 * - IV randomness (same input → different ciphertexts)
 * - Classification registry correctness
 */

import {
    encryptField,
    decryptField,
    hashForLookup,
    isEncryptedValue,
    _resetKeyCache,
} from '../../src/lib/security/encryption';

import {
    DATA_CLASSIFICATION,
    getAppEncryptedFields,
    getFieldsNeedingSearchHash,
    isFieldAppEncrypted,
    getFieldClassification,
    SOFT_DELETE_TARGETS,
} from '../../src/lib/security/classification';

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
    _resetKeyCache();
    // Use a stable test key
    process.env.DATA_ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests-minimum-32-chars!!!';
});

afterEach(() => {
    _resetKeyCache();
    delete process.env.DATA_ENCRYPTION_KEY;
});

// ═══════════════════════════════════════════════════════════════════
//  Encryption / Decryption
// ═══════════════════════════════════════════════════════════════════

describe('encryptField / decryptField', () => {
    it('roundtrips a simple string', () => {
        const plain = 'user@example.com';
        const encrypted = encryptField(plain);
        expect(decryptField(encrypted)).toBe(plain);
    });

    it('roundtrips an empty string', () => {
        const encrypted = encryptField('');
        expect(decryptField(encrypted)).toBe('');
    });

    it('roundtrips unicode / emoji', () => {
        const plain = 'José García 🔐 données™';
        const encrypted = encryptField(plain);
        expect(decryptField(encrypted)).toBe(plain);
    });

    it('roundtrips a long string', () => {
        const plain = 'a'.repeat(10_000);
        const encrypted = encryptField(plain);
        expect(decryptField(encrypted)).toBe(plain);
    });

    it('produces different ciphertexts for the same input (random IV)', () => {
        const plain = 'same-input';
        const a = encryptField(plain);
        const b = encryptField(plain);
        expect(a).not.toBe(b); // Different IVs
        expect(decryptField(a)).toBe(plain);
        expect(decryptField(b)).toBe(plain);
    });

    it('output starts with version prefix "v1:"', () => {
        const encrypted = encryptField('test');
        expect(encrypted.startsWith('v1:')).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Tamper Detection
// ═══════════════════════════════════════════════════════════════════

describe('tamper detection', () => {
    it('detects modified ciphertext payload', () => {
        const encrypted = encryptField('sensitive data');
        // Flip a byte in the base64 payload
        const parts = encrypted.split(':');
        const payload = parts[1];
        const buf = Buffer.from(payload, 'base64');
        buf[14] ^= 0xFF; // Flip byte in the ciphertext region
        const tampered = 'v1:' + buf.toString('base64');

        expect(() => decryptField(tampered)).toThrow();
    });

    it('detects modified auth tag', () => {
        const encrypted = encryptField('sensitive data');
        const parts = encrypted.split(':');
        const buf = Buffer.from(parts[1], 'base64');
        buf[buf.length - 1] ^= 0xFF; // Flip last byte (in auth tag)
        const tampered = 'v1:' + buf.toString('base64');

        expect(() => decryptField(tampered)).toThrow();
    });

    it('rejects truncated ciphertext', () => {
        const encrypted = encryptField('sensitive data');
        const truncated = encrypted.slice(0, 20);
        expect(() => decryptField(truncated)).toThrow();
    });

    it('rejects missing version prefix', () => {
        expect(() => decryptField('not-versioned')).toThrow(/version prefix/i);
    });

    it('rejects null/undefined/empty input', () => {
        expect(() => decryptField('')).toThrow();
        expect(() => decryptField(null as unknown as string)).toThrow();
        expect(() => decryptField(undefined as unknown as string)).toThrow();
    });

    it('rejects null/undefined plaintext for encryption', () => {
        expect(() => encryptField(null as unknown as string)).toThrow();
        expect(() => encryptField(undefined as unknown as string)).toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Key Management
// ═══════════════════════════════════════════════════════════════════

describe('key management', () => {
    it('throws in production without DATA_ENCRYPTION_KEY', () => {
        _resetKeyCache();
        delete process.env.DATA_ENCRYPTION_KEY;
        const origEnv = process.env.NODE_ENV;
        // @ts-expect-error — process.env.NODE_ENV is typed as read-only but we need to override for testing
        process.env.NODE_ENV = 'production';

        expect(() => encryptField('test')).toThrow(/DATA_ENCRYPTION_KEY.*required/i);

        // @ts-expect-error — restoring original value
        process.env.NODE_ENV = origEnv;
    });

    it('uses dev fallback key in test environment', () => {
        _resetKeyCache();
        delete process.env.DATA_ENCRYPTION_KEY;
        // NODE_ENV is 'test' in jest — should use fallback without throwing
        const encrypted = encryptField('test-value');
        expect(decryptField(encrypted)).toBe('test-value');
    });

    it('data encrypted with one key cannot be decrypted with another', () => {
        const encrypted = encryptField('secret');

        _resetKeyCache();
        process.env.DATA_ENCRYPTION_KEY = 'completely-different-key-for-testing-minimum-32-chars!!!';

        expect(() => decryptField(encrypted)).toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Lookup Hashes
// ═══════════════════════════════════════════════════════════════════

describe('hashForLookup', () => {
    it('produces a 64-character hex string', () => {
        const hash = hashForLookup('user@example.com');
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic — same input gives same hash', () => {
        const a = hashForLookup('user@example.com');
        const b = hashForLookup('user@example.com');
        expect(a).toBe(b);
    });

    it('normalises case and whitespace', () => {
        const a = hashForLookup('User@Example.COM');
        const b = hashForLookup('user@example.com');
        const c = hashForLookup('  user@example.com  ');
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it('different inputs give different hashes', () => {
        const a = hashForLookup('alice@example.com');
        const b = hashForLookup('bob@example.com');
        expect(a).not.toBe(b);
    });

    it('rejects null/undefined', () => {
        expect(() => hashForLookup(null as unknown as string)).toThrow();
        expect(() => hashForLookup(undefined as unknown as string)).toThrow();
    });

    it('hash changes when key changes', () => {
        const hash1 = hashForLookup('user@example.com');

        _resetKeyCache();
        process.env.DATA_ENCRYPTION_KEY = 'a-completely-different-key-for-hash-testing-min32!!!';
        const hash2 = hashForLookup('user@example.com');

        expect(hash1).not.toBe(hash2);
    });
});

// ═══════════════════════════════════════════════════════════════════
//  isEncryptedValue
// ═══════════════════════════════════════════════════════════════════

describe('isEncryptedValue', () => {
    it('recognises encrypted values', () => {
        const encrypted = encryptField('test');
        expect(isEncryptedValue(encrypted)).toBe(true);
    });

    it('rejects plain strings', () => {
        expect(isEncryptedValue('user@example.com')).toBe(false);
    });

    it('handles null/undefined safely', () => {
        expect(isEncryptedValue(null)).toBe(false);
        expect(isEncryptedValue(undefined)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Data Classification Registry
// ═══════════════════════════════════════════════════════════════════

describe('Data Classification', () => {
    it('has at least 9 APP_ENCRYPTED fields', () => {
        const appEncrypted = DATA_CLASSIFICATION.filter(
            (c) => c.tier === 'APP_ENCRYPTED',
        );
        expect(appEncrypted.length).toBeGreaterThanOrEqual(9);
    });

    it('User.email is classified as APP_ENCRYPTED with search hash', () => {
        const field = getFieldClassification('User', 'email');
        expect(field).toBeDefined();
        expect(field!.tier).toBe('APP_ENCRYPTED');
        expect(field!.needsSearchHash).toBe(true);
    });

    it('User.passwordHash is ALREADY_SECURED', () => {
        const field = getFieldClassification('User', 'passwordHash');
        expect(field).toBeDefined();
        expect(field!.tier).toBe('ALREADY_SECURED');
    });

    it('Evidence.content is DB_ENCRYPTED', () => {
        const field = getFieldClassification('Evidence', 'content');
        expect(field).toBeDefined();
        expect(field!.tier).toBe('DB_ENCRYPTED');
    });

    it('getAppEncryptedFields returns correct fields for User', () => {
        const fields = getAppEncryptedFields('User');
        const fieldNames = fields.map((f) => f.field).sort();
        expect(fieldNames).toEqual(['email', 'name']);
    });

    it('getFieldsNeedingSearchHash returns only hash-needed fields', () => {
        const fields = getFieldsNeedingSearchHash();
        expect(fields.length).toBeGreaterThanOrEqual(4);
        expect(fields.every((f) => f.needsSearchHash === true)).toBe(true);
    });

    it('isFieldAppEncrypted returns correct booleans', () => {
        expect(isFieldAppEncrypted('User', 'email')).toBe(true);
        expect(isFieldAppEncrypted('User', 'id')).toBe(false);
        expect(isFieldAppEncrypted('Risk', 'title')).toBe(false);
    });

    it('every classification has a reason', () => {
        for (const c of DATA_CLASSIFICATION) {
            expect(c.reason).toBeTruthy();
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Soft-Delete Target Registry
// ═══════════════════════════════════════════════════════════════════

describe('Soft-Delete Targets', () => {
    it('has at least 12 target models', () => {
        expect(SOFT_DELETE_TARGETS.length).toBeGreaterThanOrEqual(12);
    });

    it('Asset, Control, Evidence, Policy already have deletedAt', () => {
        const existing = SOFT_DELETE_TARGETS.filter((t) => t.hasDeletedAt);
        const names = existing.map((t) => t.model).sort();
        expect(names).toContain('Asset');
        expect(names).toContain('Control');
        expect(names).toContain('Evidence');
        expect(names).toContain('Policy');
    });

    it('Vendor and FileRecord need deletedAt', () => {
        const needed = SOFT_DELETE_TARGETS.filter((t) => !t.hasDeletedAt);
        const names = needed.map((t) => t.model);
        expect(names).toContain('Vendor');
        expect(names).toContain('FileRecord');
    });
});
