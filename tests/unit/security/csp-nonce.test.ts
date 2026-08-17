/**
 * Mutation proof for the CSP-nonce detector used by
 * `tests/e2e/security/csp-nonce.spec.ts`.
 *
 * The E2E spec passing means the pages it loaded were clean. It does NOT mean
 * the detector would have noticed if they weren't — and a detector that matches
 * nothing passes forever. That distinction is the whole reason the CSP nonce
 * bug survived ten weeks of green CI, so the detector gets its own tests.
 *
 * The centrepiece is `the exact tag that shipped`: the real unnonced element
 * from the 2026-05-14 incident, which must be caught.
 */
import {
    attrValue,
    countScriptTags,
    extractNonce,
    findUnnoncedScripts,
} from '../../helpers/csp-nonce';

const NONCE = 'dGVzdC1ub25jZS12YWx1ZQ==';

describe('extractNonce', () => {
    it('pulls the nonce out of a realistic policy', () => {
        const csp =
            `default-src 'self'; script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'; ` +
            `style-src 'self' 'unsafe-inline'; worker-src 'self' blob:`;
        expect(extractNonce(csp)).toBe(NONCE);
    });

    it('returns null when script-src carries no nonce', () => {
        // A policy that lost its nonce is not a policy with an empty nonce —
        // the spec must fail loudly rather than compare against ''.
        expect(
            extractNonce("default-src 'self'; script-src 'self' 'strict-dynamic'"),
        ).toBeNull();
    });

    it('does not confuse a nonce on another directive for the script one', () => {
        // style-src deliberately has no nonce in this codebase (a nonce there
        // would void 'unsafe-inline' for style attributes). If it ever gains
        // one, we must not silently read it as script-src's.
        const csp = `style-src 'self' 'nonce-STYLEONLY'; script-src 'self' 'strict-dynamic'`;
        expect(extractNonce(csp)).toBeNull();
    });
});

describe('findUnnoncedScripts', () => {
    it('catches the exact tag that shipped in the 2026-05-14 incident', () => {
        // A component script rendered with src+async+no nonce. This is the
        // regression the whole mechanism exists to prevent.
        const html =
            `<html><head>` +
            `<script src="/_next/static/chunks/main.js" async nonce="${NONCE}"></script>` +
            `<script src="/_next/static/chunks/18at7xtdx0uoz.js" async></script>` +
            `</head></html>`;
        const bad = findUnnoncedScripts(html, NONCE);
        expect(bad).toHaveLength(1);
        expect(bad[0]).toContain('18at7xtdx0uoz.js');
    });

    it('accepts a page where every executable script is nonced', () => {
        const html =
            `<script src="/a.js" nonce="${NONCE}"></script>` +
            `<script nonce="${NONCE}">self.__next_f.push([1,"x"])</script>`;
        expect(findUnnoncedScripts(html, NONCE)).toEqual([]);
    });

    it('flags an inline script with no nonce', () => {
        // Inline scripts need the nonce as much as external ones — Next's
        // flight-data pushes are inline.
        const html = `<script>self.__next_f.push([1,"x"])</script>`;
        expect(findUnnoncedScripts(html, NONCE)).toHaveLength(1);
    });

    it('flags a script whose nonce is present but WRONG', () => {
        // A stale/mismatched nonce is blocked by the browser exactly like a
        // missing one, so presence alone must not satisfy the check.
        const html = `<script src="/a.js" nonce="some-other-value"></script>`;
        expect(findUnnoncedScripts(html, NONCE)).toHaveLength(1);
    });

    it('ignores non-executable script types, which need no nonce', () => {
        const html =
            `<script type="application/json">{"a":1}</script>` +
            `<script type="application/ld+json">{"@context":"x"}</script>` +
            `<script type="importmap">{"imports":{}}</script>` +
            `<script type="speculationrules">{"prerender":[]}</script>`;
        expect(findUnnoncedScripts(html, NONCE)).toEqual([]);
    });

    it('still requires a nonce on type="module" and explicit JS mime types', () => {
        const html =
            `<script type="module" src="/m.js"></script>` +
            `<script type="text/javascript" src="/j.js"></script>`;
        expect(findUnnoncedScripts(html, NONCE)).toHaveLength(2);
    });

    it('handles single-quoted and unusually-spaced attributes', () => {
        // Minifiers and streaming renderers are not obliged to use the
        // formatting we expect; a detector that only reads one style would
        // under-report.
        const html =
            `<script src='/a.js' nonce='${NONCE}'></script>` +
            `<script   src="/b.js"   nonce = "${NONCE}"  ></script>` +
            `<script src='/c.js'></script>`;
        const bad = findUnnoncedScripts(html, NONCE);
        expect(bad).toHaveLength(1);
        expect(bad[0]).toContain('/c.js');
    });

    it('is case-insensitive about the tag and attribute names', () => {
        const html = `<SCRIPT SRC="/a.js" NONCE="${NONCE}"></SCRIPT><Script src="/b.js"></Script>`;
        expect(findUnnoncedScripts(html, NONCE)).toHaveLength(1);
    });
});

describe('countScriptTags — the positive control', () => {
    it('counts every script tag, executable or not', () => {
        const html =
            `<script src="/a.js" nonce="${NONCE}"></script>` +
            `<script type="application/json">{}</script>`;
        expect(countScriptTags(html)).toBe(2);
    });

    it('returns 0 for a page with no scripts, which is what makes it a control', () => {
        // The E2E spec asserts this is > 0 before trusting "no unnonced
        // scripts". Without that, a page that rendered no scripts at all —
        // an error page, a redirect body — would pass vacuously.
        expect(countScriptTags('<html><body>no scripts here</body></html>')).toBe(0);
    });
});

describe('attrValue', () => {
    it('returns null for an absent attribute and empty string for an empty one', () => {
        // These must be distinguishable: nonce="" is a real (broken) nonce,
        // while an absent nonce is a different failure. Both are caught, but
        // the helper should not conflate them.
        expect(attrValue('src="/a.js"', 'nonce')).toBeNull();
        expect(attrValue('src="/a.js" nonce=""', 'nonce')).toBe('');
    });
});
