/**
 * What the bytes actually are, as opposed to what the uploader said they are.
 *
 * `file.type` on a `File` is the browser's guess, and on a hand-built
 * multipart request it is simply a string the client chose. The upload path
 * gated `isAllowedMime(file.type)` on it, persisted it to
 * `FileRecord.mimeType`, and the download path replays that value as the
 * response `Content-Type`. So the uploader picked what a future browser would
 * treat the bytes as: send HTML, declare `text/plain`, pass the allowlist, and
 * have it served back under a type you chose.
 *
 * The allowlist is only as good as the claim it checks. This module checks the
 * bytes.
 *
 * ## Scope, stated plainly
 *
 * This is a magic-number check, not a parser and not a virus scanner. It
 * recognises the container formats the allowlist actually admits and answers
 * `null` for everything else, which the caller reads as "no opinion" rather
 * than "safe". It catches the case that matters — a file whose CONTENT is one
 * recognisable thing while its DECLARED type is another — and does not pretend
 * to validate a document's interior. AV scanning (`scanUploadedBuffer`) is the
 * separate control for that.
 *
 * @module lib/storage/mime-sniff
 */

/** Longest prefix any signature below inspects. */
const MAX_PREFIX = 262;

interface Signature {
    mime: string;
    /** Byte prefix, or null for a matcher-only entry. */
    magic?: readonly number[];
    /** Offset the magic starts at. Default 0. */
    offset?: number;
    /** Extra check for formats that share a container. */
    refine?: (buf: Buffer) => string | null;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

/**
 * OOXML (docx / xlsx) and plain zips are all ZIP containers. The distinguishing
 * marker is the mimetype-ish path near the front of the archive, which is
 * enough to tell a spreadsheet from a document from an ordinary zip without
 * unpacking it.
 */
function refineZip(buf: Buffer): string {
    const head = buf.subarray(0, MAX_PREFIX).toString('latin1');
    if (head.includes('word/')) {
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    if (head.includes('xl/')) {
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    return 'application/zip';
}

const SIGNATURES: readonly Signature[] = [
    { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },            // %PDF
    { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
    { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },                  // GIF8
    { mime: 'application/zip', magic: ZIP_MAGIC, refine: refineZip },
    // Legacy Office (.doc / .xls) share the OLE2 compound-file header. They
    // are not distinguishable without parsing the directory stream, so both
    // resolve to the doc type; the allowlist admits both, and the point here
    // is "this is an OLE2 document, not the HTML you claimed".
    { mime: 'application/msword', magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

/** RIFF….WEBP — magic split across two ranges. */
function isWebp(buf: Buffer): boolean {
    return buf.length >= 12
        && buf.toString('latin1', 0, 4) === 'RIFF'
        && buf.toString('latin1', 8, 12) === 'WEBP';
}

function startsWith(buf: Buffer, magic: readonly number[], offset = 0): boolean {
    if (buf.length < offset + magic.length) return false;
    for (let i = 0; i < magic.length; i++) {
        if (buf[offset + i] !== magic[i]) return false;
    }
    return true;
}

/**
 * The MIME type implied by a buffer's leading bytes, or `null` when the format
 * carries no signature this module recognises.
 *
 * `null` means "no opinion", NOT "safe". Text-shaped formats (`text/plain`,
 * `text/csv`, `application/json`) have no magic number by design and always
 * answer null — which is why {@link reconcileMimeType} treats null as a pass
 * rather than a rejection.
 */
export function sniffMimeType(buffer: Buffer): string | null {
    if (buffer.length === 0) return null;
    if (isWebp(buffer)) return 'image/webp';
    for (const sig of SIGNATURES) {
        if (sig.magic && startsWith(buffer, sig.magic, sig.offset)) {
            return sig.refine ? sig.refine(buffer) : sig.mime;
        }
    }
    return null;
}

/**
 * Declared types that are acceptable for a given DETECTED type.
 *
 * Keyed by what the bytes are; the values are claims that do not contradict
 * them. A `.docx` genuinely IS a zip, so a client declaring `application/zip`
 * for one is not lying in any way that matters — and the legacy Office formats
 * share one OLE2 header that cannot be told apart without parsing the
 * directory stream, so `.doc` and `.xls` accept each other.
 *
 * These are containment and indistinguishability relationships, not a general
 * "close enough" list. Anything not stated here is a contradiction.
 */
const ACCEPTABLE_CLAIMS: Readonly<Record<string, readonly string[]>> = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['application/zip'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['application/zip'],
    'application/msword': ['application/vnd.ms-excel'],
    'application/vnd.ms-excel': ['application/msword'],
};

export interface MimeCheck {
    /** The type to persist and later serve. */
    resolved: string;
    /** What the bytes say, when they say anything. */
    detected: string | null;
    /** True when the claim was overridden. */
    corrected: boolean;
}

/**
 * Reconcile the declared MIME type with the bytes.
 *
 * The bytes win. When they carry a recognisable signature that contradicts the
 * claim, the detected type is what gets stored and served — a file cannot talk
 * its way into being served as something it is not.
 *
 * Returns the type to use; throws nothing. The caller re-checks the resolved
 * type against the allowlist, so a PDF-that-claimed-to-be-CSV is stored as a
 * PDF, and an executable that claimed to be a PDF fails the allowlist on the
 * type its bytes actually are.
 */
export function reconcileMimeType(declared: string, buffer: Buffer): MimeCheck {
    const detected = sniffMimeType(buffer);
    if (!detected) return { resolved: declared, detected: null, corrected: false };
    if (detected === declared) return { resolved: detected, detected, corrected: false };
    if ((ACCEPTABLE_CLAIMS[detected] ?? []).includes(declared)) {
        // The claim does not contradict the bytes — keep it.
        return { resolved: declared, detected, corrected: false };
    }
    return { resolved: detected, detected, corrected: true };
}
