/**
 * Remove document metadata from an uploaded PDF — #2035.
 *
 * ## Why this is not `stripImageMetadata`
 *
 * `src/lib/images/strip-metadata.ts` re-encodes images through sharp and
 * excludes PDFs with its reason recorded in the module:
 *
 * > **PDF** — carries author metadata and needs stripping, but it is not an
 * > image and must not be rasterised, because that destroys the text layer
 * > that for an invoice or a БАБХ form IS the content.
 *
 * Both halves still hold. A PDF carries `/Author`, `/Creator`, `/Producer`,
 * `/CreationDate` and often an XMP packet repeating them, and documents
 * exported from GIS or farm-management tools sometimes carry considerably
 * more. And it must not go near libvips.
 *
 * So this is a document-level rewrite: replace the `/Info` dictionary's
 * fields and drop the XMP metadata stream, leaving every content stream
 * untouched. No page is re-rendered, so the text layer survives byte for
 * byte.
 *
 * ## `updateMetadata: false` is load-bearing, not tidiness
 *
 * `PDFDocument.save()` stamps its OWN `Producer` ("pdf-lib (https://…)") and a
 * fresh `ModDate` unless told not to. Saving without that option would strip
 * the uploader's fingerprint and substitute ours, plus a timestamp of the
 * upload — a different leak rather than no leak, and one that would look
 * fixed in a test that only asserted the original author was gone.
 *
 * ## It refuses rather than storing an unstripped file
 *
 * A PDF this cannot parse, rewrite OR re-serialise throws — all three in one
 * refusal, because they mean the same thing to the caller: no stripped file
 * was produced. The alternative — pass the bytes through untouched — is how a
 * privacy property degrades silently to no privacy, and #1812's standard
 * applies here: the caller stores what this returns, so returning the input on
 * failure means storing metadata we promised to remove. A refused upload is
 * visible; a silently unstripped one is not.
 *
 * pdf-lib is lenient about what it will LOAD — measured: it accepts a
 * `%PDF-1.5` header with a junk body — so the load alone is not the gate. That
 * file fails later, on a missing catalog, which is why the scope is the whole
 * rewrite.
 *
 * Which also means the error has to be a CODED refusal the route can turn
 * into a 400, not an internal 500: a corrupt PDF is the caller's file, not
 * our fault.
 */
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

import { codedBadRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/** The one MIME type this module handles. */
export const STRIPPABLE_PDF_MIME = 'application/pdf';

export interface PdfStripResult {
    /** The bytes to store — rewritten, or the input unchanged. */
    bytes: Buffer;
    /** True when a rewrite happened. False means the type is not a PDF. */
    stripped: boolean;
}

export interface PdfStripOptions {
    /** Component name for the log line. */
    component: string;
}

/** Whether these bytes' RESOLVED type is one this module rewrites. */
export function isStrippablePdfType(mimeType: string): boolean {
    return mimeType === STRIPPABLE_PDF_MIME;
}

/**
 * The `/Info` fields that carry identity. Blanked rather than deleted: some
 * readers and validators expect the keys to exist, and an empty string is
 * unambiguous where an absent key invites a reader to infer from elsewhere.
 *
 * Dates are DELETED rather than blanked, because `/CreationDate` is typed as a
 * date string and an empty one is malformed. A PDF with no dates is valid; a
 * PDF with `/CreationDate ()` is not reliably so.
 */
const BLANKED_INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'] as const;
const DELETED_INFO_KEYS = ['CreationDate', 'ModDate'] as const;

export async function stripPdfMetadata(
    bytes: Buffer,
    mimeType: string,
    opts: PdfStripOptions,
): Promise<PdfStripResult> {
    if (!isStrippablePdfType(mimeType)) return { bytes, stripped: false };

    let out: Buffer;
    try {
        const doc = await PDFDocument.load(bytes, {
            // The uploader's file, not a trusted one. `throwOnInvalidObject`
            // left at its default (false) on purpose: real-world PDFs from
            // scanners and accounting software routinely carry objects a
            // strict parser rejects, and refusing those would reject invoices
            // that every reader opens happily.
            updateMetadata: false,
        });

        const info = doc.context.lookup(doc.context.trailerInfo.Info);
        if (info && 'set' in info && 'delete' in info) {
            const dict = info as {
                set: (k: PDFName, v: unknown) => void;
                delete: (k: PDFName) => void;
            };
            for (const key of BLANKED_INFO_KEYS) {
                // `PDFString.of('')`, NOT `context.obj('')`. Measured:
                // `obj('')` returns a **PDFName**, because a bare string is a
                // name in pdf-lib's DSL. Writing one here left `/Info`
                // structurally wrong — `getTitle()` on the result threw
                // "Expected instance of PDFHexString or PDFString, but got
                // instance of PDFName" — while still removing the author, so a
                // test that only checked the name was gone would have passed
                // on a corrupted dictionary.
                dict.set(PDFName.of(key), PDFString.of(''));
            }
            for (const key of DELETED_INFO_KEYS) {
                dict.delete(PDFName.of(key));
            }
        }

        // The XMP packet, which repeats most of `/Info` in RDF and is what a
        // metadata viewer usually shows. Blanking `/Info` alone leaves this
        // intact, so a file would read as stripped in one tool and not in
        // another.
        //
        // `doc.catalog` is UNDEFINED for a file with no catalog — measured: a
        // `%PDF-1.5` header with a junk body loads without complaint and then
        // throws `Cannot read properties of undefined (reading 'delete')`
        // here. That is why the refusal below wraps the whole rewrite rather
        // than only the load: load, rewrite and save failures all mean the
        // same thing to the caller, and an uncoded TypeError would surface as
        // a 500 blaming us for their file.
        doc.catalog?.delete(PDFName.of('Metadata'));

        out = Buffer.from(await doc.save({ useObjectStreams: false }));
    } catch (err) {
        logger.warn('pdf.strip_failed', {
            component: opts.component,
            // Length only. The bytes are an uploaded document.
            bytes: bytes.length,
            error: err instanceof Error ? err.message : String(err),
        });
        throw codedBadRequest(
            'PDF_UNREADABLE',
            'This PDF could not be read, so its document metadata could not be removed.',
        );
    }

    logger.info('pdf.metadata_stripped', {
        component: opts.component,
        // Sizes, never content. A rewrite can grow a file — pdf-lib
        // re-serialises the object graph — and that is worth seeing rather
        // than assuming it shrinks.
        bytesIn: bytes.length,
        bytesOut: out.length,
    });

    return { bytes: out, stripped: true };
}
