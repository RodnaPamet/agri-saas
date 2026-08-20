/**
 * Safe URL utilities.
 *
 * Used to render user-controlled URLs (vendor websites, privacy
 * policies, evidence external-URLs, etc.) as `<a href>` without
 * introducing XSS (`javascript:`) or reverse-tabnabbing
 * (`target="_blank"` without `rel="noopener"`).
 *
 * Rules enforced:
 *   - `javascript:`, `data:`, `vbscript:` hrefs are blocked.
 *   - Relative URLs and `http(s)://` URLs pass through verbatim.
 *   - All external links emit `rel="noopener noreferrer"` whenever
 *     `target="_blank"` is set.
 *
 * The guard is structural (the hook returns `null` when the URL is
 * unsafe) so callers can `{safeHref && <a …>}` without having to
 * remember the security story at every site.
 */

const DANGEROUS_PROTOCOLS = /^\s*(javascript|data|vbscript|file):/i;

export function isSafeHref(raw: string | null | undefined): boolean {
    if (!raw) return false;
    if (DANGEROUS_PROTOCOLS.test(raw)) return false;
    return true;
}

/**
 * Normalise a user-supplied URL for rendering. Returns null when the
 * URL is missing or uses a dangerous protocol — callers should not
 * render a link in that case.
 */
export function normaliseHref(raw: string | null | undefined): string | null {
    if (!isSafeHref(raw)) return null;
    return (raw ?? "").trim();
}

/**
 * Stricter than {@link isSafeHref}: the value must be an ABSOLUTE `http(s)`
 * URL.
 *
 * `isSafeHref` blocks a denylist (`javascript:`, `data:`, `vbscript:`,
 * `file:`) and lets everything else through — which is right for an
 * in-app href, where a relative path is normal and expected. It is the
 * wrong shape for a value a THIRD PARTY supplied: an RSS `<link>` can
 * carry any scheme at all, and a denylist has to have anticipated it.
 *
 * Use this at ingest boundaries; use `isSafeHref`/`normaliseHref` at
 * render sites for values the app itself produced.
 */
export function isHttpUrl(raw: string | null | undefined): boolean {
    if (!raw) return false;
    try {
        const { protocol } = new URL(raw.trim());
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false; // not absolute, or not parseable at all
    }
}

/**
 * Canonical anchor attrs for opening a user-supplied URL in a new
 * tab. Satisfies WCAG 2.1 + reverse-tabnabbing mitigation in one call.
 */
export const EXTERNAL_LINK_ATTRS = {
    target: "_blank" as const,
    rel: "noopener noreferrer" as const,
};
