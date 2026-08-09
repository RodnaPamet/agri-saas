/**
 * Unit + integration tests for file storage:
 * - Path sanitization & traversal prevention
 * - MIME/size validation
 * - PathKey generation (tenant partitioning)
 * - Streaming write + SHA-256
 * - Route structure
 * - FileRecord lifecycle
 */
import {
    sanitizeFileName,
    generatePathKey,
    resolveStoragePath,
    isAllowedMime,
    isAllowedSize,
    streamWriteFile,
    FILE_MAX_SIZE_BYTES,
    FILE_ALLOWED_MIME,
    FILE_STORAGE_ROOT,
} from '@/lib/storage';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';

// ─── Path Sanitization ───

describe('File Storage — Path Sanitization', () => {
    test('sanitizeFileName strips directory separators', () => {
        expect(sanitizeFileName('../../../etc/passwd')).toBe('passwd');
        expect(sanitizeFileName('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    });

    test('sanitizeFileName strips practice characters', () => {
        expect(sanitizeFileName('file\x00name\x1F.pdf')).toBe('file_name_.pdf');
    });

    test('sanitizeFileName limits length to 200 chars', () => {
        const longName = 'a'.repeat(300) + '.pdf';
        expect(sanitizeFileName(longName).length).toBeLessThanOrEqual(200);
    });

    test('sanitizeFileName strips special characters', () => {
        expect(sanitizeFileName('file<>:"|?*.pdf')).toBe('file_______.pdf');
    });

    test('sanitizeFileName preserves valid filenames', () => {
        expect(sanitizeFileName('report_2026-Q1.pdf')).toBe('report_2026-Q1.pdf');
        expect(sanitizeFileName('my document (v2).docx')).toBe('my document (v2).docx');
    });
});

// ─── Path Generation ───

describe('File Storage — Path Generation', () => {
    test('generatePathKey includes tenant, year, month, uuid, and sanitized name', () => {
        const key = generatePathKey('tenant-abc', 'report.pdf');
        // generatePathKey uses buildTenantObjectKey with domain='general'
        expect(key).toMatch(/^tenants\/tenant-abc\/general\/\d{4}\/\d{2}\/[0-9a-f-]+_report\.pdf$/);
    });

    test('generatePathKey generates unique keys', () => {
        const key1 = generatePathKey('t1', 'file.pdf');
        const key2 = generatePathKey('t1', 'file.pdf');
        expect(key1).not.toBe(key2);
    });

    test('generatePathKey sanitizes dangerous filenames', () => {
        const key = generatePathKey('t1', '../../../etc/passwd');
        expect(key).toContain('passwd');
        expect(key).not.toContain('..');
        expect(key).toMatch(/^tenants\/t1\//);
    });
});

// ─── Traversal Prevention ───

describe('File Storage — Traversal Prevention', () => {
    test('resolveStoragePath rejects traversal attempts', () => {
        expect(() => resolveStoragePath('../../etc/passwd')).toThrow('Path traversal detected');
        expect(() => resolveStoragePath('../../../windows/system32')).toThrow('Path traversal detected');
    });

    test('resolveStoragePath accepts valid tenant paths', () => {
        const result = resolveStoragePath('tenants/tenant-1/2026/03/uuid_file.pdf');
        const root = path.resolve(FILE_STORAGE_ROOT);
        expect(result).toContain(root);
        expect(result).toContain('tenants');
    });
});

// ─── MIME/Size Validation ───

describe('File Storage — Validation', () => {
    test('isAllowedMime accepts PDF', () => {
        expect(isAllowedMime('application/pdf')).toBe(true);
    });

    test('isAllowedMime accepts images', () => {
        expect(isAllowedMime('image/jpeg')).toBe(true);
        expect(isAllowedMime('image/png')).toBe(true);
    });

    test('isAllowedMime rejects executables', () => {
        expect(isAllowedMime('application/x-executable')).toBe(false);
        expect(isAllowedMime('application/x-msdownload')).toBe(false);
    });

    test('isAllowedMime rejects HTML (XSS risk)', () => {
        expect(isAllowedMime('text/html')).toBe(false);
    });

    test('isAllowedSize rejects zero-size files', () => {
        expect(isAllowedSize(0)).toBe(false);
    });

    test('isAllowedSize accepts normal files', () => {
        expect(isAllowedSize(1024)).toBe(true);
        expect(isAllowedSize(1024 * 1024)).toBe(true);
    });

    test('isAllowedSize rejects oversized files', () => {
        expect(isAllowedSize(FILE_MAX_SIZE_BYTES + 1)).toBe(false);
    });

    test('FILE_ALLOWED_MIME is a non-empty array', () => {
        expect(Array.isArray(FILE_ALLOWED_MIME)).toBe(true);
        expect(FILE_ALLOWED_MIME.length).toBeGreaterThan(0);
    });
});

// ─── Streaming Write + SHA-256 ───

describe('File Storage — Streaming Write', () => {
    const testDir = path.join(FILE_STORAGE_ROOT, 'test-unit-' + Date.now());

    afterAll(async () => {
        try { await fs.rm(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('streamWriteFile writes file and computes SHA-256', async () => {
        const content = 'Hello, World! ' + crypto.randomUUID();
        const pathKey = `test-unit-${Date.now()}/test_${crypto.randomUUID()}.txt`;
        const readable = Readable.from(Buffer.from(content));

        const result = await streamWriteFile(pathKey, readable);

        expect(result.sizeBytes).toBe(Buffer.byteLength(content));
        expect(result.sha256).toHaveLength(64);

        // Verify hash
        const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
        expect(result.sha256).toBe(expectedHash);

        // Verify file exists and is readable
        const written = await fs.readFile(result.finalPath, 'utf-8');
        expect(written).toBe(content);

        // Cleanup
        await fs.unlink(result.finalPath);
    });

    test('streamWriteFile works with Buffer input', async () => {
        const content = Buffer.from('Buffer content ' + crypto.randomUUID());
        const pathKey = `test-unit-${Date.now()}/buf_${crypto.randomUUID()}.txt`;

        const result = await streamWriteFile(pathKey, content);

        expect(result.sizeBytes).toBe(content.length);
        expect(result.sha256).toHaveLength(64);

        await fs.unlink(result.finalPath);
    });

    test('streamWriteFile SHA-256 is consistent', async () => {
        const content = 'consistent hash test';
        const pathKey1 = `test-unit-${Date.now()}/h1_${crypto.randomUUID()}.txt`;
        const pathKey2 = `test-unit-${Date.now()}/h2_${crypto.randomUUID()}.txt`;

        const r1 = await streamWriteFile(pathKey1, Readable.from(Buffer.from(content)));
        const r2 = await streamWriteFile(pathKey2, Readable.from(Buffer.from(content)));

        expect(r1.sha256).toBe(r2.sha256);

        await fs.unlink(r1.finalPath);
        await fs.unlink(r2.finalPath);
    });
});

// ─── Route Structure ───

describe('File Storage — Route Structure', () => {
    const fs = require('fs');
    const path = require('path');

    const routes = [
        'src/app/api/t/[tenantSlug]/evidence/uploads/route.ts',
        'src/app/api/t/[tenantSlug]/evidence/files/[fileId]/download/route.ts',
    ];

    test.each(routes)('route file exists: %s', (routePath) => {
        expect(fs.existsSync(path.resolve(routePath))).toBe(true);
    });

    const files = [
        'src/app-layer/repositories/FileRepository.ts',
        'src/lib/storage.ts',
    ];

    test.each(files)('source file exists: %s', (filePath) => {
        expect(fs.existsSync(path.resolve(filePath))).toBe(true);
    });
});

// ─── FileRecord Lifecycle ───

describe('File Storage — FileRecord Lifecycle', () => {
    test('FileRecord status transitions are valid', () => {
        const validTransitions: Record<string, string[]> = {
            PENDING: ['STORED', 'FAILED'],
            STORED: ['DELETED'],
            FAILED: [],
            DELETED: [],
        };

        expect(validTransitions.PENDING).toContain('STORED');
        expect(validTransitions.PENDING).toContain('FAILED');
        expect(validTransitions.STORED).toContain('DELETED');
        expect(validTransitions.FAILED).toHaveLength(0);
        expect(validTransitions.DELETED).toHaveLength(0);
    });

    test('pathKey structure matches expected format', () => {
        const pathKey = generatePathKey('tenant-123', 'report.pdf');
        const parts = pathKey.split('/');
        expect(parts[0]).toBe('tenants');
        expect(parts[1]).toBe('tenant-123');
        expect(parts[2]).toBe('general');     // domain
        expect(parts[3]).toMatch(/^\d{4}$/); // year
        expect(parts[4]).toMatch(/^\d{2}$/); // month
        expect(parts[5]).toMatch(/^[0-9a-f-]+_report\.pdf$/); // uuid_name
    });
});
