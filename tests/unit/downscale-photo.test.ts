/** @jest-environment jsdom */
/**
 * Unit tests for the field-journal photo downscaler.
 *
 * jsdom implements neither `createImageBitmap` nor `canvas.toBlob`, so both
 * are stubbed. The assertions lock the contract: a large photo is shrunk
 * (aspect preserved, no crop), a small one and a non-image pass through
 * untouched, and every failure path fails OPEN to the original File.
 */
import { downscalePhoto } from '@/lib/image/downscale-photo';

// A File whose reported byte size we practice (jsdom Blob size = buffer length).
function fileOfSize(bytes: number, name = 'photo.jpg', type = 'image/jpeg'): File {
    return new File([new Uint8Array(bytes)], name, { type });
}

interface FakeCanvas {
    width: number;
    height: number;
    getContext: jest.Mock;
    toBlob: jest.Mock;
}

let fakeCanvas: FakeCanvas;
let outBlobBytes = 100; // bytes the toBlob re-encode yields

const realCreateElement = document.createElement.bind(document);

beforeEach(() => {
    fakeCanvas = {
        width: 0,
        height: 0,
        getContext: jest.fn(() => ({ imageSmoothingQuality: '', drawImage: jest.fn() })),
        toBlob: jest.fn((cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array(outBlobBytes)], { type: 'image/jpeg' }))),
    };
    jest.spyOn(document, 'createElement').mockImplementation((tag: string) =>
        tag === 'canvas' ? (fakeCanvas as unknown as HTMLElement) : realCreateElement(tag),
    );
    // Default: a 4000×3000 source image.
    (global as unknown as { createImageBitmap: unknown }).createImageBitmap = jest.fn(async () => ({
        width: 4000,
        height: 3000,
        close: jest.fn(),
    }));
});

afterEach(() => {
    jest.restoreAllMocks();
    delete (global as unknown as { createImageBitmap?: unknown }).createImageBitmap;
});

describe('downscalePhoto', () => {
    it('shrinks a large photo below its original size, preserving aspect (no crop)', async () => {
        outBlobBytes = 200 * 1024; // 200 KB re-encode
        const original = fileOfSize(10 * 1024 * 1024, 'IMG_1234.HEIC.jpg'); // 10 MB

        const result = await downscalePhoto(original);

        expect(result).not.toBe(original);
        expect(result.type).toBe('image/jpeg');
        expect(result.name).toMatch(/\.jpg$/);
        expect(result.size).toBeLessThan(original.size);
        // 4000×3000 capped at 2000 long-edge → 2000×1500 (ratio preserved).
        expect(fakeCanvas.width).toBe(2000);
        expect(fakeCanvas.height).toBe(1500);
        expect(fakeCanvas.width / fakeCanvas.height).toBeCloseTo(4000 / 3000, 5);
    });

    it('passes a small image through untouched (no recompression)', async () => {
        (global as unknown as { createImageBitmap: unknown }).createImageBitmap = jest.fn(async () => ({
            width: 1600,
            height: 1200, // long edge 1600 ≤ 2000
            close: jest.fn(),
        }));
        const original = fileOfSize(300 * 1024, 'small.jpg');

        const result = await downscalePhoto(original);

        expect(result).toBe(original); // same reference — no canvas work
        expect(fakeCanvas.toBlob).not.toHaveBeenCalled();
    });

    it('passes a non-image (PDF) through untouched', async () => {
        const bitmapSpy = (global as unknown as { createImageBitmap: jest.Mock }).createImageBitmap as jest.Mock;
        const pdf = fileOfSize(4 * 1024 * 1024, 'scan.pdf', 'application/pdf');

        const result = await downscalePhoto(pdf);

        expect(result).toBe(pdf);
        expect(bitmapSpy).not.toHaveBeenCalled();
    });

    it('fails open to the original when decoding throws', async () => {
        (global as unknown as { createImageBitmap: unknown }).createImageBitmap = jest.fn(async () => {
            throw new Error('decode failed');
        });
        const original = fileOfSize(9 * 1024 * 1024);

        const result = await downscalePhoto(original);

        expect(result).toBe(original);
    });

    it('keeps the original when the re-encode is not actually smaller', async () => {
        outBlobBytes = 12 * 1024 * 1024; // re-encode bigger than the source
        const original = fileOfSize(8 * 1024 * 1024);

        const result = await downscalePhoto(original);

        expect(result).toBe(original);
    });
});
