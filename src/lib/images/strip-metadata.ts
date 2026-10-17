/**
 * Strip camera metadata from an uploaded image — P6.3 (#1812).
 *
 * ## The privacy case, in the product's own terms
 *
 * A farmer photographs a field from the field. The GPS tag in that photo is
 * the parcel's location, which is the one piece of data the private product
 * treats as tenant-confidential — and which a public profile image, or a
 * receipt attached to a cost entry, would publish by accident. The camera
 * also writes the device make, model and serial, and the capture timestamp.
 *
 * The owner's ruling of 2026-10-16 is that this applies to **all uploads,
 * public and private**, not only the public farm profile that prompted it.
 * A private evidence photo shared with an advisor is still a disclosure.
 *
 * ## Stripping is a property of RE-ENCODING, not a step
 *
 * sharp writes no metadata unless `withMetadata()` is called. So the strip is
 * not a filter that could be forgotten or mis-ordered: it is what decoding
 * and re-encoding *does*. The only way to reintroduce EXIF is to add a call
 * that is not here, which is a visible edit rather than a silent omission.
 *
 * That is also why the test reads EXIF back out of the PRODUCED BYTES rather
 * than asserting a sharp option was passed. #1812: "an option that stops
 * being passed is a silent regression".
 *
 * ## Format is PRESERVED
 *
 * JPEG in, JPEG out. This is the one decision that makes the function safe to
 * drop into existing upload paths: converting to WebP would change
 * `FileRecord.mimeType`, contradict the stored filename's extension, and
 * change what every download and preview surface has to handle. Those are
 * four coupled changes for a privacy fix that needs none of them.
 *
 * `src/lib/account/avatar.ts` deliberately does convert — it owns its storage
 * key, serves its own route, and wants one canonical format. It is not a
 * caller of this module for that reason, and its own pipeline stays as the
 * model this one was derived from.
 *
 * ## `.rotate()` before anything else
 *
 * With no argument it applies the EXIF orientation and then drops it. Without
 * it, a portrait phone photo is stored sideways — the orientation tag was the
 * only thing telling a viewer to turn it, and stripping metadata without
 * baking in the rotation would quietly rotate every phone photo in the
 * product.
 *
 * ## `limitInputPixels` is a cap the byte cap cannot give
 *
 * A few MB of JPEG can decode to a far larger bitmap, and the pixel count is
 * what the decoder allocates. The byte cap upstream cannot bound it.
 */
import sharp from 'sharp';

import { codedBadRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/**
 * Pixel ceiling for a decode. 50 Mpx clears any real camera — a 100 Mpx
 * medium-format back would be refused, and that is the intended trade.
 */
export const IMAGE_MAX_INPUT_PIXELS = 50 * 1000 * 1000;

/**
 * The types this strips, keyed by the sharp output format to re-encode with.
 *
 * A map rather than a set because the format must be named explicitly: sharp
 * infers the output format from the OUTPUT path or an explicit call, and
 * `toBuffer()` with neither would re-encode to the input format implicitly.
 * Relying on that inference would make the output format a property of
 * libvips's defaults rather than of this table.
 *
 * What is deliberately absent matters as much:
 *
 * - **GIF** — the still-image formats here are the ones cameras produce. A
 *   GIF is software-authored, and sharp's GIF support depends on how libvips
 *   was built, so a re-encode could fail on a file that uploads fine today.
 * - **SVG** — not a raster image. Re-encoding would rasterise it, and SVG's
 *   privacy problem is embedded scripts and external references, which is a
 *   sanitiser's job rather than an encoder's.
 * - **PDF** — carries author metadata and needs stripping, but it is not an
 *   image and must not be rasterised, because that destroys the text layer
 *   that for an invoice or a БАБХ form IS the content. Tracked as #2035.
 */
const STRIPPABLE: Record<string, 'jpeg' | 'png' | 'webp' | 'tiff'> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/tiff': 'tiff',
};

export interface StripOptions {
    /** Component name for the log line. */
    component: string;
    /**
     * Longest edge, in pixels, to fit the image INSIDE. Omit to leave the
     * dimensions alone.
     *
     * Opt-in rather than defaulted, and the asymmetry is deliberate. The
     * surfaces this module was written for — evidence and journal attachments
     * — are RECORDS: a treatment photo may be the proof an inspector reads,
     * and quietly downscaling it would destroy detail nobody chose to lose.
     * A profile photograph is the opposite: it exists to be looked at on a
     * phone, and shipping a 4000px original to do that is a cost with no
     * benefit.
     *
     * So the caller that wants a smaller image asks for one.
     */
    maxDimension?: number;
}

export interface StripResult {
    /** The bytes to store — re-encoded, or the input unchanged. */
    bytes: Buffer;
    /** True when a re-encode happened. False means the type is not an image. */
    stripped: boolean;
}

/** Whether these bytes' RESOLVED type is one this module re-encodes. */
export function isStrippableImageType(mimeType: string): boolean {
    return mimeType in STRIPPABLE;
}

/**
 * Re-encode an image to drop its metadata, or pass non-images through.
 *
 * `mimeType` must be the RESOLVED type — what the bytes are, per
 * `reconcileMimeType` or `sniffMimeType` — never the type the client
 * declared. A caller that passes the declared type lets an attacker opt out
 * of stripping by lying about the content type, which is the whole reason
 * every upload path in this repo sniffs.
 *
 * ## Why an image this cannot re-encode is REFUSED rather than passed through
 *
 * The alternative is to log a warning and store the original bytes. That
 * fails in the one direction that matters: the file keeps its GPS tags, and
 * the operator learns about it from a log line nobody reads. A privacy
 * property that degrades silently to "no privacy" is not a property. So the
 * rule is simply: if it cannot be stripped, it is not stored.
 *
 * What this is NOT is "the file must be corrupt". I wrote that first — that a
 * decoder failure means a truncated container, "a file no viewer could render
 * either" — and an E2E test disproved it. A 69-byte hand-minimised 1x1 PNG
 * that every browser decodes (the mobile offline-photo spec relies on
 * `createImageBitmap` reading it) passes `metadata()` here as `png 1x1` and
 * then dies on the re-encode with `vipspng: libpng read error`. Measured: two
 * different hand-minimised 1x1 PNGs fail that way and sharp's own 1x1 does
 * not, so it is the minimised encoding rather than the size.
 *
 * So this refusal has a real cost, stated honestly: a narrow class of VALID
 * images — ones libvips can inspect but not round-trip — is refused. The trade
 * is deliberate, because those are synthetic files (tracking pixels, minimised
 * fixtures) rather than anything a camera or an editor produces, and the
 * alternative is a silent metadata leak on every file in that class.
 */
export async function stripImageMetadata(
    bytes: Buffer,
    mimeType: string,
    opts: StripOptions,
): Promise<StripResult> {
    const format = STRIPPABLE[mimeType];
    // Not an image this module handles. Returned untouched and WITHOUT a
    // decode attempt — a PDF, a zip or a shapefile must never reach libvips.
    if (!format) return { bytes, stripped: false };

    try {
        // One `metadata()` read before the re-encode, for `pages`.
        const meta = await sharp(bytes, { limitInputPixels: IMAGE_MAX_INPUT_PIXELS }).metadata();

        // A MULTI-PAGE image is passed through rather than re-encoded.
        //
        // Re-encoding one as a single frame would silently lose every frame
        // but the first — data loss dressed as a privacy fix — and the
        // frame-preserving path (`{ animated: true }`) is one I could not
        // build a fixture for: measured on this sharp build, four separate
        // constructions of a multi-page WebP all came back `pages:
        // undefined`, so a test for it could only have asserted
        // `1 === 1` and passed whatever the code did.
        //
        // Shipping an untestable re-encode is the worse of the two risks. A
        // camera does not produce an animation, so the accidental-GPS case
        // this module exists for cannot arise here; the residual exposure is
        // a deliberately crafted animation carrying its AUTHOR's metadata,
        // which is not the farmer's parcel location.
        //
        // `stripped: false` rather than `true`, so a caller or a log line can
        // tell this case from a non-image. If sharp's multi-page handling
        // becomes testable, this is the branch to revisit.
        if ((meta.pages ?? 1) > 1) {
            logger.info('image.strip_skipped_multipage', {
                component: opts.component,
                mimeType,
                pages: meta.pages,
            });
            return { bytes, stripped: false };
        }

        // `.rotate()` with no argument applies the EXIF orientation and then
        // drops it, and it must come BEFORE any resize — otherwise a portrait
        // photo is fitted to the box in its unrotated frame and comes out
        // scaled wrong as well as sideways. `account/avatar.ts` records the
        // same ordering for the same reason.
        let pipeline = sharp(bytes, { limitInputPixels: IMAGE_MAX_INPUT_PIXELS }).rotate();

        if (opts.maxDimension !== undefined) {
            pipeline = pipeline.resize(opts.maxDimension, opts.maxDimension, {
                // `inside` preserves the aspect ratio and fits the whole image
                // in the box, so neither edge exceeds the cap and nothing is
                // cropped. A farm's photograph is not a thumbnail and must not
                // be centre-cropped to a square — the subject is often the
                // horizon.
                fit: 'inside',
                // An image already smaller than the cap is left alone. Without
                // this, sharp would UPSCALE it to the box: more bytes, no more
                // detail, and a visible softening.
                withoutEnlargement: true,
            });
        }

        const out = await pipeline[format]().toBuffer();
        return { bytes: out, stripped: true };
    } catch (err) {
        logger.warn('image.strip_failed', {
            component: opts.component,
            mimeType,
            bytes: bytes.length,
            error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        });
        // Coded, like `AVATAR_UNREADABLE`. `no-server-authored-user-copy`
        // exempts a coded throw, and a client can tell "we could not read
        // your image" from "wrong format" without parsing English.
        throw codedBadRequest(
            'IMAGE_UNREADABLE',
            'That image could not be read. Try a different photo.',
        );
    }
}
