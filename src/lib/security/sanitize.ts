/**
 * Server-side HTML sanitisation (Epic C.5).
 *
 * Every API write path that accepts user-supplied rich text routes
 * through one of the helpers below BEFORE the value is persisted. This
 * is the durable line of defence — render-time sanitisation in React
 * is helpful but not sufficient: a single missed `dangerouslySetInner-
 * HTML` consumer would otherwise turn a stored payload into a stored
 * XSS vector. Sanitising at write time means even off-app surfaces
 * (PDF export, audit pack share link, future SDKs reading the row
 * verbatim) inherit the same safety.
 *
 * Two profiles. Pick by the call-site's intent:
 *
 *   - `sanitizeRichTextHtml(input)` — for surfaces that render HTML
 *     (policy `contentText` when `contentType === 'HTML'`,
 *     comment bodies when we eventually allow HTML formatting).
 *     Allows a deliberately small set of formatting tags + safe links.
 *
 *   - `sanitizePlainText(input)` — for surfaces that render plain text
 *     (titles, single-line descriptions, comment bodies today). Resolves
 *     entities to a FIXED POINT, then strips all tags, so a stored
 *     `&lt;script&gt;` can't roundtrip back into a `<script>` somewhere
 *     downstream — and is IDEMPOTENT, so a caller that sanitises the same
 *     value twice is safe. Until #2854 this sentence was false in both
 *     halves: the order was the reverse and it produced the very round-trip
 *     the sentence denied.
 *
 * Library choice
 * --------------
 *   `sanitize-html` over DOMPurify+jsdom because it runs natively on
 *   Node without a DOM polyfill, bundles smaller, and exposes a
 *   declarative allowlist API that's simpler to review in code review.
 *   It is the de-facto Node.js sanitiser used by GitHub, npm, Sentry,
 *   and others.
 */

import sanitizeHtml from 'sanitize-html';

// ─── Rich-text profile ──────────────────────────────────────────────

/**
 * Tags allowed in the rich-text profile. Headings, paragraphs, lists,
 * inline emphasis, links, code blocks, blockquotes, tables. No
 * `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<form>`,
 * `<input>`, no SVG, no MathML. The `sanitize-html` defaults already
 * exclude these, but we re-state the allowed set explicitly so a
 * library default change can't quietly widen it.
 */
const RICH_TEXT_ALLOWED_TAGS: string[] = [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'u', 's', 'sub', 'sup', 'mark',
    'ul', 'ol', 'li',
    'blockquote',
    'code', 'pre',
    'a',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'div', 'span',
];

/**
 * Per-tag attribute allowlist. Anything not listed here is stripped.
 * Notably, NO `style`, `class`, `id`, or any `on*` handlers anywhere.
 */
const RICH_TEXT_ALLOWED_ATTRS: Record<string, string[]> = {
    a: ['href', 'title', 'rel', 'target'],
    th: ['scope', 'colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    code: ['data-language'],
    pre: ['data-language'],
};

/**
 * URL schemes accepted on `href` and friends. Note the deliberate
 * absence of `javascript:`, `data:` (except `data:image/...` which we
 * also exclude — embed images via the upload API instead), and
 * `vbscript:`. Relative URLs are accepted via
 * `allowProtocolRelative: false` + the schemes below being the only
 * legal protocol prefixes.
 */
const RICH_TEXT_ALLOWED_SCHEMES: string[] = ['http', 'https', 'mailto', 'tel'];

/**
 * Sanitise an HTML rich-text payload before persisting it.
 *
 * Behaviour:
 *   - Allowed tags: headings, paragraphs, lists, basic inline marks,
 *     links (`http`, `https`, `mailto`, `tel`), code blocks, tables.
 *   - All other tags are stripped (their text content is preserved).
 *   - All attributes outside the per-tag allowlist are stripped — no
 *     `style`, `class`, `id`, `on*`.
 *   - All `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>` are
 *     dropped along with their text content (XSS sinks).
 *   - Links get `rel="noopener noreferrer"` and `target` gets coerced
 *     to `_blank` only when explicitly set — a bare link stays
 *     same-tab.
 *   - Returns `''` for `null` / `undefined` so callers can pipe an
 *     optional field through unconditionally.
 */
export function sanitizeRichTextHtml(input: string | null | undefined): string {
    if (input == null) return '';
    if (typeof input !== 'string') return '';
    return sanitizeHtml(input, {
        allowedTags: RICH_TEXT_ALLOWED_TAGS,
        allowedAttributes: RICH_TEXT_ALLOWED_ATTRS,
        allowedSchemes: RICH_TEXT_ALLOWED_SCHEMES,
        allowedSchemesAppliedToAttributes: ['href'],
        allowProtocolRelative: false,
        // Drop disallowed tags AND their text content for known XSS
        // sinks; for everything else, keep the inner text. This
        // matches user intent ("they tried to insert <script> with
        // text — strip the script AND don't ship the script body as
        // plain text") while preserving e.g. `<custom-tag>hi</custom-tag>`
        // → `hi`.
        nonTextTags: ['script', 'style', 'textarea', 'noscript', 'iframe', 'object', 'embed'],
        // Coerce `<a target="...">`: keep target only when it's a
        // recognised value, and always pair with a safe rel.
        transformTags: {
            a: (tagName, attribs) => {
                const next: Record<string, string> = { ...attribs };
                // Force-safe relationship attrs.
                next.rel = 'noopener noreferrer';
                if (next.target && next.target !== '_blank' && next.target !== '_self') {
                    delete next.target;
                }
                return { tagName, attribs: next };
            },
        },
    });
}

// ─── Plain-text profile ─────────────────────────────────────────────

/**
 * Strip all HTML and decode HTML entities. Use for fields that have
 * NO formatting (title, label, single-line description, current task
 * comment body).
 *
 * Why entity-decode at the end? `sanitize-html` strips tags but
 * preserves entity-encoded brackets — `&lt;script&gt;` survives. If
 * the storage path then writes the result to a surface that decodes
 * entities (a Markdown renderer, a PDF generator that decodes
 * runtime, an email body), the literal `<script>` reappears. Decoding
 * here means the caller stores exactly what a user reading the field
 * verbatim would see.
 *
 * ## It TRIMS, and that is load-bearing (#1825)
 *
 * It did not until 2026-10-15, and the repo's standard blank check is
 *
 *     const name = sanitizePlainText(input.name);
 *     if (!name) throw codedBadRequest('…_NAME_REQUIRED', '…');
 *
 * so `'   '` was truthy and a name of three spaces passed a check whose own
 * code says it is required. The check worked for the attack it was written
 * against — `'<b></b>'` sanitises to `''` and is refused — and failed for the
 * typo. 28 of this function's call sites are that shape and none trimmed.
 *
 * The cost was not only the refusal. A parcel, contract or crop plan named
 * «   » renders as an empty cell in the ДНЕВНИК and cannot be found by name,
 * and because the row was ACCEPTED nothing anywhere reported a problem. The
 * quieter half is that `' a '` was STORED as `' a '`, so leading whitespace
 * reached the register and the search index at all 139 call sites, not just
 * the 28 that blank-check.
 *
 * Trimming HERE rather than at each caller was the owner's ruling
 * (2026-10-15), over a `sanitizePlainTextRequired` helper and over 28 local
 * `.trim()` calls: it fixes both halves at every site at once, and the 140th
 * caller is correct without knowing this exists. A per-site fix is 28 chances
 * to forget and leaves 111 sites still storing whitespace.
 *
 * Only the ENDS. A multi-line description keeps its internal newlines, so
 * nothing about the notes or rich-text surfaces changes shape.
 *
 * What trim covers, MEASURED rather than assumed — I wrote the opposite
 * here first. `String.prototype.trim` strips the spec's WhiteSpace, which
 * includes every Unicode space separator, so U+00A0 (nbsp), U+2007, U+3000
 * and U+FEFF all go. A non-breaking-space-only name is refused too.
 *
 * **U+200B, the zero-width space, is NOT WhiteSpace and survives**, so a
 * name of one zero-width space is still truthy and still accepted. Same
 * class as the defect this fixes, for a far rarer input, and left alone
 * deliberately: widening past `String.trim` means deciding which characters
 * count as blank, and U+200B is used as a line-break hint in some scripts.
 * That is a different call from discarding incidental whitespace and not one
 * to take while fixing 28 typo-shaped sites. Asserted in
 * `tests/unit/security/sanitize.test.ts` so the residual stays visible.
 */
/**
 * The canonical handful, decoded ONCE.
 *
 * `&amp;` LAST within a pass: decoding it first would turn `&amp;lt;` into
 * `&lt;` and then into `<` inside the same pass, which is a double-unescape.
 *
 * That ordering was already here and is correct — but since #2854 it is no
 * longer LOAD-BEARING, and saying so is the point of this paragraph.
 * Measured: reordering it passes all 62 tests. In the LEADING call the loop
 * reaches the same fixed point whatever the order within a pass; in the
 * TRAILING call the input is `sanitize-html`'s output, and
 * `strip('&amp;lt;') === '&amp;lt;'` — the library leaves an existing entity
 * alone — so after the fixed point no `&amp;lt;` can reach it.
 *
 * Kept because it becomes load-bearing again the moment anyone removes the
 * leading fixed point, which is exactly the edit someone will try.
 */
function decodeCanonicalEntitiesOnce(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#x2F;/g, '/')
        .replace(/&#47;/g, '/')
        .replace(/&amp;/g, '&');
}

/** Bound on the fixed-point loop. Four levels of nesting is already absurd. */
const MAX_DECODE_PASSES = 6;

/**
 * Decode until the value stops changing.
 *
 * This is what makes the strip below SAFE BY CONSTRUCTION rather than by
 * argument: once no entity remains, every escape in `sanitize-html`'s output
 * must be the library's own, so the trailing decode cannot resurrect an
 * entity the USER typed. One decode pass is not enough — it peels one level,
 * and `&amp;lt;script&amp;gt;` needs two.
 *
 * Bounded rather than `while`: the loop converges because each pass strictly
 * shortens the string, but a bound is cheaper to reason about than that
 * argument, and a pathological input must not become a hang on a write path.
 */
function decodeEntitiesToFixedPoint(s: string): string {
    let cur = s;
    for (let i = 0; i < MAX_DECODE_PASSES; i += 1) {
        const next = decodeCanonicalEntitiesOnce(cur);
        if (next === cur) return cur;
        cur = next;
    }
    return cur;
}

/**
 * Plain text: no tags, entities resolved, trimmed.
 *
 * ## The order is decode-to-fixed-point, STRIP, decode once (#2854)
 *
 * It used to be strip-then-decode, which produced exactly the round-trip the
 * docblock at the top of this file promises it prevents. Measured on the real
 * function:
 *
 *     "&lt;b&gt;X&lt;/b&gt;"        ->  "<b>X</b>"
 *     "&lt;script&gt;a&lt;/script&gt;" ->  "<script>a</script>"
 *
 * The strip saw no tags (they were entities), and the decode then made them.
 * A value stored like that is a literal `<script>` in plain text, one careless
 * render away from executing — and `backend-2` measured the sharper version
 * of the same thing: the function CONVERGES to stripping over repeated
 * passes, but **pass two is where it is at its worst**, so a caller that
 * sanitises the same value twice sits exactly on the bad step.
 *
 * ## Why the obvious fix is wrong, measured
 *
 * Simply decoding before stripping regresses ordinary text, because
 * `sanitize-html` RE-ENCODES and in that order nothing undoes it:
 *
 *     "Иван & Петър ООД"    ->  "Иван &amp; Петър ООД"
 *     "цена < 100 лв/дка"   ->  "цена &lt; 100 лв/дка"
 *     "Нива 5 > Нива 3"     ->  "Нива 5 &gt; Нива 3"
 *
 * That is why the decode was last. A farmer types `цена < 100 лв/дка` into a
 * listing description, so this is a real regression and not a corner.
 *
 * Decode → strip → decode preserves those but only moves the defect up a
 * level: the trailing decode cannot tell the library's re-encoding from an
 * entity the user typed, so a doubly-encoded input yields a literal
 * `<script>` on the FIRST pass.
 *
 * The leading FIXED POINT resolves that ambiguity before the strip, which is
 * the only place it can be resolved. Afterwards there are no user entities
 * left to confuse with the library's.
 *
 * ## It is idempotent now, and that is a property callers rely on
 *
 * `f(f(x)) === f(x)`. One live caller sanitised the same value twice (the DM
 * link card, `backend-2`'s #2862) and defended it as idempotent, which was
 * false. That path is down to one pass on its own merits, but the property is
 * what stops the next two-pass caller being a vulnerability.
 *
 * ## One accepted behaviour change
 *
 * `"a &amp;amp; b"` now yields `"a & b"` where it used to yield
 * `"a &amp; b"` — a deliberately double-escaped ampersand collapses.
 * Documented rather than special-cased: no field in this product round-trips
 * escaped markup on purpose (confirmed with `backend-2` for the social
 * fields, whose link-card columns are inbound third-party text that is never
 * re-submitted), and a special case would reintroduce exactly the
 * whose-entity-is-this ambiguity the fixed point removes.
 *
 * The #1825 contract is unchanged: the trim is LAST, so `'&#x20;'` is a space
 * by the time it runs, and a whitespace-only value is still falsy — which 28
 * blank-check call sites depend on.
 */
export function sanitizePlainText(input: string | null | undefined): string {
    if (input == null) return '';
    if (typeof input !== 'string') return '';
    const resolved = decodeEntitiesToFixedPoint(input);
    const stripped = sanitizeHtml(resolved, {
        allowedTags: [],
        allowedAttributes: {},
    });
    // `sanitize-html` re-encodes `<`/`>`/`&` even after stripping tags, so the
    // stored value would otherwise carry the library's escaping rather than
    // the literal text the user typed. Unambiguous here BECAUSE of the leading
    // fixed point: nothing in `stripped` can be an entity the user wrote.
    //
    // The trim is LAST, which #1825 put there because `'&#x20;'` is a space
    // once decoded and trimming first would leave it.
    //
    // That reason turns out to describe the WRONG step, and the correction is
    // worth more than the ordering. Measured: `sanitize-html` resolves
    // `&#x20;` itself — `strip('&#x20;&#x20;ляво')` is `'  ляво'`, literal
    // spaces — so the whitespace is already literal before either of our
    // decodes runs. No entity in `decodeCanonicalEntitiesOnce`'s list yields
    // whitespace, so trim-before and trim-after are indistinguishable on every
    // reachable input, and swapping them passes all 62 tests.
    //
    // Left last anyway: it is correct, it is free, and it stops being a no-op
    // the moment a whitespace entity joins that list.
    return decodeCanonicalEntitiesOnce(stripped).trim();
}

// ─── Convenience helpers ────────────────────────────────────────────

/**
 * Pick the right sanitiser for a policy version's content based on
 * its declared content type. `MARKDOWN` gets the plain-text treatment
 * because the renderer (the markdown engine) is responsible for
 * escaping; storing literal HTML inside a Markdown field would be a
 * silent bypass of the markdown sanitiser.
 */
export function sanitizePolicyContent(
    contentType: 'HTML' | 'MARKDOWN' | 'EXTERNAL_LINK',
    content: string | null | undefined,
): string {
    if (content == null) return '';
    if (contentType === 'HTML') return sanitizeRichTextHtml(content);
    return sanitizePlainText(content);
}
