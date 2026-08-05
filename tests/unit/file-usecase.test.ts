/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/file.ts`.
 *
 * Single-function file — `downloadFile`. Provider-dispatched: S3
 * goes through `createSignedDownloadUrl` (mode: 'redirect'), local
 * fallback streams through the storage provider (mode: 'stream').
 *
 * Roadmap Q1 — Evidence + files. Mocks FileRepository, storage,
 * audit, runInTenantContext, and the storage abstraction.
 *
 * Covers:
 *   - Tenant-ownership gate via FileRepository.isFileOwnedByTenant.
 *   - S3 provider — presigned URL path with FileRecord lookup +
 *     READ audit + redirect mode payload.
 *   - S3 + no FileRecord — falls through to the local-stream path.
 *   - Local provider — stream concatenation into a buffer, MIME
 *     map for common extensions + octet-stream fallback,
 *     safeName strip of leading slashes, READ audit.
 *   - Forbidden when the file is not owned by the tenant.
 *   - notFound when the storage provider throws.
 */

const mockDb = {
    fileRecord: { findFirst: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        findOwnedByTenant: jest.fn(),
    },
}));

const mockStorage: any = {
    name: 'local',
    readStream: jest.fn(),
    createSignedDownloadUrl: jest.fn(),
};

jest.mock('@/lib/storage', () => ({
    getStorageProvider: jest.fn(() => mockStorage),
    assertTenantKey: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { logEvent } from '@/app-layer/events/audit';
import { assertTenantKey } from '@/lib/storage';
import { downloadFile } from '@/app-layer/usecases/file';
import { makeRequestContext } from '../helpers/make-context';

async function* streamFrom(buffers: Buffer[]) {
    for (const b of buffers) yield b;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.name = 'local';
});

const readerCtx = makeRequestContext('READER');

// ─── Forbidden + notFound ──────────────────────────────────────────

describe('downloadFile — gate + missing', () => {
    it('404s (not 403s) when the file does not belong to the tenant', async () => {
        // A 403 confirms the object exists — an existence oracle across
        // tenants. notFound is indistinguishable from "no such file".
        (FileRepository.findOwnedByTenant as jest.Mock).mockResolvedValue(null);
        await expect(downloadFile(readerCtx, 'foreign/file.pdf')).rejects.toThrow(/File not found/i);
        expect(mockStorage.readStream).not.toHaveBeenCalled();
    });

    it('throws notFound when the provider stream errors (file gone)', async () => {
        (FileRepository.findOwnedByTenant as jest.Mock).mockResolvedValue({
            id: 'file-1',
            pathKey: 'tenants/tenant-1/general/doc.pdf',
            originalName: 'note.pdf',
            mimeType: 'application/pdf',
            status: 'STORED',
            scanStatus: 'CLEAN',
        });
        mockStorage.readStream.mockImplementation(() => { throw new Error('ENOENT'); });
        await expect(downloadFile(readerCtx, 'gone.pdf')).rejects.toThrow(/File not found on disk/i);
    });
});

// ─── Local provider — stream + MIME mapping ────────────────────────

describe('downloadFile — local provider stream mode', () => {
    it('concatenates the stream into a single buffer with the right MIME', async () => {
        (FileRepository.findOwnedByTenant as jest.Mock).mockResolvedValue({
            id: 'file-1',
            pathKey: 'tenants/tenant-1/general/doc.pdf',
            originalName: 'note.pdf',
            mimeType: 'application/pdf',
            status: 'STORED',
            scanStatus: 'CLEAN',
        });
        mockStorage.readStream.mockReturnValue(streamFrom([Buffer.from('hello '), Buffer.from('world')]));

        const res = await downloadFile(readerCtx, 'docs/note.pdf');

        expect(res.mode).toBe('stream');
        expect((res as any).buffer.toString()).toBe('hello world');
        expect(res.mimeType).toBe('application/pdf');
        expect(res.name).toBe('note.pdf');
    });

    it('reads the RESOLVED pathKey, never the caller string', async () => {
        // The whole bug in one assertion. The caller asks for one key; the
        // bytes must come from the key on the tenant-owned record.
        (FileRepository.findOwnedByTenant as jest.Mock).mockResolvedValue({
            id: 'file-1',
            pathKey: 'tenants/tenant-1/general/doc.pdf',
            originalName: 'note.pdf',
            mimeType: 'application/pdf',
            status: 'STORED',
            scanStatus: 'CLEAN',
        });
        mockStorage.readStream.mockReturnValue(streamFrom([Buffer.from('x')]));

        await downloadFile(readerCtx, 'tenants/OTHER-TENANT/general/secret.pdf');

        expect(mockStorage.readStream).toHaveBeenCalledWith('tenants/tenant-1/general/doc.pdf');
        expect(mockStorage.readStream).not.toHaveBeenCalledWith(
            'tenants/OTHER-TENANT/general/secret.pdf',
        );
    });

    it('takes name and MIME from the record, not from the requested extension', async () => {
        // MIME used to be guessed from the caller's extension and replayed as
        // the download Content-Type — i.e. the caller chose what the browser
        // would treat the bytes as.
        (FileRepository.findOwnedByTenant as jest.Mock).mockResolvedValue({
            id: 'file-1',
            pathKey: 'tenants/tenant-1/general/doc.pdf',
            originalName: 'note.pdf',
            mimeType: 'application/pdf',
            status: 'STORED',
            scanStatus: 'CLEAN',
        });
        mockStorage.readStream.mockReturnValue(streamFrom([Buffer.from('x')]));

        const res = await downloadFile(readerCtx, 'a/b/c/report.csv');

        expect(res.name).toBe('note.pdf');
        expect(res.mimeType).toBe('application/pdf');
    });

    it('emits READ audit on success', async () => {
        (FileRepository.findOwnedByTenant as jest.Mock).mockResolvedValue({
            id: 'file-1',
            pathKey: 'tenants/tenant-1/general/doc.pdf',
            originalName: 'note.pdf',
            mimeType: 'application/pdf',
            status: 'STORED',
            scanStatus: 'CLEAN',
        });
        mockStorage.readStream.mockReturnValue(streamFrom([Buffer.from('x')]));
        await downloadFile(readerCtx, 'note.pdf');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('READ');
        expect(payload.entityType).toBe('File');
    });

    it('handles string chunks in the stream (non-Buffer)', async () => {
        (FileRepository.findOwnedByTenant as jest.Mock).mockResolvedValue({
            id: 'file-1',
            pathKey: 'tenants/tenant-1/general/doc.pdf',
            originalName: 'note.pdf',
            mimeType: 'application/pdf',
            status: 'STORED',
            scanStatus: 'CLEAN',
        });
        // Stream yields strings; the usecase normalises via Buffer.from
        mockStorage.readStream.mockReturnValue(streamFrom([Buffer.from('') ]));
        const customStream = (async function* () { yield 'string-chunk'; })();
        mockStorage.readStream.mockReturnValue(customStream);
        const res = await downloadFile(readerCtx, 'log.txt');
        expect((res as any).buffer.toString()).toBe('string-chunk');
    });
});

// ─── S3 provider — presigned URL ───────────────────────────────────

describe('downloadFile — S3 provider', () => {
    beforeEach(() => {
        mockStorage.name = 's3';
    });

    it('returns redirect mode with a presigned URL when the FileRecord matches', async () => {
        (FileRepository.findOwnedByTenant as jest.Mock).mockResolvedValue({
            id: 'file-1',
            pathKey: 'tenants/tenant-1/general/doc.pdf',
            originalName: 'note.pdf',
            mimeType: 'application/pdf',
            status: 'STORED',
            scanStatus: 'CLEAN',
        });
        mockStorage.createSignedDownloadUrl.mockResolvedValue('https://s3.example.com/signed-url');

        const res = await downloadFile(readerCtx, 'anything-the-caller-typed');

        expect(res).toEqual({
            mode: 'redirect',
            downloadUrl: 'https://s3.example.com/signed-url',
            name: 'note.pdf',
            mimeType: 'application/pdf',
        });
        // Signed against the RESOLVED key, and asserted before signing.
        expect(assertTenantKey).toHaveBeenCalledWith(
            'tenants/tenant-1/general/doc.pdf',
            readerCtx.tenantId,
        );
        expect(mockStorage.createSignedDownloadUrl).toHaveBeenCalledWith(
            'tenants/tenant-1/general/doc.pdf',
            { expiresIn: 300, downloadFilename: 'note.pdf' },
        );
    });

    it('emits READ audit with the file original name', async () => {
        (FileRepository.findOwnedByTenant as jest.Mock).mockResolvedValue({
            id: 'file-1',
            pathKey: 'tenants/tenant-1/general/doc.pdf',
            originalName: 'note.pdf',
            mimeType: 'application/pdf',
            status: 'STORED',
            scanStatus: 'CLEAN',
        });

        mockStorage.createSignedDownloadUrl.mockResolvedValue('https://x');

        await downloadFile(readerCtx, 'tenant-1/x.pdf');

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('READ');
        expect(payload.details).toMatch(/presigned URL/);
    });

    it('does NOT fall through to a local read when no record matches (S3)', async () => {
        // This fallthrough WAS the vulnerability: an unmatched key on S3 fell
        // to `storage.readStream(fileName)` with the caller's raw string. An
        // unresolvable key is now simply not found.
        (FileRepository.findOwnedByTenant as jest.Mock).mockResolvedValue(null);

        await expect(downloadFile(readerCtx, 'tenants/OTHER/secret.pdf')).rejects.toThrow(
            /File not found/i,
        );
        expect(mockStorage.readStream).not.toHaveBeenCalled();
        expect(mockStorage.createSignedDownloadUrl).not.toHaveBeenCalled();
    });
});
