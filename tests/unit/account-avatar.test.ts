/**
 * Unit — `src/lib/account/avatar.ts` (avatar roadmap P3).
 *
 * Covers the server-side validation that is the trust boundary for
 * the upload: the magic-number webp sniff, the size cap, the
 * empty-payload guard, and the AV scan — plus the deterministic
 * key/URL helpers.
 *
 * The scan cases matter more than their size suggests. This path stores
 * no `FileRecord`, so no download gate will ever look at a scan status:
 * the bytes are streamed by key to any authenticated user who asks. Until
 * 2026-08-12 nothing scanned them at all. Only `scanUploadedBuffer` is
 * stubbed below — the accept/refuse decision runs for real.
 */
const mockScanVerdict = jest.fn();

jest.mock('@/lib/storage', () => ({ getStorageProvider: jest.fn() }));
// Both seams. `uploadOwnAvatar` reaches `scanOrRefuse`, which reads
// `scanUploadedBufferDetailed` since #1811 — so overriding only
// `scanUploadedBuffer` would let `...actual` spread the REAL detailed
// function through and every verdict set below would be ignored. The spread
// is what makes that quiet: a missing override looks like a present one.
jest.mock('@/lib/storage/av-scan', () => {
    const actual = jest.requireActual('@/lib/storage/av-scan');
    const widen = (v: unknown) => {
        if (typeof v !== 'string') return v;
        if (v === 'SKIPPED') return { status: 'SKIPPED', reason: 'scanning-disabled' };
        if (v === 'PENDING') return { status: 'PENDING', reason: 'scanner-error-strict' };
        return { status: v };
    };
    return {
        ...actual,
        scanUploadedBuffer: (...args: unknown[]) => mockScanVerdict(...args),
        scanUploadedBufferDetailed: async (...args: unknown[]) =>
            widen(await mockScanVerdict(...args)),
    };
});
// Jest runs with `skipValidation`, so zod's `.default('strict')` never fires
// and an unset AV_SCAN_MODE would read as "not strict" — quietly turning the
// fail-closed case below into a fail-open one.
const mockEnv: { AV_SCAN_MODE: string } = { AV_SCAN_MODE: 'strict' };
jest.mock('@/env', () => ({
    get env() {
        return mockEnv;
    },
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { user: { update: jest.fn() } },
}));

import sharp from 'sharp';

import {
    isWebp,
    acceptedAvatarUpload,
    avatarStorageKey,
    avatarServeUrl,
    uploadOwnAvatar,
    removeOwnAvatar,
    getAvatarStream,
    AVATAR_MAX_BYTES,
    AVATAR_UPLOAD_MAX_BYTES,
    AVATAR_PX,
} from '@/lib/account/avatar';
import { getStorageProvider } from '@/lib/storage';
import prisma from '@/lib/prisma';

const mockGetStorageProvider = getStorageProvider as jest.Mock;
const mockUserUpdate = (prisma as unknown as {
    user: { update: jest.Mock };
}).user.update;

/**
 * REAL encoded images, because since #1903 the server decodes what it is
 * given rather than only sniffing it.
 *
 * `webpBuffer()` below is a 12-byte header with no image in it. That was
 * enough while the check was a magic-number sniff, and it is exactly the
 * fixture that stops being enough once bytes are decoded — a header-only
 * buffer now fails the decode and lands on `AVATAR_UNREADABLE`, which is
 * correct behaviour and a useless fixture for the happy path. Kept for the
 * sniff tests, which are still only sniffing.
 */
let realWebp: Buffer;
let realJpeg: Buffer;
/** A JPEG carrying EXIF including GPS tags — the privacy case. */
let jpegWithGps: Buffer;

beforeAll(async () => {
    realWebp = await sharp({
        create: { width: 300, height: 200, channels: 3, background: '#4a7' },
    })
        .webp()
        .toBuffer();
    realJpeg = await sharp({
        create: { width: 300, height: 200, channels: 3, background: '#246' },
    })
        .jpeg()
        .toBuffer();
    // Written through IFD0 rather than `GPSIFD`. libvips accepts a GPSIFD
    // directory and sharp's TS `Exif` type models only IFD0–IFD3, so naming
    // it needs a cast — and a cast is not worth carrying here, because GPS
    // tags live INSIDE the EXIF block this test asserts is wholly absent.
    // Proving the block is gone proves the GPS tags with it; proving one tag
    // gone would be the weaker claim.
    jpegWithGps = await sharp({
        create: { width: 400, height: 240, channels: 3, background: '#812' },
    })
        .withExif({ IFD0: { Make: 'TESTCAM', Model: 'GPS-BEARING' } })
        .jpeg()
        .toBuffer();
});

/** A minimal byte buffer carrying the RIFF/WEBP magic number. */
function webpBuffer(extraBytes = 32): Buffer {
    return Buffer.concat([
        Buffer.from('RIFF', 'ascii'),
        Buffer.from([0, 0, 0, 0]), // RIFF chunk size (unchecked)
        Buffer.from('WEBP', 'ascii'),
        Buffer.alloc(extraBytes),
    ]);
}

beforeEach(() => {
    mockEnv.AV_SCAN_MODE = 'strict';
    mockScanVerdict.mockReset();
    mockScanVerdict.mockResolvedValue('CLEAN');
});

describe('isWebp — magic-number sniff', () => {
    it('accepts a RIFF/WEBP buffer', () => {
        expect(isWebp(webpBuffer())).toBe(true);
    });

    it('rejects a PNG buffer', () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(isWebp(png)).toBe(false);
    });

    it('rejects a JPEG buffer', () => {
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(isWebp(jpeg)).toBe(false);
    });

    it('rejects a buffer shorter than the 12-byte header', () => {
        expect(isWebp(Buffer.from('RIFF', 'ascii'))).toBe(false);
        expect(isWebp(Buffer.alloc(0))).toBe(false);
    });

    it('rejects RIFF without the WEBP form-type', () => {
        // RIFF container, but a WAVE payload — not an image.
        const wav = Buffer.concat([
            Buffer.from('RIFF', 'ascii'),
            Buffer.from([0, 0, 0, 0]),
            Buffer.from('WAVE', 'ascii'),
            Buffer.alloc(8),
        ]);
        expect(isWebp(wav)).toBe(false);
    });
});

describe('storage key / serve URL helpers', () => {
    it('avatarStorageKey is deterministic + webp-suffixed per user', () => {
        expect(avatarStorageKey('user-123')).toBe('avatars/user-123.webp');
    });

    it('avatarServeUrl points at the per-user serve route', () => {
        expect(avatarServeUrl('user-123')).toBe(
            '/api/account/avatar/user-123',
        );
    });
});

describe('uploadOwnAvatar — validation branches', () => {
    const write = jest.fn();

    beforeEach(() => {
        write.mockReset();
        mockUserUpdate.mockReset();
        mockGetStorageProvider.mockReturnValue({ write });
    });

    it('rejects an empty upload', async () => {
        await expect(uploadOwnAvatar('u1', Buffer.alloc(0))).rejects.toThrow(
            /empty/i,
        );
        expect(write).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('rejects a payload over the UPLOAD cap', async () => {
        // `AVATAR_UPLOAD_MAX_BYTES`, not `AVATAR_MAX_BYTES`. They were the
        // same number until #1903; now the server re-encodes, so what
        // arrives and what is stored have different ceilings and testing the
        // stored one here would assert a refusal the route no longer makes.
        const tooBig = Buffer.concat([
            webpBuffer(),
            Buffer.alloc(AVATAR_UPLOAD_MAX_BYTES + 1),
        ]);
        await expect(uploadOwnAvatar('u1', tooBig)).rejects.toThrow(
            /too large/i,
        );
        expect(write).not.toHaveBeenCalled();
    });

    it('rejects a PNG — the accepted set is JPEG and WebP only', async () => {
        // PNG stays out even though the web file input offers it: the client
        // canvas already converts one to WebP, so nothing needs the server
        // to decode a PNG, and every format accepted is another parser
        // reachable with attacker-controlled bytes.
        const png = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            Buffer.alloc(32),
        ]);
        await expect(uploadOwnAvatar('u1', png)).rejects.toThrow(/JPEG or WebP/i);
        expect(write).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('rejects HEIC, which the owner declined on 2026-10-16', async () => {
        // `ftypheic` at offset 4 is the HEIF brand. Declined so libheif is
        // never reached with attacker-controlled input; the phone converts
        // to JPEG on device, which iOS can do and WebP it cannot.
        const heic = Buffer.concat([
            Buffer.from([0, 0, 0, 0x18]),
            Buffer.from('ftypheic', 'ascii'),
            Buffer.alloc(32),
        ]);
        expect(acceptedAvatarUpload(heic)).toBeNull();
        await expect(uploadOwnAvatar('u1', heic)).rejects.toThrow(/JPEG or WebP/i);
        expect(write).not.toHaveBeenCalled();
    });

    it('rejects bytes whose magic number lies about being decodable', async () => {
        // The header says WebP and there is no image behind it. Its own
        // code, because the remedy differs: a different photo, not the same
        // one re-exported.
        await expect(uploadOwnAvatar('u1', webpBuffer())).rejects.toThrow(
            /could not be read/i,
        );
        expect(write).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('stores a valid webp and points User.image at the serve URL', async () => {
        const result = await uploadOwnAvatar('u1', realWebp);
        expect(write).toHaveBeenCalledWith(
            'avatars/u1.webp',
            expect.any(Buffer),
            expect.objectContaining({ mimeType: 'image/webp' }),
        );
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { image: '/api/account/avatar/u1' },
        });
        expect(result).toEqual({ imageUrl: '/api/account/avatar/u1' });
    });
});

describe('uploadOwnAvatar — the AV scan gate', () => {
    const write = jest.fn();

    beforeEach(() => {
        write.mockReset();
        mockUserUpdate.mockReset();
        mockGetStorageProvider.mockReturnValue({ write });
    });

    it('scans the uploaded bytes', async () => {
        // The whole gap: this call did not exist. An avatar is rendered to
        // every colleague in every tenant the owner belongs to, which makes
        // it one of the few uploads with a distribution path built in.
        const buf = realWebp;
        await uploadOwnAvatar('u1', buf);
        expect(mockScanVerdict).toHaveBeenCalledWith(buf);
    });

    it('REFUSES an infected avatar — no write, no User.image', async () => {
        mockScanVerdict.mockResolvedValue('INFECTED');

        await expect(uploadOwnAvatar('u1', realWebp)).rejects.toThrow(
            /malware/i,
        );
        expect(write).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('REFUSES to store when a configured scanner failed under strict', async () => {
        // `scanUploadedBuffer` returns PENDING only when a scanner IS
        // deployed, DID error, and the operator asked to fail closed. Storing
        // anyway would put unscanned bytes at a key the serve route reads.
        mockScanVerdict.mockResolvedValue('PENDING');

        await expect(uploadOwnAvatar('u1', realWebp)).rejects.toThrow(
            /unavailable/i,
        );
        expect(write).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('stores when no scanner is deployed at all', async () => {
        // The branch the live stack takes (`AV_SCAN_MODE=disabled`, no
        // CLAMAV_HOST). Refusing here would break avatars everywhere ClamAV
        // is not run, for no gain over what every FileRecord path already
        // does with the identical verdict.
        mockScanVerdict.mockResolvedValue('SKIPPED');

        await uploadOwnAvatar('u1', realWebp);
        expect(write).toHaveBeenCalledTimes(1);
        expect(mockUserUpdate).toHaveBeenCalledTimes(1);
    });

    it('scans BEFORE writing, not after', async () => {
        // The mirror image of the record-backed pipeline's ordering, and for
        // the reason that pipeline states: there, an infected file is
        // recoverable because the download gate refuses it. Here there is no
        // gate, so bytes that reach the key are already being served.
        const order: string[] = [];
        mockScanVerdict.mockImplementation(async () => {
            order.push('scan');
            return 'CLEAN';
        });
        write.mockImplementation(async () => {
            order.push('write');
        });

        await uploadOwnAvatar('u1', realWebp);
        expect(order).toEqual(['scan', 'write']);
    });

    it('never occupies the scanner with bytes that fail the cheap checks', async () => {
        await expect(uploadOwnAvatar('u1', Buffer.alloc(0))).rejects.toThrow();
        const png = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(32),
        ]);
        await expect(uploadOwnAvatar('u1', png)).rejects.toThrow(/WebP/i);
        expect(mockScanVerdict).not.toHaveBeenCalled();
    });
});

describe('removeOwnAvatar', () => {
    it('deletes the stored object and clears User.image', async () => {
        const del = jest.fn().mockResolvedValue(undefined);
        mockGetStorageProvider.mockReturnValue({ delete: del });
        mockUserUpdate.mockReset();

        await removeOwnAvatar('u1');

        expect(del).toHaveBeenCalledWith('avatars/u1.webp');
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { image: null },
        });
    });

    it('still clears User.image when the stored object is already gone', async () => {
        const del = jest.fn().mockRejectedValue(new Error('not found'));
        mockGetStorageProvider.mockReturnValue({ delete: del });
        mockUserUpdate.mockReset();

        await expect(removeOwnAvatar('u1')).resolves.toBeUndefined();
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { image: null },
        });
    });
});

describe('getAvatarStream — serve-route resolution', () => {
    it('returns the stream when the stored object exists', async () => {
        const fakeStream = { id: 'stream' };
        const head = jest.fn().mockResolvedValue({ sizeBytes: 1 });
        const readStream = jest.fn().mockReturnValue(fakeStream);
        mockGetStorageProvider.mockReturnValue({ head, readStream });

        const result = await getAvatarStream('u1');

        expect(head).toHaveBeenCalledWith('avatars/u1.webp');
        expect(readStream).toHaveBeenCalledWith('avatars/u1.webp');
        expect(result).toBe(fakeStream);
    });

    it('returns null when the user has no stored avatar', async () => {
        const head = jest.fn().mockRejectedValue(new Error('not found'));
        const readStream = jest.fn();
        mockGetStorageProvider.mockReturnValue({ head, readStream });

        expect(await getAvatarStream('u1')).toBeNull();
        expect(readStream).not.toHaveBeenCalled();
    });
});

describe('uploadOwnAvatar — the server-side re-encode (#1903)', () => {
    const write = jest.fn();

    beforeEach(() => {
        write.mockReset();
        mockUserUpdate.mockReset();
        mockGetStorageProvider.mockReturnValue({ write });
    });

    /** The bytes handed to storage, which is what a later GET streams. */
    const written = (): Buffer => write.mock.calls[0][1] as Buffer;

    it('accepts a JPEG — the refusal that blocked every iPhone photo', async () => {
        // iOS ImageIO decodes WebP but has no encoder for it
        // (`CGImageDestinationCopyTypeIdentifiers()` omits
        // `org.webmproject.webp`), so a WebP-only endpoint refused every
        // photo the phone could produce. This is the whole of agrent-ios
        // #333.
        expect(acceptedAvatarUpload(realJpeg)).toBe('image/jpeg');
        const result = await uploadOwnAvatar('u1', realJpeg);
        expect(result).toEqual({ imageUrl: '/api/account/avatar/u1' });
        expect(write).toHaveBeenCalledWith(
            'avatars/u1.webp',
            expect.any(Buffer),
            expect.objectContaining({ mimeType: 'image/webp' }),
        );
    });

    it('stores a square WebP whatever it was handed', async () => {
        // The stored artefact is the same shape from either input format,
        // so the serve route and every renderer keep one contract.
        for (const source of [realJpeg, realWebp]) {
            write.mockReset();
            await uploadOwnAvatar('u1', source);
            const meta = await sharp(written()).metadata();
            expect(meta.format).toBe('webp');
            expect(meta.width).toBe(AVATAR_PX);
            expect(meta.height).toBe(AVATAR_PX);
        }
    });

    it('strips the whole EXIF block, GPS tags included — with its control', async () => {
        // The control FIRST: if the fixture carried no EXIF, the assertion
        // below would pass on an empty subject and prove nothing. This is
        // the shape of test this repo keeps having to fix.
        const sourceMeta = await sharp(jpegWithGps).metadata();
        expect(sourceMeta.exif?.length ?? 0).toBeGreaterThan(0);

        await uploadOwnAvatar('u1', jpegWithGps);

        const storedMeta = await sharp(written()).metadata();
        expect(storedMeta.exif?.length ?? 0).toBe(0);
        // And the bytes carry no trace of the tags, not merely no parsed
        // EXIF block — a reader looking for the string would not find it.
        expect(written().includes(Buffer.from('TESTCAM', 'ascii'))).toBe(false);
        expect(written().includes(Buffer.from('GPS-BEARING', 'ascii'))).toBe(false);
    });

    it('re-encodes an already-valid WebP rather than passing it through', async () => {
        // The reason this moved server-side at all: the guarantee should
        // hold for EVERY client, not rest on the web canvas being the only
        // path that meets it. A WebP from an unknown client can still carry
        // EXIF, so it is decoded and re-encoded like anything else.
        await uploadOwnAvatar('u1', realWebp);
        // Same format, but not the same bytes — it went through the pipeline.
        expect(written().equals(realWebp)).toBe(false);
        const meta = await sharp(written()).metadata();
        expect(meta.width).toBe(AVATAR_PX);
    });

    it('scans what the CALLER sent, not the re-encoded bytes', async () => {
        // Order matters and this pins it. A signature describes the artefact
        // somebody uploaded; scanning a re-encode would scan something no
        // caller ever sent, and the decode is the step most worth having
        // scanned input for.
        await uploadOwnAvatar('u1', jpegWithGps);
        expect(mockScanVerdict).toHaveBeenCalledWith(jpegWithGps);
        expect(written().equals(jpegWithGps)).toBe(false);
    });

    it('keeps the stored result inside the STORED cap', async () => {
        await uploadOwnAvatar('u1', jpegWithGps);
        expect(written().length).toBeLessThanOrEqual(AVATAR_MAX_BYTES);
        // And the upload it came from was allowed to be larger than that
        // cap — the two numbers are now independent.
        expect(AVATAR_UPLOAD_MAX_BYTES).toBeGreaterThan(AVATAR_MAX_BYTES);
    });
});
