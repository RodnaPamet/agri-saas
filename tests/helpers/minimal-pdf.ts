/**
 * A minimal, valid PDF written by hand — #2035.
 *
 * ## Why a helper rather than a literal per suite
 *
 * `stripPdfMetadata` REFUSES a file it cannot parse, because a privacy
 * property that degrades silently to no privacy is not one. That makes
 * "pretend these bytes are a PDF" an unusable fixture: several suites set a
 * mocked sniffer to `resolved: 'application/pdf'` over a body of `'hello'`,
 * which the image strip ignored and the PDF strip rejects.
 *
 * Those fixtures were never PDFs — the mock made the TYPE true and left the
 * BYTES arbitrary — so the fix is to give them real ones rather than to soften
 * the refusal. A suite that asserts PDF handling should hold a PDF.
 *
 * ## Why hand-written rather than produced by pdf-lib
 *
 * Two measured reasons:
 *
 *   - `PDFDocument.create()` + `save()` stamps pdf-lib's own `/Producer` and
 *     will not keep one you set — with `updateMetadata: false` as well. A
 *     fixture that cannot carry a known producer cannot prove the producer was
 *     removed.
 *   - Using the library under test to build the input makes a strip look
 *     successful whenever the library is self-consistent, which is not the
 *     property anybody wants.
 */

/** The text drawn on the page, so callers can assert the content survived. */
export const MINIMAL_PDF_PAGE_TEXT = 'Invoice 2026-0042';

/** The `/Info` values the fixture carries, for positive controls. */
export const MINIMAL_PDF_METADATA = {
    title: 'Supplier invoice',
    author: 'Ivan Petrov',
    subject: 'Fertiliser delivery',
    keywords: 'invoice fertiliser',
    producer: 'AgroBooks PDF Engine',
    creator: 'AgroBooks Desktop 7.2',
} as const;

/**
 * Four objects, a content stream, a real xref table and a trailer whose
 * `/Info` points at the metadata dictionary.
 *
 * @param opts.withMetadata pass `false` for a valid PDF carrying no `/Info`,
 *   which is what a stripped file looks like and therefore what a
 *   "nothing left to remove" case needs.
 */
export function minimalPdf(opts: { withMetadata?: boolean } = {}): Buffer {
    const withMetadata = opts.withMetadata ?? true;
    const m = MINIMAL_PDF_METADATA;

    const content = `BT /F1 14 Tf 20 150 Td (${MINIMAL_PDF_PAGE_TEXT}) Tj ET`;
    const objs = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] '
            + '/Contents 5 0 R >>\nendobj\n',
        withMetadata
            ? '4 0 obj\n<< '
              + `/Title (${m.title}) /Author (${m.author}) /Subject (${m.subject}) `
              + `/Keywords (${m.keywords}) /Producer (${m.producer}) `
              + `/Creator (${m.creator}) `
              + '/CreationDate (D:20260304100000Z) /ModDate (D:20260305110000Z) '
              + '>>\nendobj\n'
            : '4 0 obj\n<< >>\nendobj\n',
        `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    ];

    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (const o of objs) {
        offsets.push(body.length);
        body += o;
    }
    const xrefAt = body.length;
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    body +=
        xref
        + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 4 0 R >>\n`
        + `startxref\n${xrefAt}\n%%EOF\n`;

    return Buffer.from(body, 'latin1');
}
