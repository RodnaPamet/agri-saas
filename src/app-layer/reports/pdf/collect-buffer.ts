/**
 * Collect a PDFKit document into a Buffer.
 *
 * Extracted from `locations/[id]/farm-record/route.ts`, which held the only
 * copy, when the per-entry ДНЕВНИК route needed the same thing (#1740). Two
 * hand-rolled stream collectors is how two byte-serving routes end up
 * disagreeing about when the document is finished.
 *
 * **Listeners first, then `end()`** — and that order is the whole of it. PDFKit
 * starts flushing on `end()`, so attaching `data` afterwards drops the chunks
 * already emitted and the buffer comes back short or empty: a truncated PDF
 * rather than an error, which a client may well still open.
 */
export function collectPdfBuffer(pdfDoc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
        pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
        pdfDoc.on('error', reject);
        pdfDoc.end();
    });
}
