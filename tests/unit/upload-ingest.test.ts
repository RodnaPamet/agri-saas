/**
 * `ingestUploadedFile` — the one upload ingest pipeline.
 *
 * This block existed near-verbatim in three usecases and in a degraded form
 * in two more, and the degraded copies are the reason it now exists once:
 * they skipped the byte sniff and the AV scan. So the cases below are the
 * steps themselves, each named by what its absence would allow.
 *
 * These EXECUTE the pipeline. `tests/guards/upload-scan-explicitness.test.ts`
 * covers the structural half (no call site omits a scan status) and, being a
 * guard, proves nothing about behaviour.
 */

// Parameters are declared even though the body ignores them: an argument-less
// `jest.fn` types its `mock.calls` as `[]`, so asserting on `calls[0][2]`
// (the write options, where the RESOLVED mime type has to land) is a compile
// error rather than a test.
const mockWrite = jest.fn(
    async (
        _pathKey: string,
        _body: unknown,
        _opts?: { mimeType?: string },
    ): Promise<{ sha256: string; sizeBytes: number }> => ({
        sha256: 'sha-1',
        sizeBytes: 11,
    }),
);
const mockDelete = jest.fn();
let allowedMime = true;
let sniffResult = { resolved: 'application/pdf', detected: null as string | null, corrected: false };
let scanVerdict: string = 'CLEAN';

jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({ name: 'local', write: mockWrite, delete: mockDelete }),
    buildTenantObjectKey: (tenantId: string, domain: string, name: string) =>
        `tenants/${tenantId}/${domain}/2026/08/abc_${name}`,
    isAllowedMime: () => allowedMime,
    isAllowedSize: (n: number) => n <= 1000,
    FILE_MAX_SIZE_BYTES: 1000,
}));
jest.mock('@/lib/storage/mime-sniff', () => ({
    reconcileMimeType: () => sniffResult,
}));
jest.mock('@/lib/storage/av-scan', () => ({
    scanUploadedBuffer: async () => scanVerdict,
}));

import { ingestUploadedFile } from '@/lib/upload/ingest';

/** A minimal `File` stand-in — jsdom's File is not available under node-env. */
function fakeFile(over: Partial<{ name: string; type: string; size: number; body: string }> = {}) {
    const body = over.body ?? 'hello world';
    return {
        name: over.name ?? 'invoice.pdf',
        type: over.type ?? 'application/pdf',
        size: over.size ?? body.length,
        arrayBuffer: async () => Buffer.from(body),
    } as unknown as File;
}

const OPTS = { domain: 'cost-invoice' as const, fallbackName: 'invoice', component: 'test' };

/**
 * Run and return the rejection.
 *
 * These paths call `badRequest(CODE, humanText)`, and `badRequest`'s first
 * argument is the MESSAGE — so the stable machine code lands on `.message`
 * and the sentence a person reads lands on `.details`. Asserting both keeps
 * the two from being swapped, which would ship an error whose code is prose.
 */
async function rejection(p: Promise<unknown>) {
    try {
        await p;
        throw new Error('expected a rejection, got none');
    } catch (e) {
        return e as Error & { details?: unknown };
    }
}

beforeEach(() => {
    jest.clearAllMocks();
    allowedMime = true;
    sniffResult = { resolved: 'application/pdf', detected: null, corrected: false };
    scanVerdict = 'CLEAN';
});

describe('ingestUploadedFile', () => {
    it('returns everything a caller needs to mint its own FileRecord', async () => {
        const out = await ingestUploadedFile('t-1', fakeFile(), OPTS);
        expect(out).toMatchObject({
            originalName: 'invoice.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 11,
            sha256: 'sha-1',
            storageProvider: 'local',
            domain: 'cost-invoice',
            scanStatus: 'CLEAN',
        });
        expect(out.pathKey).toContain('tenants/t-1/cost-invoice/');
    });

    it('RETURNS the scan verdict rather than defaulting it', async () => {
        // The whole point. A pipeline that swallowed the verdict would put
        // the caller back to guessing, which is the bug this replaced.
        scanVerdict = 'INFECTED';
        const out = await ingestUploadedFile('t-1', fakeFile(), OPTS);
        expect(out.scanStatus).toBe('INFECTED');
    });

    it('rejects a disallowed declared type BEFORE reading any bytes', async () => {
        allowedMime = false;
        const file = fakeFile();
        const spy = jest.spyOn(file, 'arrayBuffer');
        const err = await rejection(ingestUploadedFile('t-1', file, OPTS));
        expect(err.message).toBe('FILE_TYPE_NOT_ALLOWED');
        expect(String(err.details)).toMatch(/is not allowed/i);
        // Cheap rejection first: a 50 MB body must not be buffered only to
        // be thrown away.
        expect(spy).not.toHaveBeenCalled();
        expect(mockWrite).not.toHaveBeenCalled();
    });

    it('rejects an oversized file', async () => {
        const err = await rejection(ingestUploadedFile('t-1', fakeFile({ size: 5000 }), OPTS));
        expect(err.message).toBe('FILE_TOO_LARGE');
        expect(String(err.details)).toMatch(/maximum size/i);
        expect(mockWrite).not.toHaveBeenCalled();
    });

    it('honours a per-surface cap smaller than the global one', async () => {
        const err = await rejection(
            ingestUploadedFile('t-1', fakeFile({ size: 900 }), { ...OPTS, maxBytes: 100 }),
        );
        expect(err.message).toBe('FILE_TOO_LARGE');
        // The SURFACE's cap in the text, not the global one — an operator
        // reading "exceeds 1000 bytes" for a 100-byte cap is being misled.
        expect(String(err.details)).toContain('100');
    });

    it('rejects an EMPTY file', async () => {
        // A zero-byte upload is almost always a failed pick or a dropped
        // connection. Storing it produces a record pointing at nothing.
        const err = await rejection(
            ingestUploadedFile('t-1', fakeFile({ size: 0, body: '' }), OPTS),
        );
        expect(err.message).toBe('FILE_EMPTY');
    });

    it('re-applies the allowlist to what the BYTES say, not the claim', async () => {
        // The declared type passes; the signature says something else that
        // is not allowed. Without this second check a .pdf full of HTML is
        // stored and later served.
        sniffResult = { resolved: 'text/html', detected: 'text/html', corrected: true };
        allowedMime = true;
        const calls: string[] = [];
        // Allow the declared type, refuse the sniffed one.
        const storage = jest.requireMock('@/lib/storage');
        storage.isAllowedMime = (m: string) => {
            calls.push(m);
            return m !== 'text/html';
        };
        const err = await rejection(ingestUploadedFile('t-1', fakeFile(), OPTS));
        expect(err.message).toBe('FILE_TYPE_NOT_ALLOWED');
        expect(String(err.details)).toMatch(/File content is "text\/html"/);
        expect(calls).toEqual(['application/pdf', 'text/html']);
    });

    it('stores the RESOLVED type when the bytes contradict an allowed claim', async () => {
        sniffResult = { resolved: 'image/png', detected: 'image/png', corrected: true };
        const out = await ingestUploadedFile('t-1', fakeFile(), OPTS);
        expect(out.mimeType).toBe('image/png');
        expect(mockWrite.mock.calls[0][2]).toEqual({ mimeType: 'image/png' });
    });

    it('lets a surface NARROW the allowlist without widening it', async () => {
        const err = await rejection(
            ingestUploadedFile('t-1', fakeFile(), {
                ...OPTS,
                extraCheck: () => 'Only .zip archives are accepted',
            }),
        );
        expect(err.message).toBe('FILE_TYPE_NOT_ALLOWED');
        expect(String(err.details)).toMatch(/Only \.zip archives/);
    });

    it('writes BEFORE scanning', async () => {
        // Deliberate ordering. Writing an infected file and recording it as
        // INFECTED is recoverable — the download gate refuses it. Scanning
        // first and writing second means a crash between the two leaves a
        // stored object with no record, which nothing will ever look at.
        const order: string[] = [];
        mockWrite.mockImplementationOnce(async () => {
            order.push('write');
            return { sha256: 'sha-1', sizeBytes: 11 };
        });
        const av = jest.requireMock('@/lib/storage/av-scan');
        av.scanUploadedBuffer = async () => {
            order.push('scan');
            return 'CLEAN';
        };
        await ingestUploadedFile('t-1', fakeFile(), OPTS);
        expect(order).toEqual(['write', 'scan']);
    });

    it('falls back to the surface name when the upload carries none', async () => {
        const out = await ingestUploadedFile('t-1', fakeFile({ name: '' }), OPTS);
        expect(out.originalName).toBe('invoice');
    });
});
