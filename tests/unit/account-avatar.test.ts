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
jest.mock('@/lib/storage/av-scan', () => {
    const actual = jest.requireActual('@/lib/storage/av-scan');
    return {
        ...actual,
        scanUploadedBuffer: (...args: unknown[]) => mockScanVerdict(...args),
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

import {
    isWebp,
    avatarStorageKey,
    avatarServeUrl,
    uploadOwnAvatar,
    removeOwnAvatar,
    getAvatarStream,
    AVATAR_MAX_BYTES,
} from '@/lib/account/avatar';
import { getStorageProvider } from '@/lib/storage';
import prisma from '@/lib/prisma';

const mockGetStorageProvider = getStorageProvider as jest.Mock;
const mockUserUpdate = (prisma as unknown as {
    user: { update: jest.Mock };
}).user.update;

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

    it('rejects a payload over the size cap', async () => {
        const tooBig = Buffer.concat([
            webpBuffer(),
            Buffer.alloc(AVATAR_MAX_BYTES + 1),
        ]);
        await expect(uploadOwnAvatar('u1', tooBig)).rejects.toThrow(
            /too large/i,
        );
        expect(write).not.toHaveBeenCalled();
    });

    it('rejects a non-webp payload (canvas step bypassed)', async () => {
        const png = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            Buffer.alloc(32),
        ]);
        await expect(uploadOwnAvatar('u1', png)).rejects.toThrow(/WebP/i);
        expect(write).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('stores a valid webp and points User.image at the serve URL', async () => {
        const result = await uploadOwnAvatar('u1', webpBuffer());
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
        const buf = webpBuffer();
        await uploadOwnAvatar('u1', buf);
        expect(mockScanVerdict).toHaveBeenCalledWith(buf);
    });

    it('REFUSES an infected avatar — no write, no User.image', async () => {
        mockScanVerdict.mockResolvedValue('INFECTED');

        await expect(uploadOwnAvatar('u1', webpBuffer())).rejects.toThrow(
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

        await expect(uploadOwnAvatar('u1', webpBuffer())).rejects.toThrow(
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

        await uploadOwnAvatar('u1', webpBuffer());
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

        await uploadOwnAvatar('u1', webpBuffer());
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
