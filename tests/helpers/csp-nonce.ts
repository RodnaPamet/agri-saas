/**
 * Pure helpers for the CSP-nonce end-to-end check.
 *
 * Split out of `tests/e2e/security/csp-nonce.spec.ts` so the DETECTOR can be
 * mutation-proved by a jest unit test (`tests/unit/security/csp-nonce.test.ts`)
 * without standing up a browser. A Playwright spec that passes tells you the
 * pages were clean; it does not tell you the detector would have noticed if
 * they weren't. Those are different claims and this repo has been burned by
 * conflating them.
 */

/** Matches an opening `<script …>` tag, capturing its attribute text. */
export const SCRIPT_TAG = /<script\b([^>]*)>/gi;

/**
 * `type` values that are NOT executable script and therefore need no nonce.
 * Next emits `application/json` data blocks; import maps and speculation rules
 * are also non-executable per the HTML spec.
 */
export const NON_EXECUTABLE_TYPES = [
    'application/json',
    'application/ld+json',
    'importmap',
    'speculationrules',
];

/** Read one HTML attribute out of a tag's attribute text. */
export function attrValue(attrs: string, name: string): string | null {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
    return m ? (m[2] ?? m[3] ?? '') : null;
}

/** The nonce inside `script-src 'nonce-<value>'`, or null if the policy has none. */
export function extractNonce(csp: string): string | null {
    const m = /script-src[^;]*'nonce-([^']+)'/i.exec(csp);
    return m ? m[1] : null;
}

/** Count every `<script>` tag, executable or not — the positive control. */
export function countScriptTags(html: string): number {
    return [...html.matchAll(SCRIPT_TAG)].length;
}

/**
 * Every executable `<script>` in `html` missing `nonce="<expected>"`.
 *
 * Returns the offending tags themselves: on failure you want the markup, not a
 * count, and certainly not a whole page dumped into the CI log.
 */
export function findUnnoncedScripts(html: string, expected: string): string[] {
    const bad: string[] = [];
    for (const m of html.matchAll(SCRIPT_TAG)) {
        const attrs = m[1] ?? '';
        const type = (attrValue(attrs, 'type') ?? '').toLowerCase().trim();
        if (NON_EXECUTABLE_TYPES.includes(type)) continue;
        if (attrValue(attrs, 'nonce') !== expected) {
            bad.push(m[0].slice(0, 200));
        }
    }
    return bad;
}
