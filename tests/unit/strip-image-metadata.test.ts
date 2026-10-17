/**
 * EXIF/GPS stripping, asserted on the PRODUCED BYTES — P6.3 (#1812).
 *
 * The issue is explicit about why this file reads metadata back out of the
 * output rather than checking that a sharp option was passed: "an option that
 * stops being passed is a silent regression". A test that asserted
 * `withMetadata` was never called would pass forever while someone replaced
 * the pipeline with one that copies metadata by default.
 *
 * Every stripping assertion here is paired with a POSITIVE CONTROL on the
 * SOURCE image, because `exif?.length ?? 0` is `0` for a buffer sharp cannot
 * read at all — so "no EXIF in the output" is also what a totally broken
 * fixture produces. The control is what separates "stripped" from "never
 * there", and it is the same reasoning `account-avatar.test.ts` records.
 */
import sharp from 'sharp';

import {
    isStrippableImageType,
    stripImageMetadata,
} from '@/lib/images/strip-metadata';

const COMPONENT = { component: 'test' };

/** A JPEG carrying EXIF, including the GPS block — the privacy case. */
let jpegWithExif: Buffer;
/** A PNG carrying a text chunk, which is PNG's metadata channel. */
let pngWithMeta: Buffer;

beforeAll(async () => {
    // IFD0, not GPSIFD: sharp's TS `Exif` type models IFD0–IFD3 only, and GPS
    // tags live INSIDE the EXIF block these tests assert is wholly absent.
    // Proving the block is gone proves the GPS tags with it — the stronger
    // claim, and the one that needs no cast.
    jpegWithExif = await sharp({
        create: { width: 400, height: 240, channels: 3, background: '#812' },
    })
        .withExif({ IFD0: { Make: 'TESTCAM', Model: 'GPS-BEARING' } })
        .jpeg()
        .toBuffer();

    pngWithMeta = await sharp({
        create: { width: 120, height: 90, channels: 3, background: '#2a6' },
    })
        .withMetadata({ exif: { IFD0: { Software: 'GPS-BEARING' } } })
        .png()
        .toBuffer();
});

describe('stripImageMetadata', () => {
    it('removes the whole EXIF block from a JPEG — with its positive control', async () => {
        // CONTROL: the source really does carry EXIF. Without this, the
        // assertion below passes on a fixture that never had any.
        const before = await sharp(jpegWithExif).metadata();
        expect(before.exif?.length ?? 0).toBeGreaterThan(0);

        const { bytes, stripped } = await stripImageMetadata(
            jpegWithExif,
            'image/jpeg',
            COMPONENT,
        );
        expect(stripped).toBe(true);

        const after = await sharp(bytes).metadata();
        expect(after.exif?.length ?? 0).toBe(0);

        // And on the RAW bytes, not only via sharp's reader. A metadata
        // parser that silently skipped a malformed block would report no EXIF
        // while the tag string sat in the file.
        expect(bytes.includes(Buffer.from('GPS-BEARING', 'ascii'))).toBe(false);
        expect(bytes.includes(Buffer.from('TESTCAM', 'ascii'))).toBe(false);
        // The control for THAT check: the string is present in the source.
        expect(jpegWithExif.includes(Buffer.from('GPS-BEARING', 'ascii'))).toBe(true);
    });

    it('removes PNG metadata too — the channel is different, the rule is not', async () => {
        const before = await sharp(pngWithMeta).metadata();
        expect(before.exif?.length ?? 0).toBeGreaterThan(0);

        const { bytes } = await stripImageMetadata(pngWithMeta, 'image/png', COMPONENT);

        const after = await sharp(bytes).metadata();
        expect(after.exif?.length ?? 0).toBe(0);
        expect(bytes.includes(Buffer.from('GPS-BEARING', 'ascii'))).toBe(false);
    });

    it('PRESERVES the format — a JPEG stays a JPEG', async () => {
        // The decision this module is built on. Converting would change
        // `FileRecord.mimeType`, contradict the stored filename and alter
        // every download surface.
        const { bytes } = await stripImageMetadata(jpegWithExif, 'image/jpeg', COMPONENT);
        expect((await sharp(bytes).metadata()).format).toBe('jpeg');

        const png = await stripImageMetadata(pngWithMeta, 'image/png', COMPONENT);
        expect((await sharp(png.bytes).metadata()).format).toBe('png');
    });

    it('keeps the pixels — stripping is not a resize', async () => {
        const { bytes } = await stripImageMetadata(jpegWithExif, 'image/jpeg', COMPONENT);
        const after = await sharp(bytes).metadata();
        expect([after.width, after.height]).toEqual([400, 240]);
    });

    // NO TEST for the animated case, deliberately, and this comment is the
    // record of why rather than an omission.
    //
    // The module passes a multi-page image through untouched. Asserting that
    // needs a multi-page fixture, and this sharp build does not appear able to
    // produce one: measured four constructions — `.webp({ pageHeight })` on a
    // tall created image, the same re-read with `{ animated: true }`, a raw
    // input declaring `pages: 2`, and a GIF round-trip — and every one
    // reported `pages: undefined`. sharp's own types agree: `pageHeight` is
    // not a member of `WebpOptions` here, so the construction a multi-page
    // WebP would need does not even typecheck.
    //
    // A test written anyway would have compared the output's page count to the
    // source's, both `1`, and passed whatever the code did. That is the shape
    // this repo calls a control that cannot express failure, so the honest
    // move is to leave the case untested and say so.

    it('passes a non-image through UNTOUCHED and undecoded', async () => {
        // A PDF, a zip or a shapefile must never reach libvips. Asserted by
        // identity, not equality: the same Buffer comes back.
        const pdf = Buffer.from('%PDF-1.7\nnot really a pdf\n', 'ascii');
        const { bytes, stripped } = await stripImageMetadata(
            pdf,
            'application/pdf',
            COMPONENT,
        );
        expect(stripped).toBe(false);
        expect(bytes).toBe(pdf);
    });

    it('REFUSES bytes it cannot decode rather than storing them unstripped', async () => {
        // The alternative — warn and pass the original through — fails in the
        // one direction that matters: the file keeps its GPS tags and the
        // operator learns from a log line nobody reads.
        const corrupt = Buffer.concat([
            jpegWithExif.subarray(0, 40),
            Buffer.alloc(200, 0xff),
        ]);
        await expect(
            stripImageMetadata(corrupt, 'image/jpeg', COMPONENT),
        ).rejects.toThrow(/IMAGE_UNREADABLE|could not be read/);
    });

    it('declares exactly the types it re-encodes', () => {
        for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/tiff']) {
            expect(isStrippableImageType(t)).toBe(true);
        }
        // Deliberate absences, each for a reason recorded in the module.
        for (const t of ['image/gif', 'image/svg+xml', 'application/pdf', 'application/zip']) {
            expect(isStrippableImageType(t)).toBe(false);
        }
    });
});
