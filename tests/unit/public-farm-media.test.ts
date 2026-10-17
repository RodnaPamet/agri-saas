/**
 * `resolvePublicMedia` — P6.3 (#1812).
 *
 * ## What this file exists to prove
 *
 * Three other places in the repo point at it by name: the `public-media-read`
 * entry in `RlsBypassReason`, the raised ceiling in
 * `no-untyped-rls-bypass.test.ts`, and the exemption reason in
 * `public-routes-self-authenticate.test.ts`. All three make the same argument
 * — that reading tenant-scoped `FileRecord` with no principal is bounded by
 * the ORDER of two reads rather than by the table — and a comment cannot hold
 * that argument up.
 *
 * So the central case is not "the reads happen in this order". It is that the
 * second read **does not happen at all** when the first says no. An
 * implementation that read the file first and filtered afterwards would
 * satisfy an ordering assertion on the results while being exactly the
 * cross-tenant file lookup by hash this must not be.
 */
const calls: string[] = [];
let projectionRow: { handle: string } | null = null;
let fileRow:
    | { pathKey: string; mimeType: string; sizeBytes: number; scanStatus: string }
    | null = null;
let downloadAllowed = true;

const fakeDb = {
    publicFarmProfile: {
        findFirst: jest.fn(async () => {
            calls.push('projection');
            return projectionRow;
        }),
    },
    fileRecord: {
        findFirst: jest.fn(async () => {
            calls.push('file');
            return fileRow;
        }),
    },
};

const reasons: string[] = [];
jest.mock('@/lib/db/rls-middleware', () => ({
    runWithoutRls: async (
        opts: { reason: string },
        fn: (db: unknown) => Promise<unknown>,
    ) => {
        reasons.push(opts.reason);
        return fn(fakeDb);
    },
}));

const mockReadStream = jest.fn(() => ({ destroy: jest.fn() }));
jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({ readStream: mockReadStream }),
}));

jest.mock('@/lib/storage/av-scan', () => ({
    isDownloadAllowed: () => downloadAllowed,
}));

import { resolvePublicMedia, isWellFormedMediaHash } from '@/app-layer/usecases/public-farm-media';

/** 64 hex characters — the shape `StorageProvider.write` returns. */
const HASH = 'a'.repeat(64);

beforeEach(() => {
    calls.length = 0;
    reasons.length = 0;
    projectionRow = { handle: 'pobeda' };
    fileRow = {
        pathKey: 'tenants/t1/general/2026/10/logo.png',
        mimeType: 'image/png',
        sizeBytes: 1234,
        scanStatus: 'CLEAN',
    };
    downloadAllowed = true;
    mockReadStream.mockClear();
    // The db doubles are module-scope `jest.fn`s, so their call records
    // survive between tests. Without this, `not.toHaveBeenCalled()` below
    // reads the PREVIOUS test's call and fails on correct code — which is
    // what it did first time.
    fakeDb.publicFarmProfile.findFirst.mockClear();
    fakeDb.fileRecord.findFirst.mockClear();
});

describe('resolvePublicMedia — the authorisation order', () => {
    it('asks the PROJECTION before it reads the file', async () => {
        const out = await resolvePublicMedia(HASH);
        expect(out).not.toBeNull();
        expect(calls).toEqual(['projection', 'file']);
    });

    it('does NOT read the file at all when no projection references the hash', async () => {
        // The load-bearing case. An implementation that read the file first
        // and filtered afterwards would pass an ordering check on its RESULTS
        // while performing a cross-tenant lookup by hash — so this asserts the
        // absence of the read, not the shape of the answer.
        projectionRow = null;

        const out = await resolvePublicMedia(HASH);

        expect(out).toBeNull();
        expect(calls).toEqual(['projection']);
        expect(fakeDb.fileRecord.findFirst).not.toHaveBeenCalled();
    });

    it('reads NEITHER table for a malformed hash', async () => {
        // Rejected before any query, so a flood of junk costs a regex. Three
        // shapes: too short, non-hex, and upper-case (the provider emits
        // lower-case, so accepting upper would be a second spelling of the
        // same bytes).
        for (const bad of ['abc', 'g'.repeat(64), 'A'.repeat(64), '', `${HASH}/../etc`]) {
            expect(isWellFormedMediaHash(bad)).toBe(false);
            expect(await resolvePublicMedia(bad)).toBeNull();
        }
        expect(calls).toEqual([]);
    });

    it('uses a DIFFERENT bypass reason for each read', async () => {
        // The projection is tenantless and `public-projection-read`'s safety
        // argument is "bounded by the table". `FileRecord` is tenant-scoped,
        // so it carries `public-media-read` instead — reusing the first reason
        // would make an audit of its call sites vouch for a read it does not
        // govern.
        await resolvePublicMedia(HASH);
        expect(reasons).toEqual(['public-projection-read', 'public-media-read']);
    });
});

describe('resolvePublicMedia — what it refuses', () => {
    it('returns null when the projection names a hash with no stored file', async () => {
        fileRow = null;
        expect(await resolvePublicMedia(HASH)).toBeNull();
        expect(mockReadStream).not.toHaveBeenCalled();
    });

    it('returns null when the scan gate refuses the file', async () => {
        // The SAME gate every other download goes through, not a second
        // opinion. An image on an indexable page is the last thing that should
        // get a looser rule than an authenticated download.
        downloadAllowed = false;
        expect(await resolvePublicMedia(HASH)).toBeNull();
        expect(mockReadStream).not.toHaveBeenCalled();
    });

    it('opens the stream only once everything has passed', async () => {
        const out = await resolvePublicMedia(HASH);
        expect(out).not.toBeNull();
        expect(mockReadStream).toHaveBeenCalledTimes(1);
        expect(mockReadStream).toHaveBeenCalledWith('tenants/t1/general/2026/10/logo.png');
        // The hash is carried through so the route can use it as the ETag
        // without re-deriving it.
        expect(out?.hash).toBe(HASH);
        expect(out?.mimeType).toBe('image/png');
    });
});
