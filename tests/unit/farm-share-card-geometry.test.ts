/**
 * The A6 card's geometry, checked by arithmetic rather than by reading the
 * comment next to it — P6.7 (#1816).
 *
 * ## Why this is a separate suite from the PDF one
 *
 * `farm-share-card-pdf.test.ts` asserts the ARTEFACT: A6 page box, one page,
 * the right text. It cannot see an overlap. pdfkit auto-paginates when text
 * passes the bottom margin, so a card whose QR is drawn THROUGH the printed
 * address is still exactly one A6 page with all the right strings in it — the
 * strongest assertion that suite can make is blind to the one failure that
 * would make the card useless.
 *
 * So the layout decision is an exported pure function and this suite drives it
 * directly, over the whole range of `blockTop` the generator can produce.
 *
 * ## The range is MEASURED, not assumed
 *
 * `maxBlockTop` is re-derived here from pdfkit each run — two lines of
 * DejaVu-Bold at 20pt plus two lines of DejaVu at 10pt, which is the most the
 * generator's `fitText` caps can consume. Hard-coding the number I measured
 * today would make this a test about a constant: a later change to the name's
 * font size would move the real worst case and leave the assertion checking a
 * blockTop the generator no longer reaches.
 */
import {
    shareCardQrSize,
    QR_MIN_MM,
} from '@/app-layer/reports/pdf/farm-share-card';
import { createPdfDocument, UNICODE_FONT, UNICODE_FONT_BOLD } from '@/lib/pdf/pdfKitFactory';

const MM = 72 / 25.4;
const MARGIN = 10 * MM;

/** The reserves `shareCardQrSize` subtracts, restated so the test can add them back. */
const URL_BLOCK_HEIGHT = 34;
const FOOTER_HEIGHT = 14;
const QR_GUTTER = 10;

function anA6Doc(): PDFKit.PDFDocument {
    return createPdfDocument(
        {
            tenantName: 'г',
            reportTitle: 'г',
            generatedAt: '2026-10-15T00:00:00.000Z',
            fontFamily: 'unicode',
        },
        {
            size: 'A6',
            margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        },
    );
}

describe('A6 share-card geometry', () => {
    const doc = anA6Doc();
    const pageHeight = doc.page.height;
    const contentWidth = doc.page.width - MARGIN * 2;

    /**
     * The largest `blockTop` the generator can hand the function: the name is
     * capped at two lines and its largest step is 20pt, the tagline at two
     * lines and 10pt, plus the 4pt gap between them.
     */
    doc.font(UNICODE_FONT_BOLD).fontSize(20);
    const nameBlock = doc.currentLineHeight() * 2;
    doc.font(UNICODE_FONT).fontSize(10);
    const taglineBlock = doc.currentLineHeight() * 2;
    const maxBlockTop = MARGIN + nameBlock + 4 + taglineBlock;

    const size = (blockTop: number) =>
        shareCardQrSize({ contentWidth, pageHeight, margin: MARGIN, blockTop });

    /** Where the bottom of the footer lands for a given `blockTop`. */
    const bottomOf = (blockTop: number) =>
        blockTop + QR_GUTTER + size(blockTop) + QR_GUTTER + URL_BLOCK_HEIGHT + FOOTER_HEIGHT;

    it('starts from a real A6 page', () => {
        // 105 x 148 mm, derived from the ISO definition rather than copied
        // from the factory — so this disagrees if pdfkit's table ever does.
        expect(doc.page.width).toBeCloseTo(105 * MM, 2);
        expect(pageHeight).toBeCloseTo(148 * MM, 2);
    });

    /**
     * The largest `blockTop` for which a card is possible AT ALL: past this,
     * the name and tagline have consumed the sheet on their own and the
     * reserves no longer fit, whatever the QR does.
     *
     * The no-overlap guarantee is bounded by this, and it has to be: clamping
     * the QR to zero cannot claw back space the TEXT already took. Writing the
     * first version of this suite without the bound is what surfaced it — the
     * sweep ran to 380 and failed, correctly.
     */
    const domainMax = pageHeight - MARGIN - URL_BLOCK_HEIGHT - FOOTER_HEIGHT - QR_GUTTER * 2;

    it('never lets the code reach the address printed under it', () => {
        // The tolerance is 1e-6 pt and it is not slack: at the worst case the
        // layout is EXACTLY flush with the bottom margin by construction, and
        // comparing two paths through the same floating-point arithmetic for
        // `<=` is how an invariant that holds becomes a flaky test.
        const limit = pageHeight - MARGIN;
        for (let blockTop = MARGIN; blockTop <= domainMax; blockTop += 0.5) {
            expect(bottomOf(blockTop)).toBeLessThanOrEqual(limit + 1e-6);
        }
    });

    it('cannot be driven past that domain by any input the generator accepts', () => {
        // This is what makes the bounded sweep above a statement rather than a
        // convenience. The sweep stops at `domainMax`; this says the generator
        // cannot reach it — with room to spare, so a later font-size change
        // has to move the worst case a long way before the guarantee is
        // merely theoretical. If this ever fails, the card is overflowing for
        // a real farm and the sweep above was quietly no longer covering it.
        expect(maxBlockTop).toBeLessThan(domainMax);
        expect(domainMax - maxBlockTop).toBeGreaterThan(100);
    });

    it('degrades past the domain by shrinking to nothing, not by overlapping', () => {
        // Outside the domain there is no good answer, so the recorded choice
        // is the less deceptive one: a card with no code is visibly broken to
        // whoever holds it, where a code drawn THROUGH the address is a sheet
        // that still looks like a card and scans to nothing.
        expect(size(domainMax)).toBeCloseTo(0, 6);
        expect(size(domainMax + 50)).toBe(0);
    });

    it('is flush with the bottom margin at the worst case it can actually reach', () => {
        // Flush rather than merely inside: the function reserves exactly the
        // address block, the footer and two gutters, so any slack here would
        // mean a reserve nothing uses. The reserves themselves hold the
        // breathing room (34pt for ~27pt of text, 14pt for a 7pt wordmark).
        expect(bottomOf(maxBlockTop)).toBeCloseTo(pageHeight - MARGIN, 6);
    });

    it('stays scannable across every blockTop the generator can produce', () => {
        // The claim QR_MIN_MM makes, bounded to the inputs that can occur.
        // It is deliberately NOT a runtime clamp — see the function's
        // docblock — so this is where the claim is actually checked.
        for (let blockTop = MARGIN; blockTop <= maxBlockTop; blockTop += 0.5) {
            expect(size(blockTop)).toBeGreaterThanOrEqual(QR_MIN_MM * MM);
        }
        // And it is not vacuous: the floor is reachable in principle, which
        // is what makes the bound above a statement rather than a tautology.
        expect(size(300)).toBeLessThan(QR_MIN_MM * MM);
    });

    it('shrinks the code as the text above it grows, and never below zero', () => {
        expect(size(MARGIN)).toBeGreaterThan(size(maxBlockTop));
        expect(size(10_000)).toBe(0);
    });

    it('is bounded by the column width, not only by the height left', () => {
        // At the top of the card there is more vertical room than the column
        // is wide. A function that ignored `contentWidth` would return a
        // square wider than the page.
        expect(size(MARGIN)).toBeLessThanOrEqual(contentWidth);
        expect(size(MARGIN)).toBe(contentWidth);
    });
});
