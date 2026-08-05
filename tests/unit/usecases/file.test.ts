/**
 * Unit tests for src/app-layer/usecases/file.ts
 *
 * Wave 4 of GAP-02. File download is the surface where the storage
 * abstraction meets tenant isolation. A regression here is a direct
 * cross-tenant data-exfiltration vector.
 *
 * Behaviours protected:
 *   1. assertCanRead gate (no anonymous downloads).
 *   2. FileRepository.isFileOwnedByTenant gates EVERY download —
 *      a 403 fires BEFORE any storage call.
 *   3. S3 path: assertTenantKey verifies the pathKey is prefixed by
 *      the caller's tenantId before the presigned-URL is minted.
 *   4. Local-fallback path: notFound error when storage stream throws.
 *   5. READ audit emit on every successful download.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx, fn) => fn({} as never)),
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        findOwnedByTenant: jest.fn(),
    },
}));

jest.mock('@/lib/storage', () => ({
    getStorageProvider: jest.fn(),
    assertTenantKey: jest.fn(),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import { downloadFile } from '@/app-layer/usecases/file';
import { runInTenantContext } from '@/lib/db-context';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { getStorageProvider, assertTenantKey } from '@/lib/storage';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockOwnedBy = FileRepository.findOwnedByTenant as jest.MockedFunction<typeof FileRepository.findOwnedByTenant>;
const mockGetStorage = getStorageProvider as jest.MockedFunction<typeof getStorageProvider>;
const mockAssertKey = assertTenantKey as jest.MockedFunction<typeof assertTenantKey>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTx.mockImplementation(async (_ctx, fn) => fn({} as never));
});

describe('downloadFile — gate ordering', () => {
    it('rejects when canRead is missing — short of any storage call', async () => {
        // assertCanRead is satisfied by every Role today, but a future
        // role with canRead=false would short-circuit here.
        const ctx = { ...makeRequestContext('READER'), permissions: {
            canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false,
        } } as never;

        await expect(
            downloadFile(ctx, 'tenant-1/file.pdf'),
        ).rejects.toThrow();
        expect(mockOwnedBy).not.toHaveBeenCalled();
    });

    it('rejects with forbidden when the file does not belong to the caller tenant', async () => {
        mockOwnedBy.mockResolvedValueOnce(null);

        await expect(
            downloadFile(makeRequestContext('EDITOR'), 'tenant-B/secret.pdf'),
        ).rejects.toThrow(/permission to access this file/);
        // Regression: a refactor that skipped this check would let any
        // logged-in user pass an arbitrary path key and exfiltrate
        // another tenant's evidence files.
        expect(mockGetStorage).not.toHaveBeenCalled();
    });
});

describe('downloadFile — S3 path', () => {
    it('asserts tenantKey on the FileRecord pathKey before minting the presigned URL', async () => {
        mockOwnedBy.mockResolvedValueOnce({
        id: 'file-1',
        pathKey: 'tenants/tenant-1/general/doc.pdf',
        originalName: 'note.pdf',
        mimeType: 'application/pdf',
        status: 'STORED',
        scanStatus: 'CLEAN',
    });
        const createSignedDownloadUrl = jest.fn().mockResolvedValue('https://signed.example.com/foo');
        mockGetStorage.mockReturnValue({
            name: 's3',
            createSignedDownloadUrl,
        } as never);

        const fakeDb = {
            fileRecord: {
                findFirst: jest.fn().mockResolvedValue({
                    pathKey: 'tenant-1/evidence/file.pdf',
                    originalName: 'file.pdf',
                    mimeType: 'application/pdf',
                }),
            },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        const result = await downloadFile(makeRequestContext('EDITOR'), 'tenant-1/evidence/file.pdf');

        // Regression: a refactor that skipped assertTenantKey could
        // hand out a URL keyed on another tenant's prefix, even after
        // the ownership check passed.
        expect(mockAssertKey).toHaveBeenCalledWith(
            'tenant-1/evidence/file.pdf',
            'tenant-1',
        );
        expect(result.mode).toBe('redirect');
        expect((result as { downloadUrl?: string }).downloadUrl).toBe('https://signed.example.com/foo');
    });

    it('emits a READ audit on S3 download', async () => {
        mockOwnedBy.mockResolvedValueOnce({
        id: 'file-1',
        pathKey: 'tenants/tenant-1/general/doc.pdf',
        originalName: 'note.pdf',
        mimeType: 'application/pdf',
        status: 'STORED',
        scanStatus: 'CLEAN',
    });
        mockGetStorage.mockReturnValue({
            name: 's3',
            createSignedDownloadUrl: jest.fn().mockResolvedValue('https://x'),
        } as never);

        const fakeDb = {
            fileRecord: {
                findFirst: jest.fn().mockResolvedValue({
                    pathKey: 'tenant-1/f.pdf',
                    originalName: 'f.pdf',
                    mimeType: 'application/pdf',
                }),
            },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await downloadFile(makeRequestContext('EDITOR'), 'tenant-1/f.pdf');

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'READ', entityType: 'File' }),
        );
    });
});

describe('downloadFile — local fallback', () => {
    it('returns a stream-mode buffer with the inferred mimeType', async () => {
        mockOwnedBy.mockResolvedValueOnce({
        id: 'file-1',
        pathKey: 'tenants/tenant-1/general/doc.pdf',
        originalName: 'note.pdf',
        mimeType: 'application/pdf',
        status: 'STORED',
        scanStatus: 'CLEAN',
    });

        async function* fakeStream() {
            yield Buffer.from('hello');
            yield Buffer.from(' world');
        }
        mockGetStorage.mockReturnValue({
            name: 'local',
            readStream: jest.fn(() => fakeStream()),
        } as never);

        const result = await downloadFile(
            makeRequestContext('EDITOR'),
            'tenant-1/evidence/report.csv',
        );

        expect(result.mode).toBe('stream');
        const r = result as { mimeType: string; buffer: Buffer; name: string };
        expect(r.mimeType).toBe('text/csv');
        expect(r.buffer.toString()).toBe('hello world');
        expect(r.name).toBe('report.csv');
    });

    it('throws notFound when the storage stream throws', async () => {
        mockOwnedBy.mockResolvedValueOnce({
        id: 'file-1',
        pathKey: 'tenants/tenant-1/general/doc.pdf',
        originalName: 'note.pdf',
        mimeType: 'application/pdf',
        status: 'STORED',
        scanStatus: 'CLEAN',
    });
        mockGetStorage.mockReturnValue({
            name: 'local',
            readStream: jest.fn(() => {
                throw new Error('ENOENT');
            }),
        } as never);

        await expect(
            downloadFile(makeRequestContext('EDITOR'), 'tenant-1/missing.pdf'),
        ).rejects.toThrow(/File not found/);
    });

    it('falls back to application/octet-stream for unknown extensions', async () => {
        mockOwnedBy.mockResolvedValueOnce({
        id: 'file-1',
        pathKey: 'tenants/tenant-1/general/doc.pdf',
        originalName: 'note.pdf',
        mimeType: 'application/pdf',
        status: 'STORED',
        scanStatus: 'CLEAN',
    });
        async function* s() {
            yield Buffer.from('blob');
        }
        mockGetStorage.mockReturnValue({
            name: 'local',
            readStream: jest.fn(() => s()),
        } as never);

        const result = await downloadFile(
            makeRequestContext('EDITOR'),
            'tenant-1/binary.xyz',
        );

        const r = result as { mimeType: string };
        expect(r.mimeType).toBe('application/octet-stream');
    });
});
