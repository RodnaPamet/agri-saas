/**
 * The A6 card as an ARTEFACT — P6.7 (#1816).
 *
 * ## What can and cannot be read back out
 *
 * The farm's name is drawn with a SUBSET-encoded embedded font inside a
 * FlateDecode stream, so the glyphs in the file are subset indices and no
 * amount of regex recovers «Победа» from the bytes. A suite that tried would
 * be asserting on pdfkit's encoder.
 *
 * What the file does carry, exactly, is the DRAWING. Inflating the content
 * stream gives the operators, and the QR is `runs.length + 1` rectangle fills
 * — the quiet-zone square plus one per coalesced run. That count is derived
 * from `qrMatrix(url)` in the assertion rather than hard-coded, which makes it
 * a statement about the shared encoder: if the generator ever drew a QR for
 * something other than this url, or stopped using the shared matrix, the
 * count moves.
 *
 * The companion suite `farm-share-card-geometry.test.ts` owns the layout
 * invariant, because nothing here can see an overlap: pdfkit auto-paginates
 * on overflow, so a card whose code is drawn THROUGH the printed address is
 * still exactly one A6 page carrying all the right operators.
 */
import zlib from 'node:zlib';

import { generateFarmShareCardPdf } from '@/app-layer/reports/pdf/farm-share-card';
import { qrMatrix } from '@/lib/qr/matrix';

const MM = 72 / 25.4;
const URL = 'https://app.agrent.bg/f/pobeda';

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}

/** Every FlateDecode stream in the file, inflated and concatenated. */
function inflatedContent(buf: Buffer): string {
    const out: string[] = [];
    let i = 0;
    for (;;) {
        const s = buf.indexOf('stream', i);
        if (s === -1) break;
        let start = s + 6;
        if (buf[start] === 0x0d) start++;
        if (buf[start] === 0x0a) start++;
        const e = buf.indexOf('endstream', start);
        if (e === -1) break;
        try {
            out.push(zlib.inflateSync(buf.subarray(start, e)).toString('latin1'));
        } catch {
            // Not a Flate stream (a font file is raw) — skip it.
        }
        i = e + 9;
    }
    return out.join('\n');
}

const card = (over: Partial<Parameters<typeof generateFarmShareCardPdf>[0]> = {}) =>
    collect(
        generateFarmShareCardPdf({
            handle: 'pobeda',
            displayName: 'Зеленчукова градина „Победа“',
            tagline: 'Домати и краставици от Пловдивско',
            url: URL,
            generatedAt: '2026-10-15T08:00:00.000Z',
            ...over,
        }),
    );

/**
 * Total glyphs drawn, across every text-showing operator.
 *
 * The font is CID-keyed, so each glyph is two bytes inside a `<hex>` string —
 * `length / 4`. This counts CHARACTERS DRAWN where `textShows` counts lines,
 * and the difference matters: line counts are blind to anything that does not
 * change where the text wraps, which is how the first version of the
 * scheme-stripping test below passed against a generator that printed the
 * scheme (proved by mutation, not assumed).
 */
function glyphCount(buf: Buffer): number {
    const content = inflatedContent(buf);
    let n = 0;
    for (const m of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) n += m[1].length / 4;
    for (const m of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
        for (const h of m[1].matchAll(/<([0-9A-Fa-f]+)>/g)) n += h[1].length / 4;
    }
    return n;
}

const rectFills = (buf: Buffer) => (inflatedContent(buf).match(/\bre\b/g) ?? []).length;
const textShows = (buf: Buffer) => (inflatedContent(buf).match(/\bTJ\b|\bTj\b/g) ?? []).length;
const pageCount = (buf: Buffer) =>
    (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

describe('the A6 farm share card', () => {
    it('is one A6 page', async () => {
        const buf = await card();
        // 105 x 148 mm in points, derived from the ISO definition here rather
        // than copied from the generator, so this disagrees if pdfkit's size
        // table ever does.
        expect(buf.toString('latin1')).toContain(
            `/MediaBox [0 0 ${(105 * MM).toFixed(2)} ${(148 * MM).toFixed(2)}]`,
        );
        expect(pageCount(buf)).toBe(1);
    });

    it('stays one page for a name and tagline far longer than any real farm', async () => {
        // pdfkit ADDS a page when text passes the bottom margin, so a second
        // page here is the signal that `fitText`'s caps stopped containing
        // the text. This is the overflow detector, and it only works because
        // the generator never calls `addPage` itself.
        const buf = await card({
            displayName: 'Земеделска кооперация за производство и преработка на зеленчуци „Слънчева долина“'.repeat(3),
            tagline: 'я'.repeat(600),
        });
        expect(pageCount(buf)).toBe(1);
    });

    it('embeds both Cyrillic faces rather than relying on the printer', async () => {
        const raw = (await card()).toString('latin1');
        // Subset-tagged (`XXXXXX+DejaVuSans`), CID-keyed, with the actual
        // TrueType program in the file. Without `FontFile2` the name would
        // depend on fonts installed wherever the sheet is printed — the whole
        // reason this is a PDF and not a print stylesheet.
        expect(raw).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+DejaVuSans\b/);
        expect(raw).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+DejaVuSans-Bold\b/);
        expect(raw).toContain('/FontFile2');
        // And NOT the AFM Helvetica, which is what a `fontFamily` regression
        // would silently fall back to — tofu for every Bulgarian name.
        expect(raw).not.toMatch(/\/BaseFont\s*\/Helvetica\b/);
    });

    it('draws the QR from the shared matrix, for this url', async () => {
        const buf = await card();
        // One rect per coalesced run, plus the white quiet-zone square. The
        // expectation is COMPUTED from the shared encoder, so this is a
        // statement that the printed code is the same encoding the screen
        // shows — not that it has some particular size.
        expect(rectFills(buf)).toBe(qrMatrix(URL).runs.length + 1);
    });

    it('encodes the farm’s own url and not a fixed decoration', async () => {
        // The positive control. A QR drawn from a hard-coded string would
        // satisfy the assertion above for the default url and never change;
        // two different handles must produce two different codes.
        const other = 'https://app.agrent.bg/f/slanchevadolina';
        expect(qrMatrix(other).runs.length).not.toBe(qrMatrix(URL).runs.length);
        expect(rectFills(await card({ url: other }))).toBe(qrMatrix(other).runs.length + 1);
    });

    it('draws the tagline when there is one, and nothing in its place when there is not', async () => {
        // Text shows are counted per LINE, not per block, so the absolute
        // number moves with font metrics and is not asserted. The DELTA is
        // the claim: omitting the tagline removes exactly one drawn line, so
        // an optional block that silently drew an empty string — or that drew
        // the tagline twice — fails here.
        const withTagline = textShows(await card());
        const without = textShows(await card({ tagline: null }));
        expect(withTagline - without).toBe(1);
        // The remaining blocks — name, address, scan line, wordmark — are all
        // still drawn, so a card is never just a QR code.
        expect(without).toBeGreaterThanOrEqual(4);
    });

    it('prints the address without its scheme', async () => {
        // The human line drops `https://` as noise on paper; the QR keeps the
        // whole url because a camera needs it.
        //
        // `https://` and `http://` differ by exactly one character, so two
        // cards differing ONLY in scheme have equal glyph counts when the
        // scheme is stripped and differ by one when it is printed. Measured
        // both ways: 74 vs 74 as written, 82 vs 81 with the strip removed.
        //
        // The first version of this test compared `textShows` instead and
        // passed against a generator that printed the scheme — both forms fit
        // on one line, so a per-line count cannot see the difference. That is
        // why the counter below is per-glyph.
        const https = await card({ url: 'https://app.agrent.bg/f/pobeda', tagline: null });
        const http = await card({ url: 'http://app.agrent.bg/f/pobeda', tagline: null });
        expect(glyphCount(https)).toBe(glyphCount(http));
    });

    it('survives a name that sanitising empties, without inventing one', async () => {
        // `sanitizePlainText` strips markup, so a farm named `<b></b>` reaches
        // the generator as an empty string even though the usecase's
        // precondition (a non-empty column) was satisfied.
        //
        // The card is drawn anyway, with no title — deliberately NOT falling
        // back to the handle. `/f/{handle}` renders the same sanitised empty,
        // so a card that invented a name would disagree with the page it
        // points at, and a farm that names itself `<b></b>` has one problem
        // rather than two inconsistent ones. What matters here is that it
        // does not throw: a 500 on the download would be a worse answer than
        // an untitled card.
        const buf = await card({ displayName: '<b></b>', tagline: null });
        expect(pageCount(buf)).toBe(1);
        // The QR, the address, the scan line and the wordmark are all still
        // drawn, so the sheet is still usable.
        expect(rectFills(buf)).toBe(qrMatrix(URL).runs.length + 1);
        expect(textShows(buf)).toBeGreaterThanOrEqual(3);
    });

    it('draws the farm’s own name, and more of it for a longer name', async () => {
        // The name's glyphs are subset indices, so the STRING is unrecoverable
        // from the file — but the COUNT is not, and it is what a dropped or
        // ignored `displayName` would change. A generator that drew a constant
        // heading, or none, gives the same count for both of these.
        const short = await card({ displayName: 'Победа', tagline: null });
        const long = await card({ displayName: 'Победа и Слънчева долина', tagline: null });
        expect(glyphCount(long)).toBeGreaterThan(glyphCount(short));
        // 'Победа и Слънчева долина' is 18 characters longer than 'Победа'.
        expect(glyphCount(long) - glyphCount(short)).toBe(18);
    });
});
