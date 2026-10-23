/**
 * The PDF metadata strip is asserted on the OUTPUT BYTES — #2035, #1812.
 *
 * #1812's standard, which this inherits: "an option that stops being passed is
 * a silent regression". So no test here asserts that a setter was called; every
 * one reads the produced file back.
 *
 * ## Two measured traps, both of which made an earlier version of this file lie
 *
 * **1. `PDFDocument.load()` defaults to `updateMetadata: true`**, which stamps
 * pdf-lib's own `Producer` and a fresh `ModDate` onto the in-memory document
 * AS IT LOADS. So `load(bytes).getProducer()` reports
 * "pdf-lib (https://github.com/Hopding/pdf-lib)" for a file whose bytes say
 * `AgroBooks PDF Engine` — the accessor describes pdf-lib's mutation, not the
 * file. Every read-back below passes `{ updateMetadata: false }`, and the
 * strongest assertions go through the raw bytes instead.
 *
 * **2. A pdf-lib-authored fixture cannot carry a custom `Producer` at all.**
 * Measured: `create()` sets its own, `setProducer()` changes it in memory, and
 * `save()` writes pdf-lib's back — with `updateMetadata: false` as well. So the
 * fixture here is written BY HAND. That also makes it a better fixture: nothing
 * pdf-lib does to the file is confounded by pdf-lib having made it.
 */
import { PDFDocument } from 'pdf-lib';

import { stripPdfMetadata, isStrippablePdfType } from '@/lib/files/strip-pdf-metadata';

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** Read a file back WITHOUT letting pdf-lib rewrite its metadata first. */
const readBack = (bytes: Buffer) => PDFDocument.load(bytes, { updateMetadata: false });

/**
 * A minimal, valid PDF written by hand, carrying everything this module is
 * supposed to remove. Four objects, a real xref table and a trailer pointing
 * `/Info` at object 4.
 */
const PAGE_TEXT = 'Invoice 2026-0042';
const CONTENT_STREAM = `BT /F1 14 Tf 20 150 Td (${PAGE_TEXT}) Tj ET`;
const CONTENT_OBJ =
    `5 0 obj\n<< /Length ${CONTENT_STREAM.length} >>\nstream\n`
    + `${CONTENT_STREAM}\nendstream\nendobj\n`;

function handMadePdf(): Buffer {
    const objs = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] '
            + '/Contents 5 0 R >>\nendobj\n',
        '4 0 obj\n<< /Title (Supplier invoice) /Author (Ivan Petrov) '
            + '/Subject (Fertiliser delivery) /Keywords (invoice fertiliser) '
            + '/Producer (AgroBooks PDF Engine) /Creator (AgroBooks Desktop 7.2) '
            + '/CreationDate (D:20260304100000Z) /ModDate (D:20260305110000Z) >>\nendobj\n',
        // A real content stream, so "the text layer survives" is a claim
        // about something. This is what rasterising would destroy and what a
        // metadata-only rewrite must leave alone.
        CONTENT_OBJ,
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

const OPTS = { component: 'test' };

describe('stripPdfMetadata', () => {
    it('the fixture really carries the metadata — the positive control', async () => {
        // Without this, every assertion below could pass against a PDF that
        // never had an author in the first place.
        //
        // Asserted on the BYTES and through a non-mutating read. A plain
        // `PDFDocument.load(...).getProducer()` answers "pdf-lib (…)" here,
        // because the default `updateMetadata: true` stamps it during the
        // load — see the module docblock.
        const raw = handMadePdf().toString('latin1');
        expect(raw).toContain('/Author (Ivan Petrov)');
        expect(raw).toContain('/Producer (AgroBooks PDF Engine)');

        const doc = await readBack(handMadePdf());
        expect(doc.getAuthor()).toBe('Ivan Petrov');
        expect(doc.getProducer()).toBe('AgroBooks PDF Engine');
        expect(doc.getCreationDate()).toBeInstanceOf(Date);
    });

    it('removes every identity field, read back from the OUTPUT', async () => {
        const { bytes, stripped } = await stripPdfMetadata(
            handMadePdf(),
            'application/pdf',
            OPTS,
        );
        expect(stripped).toBe(true);

        const out = await readBack(bytes);
        expect(out.getTitle() ?? '').toBe('');
        expect(out.getAuthor() ?? '').toBe('');
        expect(out.getSubject() ?? '').toBe('');
        expect(out.getKeywords() ?? '').toBe('');
        expect(out.getCreator() ?? '').toBe('');
        expect(out.getProducer() ?? '').toBe('');
        expect(out.getCreationDate()).toBeUndefined();
        expect(out.getModificationDate()).toBeUndefined();
    });

    it('does not substitute pdf-lib as the Producer — the subtle leak', async () => {
        // `save()` stamps its own Producer and a fresh ModDate unless
        // `updateMetadata: false` is passed. Dropping that option would
        // replace the uploader's fingerprint with ours plus an upload
        // timestamp — a different leak, and one the test above would still
        // pass, because "Ivan Petrov" would indeed be gone.
        const { bytes } = await stripPdfMetadata(
            handMadePdf(),
            'application/pdf',
            OPTS,
        );
        expect(bytes.toString('latin1')).not.toMatch(/pdf-lib/i);
        const out = await readBack(bytes);
        expect(out.getProducer() ?? '').not.toMatch(/pdf-lib/i);
    });

    it('leaves no trace of the author anywhere in the bytes', async () => {
        // Blanking `/Info` is not enough on its own: the XMP packet repeats
        // most of it in RDF, and a viewer that reads XMP would still show the
        // author. Asserted over the whole file rather than through the
        // accessors, which only see `/Info`.
        const { bytes } = await stripPdfMetadata(
            handMadePdf(),
            'application/pdf',
            OPTS,
        );
        const raw = bytes.toString('latin1');
        expect(raw).not.toContain('Ivan Petrov');
        expect(raw).not.toContain('AgroBooks');
        expect(raw).not.toContain('Fertiliser delivery');
    });

    it('keeps the page content — the reason it is not rasterised', async () => {
        const { bytes } = await stripPdfMetadata(
            handMadePdf(),
            'application/pdf',
            OPTS,
        );
        const out = await readBack(bytes);
        expect(out.getPageCount()).toBe(1);
        const [page] = out.getPages();
        expect(Math.round(page.getWidth())).toBe(300);
        expect(Math.round(page.getHeight())).toBe(200);
        // The drawn string is in a content stream, so it survives a rewrite
        // that touches only the object graph's metadata.
        expect(bytes.toString('latin1')).toContain(PAGE_TEXT);
    });

    it('passes a non-PDF through untouched, with no parse attempt', async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const { bytes, stripped } = await stripPdfMetadata(png, 'image/png', OPTS);
        expect(stripped).toBe(false);
        // The SAME buffer, not a copy: nothing read it, nothing rewrote it.
        expect(bytes).toBe(png);
    });

    it('REFUSES an unreadable PDF rather than storing it unstripped', async () => {
        // The property that makes this a privacy control rather than a
        // best-effort one. Returning the input here would store exactly the
        // metadata the module promises to remove.
        // No `%PDF-` header. Measured: pdf-lib throws on this, on empty
        // input and on random bytes, but LOADS a `%PDF-1.7` header with a junk
        // body — so the earlier version of this test used input pdf-lib
        // accepts, and asserted a refusal that never came.
        const notAPdf = Buffer.from('not a pdf at all', 'latin1');
        await expect(
            stripPdfMetadata(notAPdf, 'application/pdf', OPTS),
        ).rejects.toThrow(/could not be read/i);
    });

    it('refuses with a CODED 400, because a corrupt file is the caller`s', async () => {
        const notAPdf = Buffer.from('nope', 'latin1');
        let err: unknown;
        try {
            await stripPdfMetadata(notAPdf, 'application/pdf', OPTS);
        } catch (e) {
            err = e;
        }
        // The code, not just the message: the route turns this into a 400, and
        // an uncoded throw would surface as a 500 blaming us for their file.
        expect((err as { code?: string }).code).toBe('PDF_UNREADABLE');
    });

    it('refuses a PDF that LOADS but has no catalog — the TypeError case', async () => {
        // pdf-lib accepts a `%PDF-1.5` header with a junk body, so this file
        // gets past the load and fails later: `doc.catalog` is undefined and
        // `delete` on it threw a raw TypeError, which would have surfaced as a
        // 500 blaming us for the caller's file. Now one refusal covers load,
        // rewrite and save alike.
        //
        // These exact bytes are what `tests/integration/evidence-import` used
        // as its PDF fixtures, which is how the gap surfaced.
        const headerOnly = Buffer.from('%PDF-1.5\nfake', 'latin1');
        let err: unknown;
        try {
            await stripPdfMetadata(headerOnly, 'application/pdf', OPTS);
        } catch (e) {
            err = e;
        }
        expect((err as { code?: string }).code).toBe('PDF_UNREADABLE');
        expect((err as Error).constructor.name).not.toBe('TypeError');
    });

    it('isStrippablePdfType answers only for the PDF type', () => {
        expect(isStrippablePdfType('application/pdf')).toBe(true);
        expect(isStrippablePdfType('image/png')).toBe(false);
        expect(isStrippablePdfType('application/zip')).toBe(false);
    });
});
