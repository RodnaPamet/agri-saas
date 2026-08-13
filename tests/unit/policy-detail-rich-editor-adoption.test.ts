/**
 * Structural ratchet — lazy-loaded RichTextEditor + sanitized HTML render.
 *
 * GRC teardown phase 2 deleted the policy detail page
 * (`policies/[policyId]/page.tsx`) along with the Policy model, so the
 * Epic 45.2 assertions lost their subject. They were NOT dropped: the
 * knowledge-article detail page is a surviving equivalent — its own
 * source calls the render branch a "COPY of the Policy detail page's
 * version-content rendering" — and it carries the same four bounds this
 * file has always enforced. The ratchet is RE-POINTED there rather than
 * deleted, because nothing else in the suite locks them:
 *
 *   - Lazy-loaded RichTextEditor (bundle posture — ~200KB of Tiptap must
 *     not land on the detail page's first paint).
 *   - The HTML render branch runs `sanitizeRichTextHtml` before
 *     `dangerouslySetInnerHTML` (client-side XSS guard, defence-in-depth
 *     over the usecase-layer sanitisation). `sanitize-rich-text-coverage`
 *     guards the WRITE paths; no other test guards this READ path.
 *   - createVersion forwards the editor's own contentType instead of
 *     hardcoding one, so an HTML version round-trips end-to-end.
 *   - Open-editor seeds the editor mode from the current version's stored
 *     contentType, so a MARKDOWN version cannot silently reopen as HTML.
 *
 * Two deliberate polarity differences from the deleted policy page, read
 * off the surviving source rather than assumed: knowledge authors in
 * WYSIWYG by default, so 'HTML' is the reset/fallback mode where policies
 * used 'MARKDOWN', and the wire payload forwards `editorContentType`
 * directly where policies routed it through a `wireContentType` local.
 *
 * (Filename kept as-is to avoid touching paths outside the teardown's
 * assigned set; the subject is the knowledge detail page.)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const KNOWLEDGE_DETAIL = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/knowledge/[id]/page.tsx',
);
const source = readFileSync(KNOWLEDGE_DETAIL, 'utf8');

describe('Knowledge article detail — RichTextEditor adoption', () => {
    it('lazy-loads RichTextEditor via next/dynamic with ssr: false', () => {
        // Bundle posture: ~200KB Tiptap chunks must not land on the
        // first paint of the article detail page.
        expect(source).toMatch(
            /dynamic\(\s*\(\)\s*=>\s*import\(['"]@\/components\/ui\/RichTextEditor['"]\)[\s\S]{0,200}ssr:\s*false/,
        );
    });

    it('imports sanitizeRichTextHtml for the render branch', () => {
        expect(source).toMatch(
            /import\s*\{[^}]*\bsanitizeRichTextHtml\b[^}]*\}\s*from\s*['"]@\/lib\/security\/sanitize['"]/,
        );
    });

    it('renders HTML versions via dangerouslySetInnerHTML with sanitization', () => {
        // The whitespace-pre fallback stays for MARKDOWN versions; HTML
        // versions branch into the sanitized dangerouslySetInnerHTML
        // path. Both halves of the bound are asserted so a refactor
        // cannot keep the sanitiser call while piping raw text into the
        // innerHTML sink.
        expect(source).toMatch(
            /v\.contentType\s*===\s*['"]HTML['"][\s\S]{0,400}sanitizeRichTextHtml\(/,
        );
        expect(source).toMatch(
            /dangerouslySetInnerHTML=\{\{\s*__html:\s*safe\s*\}\}/,
        );
    });

    it('forwards the editor contentType into the createVersion payload', () => {
        // Never a hardcoded literal on the wire — the payload reflects
        // whichever mode the editor is in (MARKDOWN or HTML) so HTML
        // round-trips end-to-end.
        expect(source).toMatch(
            /body:\s*JSON\.stringify\(\{[\s\S]{0,200}contentType:\s*editorContentType/,
        );
    });

    it('open-editor seeds editorContentType from the current version', () => {
        // A version saved as MARKDOWN must reopen in markdown mode —
        // that branch is locked here so a future refactor cannot
        // silently upgrade stored markdown into the WYSIWYG path.
        expect(source).toMatch(
            /currentVersion\?\.contentType === ['"]MARKDOWN['"][\s\S]{0,80}'MARKDOWN'/,
        );
    });

    it('reset-after-save clears editorContentType back to the default mode', () => {
        // The default authoring mode for this surface is HTML (WYSIWYG);
        // forcing it back after a save means the next "new version"
        // doesn't inherit a one-off toggle into MARKDOWN.
        expect(source).toMatch(
            /setEditorContentType\(['"]HTML['"]\)/,
        );
    });

    it('mounts <RichTextEditor> in the editor tab with the canonical id', () => {
        // E2E selector preserved (`#version-editor`).
        expect(source).toMatch(/<RichTextEditor[\s\S]{0,400}id="version-editor"/);
    });
});
