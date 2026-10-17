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

    it('keeps the pixels when no cap is given — stripping is not a resize', async () => {
        // The default, and the one the record-keeping surfaces rely on: an
        // evidence photo may be the proof an inspector reads, so losing detail
        // nobody asked to lose would be the wrong trade.
        const { bytes } = await stripImageMetadata(jpegWithExif, 'image/jpeg', COMPONENT);
        const after = await sharp(bytes).metadata();
        expect([after.width, after.height]).toEqual([400, 240]);
    });

    describe('maxDimension', () => {
        it('fits the image inside the cap, aspect ratio intact', async () => {
            // 400x240 into a 200 box → 200x120, not 200x200. `fit: inside`
            // rather than `cover`, because a farm's photograph must not be
            // centre-cropped — the subject is often the horizon.
            const { bytes } = await stripImageMetadata(jpegWithExif, 'image/jpeg', {
                ...COMPONENT,
                maxDimension: 200,
            });
            const after = await sharp(bytes).metadata();
            expect([after.width, after.height]).toEqual([200, 120]);
        });

        it('does NOT upscale an image already under the cap', async () => {
            // `withoutEnlargement`. Upscaling would cost bytes, add no detail
            // and visibly soften a small logo.
            const { bytes } = await stripImageMetadata(jpegWithExif, 'image/jpeg', {
                ...COMPONENT,
                maxDimension: 4000,
            });
            const after = await sharp(bytes).metadata();
            expect([after.width, after.height]).toEqual([400, 240]);
        });

        it('still strips the metadata — the cap does not replace the point', async () => {
            const before = await sharp(jpegWithExif).metadata();
            expect(before.exif?.length ?? 0).toBeGreaterThan(0);
            const { bytes } = await stripImageMetadata(jpegWithExif, 'image/jpeg', {
                ...COMPONENT,
                maxDimension: 200,
            });
            expect((await sharp(bytes).metadata()).exif?.length ?? 0).toBe(0);
            expect(bytes.includes(Buffer.from('GPS-BEARING', 'ascii'))).toBe(false);
        });

        it('APPLIES the orientation, so a portrait photo stays portrait', async () => {
            // Presence, not order — and the distinction is the result of a
            // mutation that did not fail.
            //
            // I first wrote this as "rotates BEFORE it resizes", inheriting the
            // claim from `account/avatar.ts`. Moving `.rotate()` after
            // `.resize()` changed nothing: all 11 cases stayed green. The
            // reason is the geometry. This surface fits inside a SQUARE box
            // with `fit: inside`, so resize-then-rotate and
            // rotate-then-resize agree — 400x240 into a 200 box is 200x120
            // either way, and 120x200 after the turn.
            //
            // Avatar's ordering claim is real because it crops to a square with
            // `fit: cover`: there the unrotated frame produces a different
            // crop. Carrying the claim across was borrowing a conclusion from
            // a different configuration.
            //
            // `.rotate()` still comes first, for consistency with that file and
            // because a future non-square cap would make the order matter. What
            // this case asserts is the property that IS here: the orientation
            // is applied at all, so a portrait phone photo is not stored
            // sideways. Deleting `.rotate()` fails it.
            // `withMetadata({ orientation })`, NOT `withExif({ IFD0: {
            // Orientation } })`. The latter is the obvious spelling and it is
            // silently ignored: measured, the produced file reads back
            // `orientation: 1` and `.rotate()` then does nothing, so the test
            // asserted 200x120 against 200x120 and would have passed whatever
            // the pipeline did. The positive control below is what caught it.
            const portrait = await sharp({
                create: { width: 400, height: 240, channels: 3, background: '#357' },
            })
                // Orientation 6 = rotate 90° clockwise on display.
                .withMetadata({ orientation: 6 })
                .jpeg()
                .toBuffer();

            // CONTROL: the fixture really does carry an orientation that
            // changes the frame. Without this the case cannot fail.
            const src = await sharp(portrait).metadata();
            expect(src.orientation).toBe(6);
            expect([src.width, src.height]).toEqual([400, 240]);

            const { bytes } = await stripImageMetadata(portrait, 'image/jpeg', {
                ...COMPONENT,
                maxDimension: 200,
            });
            const after = await sharp(bytes).metadata();
            expect([after.width, after.height]).toEqual([120, 200]);
        });
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

    it('REFUSES bytes it cannot re-encode rather than storing them unstripped', async () => {
        // The alternative — warn and pass the original through — fails in the
        // one direction that matters: the file keeps its GPS tags and the
        // operator learns from a log line nobody reads.
        //
        // Named "cannot re-encode" rather than "cannot decode" on purpose.
        // Some VALID images reach the second state without the first: a
        // hand-minimised 1x1 PNG passes `metadata()` and then fails the
        // re-encode with a libpng read error. The refusal covers both, and
        // the module's docblock records the measurement.
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
