/**
 * Paragraph-level HTML chunker (S6, KB agronomy structure PR).
 *
 * Pure function — no mocks needed. Covers: paragraph/heading/list-item
 * boundaries, tag stripping, whitespace collapse, empty input, the
 * no-block-tags fallback, and the per-chunk length cap.
 */
import { chunkHtmlByParagraph } from '@/app-layer/ai/rag/chunk';

describe('chunkHtmlByParagraph', () => {
    it('returns [] for empty / null / undefined / whitespace-only input', () => {
        expect(chunkHtmlByParagraph('')).toEqual([]);
        expect(chunkHtmlByParagraph(null)).toEqual([]);
        expect(chunkHtmlByParagraph(undefined)).toEqual([]);
        expect(chunkHtmlByParagraph('   \n\t  ')).toEqual([]);
    });

    it('splits on paragraph boundaries, one chunk per <p>', () => {
        const html = '<p>Wear gloves before mixing.</p><p>Apply within the label window.</p>';
        expect(chunkHtmlByParagraph(html)).toEqual([
            'Wear gloves before mixing.',
            'Apply within the label window.',
        ]);
    });

    it('splits on headings, list items, and blockquotes too', () => {
        const html =
            '<h2>Pre-spray checklist</h2><ul><li>Check wind speed</li><li>Check re-entry interval</li></ul>' +
            '<blockquote>Never spray within 3m of a water source.</blockquote>';
        expect(chunkHtmlByParagraph(html)).toEqual([
            'Pre-spray checklist',
            'Check wind speed',
            'Check re-entry interval',
            'Never spray within 3m of a water source.',
        ]);
    });

    it('strips inline tags and collapses internal whitespace within a block', () => {
        const html = '<p>Apply  <strong>2.5 L/ha</strong>   of\nproduct.</p>';
        expect(chunkHtmlByParagraph(html)).toEqual(['Apply 2.5 L/ha of product.']);
    });

    it('drops empty blocks (e.g. an empty trailing <p></p>)', () => {
        const html = '<p>Only real content.</p><p></p><p>   </p>';
        expect(chunkHtmlByParagraph(html)).toEqual(['Only real content.']);
    });

    it('falls back to one bounded chunk when no block tags are present', () => {
        expect(chunkHtmlByParagraph('Just plain text, no wrapper tags.')).toEqual([
            'Just plain text, no wrapper tags.',
        ]);
    });

    it('caps each chunk at the max character length', () => {
        const long = 'x'.repeat(5000);
        const [chunk] = chunkHtmlByParagraph(`<p>${long}</p>`);
        expect(chunk.length).toBe(4000);
    });

    it('is idempotent to call — same input always produces the same output', () => {
        const html = '<p>One.</p><p>Two.</p>';
        expect(chunkHtmlByParagraph(html)).toEqual(chunkHtmlByParagraph(html));
    });
});
