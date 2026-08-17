/**
 * CSP nonce — the end-to-end check (@security).
 *
 * READ-ONLY: logs into the shared seeded tenant, requests real pages, and
 * asserts that every executable <script> in the SERVER-RENDERED HTML carries
 * the nonce from that same response's Content-Security-Policy header.
 *
 * Why this exists. Every other nonce check in this repo reads BYTES —
 * `tests/guards/csp-nonce-component-scripts-patch.test.ts` regexes the minified
 * Next bundles in `node_modules`, and `scripts/verify-image-patches.mjs` does
 * the same inside the built image. Both are good, and neither renders anything.
 *
 * That gap is not theoretical. From 2026-05-14 to 2026-07-25 every deployed
 * container served an unnonced `<script>` that
 * `script-src 'nonce-…' 'strict-dynamic'` blocks, and CI was green for ten
 * weeks — because every signal we had described a developer's machine or a
 * source file rather than a rendered page. See
 * `docs/implementation-notes/2026-07-25-csp-nonce-prod-runtime-regression.md`.
 *
 * The structural guards can only catch the failure mode they were written for
 * (our patch not applying). An unnonced script arriving for some OTHER reason —
 * a new Next code path, a middleware regression, a header-ordering change —
 * still ships green. This spec is indifferent to the cause: it asks the only
 * question that matters to a browser.
 *
 * `playwright.config.ts` already runs the app under `next start` in PRODUCTION
 * mode in both CI and local runs, which is exactly the mode where the bundled
 * app-page runtime executes. The capability was sitting there unused.
 *
 * TWO THINGS THIS SPEC IS DELIBERATELY CAREFUL ABOUT:
 *
 *  1. The nonce is PER-REQUEST. The CSP header and the HTML must come from the
 *     SAME response, or the comparison is meaningless. So each assertion makes
 *     one request and reads both from it, rather than reading a header from one
 *     navigation and markup from another.
 *
 *  2. It asserts on the SERVER-RENDERED HTML, not the live DOM. Under
 *     `strict-dynamic`, a correctly-nonced script may load further scripts that
 *     legitimately carry no nonce — those are trusted by delegation. Asserting
 *     over `document.querySelectorAll('script')` would flag them and be wrong.
 *     The bug this guards against was a server-rendered tag, which is precisely
 *     what the response body shows.
 */
import { test, expect, type APIResponse } from '@playwright/test';
import { loginAndGetTenant } from '../e2e-utils';
// Detector lives in tests/helpers so a jest unit test can mutation-prove it
// (tests/unit/security/csp-nonce.test.ts). A green Playwright run proves the
// PAGES were clean; only the mutation proof shows the detector would have
// noticed if they weren't.
import {
    countScriptTags,
    extractNonce,
    findUnnoncedScripts,
} from '../../helpers/csp-nonce';

/** Read whichever CSP header this deployment is configured to send. */
function cspHeaderOf(res: APIResponse): { name: string; value: string } | null {
    const h = res.headers();
    const enforced = h['content-security-policy'];
    if (enforced) return { name: 'Content-Security-Policy', value: enforced };
    const reportOnly = h['content-security-policy-report-only'];
    if (reportOnly) {
        return { name: 'Content-Security-Policy-Report-Only', value: reportOnly };
    }
    return null;
}

test.describe('CSP nonce is applied to server-rendered scripts @security', () => {
    test('every executable script in the rendered HTML carries the response nonce', async ({
        page,
    }) => {
        const slug = await loginAndGetTenant(page);

        // Pages worth checking: the authenticated app shell (where the bug
        // actually shipped) and a public entry surface.
        const paths = [`/t/${slug}/dashboard`, '/login'];

        for (const path of paths) {
            // ONE request; header and body read from it, so the nonce matches.
            // `page.request` shares the browser context's cookies, so this is
            // the authenticated render, not a redirect to /login.
            const res = await page.request.get(path);
            expect(res.status(), `${path}: expected a 2xx render`).toBeLessThan(400);

            const csp = cspHeaderOf(res);
            expect(csp, `${path}: no CSP header on the response at all`).not.toBeNull();

            const nonce = extractNonce(csp!.value);
            expect(
                nonce,
                `${path}: ${csp!.name} has no script-src 'nonce-…' — ` +
                    `policy was: ${csp!.value.slice(0, 300)}`,
            ).not.toBeNull();

            const html = await res.text();

            // Positive control. If the page somehow renders no <script> at all,
            // "no unnonced scripts" would be vacuously true — the same
            // fail-open the structural guard had until #588.
            const total = countScriptTags(html);
            expect(
                total,
                `${path}: no <script> tags found — this assertion would be vacuous`,
            ).toBeGreaterThan(0);

            const unnonced = findUnnoncedScripts(html, nonce!);
            expect(
                unnonced,
                `${path}: ${unnonced.length} of ${total} server-rendered scripts are ` +
                    `missing nonce="${nonce}". ` +
                    `script-src 'nonce-…' 'strict-dynamic' BLOCKS these in the browser.\n` +
                    unnonced.join('\n'),
            ).toEqual([]);
        }
    });

    test('the browser reports no CSP violations while the app shell loads', async ({
        page,
    }) => {
        // The other half: the first test proves the markup is well-formed, this
        // proves the browser agrees. A violation here means something is being
        // blocked in practice, whatever the markup looks like.
        const violations: string[] = [];
        await page.addInitScript(() => {
            document.addEventListener('securitypolicyviolation', (e) => {
                const ev = e as SecurityPolicyViolationEvent;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ((window as any).__cspViolations ??= []).push(
                    `${ev.violatedDirective} blocked ${ev.blockedURI}`,
                );
            });
        });

        const slug = await loginAndGetTenant(page);
        await page.goto(`/t/${slug}/dashboard`);
        await page.waitForLoadState('networkidle').catch(() => undefined);

        violations.push(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(await page.evaluate(() => (window as any).__cspViolations ?? [])),
        );

        // script-src violations are the ones this whole mechanism exists to
        // prevent. Report everything, but fail on any of them — a style-src or
        // img-src violation is also a real policy break worth seeing.
        expect(violations, `CSP violations fired in the browser:\n${violations.join('\n')}`)
            .toEqual([]);
    });
});
