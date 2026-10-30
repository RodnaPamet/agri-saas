/**
 * Storage Key Builder & Tenant Isolation Tests
 *
 * Tests the domain-scoped key builder, tenant key assertions,
 * key parsing, and S3 provider with mocked SDK calls.
 */
import { Readable } from 'stream';

// ─── Mock env ───
jest.mock('@/env', () => ({
    env: {
        FILE_STORAGE_ROOT: '/tmp/test-storage',
        UPLOAD_DIR: '/tmp/test-storage',
        STORAGE_PROVIDER: 'local',
        S3_BUCKET: 'test-bucket',
        S3_REGION: 'us-east-1',
    },
}));

import {
    buildTenantObjectKey,
    generatePathKey,
    assertTenantKey,
    parseTenantKey,
} from '@/lib/storage/index';
import type { StorageDomain } from '@/lib/storage/index';

// ═══════════════════════════════════════════════════════════════
//  buildTenantObjectKey — Domain-scoped key builder
// ═══════════════════════════════════════════════════════════════

describe('buildTenantObjectKey', () => {
    const fixedDate = new Date('2026-03-15T10:00:00Z');

    it('produces key with correct format: tenants/{tenantId}/{domain}/{yyyy}/{mm}/{uuid}.{ext}', () => {
        const key = buildTenantObjectKey('tenant-abc', 'evidence', 'report.pdf', { date: fixedDate });
        expect(key).toMatch(/^tenants\/tenant-abc\/evidence\/2026\/03\/[a-f0-9-]+\.pdf$/);
    });

    it('does NOT put the filename in the key (#2497)', () => {
        // The property, not a format detail. A filename in this product
        // routinely IS personal data, and `pathKey` is plaintext, `@unique`,
        // and — under STORAGE_PROVIDER=local — a real path on a disk that is
        // snapshotted daily.
        const key = buildTenantObjectKey('t1', 'evidence', 'Договор аренда Иванов.pdf', {
            date: fixedDate,
        });
        expect(key).not.toContain('Иванов');
        expect(key).not.toContain('Договор');
        expect(key).toMatch(/^tenants\/t1\/evidence\/2026\/03\/[a-f0-9-]+\.pdf$/);
    });

    it('keeps only the LAST dot-segment, lowercased and bounded', () => {
        const ext = (name: string) =>
            buildTenantObjectKey('t1', 'evidence', name, { date: fixedDate }).split('/').pop()!.replace(/^[a-f0-9-]+/, '');
        expect(ext('archive.tar.gz')).toBe('.gz');
        expect(ext('REPORT.PDF')).toBe('.pdf');
        // A leading dot is not an extension.
        expect(ext('.gitignore')).toBe('');
        expect(ext('noextension')).toBe('');
        // Nothing unbounded or non-alphanumeric reaches a path.
        expect(ext('x.' + 'y'.repeat(50))).toBe('');
        expect(ext('x.документ')).toBe('');
    });

    it('uses correct domain in path', () => {
        const domains: StorageDomain[] = ['evidence', 'reports', 'exports', 'temp', 'general'];
        for (const domain of domains) {
            const key = buildTenantObjectKey('t1', domain, 'file.txt', { date: fixedDate });
            expect(key).toContain(`/${domain}/`);
        }
    });

    it('cannot be made to carry a traversal, because it carries no name at all', () => {
        // This asserted `/_passwd$/` — that the sanitised basename survived.
        // Since #2497 the key has no filename, so the traversal property holds
        // more strongly: there is nothing to sanitise and nothing to escape.
        const key = buildTenantObjectKey('t1', 'evidence', '../../../etc/passwd', { date: fixedDate });
        expect(key).not.toContain('..');
        expect(key).not.toContain('passwd');
        expect(key).toMatch(/^tenants\/t1\/evidence\/2026\/03\/[a-f0-9-]+$/);
    });

    it('handles filenames with special characters', () => {
        const key = buildTenantObjectKey('t1', 'reports', 'my <file> "test".pdf', { date: fixedDate });
        expect(key).not.toMatch(/[<>"]/);
        expect(key).toMatch(/^tenants\/t1\/reports\//);
        // Nothing of the name survives, special characters included.
        expect(key).not.toContain('test');
    });

    it('throws if tenantId is empty', () => {
        expect(() => buildTenantObjectKey('', 'evidence', 'file.txt')).toThrow('tenantId is required');
    });

    it('throws if originalName is empty', () => {
        expect(() => buildTenantObjectKey('t1', 'evidence', '')).toThrow('originalName is required');
    });

    it('throws if domain is invalid', () => {
        expect(() => buildTenantObjectKey('t1', 'invalid' as StorageDomain, 'file.txt')).toThrow('Invalid storage domain');
    });

    it('uses current date if no date option', () => {
        const key = buildTenantObjectKey('t1', 'evidence', 'file.txt');
        const now = new Date();
        const yyyy = now.getFullYear().toString();
        expect(key).toContain(`/${yyyy}/`);
    });

    it('generates unique keys for same inputs', () => {
        const key1 = buildTenantObjectKey('t1', 'evidence', 'file.txt');
        const key2 = buildTenantObjectKey('t1', 'evidence', 'file.txt');
        expect(key1).not.toBe(key2);
    });

    it('limits filename length', () => {
        const longName = 'a'.repeat(500) + '.pdf';
        const key = buildTenantObjectKey('t1', 'general', longName, { date: fixedDate });
        const filename = key.split('/').pop()!;
        expect(filename.length).toBeLessThanOrEqual(237); // uuid(36) + _(1) + 200
    });
});

// ═══════════════════════════════════════════════════════════════
//  generatePathKey — Backward-compat wrapper
// ═══════════════════════════════════════════════════════════════

describe('generatePathKey (backward-compat)', () => {
    it('uses "general" domain', () => {
        const key = generatePathKey('tenant-xyz', 'file.txt');
        expect(key).toContain('/general/');
    });

    it('produces valid tenant-scoped key', () => {
        const key = generatePathKey('t1', 'doc.pdf');
        expect(key).toMatch(/^tenants\/t1\/general\/\d{4}\/\d{2}\/[a-f0-9-]+\.pdf$/);
    });
});

// ═══════════════════════════════════════════════════════════════
//  assertTenantKey — Runtime tenant isolation guard
// ═══════════════════════════════════════════════════════════════

describe('assertTenantKey', () => {
    it('passes for matching tenant', () => {
        const key = buildTenantObjectKey('tenant-abc', 'evidence', 'file.pdf');
        expect(() => assertTenantKey(key, 'tenant-abc')).not.toThrow();
    });

    it('throws for wrong tenant', () => {
        const key = buildTenantObjectKey('tenant-abc', 'evidence', 'file.pdf');
        expect(() => assertTenantKey(key, 'tenant-xyz')).toThrow('Tenant isolation violation');
    });

    it('throws for crafted traversal key', () => {
        expect(() => assertTenantKey('tenants/other-tenant/../tenant-abc/file', 'tenant-abc')).toThrow('Tenant isolation violation');
    });

    it('throws for keys without tenant prefix', () => {
        expect(() => assertTenantKey('some/random/path.txt', 'tenant-abc')).toThrow('Tenant isolation violation');
    });
});

// ═══════════════════════════════════════════════════════════════
//  parseTenantKey — Key metadata extraction
// ═══════════════════════════════════════════════════════════════

describe('parseTenantKey', () => {
    it('still parses keys minted BEFORE the filename was dropped (#2497)', () => {
        // The property that makes #2497 safe to do in place. Existing objects
        // live at `<uuid>_<filename>` keys and nothing moves them, so if this
        // regex stopped accepting that shape, every file uploaded before the
        // change would read as malformed — `parseTenantKey` returning null and
        // callers treating a perfectly valid key as crafted.
        //
        // This exact drift has happened once already: `cost-invoice` was added
        // to the domain union and to the builder but not to this regex, so
        // keys this module had itself minted parsed as null. Changing the key
        // shape without widening the tail would have been that bug again, for
        // EVERY new key rather than one domain.
        const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        const base = `tenants/t1/evidence/2026/03/${uuid}`;

        expect(parseTenantKey(`${base}_audit-report.pdf`)).toEqual({
            tenantId: 't1',
            domain: 'evidence',
        });
        expect(parseTenantKey(`${base}.pdf`)).toEqual({ tenantId: 't1', domain: 'evidence' });
        expect(parseTenantKey(base)).toEqual({ tenantId: 't1', domain: 'evidence' });

        // And still refuses what it always refused.
        expect(parseTenantKey('tenants/t1/not-a-domain/2026/03/' + uuid)).toBeNull();
        expect(parseTenantKey('tenants/t1/evidence/26/3/' + uuid)).toBeNull();
    });

    it('extracts tenantId and domain from valid key', () => {
        const key = buildTenantObjectKey('my-tenant', 'reports', 'quarterly.pdf');
        const parsed = parseTenantKey(key);
        expect(parsed).toEqual({ tenantId: 'my-tenant', domain: 'reports' });
    });

    it('returns null for invalid key format', () => {
        expect(parseTenantKey('random/path.txt')).toBeNull();
        expect(parseTenantKey('')).toBeNull();
    });

    it('handles all valid domains', () => {
        const domains: StorageDomain[] = ['evidence', 'reports', 'exports', 'temp', 'general'];
        for (const domain of domains) {
            const key = buildTenantObjectKey('t1', domain, 'file.txt');
            const parsed = parseTenantKey(key);
            expect(parsed?.domain).toBe(domain);
        }
    });
});

// ═══════════════════════════════════════════════════════════════
//  S3StorageProvider — Mocked SDK tests
// ═══════════════════════════════════════════════════════════════

// Mock the entire AWS SDK
const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    PutObjectCommand: jest.fn().mockImplementation((input) => ({ __type: 'PutObject', ...input })),
    GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: 'GetObject', ...input })),
    HeadObjectCommand: jest.fn().mockImplementation((input) => ({ __type: 'HeadObject', ...input })),
    DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ __type: 'DeleteObject', ...input })),
    CopyObjectCommand: jest.fn().mockImplementation((input) => ({ __type: 'CopyObject', ...input })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

describe('S3StorageProvider', () => {

    const { S3StorageProvider } = require('@/lib/storage/s3-provider');

    let provider: InstanceType<typeof S3StorageProvider>;

    beforeEach(() => {
        jest.clearAllMocks();
        provider = new S3StorageProvider();
    });

    it('has name "s3"', () => {
        expect(provider.name).toBe('s3');
    });

    describe('write', () => {
        it('sends PutObjectCommand with correct bucket and key', async () => {
            mockSend.mockResolvedValueOnce({});

            const key = 'tenants/t1/evidence/2026/03/uuid_test.pdf';
            const buffer = Buffer.from('test content');
            const result = await provider.write(key, buffer, { mimeType: 'application/pdf' });

            expect(mockSend).toHaveBeenCalledTimes(1);
            const command = mockSend.mock.calls[0][0];
            expect(command.Bucket).toBe('test-bucket');
            expect(command.Key).toBe(key);
            expect(command.ContentType).toBe('application/pdf');
            expect(result.sizeBytes).toBe(buffer.length);
            expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
        });

        it('writes stream data correctly', async () => {
            mockSend.mockResolvedValueOnce({});

            const key = 'tenants/t1/evidence/2026/03/uuid_stream.txt';
            const stream = Readable.from(['hello ', 'world']);
            const result = await provider.write(key, stream);

            expect(result.sizeBytes).toBe(11); // 'hello world'
            expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
        });

        it('rejects files exceeding maxSizeBytes', async () => {
            const key = 'tenants/t1/evidence/2026/03/uuid_big.bin';
            const bigBuffer = Buffer.alloc(1024);

            await expect(
                provider.write(key, bigBuffer, { maxSizeBytes: 512 })
            ).rejects.toThrow(/exceeds maximum/);
            expect(mockSend).not.toHaveBeenCalled();
        });
    });

    describe('createSignedDownloadUrl', () => {
        it('returns presigned URL', async () => {
            const expectedUrl = 'https://bucket.s3.amazonaws.com/tenants/t1/file.pdf?X-Amz-...';
            mockGetSignedUrl.mockResolvedValueOnce(expectedUrl);

            const url = await provider.createSignedDownloadUrl('tenants/t1/file.pdf', { expiresIn: 900 });
            expect(url).toBe(expectedUrl);
            expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
        });

        it('passes download filename as Content-Disposition', async () => {
            mockGetSignedUrl.mockResolvedValueOnce('https://...');

            await provider.createSignedDownloadUrl('tenants/t1/file.pdf', {
                downloadFilename: 'audit-report.pdf',
            });

            const command = mockGetSignedUrl.mock.calls[0][1];
            expect(command.ResponseContentDisposition).toContain('audit-report.pdf');
        });
    });

    describe('createSignedUploadUrl', () => {
        it('returns presigned upload target', async () => {
            mockGetSignedUrl.mockResolvedValueOnce('https://upload-url');

            const result = await provider.createSignedUploadUrl('tenants/t1/file.pdf', {
                mimeType: 'application/pdf',
                expiresIn: 600,
            });

            expect(result.url).toBe('https://upload-url');
            expect(result.method).toBe('PUT');
            expect(result.expiresIn).toBe(600);
        });
    });

    describe('head', () => {
        it('returns object metadata', async () => {
            mockSend.mockResolvedValueOnce({
                ContentLength: 42,
                ContentType: 'application/pdf',
                LastModified: new Date('2026-03-15'),
            });

            const result = await provider.head('tenants/t1/file.pdf');
            expect(result.sizeBytes).toBe(42);
            expect(result.mimeType).toBe('application/pdf');
        });
    });

    describe('delete', () => {
        it('sends DeleteObjectCommand', async () => {
            mockSend.mockResolvedValueOnce({});

            await provider.delete('tenants/t1/file.pdf');

            expect(mockSend).toHaveBeenCalledTimes(1);
            const command = mockSend.mock.calls[0][0];
            expect(command.__type).toBe('DeleteObject');
            expect(command.Key).toBe('tenants/t1/file.pdf');
        });
    });

    describe('copy', () => {
        it('sends CopyObjectCommand with correct source', async () => {
            mockSend.mockResolvedValueOnce({});

            await provider.copy('tenants/t1/src.pdf', 'tenants/t1/dest.pdf');

            const command = mockSend.mock.calls[0][0];
            expect(command.__type).toBe('CopyObject');
            expect(command.Key).toBe('tenants/t1/dest.pdf');
            expect(command.CopySource).toBe('test-bucket/tenants/t1/src.pdf');
        });
    });
});
