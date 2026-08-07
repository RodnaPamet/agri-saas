/**
 * Paragraph-level HTML chunker (S6, KB agronomy structure PR).
 *
 * TipTap serialises article content as block-level HTML (p, h1-h6, li,
 * blockquote, table cells). This splits on those block boundaries so each
 * retrieval chunk is one coherent paragraph/step - the unit a spray
 * procedure or harvest protocol actually reasons in, not an arbitrary
 * character window. There was no chunking helper anywhere in src/ before
 * this - scripts/rag/ingest-corpus.ts chunks the GLOBAL external corpus at
 * ingest time (its own bespoke splitter) and scripts/rag/ingest-tenant.ts
 * treats a whole published article as ONE chunk; this is the first
 * paragraph-aware chunker for KB article content.
 *
 * Mirrors the tag-stripping approach in ingest-tenant.ts's plainText()
 * helper, but block-aware: that helper collapses a whole document to ONE
 * string, this one preserves block boundaries as chunk boundaries.
 */

/**
 * Closing tags that mark a block-level boundary in TipTap HTML output.
 * Non-capturing group is load-bearing: `String.split()` on a regex WITH a
 * capturing group would splice the captured text back into the result
 * array between segments — `(?:...)` discards the matched delimiter
 * cleanly instead.
 */
const BLOCK_CLOSE_TAG = /<\/(?:p|h[1-6]|li|blockquote|td|th)>/gi;
const ANY_TAG = /<[^>]*>/g;
/** Hard cap per chunk - bounds a single pathologically long block (or the
 *  whole-document fallback below) before it reaches the embedding call. */
const MAX_CHUNK_CHARS = 4000;

function stripAndCollapse(segment: string): string {
    return segment.replace(ANY_TAG, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Split TipTap HTML into paragraph-level text chunks.
 *
 * Returns [] for empty/whitespace-only input. When no block-closing tag is
 * found (plain text, or HTML the regex doesn't recognise), falls back to
 * the whole stripped content as a single bounded chunk - chunking degrades
 * to "one chunk" rather than dropping the content entirely.
 *
 * Pure function - no I/O, no chunkIndex/tenantId/id assignment (the
 * caller, reindex-knowledge-article.ts, owns row construction).
 */
export function chunkHtmlByParagraph(html: string | null | undefined): string[] {
    if (!html) return [];
    const trimmed = html.trim();
    if (!trimmed) return [];

    const segments = trimmed
        .split(BLOCK_CLOSE_TAG)
        .map(stripAndCollapse)
        .filter((seg) => seg.length > 0);

    if (segments.length > 0) {
        return segments.map((seg) => seg.slice(0, MAX_CHUNK_CHARS));
    }

    // No recognised block tags - fall back to one bounded chunk so content
    // authored without <p> wrappers (or malformed HTML) still indexes.
    const flat = stripAndCollapse(trimmed);
    return flat ? [flat.slice(0, MAX_CHUNK_CHARS)] : [];
}
