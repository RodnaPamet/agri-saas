/**
 * P6.7 (#1816) — the A6 share card: a farm's public address on paper.
 *
 * ## Why a PDF and not a CSS print stylesheet
 *
 * "A6 print" reads like a `@media print` surface, and it was measured not to
 * be one. `@page` is a DOCUMENT-level rule with no element scope, and
 * `src/app/globals.css:419` already declares the repo's only one —
 * `@page { margin: 15mm 12mm; size: A4 landscape; }` — inside a `@media print`
 * block, from a stylesheet the root layout imports unconditionally
 * (`src/app/layout.tsx:22`). A second `@page` for A6 would therefore either
 * lose to that rule or win over it for EVERY other print surface in the app,
 * depending only on stylesheet order. There is no scoping that avoids the
 * choice.
 *
 * A server-rendered PDF has no such coupling, and gains three things a browser
 * print cannot promise:
 *
 *   - **Cyrillic is guaranteed.** DejaVu Sans is embedded in the file, so the
 *     farm's name does not depend on the fonts installed wherever the sheet is
 *     printed. Browser print would hand «Победа» to an unknown printer driver.
 *   - **The geometry is exact.** 105 x 148 mm comes from pdfkit's ISO table,
 *     not from a user agent's interpretation of `size: A6` plus its own
 *     unprintable-margin policy.
 *   - **It is assertable in node.** The page box is bytes in the file
 *     (`/MediaBox [0 0 297.64 419.53]`), so the paper size is covered by a
 *     normal test rather than by a headless browser.
 *
 * ## It refuses to draw an address that leads nowhere
 *
 * Paper outlives state, which is the hazard #1816 raises for handles in its
 * own text. So the preconditions are the caller's, in `buildFarmShareCard`,
 * and they are fail-closed: an unpublished farm's card would carry a URL that
 * 404s, and unlike a screen there is no way to withdraw it once printed.
 *
 * ## No photo, by ruling
 *
 * Text and the QR only. The owner's ruling on the public farm page — "let's
 * leave the avatar out of the farm page - text only" — is why there is no
 * logo slot here either; a card is the same surface one step further from
 * anyone who could correct it.
 */
import { sanitizePlainText } from '@/lib/security/sanitize';
import { createPdfDocument, UNICODE_FONT, UNICODE_FONT_BOLD, BRAND } from '@/lib/pdf/pdfKitFactory';
import { qrMatrix } from '@/lib/qr/matrix';

/** 1 mm in PostScript points. */
const MM = 72 / 25.4;

/**
 * Bulgarian labels. The card's language is Bulgarian regardless of UI locale,
 * the same decision (and for the same reason) as the БАБХ ДНЕВНИК generator:
 * the artefact leaves the product and is read by whoever picks it up.
 */
const L = {
    scanCta: 'Сканирайте за профила на стопанството',
    wordmark: 'agrent.bg',
} as const;

export interface FarmShareCardData {
    /** The published handle. The caller guarantees it is non-empty. */
    readonly handle: string;
    /** The farm's public name. The caller guarantees it is non-empty. */
    readonly displayName: string;
    readonly tagline: string | null;
    /** Absolute public URL, e.g. `https://app.agrent.bg/f/pobeda`. */
    readonly url: string;
    readonly generatedAt: string;
}

/** Height reserved under the QR for the printed address + scan line. */
const URL_BLOCK_HEIGHT = 34;
/** Height reserved at the foot for the wordmark. */
const FOOTER_HEIGHT = 14;
/** Gap between the QR and the address under it. */
const QR_GUTTER = 10;

/**
 * The smallest QR this will claim is scannable: 26 mm.
 *
 * Below roughly that, a phone camera at arm's length stops resolving the
 * modules of a version-3 code reliably. It is a FLOOR TO ASSERT AGAINST, not
 * a clamp — see `shareCardQrSize`, which deliberately does not enforce it.
 */
export const QR_MIN_MM = 26;

/**
 * How large the QR can be, given how much the name and tagline consumed.
 *
 * Exported and pure so the geometry is checked by arithmetic rather than by
 * reading the comment next to it. `farm-share-card-geometry.test.ts` drives
 * this over the whole range of `blockTop` the capped text blocks can produce,
 * and asserts both properties at once: the code never reaches the address
 * under it, and it never drops below {@link QR_MIN_MM} for any input the
 * generator can actually hand it.
 *
 * ## It clamps to the space available and does NOT apply the floor
 *
 * The two degradations are not equally bad. If a future edit lets the name run
 * to three lines, honouring a minimum size would push the code THROUGH the
 * printed address — a corrupt artefact that still looks like a card. Clamping
 * instead yields a code that is visibly too small, which is wrong in a way the
 * person holding it can see. So the floor is a test's claim about today's
 * inputs, not a runtime guarantee that silently buys itself room.
 */
export function shareCardQrSize(geom: {
    contentWidth: number;
    pageHeight: number;
    margin: number;
    /** Y of the first free pixel under the tagline. */
    blockTop: number;
}): number {
    const available =
        geom.pageHeight -
        geom.margin -
        geom.blockTop -
        URL_BLOCK_HEIGHT -
        FOOTER_HEIGHT -
        QR_GUTTER -
        QR_GUTTER;
    return Math.max(0, Math.min(geom.contentWidth, available));
}

/**
 * Shrink `size` until `text` fits `maxLines` at `width`, then ellipsize.
 *
 * Both halves are needed. Shrinking alone cannot bound an arbitrarily long
 * name — a 300-character display name would reach an unreadable size and still
 * overflow — and ellipsizing alone would clip a name that a smaller face would
 * have carried whole. So `sizes` is tried in order and the LAST entry is the
 * floor; below it the text is trimmed instead of shrunk further.
 *
 * Measures with whichever face the CALLER has already selected — it sets
 * `fontSize` but never `font`, because the name is bold and the tagline is
 * not, and a helper that chose the face would have to know which block it was
 * measuring. Both call sites below set `doc.font(...)` immediately before.
 */
function fitText(
    doc: PDFKit.PDFDocument,
    text: string,
    opts: { width: number; sizes: readonly number[]; maxLines: number },
): { text: string; size: number } {
    const lineCount = (s: string, size: number): number => {
        doc.fontSize(size);
        return Math.ceil(doc.heightOfString(s, { width: opts.width }) / doc.currentLineHeight());
    };

    for (const size of opts.sizes) {
        if (lineCount(text, size) <= opts.maxLines) return { text, size };
    }

    // Still too tall at the smallest step: trim characters until it fits.
    const size = opts.sizes[opts.sizes.length - 1];
    let trimmed = text;
    while (trimmed.length > 1 && lineCount(`${trimmed}…`, size) > opts.maxLines) {
        trimmed = trimmed.slice(0, -1).trimEnd();
    }
    return { text: `${trimmed}…`, size };
}

/**
 * Build the A6 card. Returns the document WITHOUT calling `.end()` — the
 * route's `collectPdfBuffer` finalises it, which is the house contract every
 * generator in this directory follows.
 */
export function generateFarmShareCardPdf(data: FarmShareCardData): PDFKit.PDFDocument {
    const displayName = sanitizePlainText(data.displayName);
    const tagline = sanitizePlainText(data.tagline ?? '');

    const margin = 10 * MM;
    const doc = createPdfDocument(
        {
            tenantName: displayName,
            reportTitle: displayName,
            reportSubtitle: data.url,
            generatedAt: data.generatedAt,
            // DejaVu, or every Bulgarian farm name on the card is tofu. The
            // factory registers it ONLY for 'unicode', and every `.font()`
            // call below must use the UNICODE_* names — registering over
            // 'Helvetica' is unreliable in pdfkit 0.19.x.
            fontFamily: 'unicode',
        },
        {
            // pdfkit's own ISO name. 105 x 148 mm = 297.64 x 419.53 pt.
            size: 'A6',
            margins: { top: margin, bottom: margin, left: margin, right: margin },
        },
    );

    const contentWidth = doc.page.width - margin * 2;
    const centre = { width: contentWidth, align: 'center' as const };

    let y = margin;

    // ── farm name ──
    doc.font(UNICODE_FONT_BOLD).fillColor(BRAND.navy);
    const name = fitText(doc, displayName, {
        width: contentWidth,
        sizes: [20, 17, 14, 11],
        maxLines: 2,
    });
    doc.fontSize(name.size).text(name.text, margin, y, centre);
    y = doc.y + 4;

    // ── tagline (optional) ──
    if (tagline) {
        doc.font(UNICODE_FONT).fillColor(BRAND.slate);
        const line = fitText(doc, tagline, {
            width: contentWidth,
            sizes: [10, 9, 8],
            maxLines: 2,
        });
        doc.fontSize(line.size).text(line.text, margin, y, centre);
        y = doc.y;
    }

    // ── QR ──
    //
    // Sized from what is LEFT rather than from a constant, so a two-line name
    // plus a two-line tagline shrinks the code instead of pushing the address
    // off the sheet. The arithmetic is `shareCardQrSize` above, so a test can
    // drive it over every `blockTop` the capped text blocks can produce.
    const qrSize = shareCardQrSize({
        contentWidth,
        pageHeight: doc.page.height,
        margin,
        blockTop: y,
    });
    const qrX = margin + (contentWidth - qrSize) / 2;
    const qrY = y + QR_GUTTER;

    const { count, runs } = qrMatrix(data.url);
    // `modulePt`, not `module`: the bare name shadows the CommonJS `module`
    // and `@next/next/no-assign-module-variable` refuses it.
    const modulePt = qrSize / count;
    // White quiet zone first: a QR with no light margin is materially harder
    // to acquire, and the sheet it is printed on is not guaranteed white.
    doc.rect(qrX, qrY, qrSize, qrSize).fill('#ffffff');
    doc.fillColor('#000000');
    for (const run of runs) {
        doc.rect(
            qrX + run.x * modulePt,
            qrY + run.y * modulePt,
            run.w * modulePt,
            modulePt,
        ).fill();
    }

    y = qrY + qrSize + QR_GUTTER;

    // ── the address, in words ──
    //
    // Printed as well as encoded: a reader without a working camera, or one
    // who wants to type it, needs the handle legible. `url` carries the
    // scheme for the QR; the human line drops it as noise on paper.
    doc.font(UNICODE_FONT_BOLD).fontSize(11).fillColor(BRAND.navy);
    doc.text(data.url.replace(/^https?:\/\//, ''), margin, y, centre);
    y = doc.y + 3;

    doc.font(UNICODE_FONT).fontSize(8).fillColor(BRAND.slate);
    doc.text(L.scanCta, margin, y, centre);

    // ── wordmark ──
    doc.font(UNICODE_FONT).fontSize(7).fillColor(BRAND.slateLight);
    doc.text(L.wordmark, margin, doc.page.height - margin - 9, centre);

    return doc;
}
