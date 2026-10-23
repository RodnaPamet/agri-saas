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
// Typed parameters for the same reason as `mockWrite` above: an argument-less
// `jest.fn` types `mock.calls` as `[]`, so asserting the mime type it was
// handed would be a compile error rather than a test.
const mockStrip = jest.fn(
    async (
        bytes: Buffer,
        _mimeType: string,
        _opts: { component: string },
    ): Promise<{ bytes: Buffer; stripped: boolean }> => ({ bytes, stripped: true }),
);
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
// #1812. Recorded rather than passed through, so the cases below can assert
// that the strip happens at all and receives the RESOLVED type — the real
// re-encode is exercised against sharp-generated images in
// `tests/unit/strip-image-metadata.test.ts`, which is where it belongs.
jest.mock('@/lib/images/strip-metadata', () => ({
    stripImageMetadata: mockStrip,
    isStrippableImageType: (m: string) => m.startsWith('image/'),
}));
jest.mock('@/lib/storage/av-scan', () => ({
    scanUploadedBuffer: async () => scanVerdict,
    // Same verdict through the other seam, so a test that sets `scanVerdict`
    // keeps meaning what it says whichever one the code under test reads.
    scanUploadedBufferDetailed: async () => ({
        status: scanVerdict,
        ...(scanVerdict === 'SKIPPED' ? { reason: 'scanning-disabled' } : {}),
        ...(scanVerdict === 'PENDING' ? { reason: 'scanner-error-strict' } : {}),
    }),
}));

import { ingestUploadedFile } from '@/lib/upload/ingest';

import { minimalPdf } from '../helpers/minimal-pdf';

/**
 * A minimal `File` stand-in — jsdom's File is not available under node-env.
 *
 * The default body is a REAL minimal PDF as of #2035. It used to be
 * `'hello world'` while the mocked sniffer reported
 * `resolved: 'application/pdf'` — so the TYPE was true and the BYTES were
 * arbitrary, which the image strip ignored (it passes non-images through
 * undecoded) and the PDF strip rejects, because it refuses a file it cannot
 * parse rather than storing it unstripped.
 *
 * Giving it a real PDF is the honest fix: a suite whose fixture declares
 * `application/pdf` should hold one. Pass `body` to override for the cases
 * that are about something else.
 */
function fakeFile(over: Partial<{ name: string; type: string; size: number; body: string | Buffer }> = {}) {
    const body = over.body ?? minimalPdf();
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return {
        name: over.name ?? 'invoice.pdf',
        type: over.type ?? 'application/pdf',
        size: over.size ?? buf.length,
        arrayBuffer: async () => buf,
    } as unknown as File;
}

const OPTS = { domain: 'cost-invoice' as const, fallbackName: 'invoice', component: 'test' };

/**
 * Run and return the rejection.
 *
 * This docblock used to read: "these paths call `badRequest(CODE,
 * humanText)`, and `badRequest`'s first argument is the MESSAGE — so the
 * stable machine code lands on `.message` and the sentence a person reads
 * lands on `.details`." Every clause of that was TRUE, and the conclusion
 * it defended was that an operator should read an identifier.
 *
 * It even ended "asserting both keeps the two from being swapped, which
 * would ship an error whose code is prose" — guarding against the mirror
 * of a defect that was already live in the other direction.
 *
 * These paths now call `codedBadRequest(code, message)`: the code is on
 * `.code`, the sentence a person reads is on `.message`. Both are still
 * asserted, for the reason the old comment gave — it is the swap that
 * matters, and it is now being checked against the right arrangement.
 */
async function rejection(p: Promise<unknown>) {
    try {
        await p;
        throw new Error('expected a rejection, got none');
    } catch (e) {
        return e as Error & { code?: string; details?: unknown };
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
        expect(err.code).toBe('FILE_TYPE_NOT_ALLOWED');
        expect(String(err.message)).toMatch(/is not allowed/i);
        // Cheap rejection first: a 50 MB body must not be buffered only to
        // be thrown away.
        expect(spy).not.toHaveBeenCalled();
        expect(mockWrite).not.toHaveBeenCalled();
    });

    it('rejects an oversized file', async () => {
        const err = await rejection(ingestUploadedFile('t-1', fakeFile({ size: 5000 }), OPTS));
        expect(err.code).toBe('FILE_TOO_LARGE');
        expect(String(err.message)).toMatch(/maximum size/i);
        expect(mockWrite).not.toHaveBeenCalled();
    });

    it('honours a per-surface cap smaller than the global one', async () => {
        const err = await rejection(
            ingestUploadedFile('t-1', fakeFile({ size: 900 }), { ...OPTS, maxBytes: 100 }),
        );
        expect(err.code).toBe('FILE_TOO_LARGE');
        // The SURFACE's cap in the text, not the global one — an operator
        // reading "exceeds 1000 bytes" for a 100-byte cap is being misled.
        expect(String(err.message)).toContain('100');
    });

    it('rejects an EMPTY file', async () => {
        // A zero-byte upload is almost always a failed pick or a dropped
        // connection. Storing it produces a record pointing at nothing.
        const err = await rejection(
            ingestUploadedFile('t-1', fakeFile({ size: 0, body: '' }), OPTS),
        );
        expect(err.code).toBe('FILE_EMPTY');
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
        expect(err.code).toBe('FILE_TYPE_NOT_ALLOWED');
        expect(String(err.message)).toMatch(/File content is "text\/html"/);
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
                // A `{ reason, message }` since #2059, not prose: the reason
                // gets its own line in the catalogue's variant table, so a
                // surface specific enough to say "only .zip" is as specific
                // in Bulgarian as in English.
                extraCheck: () => ({ reason: 'zip_only', message: 'Only .zip archives are accepted' }),
            }),
        );
        expect(err.code).toBe('FILE_TYPE_NOT_ALLOWED');
        expect(String(err.message)).toMatch(/Only \.zip archives/);
        // The reason reaches the wire, which is what makes it translatable.
        expect((err as { params?: Record<string, unknown> }).params).toMatchObject({
            reason: 'zip_only',
        });
    });

    it('scans, THEN strips, THEN writes', async () => {
        // This used to assert `['write', 'scan']`, and the reversal is
        // deliberate (#1812). Both halves of the old reasoning are worth
        // keeping, because neither is contradicted:
        //
        // "Writing an infected file and recording it as INFECTED is
        // recoverable — the download gate refuses it." Still exactly true.
        // `scanUploadedBuffer` RETURNS a verdict rather than throwing, and
        // nothing here branches on it, so an infected upload is written and
        // recorded INFECTED under this ordering too. The end state is
        // identical; only the moment of the scan moved.
        //
        // "A crash between the two leaves a stored object with no record."
        // Unchanged as well — the orphan window is between the write and the
        // caller's `markStored`, and that window is the same length whichever
        // side of it the scan sits on.
        //
        // What the new order ADDS is the reason it changed: stripping EXIF
        // means handing the caller's bytes to libvips, and a decoder fed
        // attacker-controlled input is the step most worth having a scan in
        // front of. `lib/account/avatar.ts` records the same ordering for the
        // same reason, and now the two paths agree.
        const order: string[] = [];
        mockWrite.mockImplementationOnce(async () => {
            order.push('write');
            return { sha256: 'sha-1', sizeBytes: 11 };
        });
        mockStrip.mockImplementationOnce(async (bytes) => {
            order.push('strip');
            return { bytes, stripped: true };
        });
        const av = jest.requireMock('@/lib/storage/av-scan');
        av.scanUploadedBuffer = async () => {
            order.push('scan');
            return 'CLEAN';
        };
        await ingestUploadedFile('t-1', fakeFile(), OPTS);
        expect(order).toEqual(['scan', 'strip', 'write']);
    });

    it('hands the stripper the RESOLVED type, never the declared one', async () => {
        // A caller who could opt out of stripping by lying about the content
        // type would defeat the measure entirely, which is why every upload
        // path here sniffs. Declared `application/pdf`, bytes say PNG.
        sniffResult = { resolved: 'image/png', detected: 'image/png', corrected: true };
        await ingestUploadedFile('t-1', fakeFile({ type: 'application/pdf' }), OPTS);
        expect(mockStrip.mock.calls[0][1]).toBe('image/png');
    });

    it('stores the STRIPPED bytes, so the recorded sha256 names what is served', async () => {
        // `FileRecord.sha256` is what `/api/public/media/[hash]` resolves, so
        // it has to digest the bytes the route actually serves rather than
        // the ones the caller sent.
        // An IMAGE for this one, as of #2035. The assertion is about the
        // image strip's output reaching storage, and the fixture's default
        // resolved type is `application/pdf` — so the PDF strip, which runs
        // after, would try to parse `'re-encoded'` and refuse. Setting the
        // sniffed type to an image is what makes this test about the thing it
        // names; `stripPdfMetadata` returns an image untouched.
        sniffResult = { resolved: 'image/jpeg', detected: 'image/jpeg', corrected: false };
        const strippedBytes = Buffer.from('re-encoded', 'ascii');
        mockStrip.mockImplementationOnce(async () => ({
            bytes: strippedBytes,
            stripped: true,
        }));
        // CONSUMED, not compared by identity: the pipeline wraps the bytes in
        // a `Readable` before handing them over, so asserting on the argument
        // itself would only prove a stream was passed. Reading it is what
        // proves WHICH bytes reach storage.
        let captured: Buffer | null = null;
        mockWrite.mockImplementationOnce(async (_pathKey, body) => {
            const chunks: Buffer[] = [];
            for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk);
            captured = Buffer.concat(chunks);
            return { sha256: 'sha-1', sizeBytes: captured.length };
        });
        await ingestUploadedFile('t-1', fakeFile(), OPTS);
        expect(captured).not.toBeNull();
        expect((captured as unknown as Buffer).toString('ascii')).toBe('re-encoded');
        // The CONTROL: the caller's original bytes are 'hello world', so this
        // would pass vacuously if the stripper were bypassed and `fakeFile`
        // happened to carry the same string.
        expect((captured as unknown as Buffer).toString('ascii')).not.toBe('hello world');
    });

    it('falls back to the surface name when the upload carries none', async () => {
        const out = await ingestUploadedFile('t-1', fakeFile({ name: '' }), OPTS);
        expect(out.originalName).toBe('invoice');
    });
});
