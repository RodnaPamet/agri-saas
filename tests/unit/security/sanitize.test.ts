/**
 * Unit tests for `src/lib/security/sanitize.ts` (Epic C.5).
 *
 * Two profiles to verify:
 *   - sanitizeRichTextHtml — keeps a small set of formatting tags +
 *     safe links; strips scripts, event handlers, javascript: URIs.
 *   - sanitizePlainText — strips ALL tags AND decodes entities so a
 *     stored `&lt;script&gt;` cannot roundtrip back into a `<script>`
 *     downstream.
 *
 * Plus the convenience policy-content selector.
 *
 * Adding a new dangerous payload? Add a positive case below; the
 * codebase's defence-in-depth posture is "block first, allow only on
 * an explicit allowlist", so a new attack should fail loudly here.
 */

import {
    sanitizeRichTextHtml,
    sanitizePlainText,
    sanitizePolicyContent,
} from '@/lib/security/sanitize';

// ─── Rich text — XSS-stripping ─────────────────────────────────────

describe('sanitizeRichTextHtml — strips dangerous content', () => {
    it('drops <script> entirely (tag + body)', () => {
        const out = sanitizeRichTextHtml(
            'Hello<script>alert(1)</script>World',
        );
        expect(out).not.toMatch(/<script/i);
        expect(out).not.toMatch(/alert\(/);
    });

    it('drops <iframe> entirely', () => {
        const out = sanitizeRichTextHtml(
            '<p>safe</p><iframe src="https://evil"></iframe>',
        );
        expect(out).not.toMatch(/<iframe/i);
        expect(out).toContain('<p>safe</p>');
    });

    it('drops <object> and <embed>', () => {
        const out = sanitizeRichTextHtml(
            '<object data="x.swf"></object><embed src="y.swf">',
        );
        expect(out).not.toMatch(/<object/i);
        expect(out).not.toMatch(/<embed/i);
    });

    it('strips inline event handlers (onclick, onmouseover, …)', () => {
        const out = sanitizeRichTextHtml(
            '<p onclick="alert(1)" onmouseover="alert(2)">click me</p>',
        );
        expect(out).not.toMatch(/onclick=/i);
        expect(out).not.toMatch(/onmouseover=/i);
        expect(out).toContain('click me');
    });

    it('strips javascript: URIs from <a href>', () => {

        const out = sanitizeRichTextHtml('<a href="javascript:alert(1)">x</a>');
        expect(out).not.toMatch(/javascript:/i);
        // Tag may stay (the body 'x' is preserved); the dangerous href
        // must be gone either by attribute removal or full tag drop.
    });

    it('strips data: URIs from <a href>', () => {
        const out = sanitizeRichTextHtml(
            '<a href="data:text/html,<script>alert(1)</script>">x</a>',
        );
        expect(out).not.toMatch(/data:/i);
    });

    it('strips style attributes (so `expression(...)` etc cannot land)', () => {
        const out = sanitizeRichTextHtml(
            '<p style="background:url(javascript:alert(1))">x</p>',
        );
        expect(out).not.toMatch(/style=/i);
        expect(out).not.toMatch(/javascript:/i);
    });

    it('strips class and id attributes (no surface to inject CSS via global stylesheet)', () => {
        const out = sanitizeRichTextHtml(
            '<p class="x" id="y">hi</p>',
        );
        expect(out).not.toMatch(/class=/);
        expect(out).not.toMatch(/id=/);
    });

    it('drops <style> tag and its body', () => {
        const out = sanitizeRichTextHtml(
            '<style>body{display:none}</style><p>hi</p>',
        );
        expect(out).not.toMatch(/<style/i);
        expect(out).not.toMatch(/display:none/);
        expect(out).toContain('<p>hi</p>');
    });

    it('drops form/input/textarea (defence against credential-harvesting injects)', () => {
        const out = sanitizeRichTextHtml(
            '<form action="https://evil"><input name="pw" /></form>',
        );
        expect(out).not.toMatch(/<form/i);
        expect(out).not.toMatch(/<input/i);
    });
});

// ─── Rich text — formatting retention ──────────────────────────────

describe('sanitizeRichTextHtml — keeps legitimate formatting', () => {
    it('keeps headings, paragraphs, lists, inline marks', () => {
        const input =
            '<h2>Title</h2><p>Hello <strong>world</strong> with <em>emphasis</em></p>' +
            '<ul><li>a</li><li>b</li></ul>';
        const out = sanitizeRichTextHtml(input);
        expect(out).toContain('<h2>Title</h2>');
        expect(out).toContain('<strong>world</strong>');
        expect(out).toContain('<em>emphasis</em>');
        expect(out).toContain('<li>a</li>');
    });

    it('keeps tables', () => {
        const out = sanitizeRichTextHtml(
            '<table><thead><tr><th scope="col">k</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>',
        );
        expect(out).toContain('<table>');
        expect(out).toContain('<thead>');
        expect(out).toContain('<th scope="col">k</th>');
        expect(out).toContain('<td>v</td>');
    });

    it('keeps safe links and rewrites rel="noopener noreferrer"', () => {
        const out = sanitizeRichTextHtml(
            '<a href="https://example.com" target="_blank">x</a>',
        );
        expect(out).toContain('href="https://example.com"');
        expect(out).toContain('target="_blank"');
        expect(out).toContain('rel="noopener noreferrer"');
    });

    it('keeps mailto: and tel: links', () => {
        const out = sanitizeRichTextHtml(
            '<a href="mailto:a@b.com">m</a><a href="tel:+1234">t</a>',
        );
        expect(out).toContain('mailto:a@b.com');
        expect(out).toContain('tel:+1234');
    });

    it('drops a non-standard target value but keeps the link', () => {
        const out = sanitizeRichTextHtml(
            '<a href="https://example.com" target="_top">x</a>',
        );
        expect(out).toContain('href="https://example.com"');
        expect(out).not.toMatch(/target=/);
    });
});

// ─── Rich text — null / non-string handling ────────────────────────

describe('sanitizeRichTextHtml — defensive defaults', () => {
    it('returns empty string for null', () => {
        expect(sanitizeRichTextHtml(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
        expect(sanitizeRichTextHtml(undefined)).toBe('');
    });

    it('returns empty string for non-string input', () => {
        // Defensive — the type system says string; the runtime check
        // is so a future TS-loose call site can't bypass sanitisation.
        expect(sanitizeRichTextHtml(42 as unknown as string)).toBe('');
    });
});

// ─── Plain text profile ───────────────────────────────────────────

describe('sanitizePlainText — strips everything', () => {
    it('removes all tags but keeps the text', () => {
        const out = sanitizePlainText('<p>Hello <b>world</b></p>');
        expect(out).toBe('Hello world');
    });

    it('drops <script> body so the text never reaches the renderer', () => {
        const out = sanitizePlainText('safe<script>alert(1)</script>tail');
        expect(out).not.toMatch(/alert/);
        expect(out).toContain('safe');
        expect(out).toContain('tail');
    });

    it('decodes encoded angle brackets so a future renderer cannot re-emit `<script>`', () => {
        const out = sanitizePlainText('&lt;script&gt;alert(1)&lt;/script&gt;');
        // The literal string the user would see when they read the
        // field verbatim. Whether it then reaches a markdown renderer
        // or PDF generator, no `<script>` element ever materialises
        // because there's no script tag in the source HTML.
        expect(out).toBe('<script>alert(1)</script>');
    });

    it('decodes &amp; and &quot; and &#39;', () => {
        expect(sanitizePlainText('Tom &amp; Jerry')).toBe('Tom & Jerry');
        expect(sanitizePlainText('she said &quot;hi&quot;')).toBe('she said "hi"');
        expect(sanitizePlainText('don&#39;t')).toBe("don't");
    });

    it('returns empty string for null / undefined / non-string', () => {
        expect(sanitizePlainText(null)).toBe('');
        expect(sanitizePlainText(undefined)).toBe('');
        expect(sanitizePlainText(42 as unknown as string)).toBe('');
    });

    // ── Trimming (#1825) ──────────────────────────────────────────

    it('a whitespace-only value becomes FALSY, which is what 28 blank checks read', () => {
        // The defect: the repo's standard check is
        //     const name = sanitizePlainText(input.name);
        //     if (!name) throw codedBadRequest('…_NAME_REQUIRED', '…');
        // and this function did not trim, so `'   '` was truthy and a name
        // of three spaces passed a check whose own code says it is required.
        // 28 call sites are that shape; none of them trimmed.
        for (const v of ['   ', '\t', '\n', ' \t\n ', '']) {
            expect(`${JSON.stringify(v)} falsy=${!sanitizePlainText(v)}`)
                .toBe(`${JSON.stringify(v)} falsy=true`);
        }
    });

    it('strips surrounding whitespace from a value it KEEPS', () => {
        // The quieter half, with no refusal attached: `' a '` was STORED as
        // `' a '` at all 139 call sites, so leading whitespace reached the
        // ДНЕВНИК and the search index — a name nobody could find by typing
        // it.
        expect(sanitizePlainText('  Пшеница 2026  ')).toBe('Пшеница 2026');
        expect(sanitizePlainText('\n Karate Zeon \t')).toBe('Karate Zeon');
    });

    it('trims AFTER decoding, so a decoded space is also trimmed', () => {
        // Ordering, and it is observable: `&#x20;` is a space only once
        // decoded. Trimming first would leave it, which is the bug one line
        // earlier in the chain.
        expect(sanitizePlainText('&#x20;a&#x20;')).toBe('a');
        expect(sanitizePlainText('&#x20;&#x20;')).toBe('');
    });

    it('keeps INTERNAL whitespace, so multi-line text is unchanged', () => {
        // Trim touches only the ends. A description or note keeps its
        // newlines and its internal spacing, which is why this could be a
        // one-function change rather than a per-field decision.
        expect(sanitizePlainText('a\n\nb')).toBe('a\n\nb');
        expect(sanitizePlainText('  a  b  ')).toBe('a  b');
    });

    it('covers the Unicode spaces String.trim covers — nbsp included', () => {
        // MEASURED, because I guessed the opposite first and wrote it into a
        // docblock: `String.prototype.trim` strips the spec's WhiteSpace,
        // which includes every Unicode space separator — so U+00A0, U+2007
        // and U+3000 all go, as does U+FEFF. A non-breaking-space-only name
        // is therefore refused too.
        for (const v of ['\u00a0', '\u2007', '\u3000', '\ufeff']) {
            expect(`${JSON.stringify(v)} -> ${JSON.stringify(sanitizePlainText(v))}`)
                .toBe(`${JSON.stringify(v)} -> ""`);
        }
    });

    it('a ZERO-WIDTH space survives — the one residual, recorded not fixed', () => {
        // U+200B is NOT in the spec's WhiteSpace, so `trim` leaves it and a
        // name of one zero-width space is still truthy and still accepted.
        // Same class as the defect #1825 fixes, for a far rarer input.
        //
        // Left alone deliberately rather than overlooked. Widening past
        // `String.trim` means deciding which characters count as blank, and
        // U+200B is a character some scripts use as a line-break hint — so
        // discarding it is a different call from discarding incidental
        // whitespace, and it is not one to take while fixing 28 typo-shaped
        // sites. Asserted so the residual is visible, in the same way the
        // case this replaces in `crop-planning-refusals-are-coded` kept the
        // original gap visible until somebody fixed it.
        expect(sanitizePlainText('\u200b')).toBe('\u200b');
        expect(!sanitizePlainText('\u200b')).toBe(false);
    });
});

// ─── Policy-content selector ──────────────────────────────────────

describe('sanitizePolicyContent — picks the right profile by content type', () => {
    it('uses the rich-text profile for HTML content', () => {
        const out = sanitizePolicyContent(
            'HTML',
            '<h1>X</h1><script>alert(1)</script>',
        );
        expect(out).toContain('<h1>X</h1>');
        expect(out).not.toMatch(/<script/);
    });

    it('uses plain-text stripping for MARKDOWN content', () => {
        // Stored markdown is later rendered by a markdown engine. If
        // we kept HTML inside a markdown blob, the engine's escaper
        // would not see it as user-supplied HTML and could pass it
        // through verbatim.
        const out = sanitizePolicyContent(
            'MARKDOWN',
            '# Heading\n\n<script>alert(1)</script>\n',
        );
        expect(out).not.toMatch(/<script/);
        expect(out).toContain('# Heading');
    });

    it('uses plain-text stripping for EXTERNAL_LINK (defence in depth)', () => {
        const out = sanitizePolicyContent('EXTERNAL_LINK', '<b>x</b>');
        expect(out).toBe('x');
    });

    it('returns empty string for null content', () => {
        expect(sanitizePolicyContent('HTML', null)).toBe('');
        expect(sanitizePolicyContent('MARKDOWN', null)).toBe('');
    });
});
