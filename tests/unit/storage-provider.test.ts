/**
 * Storage Provider Tests
 *
 * Tests the provider factory, local provider contract,
 * and path generation utilities.
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';

// ─── Mock env before importing storage ───
const TEST_STORAGE_ROOT = path.join(os.tmpdir(), 'inflect-storage-test-' + Date.now());

jest.mock('@/env', () => ({
    env: {
        FILE_STORAGE_ROOT: TEST_STORAGE_ROOT,
        UPLOAD_DIR: TEST_STORAGE_ROOT,
        STORAGE_PROVIDER: 'local',
    },
}));

import { LocalStorageProvider } from '@/lib/storage/local-provider';
import { generatePathKey, sanitizeFileName, isAllowedMime, isAllowedSize } from '@/lib/storage/index';
import type { StorageProvider } from '@/lib/storage/types';

// ─── Setup / Teardown ───

beforeAll(async () => {
    await fs.mkdir(TEST_STORAGE_ROOT, { recursive: true });
});

afterAll(async () => {
    await fs.rm(TEST_STORAGE_ROOT, { recursive: true, force: true });
});

// ─── Provider Factory ───

describe('Storage Provider Factory', () => {
    it('getStorageProvider returns local provider by default', () => {
        // Reset to force re-creation
        const { getStorageProvider, resetStorageProvider } = require('@/lib/storage/index');
        resetStorageProvider();
        const provider = getStorageProvider();
        expect(provider.name).toBe('local');
    });

    it('getStorageProvider returns singleton', () => {
        const { getStorageProvider } = require('@/lib/storage/index');
        const p1 = getStorageProvider();
        const p2 = getStorageProvider();
        expect(p1).toBe(p2);
    });
});

// ─── Local Provider Contract ───

describe('LocalStorageProvider', () => {
    let provider: StorageProvider;

    beforeEach(() => {
        provider = new LocalStorageProvider();
    });

    it('has name "local"', () => {
        expect(provider.name).toBe('local');
    });

    describe('write + readStream', () => {
        it('writes a buffer and produces correct SHA-256 and size', async () => {
            const content = Buffer.from('hello, storage abstraction!');
            const key = `tenants/test-tenant/2026/03/test-write-${Date.now()}.txt`;

            const result = await provider.write(key, content);

            expect(result.sizeBytes).toBe(content.length);
            expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
        });

        it('writes a stream and reads it back', async () => {
            const content = 'streaming content for test';
            const key = `tenants/test-tenant/2026/03/test-stream-${Date.now()}.txt`;
            const stream = Readable.from([content]);

            const writeResult = await provider.write(key, stream);
            expect(writeResult.sizeBytes).toBe(content.length);

            // Read back
            const readStream = provider.readStream(key);
            const chunks: Buffer[] = [];
            for await (const chunk of readStream) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const readContent = Buffer.concat(chunks).toString();
            expect(readContent).toBe(content);
        });
    });

    describe('head', () => {
        it('returns file metadata', async () => {
            const content = Buffer.from('metadata test');
            const key = `tenants/test-tenant/2026/03/test-head-${Date.now()}.txt`;
            await provider.write(key, content);

            const head = await provider.head(key);
            expect(head.sizeBytes).toBe(content.length);
            // Use duck-typing check because Jest module sandboxing can cause Date
            // constructor identity mismatches across contexts.
            expect(typeof head.lastModified!.getTime).toBe('function');
        });

        it('throws for non-existent file', async () => {
            await expect(
                provider.head('tenants/test-tenant/nonexistent.txt')
            ).rejects.toThrow();
        });
    });

    describe('delete', () => {
        it('deletes an existing file', async () => {
            const key = `tenants/test-tenant/2026/03/test-delete-${Date.now()}.txt`;
            await provider.write(key, Buffer.from('to be deleted'));
            await provider.delete(key);
            await expect(provider.head(key)).rejects.toThrow();
        });

        it('is a no-op for non-existent file', async () => {
            await expect(
                provider.delete('tenants/test-tenant/nonexistent.txt')
            ).resolves.not.toThrow();
        });
    });

    describe('copy', () => {
        it('copies a file to a new key', async () => {
            const srcKey = `tenants/test-tenant/2026/03/test-copy-src-${Date.now()}.txt`;
            const destKey = `tenants/test-tenant/2026/03/test-copy-dest-${Date.now()}.txt`;
            const content = Buffer.from('copy me');

            await provider.write(srcKey, content);
            await provider.copy(srcKey, destKey);

            const head = await provider.head(destKey);
            expect(head.sizeBytes).toBe(content.length);
        });
    });

    describe('size limit enforcement', () => {
        it('rejects buffer exceeding maxSizeBytes', async () => {
            const key = `tenants/test-tenant/2026/03/test-limit-${Date.now()}.txt`;
            const bigContent = Buffer.alloc(1024);
            await expect(
                provider.write(key, bigContent, { maxSizeBytes: 512 })
            ).rejects.toThrow(/exceeds maximum/);
        });

        it('rejects stream exceeding maxSizeBytes', async () => {
            const key = `tenants/test-tenant/2026/03/test-stream-limit-${Date.now()}.txt`;
            const stream = Readable.from([Buffer.alloc(1024)]);
            await expect(
                provider.write(key, stream, { maxSizeBytes: 512 })
            ).rejects.toThrow(/exceeds maximum/);
        });
    });

    describe('presigned URLs (local fallback)', () => {
        it('createSignedDownloadUrl refuses rather than returning a dead link', async () => {
            // It used to return `/api/files/<key>` — a route now deleted for
            // serving bytes with no AV gate and no assertTenantKey. Both call
            // sites of createSignedDownloadUrl are `s3`-gated, so this branch
            // was already unreachable; the throw makes that explicit instead
            // of handing back a URL that 404s at the far end.
            await expect(
                provider.createSignedDownloadUrl('tenants/t1/file.pdf'),
            ).rejects.toThrow(/does not issue signed URLs/);
        });

        it('createSignedUploadUrl returns API path', async () => {
            const result = await provider.createSignedUploadUrl('tenants/t1/file.pdf');
            expect(result.url).toContain('/api/files/upload');
            expect(result.method).toBe('PUT');
        });
    });
});

// ─── Path Generation ───

describe('generatePathKey', () => {
    it('produces tenant-scoped path', () => {
        const key = generatePathKey('tenant-abc', 'report.pdf');
        // generatePathKey uses buildTenantObjectKey with domain='general'
        expect(key).toMatch(/^tenants\/tenant-abc\/general\/\d{4}\/\d{2}\/[a-f0-9-]+_report\.pdf$/);
    });

    it('sanitizes dangerous filenames', () => {
        const key = generatePathKey('tenant-abc', '../../../etc/passwd');
        expect(key).not.toContain('../..');
        expect(key).toMatch(/^tenants\/tenant-abc\//);
    });

    it('handles very long filenames', () => {
        const longName = 'a'.repeat(500) + '.pdf';
        const key = generatePathKey('t1', longName);
        // uuid(36) + _(1) + up to 200 chars of sanitized name
        const filename = key.split('/').pop()!;
        expect(filename.length).toBeLessThanOrEqual(250);
    });
});

// ─── sanitizeFileName ───

describe('sanitizeFileName', () => {
    it('strips path traversal', () => {
        expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    });

    it('replaces special characters', () => {
        // Use input without backslash/slash to avoid platform-specific path.basename behavior
        expect(sanitizeFileName('file<>:"|?*.txt')).toBe('file_______.txt');
    });

    it('limits length to 200', () => {
        const long = 'x'.repeat(300) + '.pdf';
        expect(sanitizeFileName(long).length).toBeLessThanOrEqual(200);
    });
});

// ─── Validation ───

describe('Validation helpers', () => {
    it('isAllowedMime accepts PDF', () => {
        expect(isAllowedMime('application/pdf')).toBe(true);
    });

    it('isAllowedMime rejects executable', () => {
        expect(isAllowedMime('application/x-executable')).toBe(false);
    });

    it('isAllowedSize accepts valid size', () => {
        expect(isAllowedSize(1024)).toBe(true);
    });

    it('isAllowedSize rejects zero', () => {
        expect(isAllowedSize(0)).toBe(false);
    });
});
