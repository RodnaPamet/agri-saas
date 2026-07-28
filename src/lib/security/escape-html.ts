/**
 * HTML-escaping for values interpolated into an HTML sink.
 *
 * ## Why this is not `sanitizePlainText`
 *
 * `sanitizePlainText` (`./sanitize.ts`) strips tags and then DELIBERATELY
 * decodes the canonical entities, so the stored value is the literal text a
 * user typed. That is correct for its documented purpose — a plain-text
 * consumer — and `tests/unit/security/sanitize.test.ts` pins the behaviour.
 *
 * An HTML template is not a plain-text consumer. Feed a sanitised value into
 * one and entity-encoded markup round-trips back into live tags: a message
 * containing `&lt;a href="…"&gt;` is stored as `<a href="…">` and rendered as
 * a working anchor. Sanitising at the source and escaping at the sink are
 * different jobs; only the second one makes an HTML template safe.
 *
 * So: **escape at the sink, every value, every time.** Do not "fix" a template
 * by tightening the sanitiser instead — other callers depend on the decoded
 * form, and the next template added would be unprotected again.
 *
 * ## Scope
 *
 * Escapes the five characters that matter inside element content and inside a
 * quoted attribute value. It is NOT sufficient for unquoted attributes, `href`
 * scheme validation (`javascript:` survives escaping), inline `<script>` or
 * `<style>` bodies, or URL components. Keep interpolations in element content
 * or double-quoted attributes, and validate URLs separately.
 *
 * Enforced by `tests/guardrails/html-template-escaping.test.ts`.
 */

/**
 * Escape a value for interpolation into HTML element content or a quoted
 * attribute value.
 *
 * `&` is replaced first so the entities introduced by the later replacements
 * are not themselves double-escaped.
 */
export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
