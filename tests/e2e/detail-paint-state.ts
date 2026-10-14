/**
 * What to collect when a detail page's shell never paints (#1076).
 *
 * `expectRouteTransition` collects diagnostics only in the `catch` around
 * `waitForURL`. Measured 2026-10-14 across two independent PRs, that half no
 * longer fails and the PAINT wait does:
 *
 *     Error: expect(locator).toBeVisible() failed
 *     Locator: locator('[data-testid="entity-detail-header"]')
 *     Timeout: 30000ms   Error: element(s) not found
 *       at e2e-utils.ts:803
 *
 * `expectRouteTransition`'s docblock predicted precisely that split in advance
 * ("this one fixes the URL wait and leaves the paint wait open"), and its own
 * stated reason for having a message-based channel at all is that the job log
 * survives a flake whose artifact may not. So the channel was wired to the
 * half that no longer fails.
 *
 * `describeListState` would be the wrong evidence here anyway: by the time the
 * paint wait fires, `waitForURL` has already succeeded, so the page is the
 * DETAIL page and a list's rows and selection describe a page that is gone.
 *
 * ## What these fields are for
 *
 * Each one exists to kill a live hypothesis rather than to be interesting:
 *
 *   - `url` — the ledger's #1076 capture recorded the frame URL moving BACK to
 *     the list between the start and end of the expect. If that is happening,
 *     this says so in one line instead of needing a trace.
 *   - `navigationType` — `'reload'` means this document arrived by a reload,
 *     which is the only direct evidence for or against a mid-test reload. The
 *     first-install service-worker reload was fixed in #1802 and measured NOT
 *     to move this flake's rate, so a `'reload'` here would mean a second,
 *     different reload path and a `'navigate'` closes that family off.
 *   - `swControlled` — pairs with the above. A page claimed mid-session routes
 *     its later RSC fetches through the worker without having started under it.
 *   - `contentCount` — the difference between "the element is absent" and "the
 *     element exists and is hidden" is two different bugs, and
 *     `toBeVisible`'s own message only distinguishes them by wording.
 *   - `testids` / `h1` — what DID render. A skeleton, an error boundary and an
 *     empty body are three different answers, and all three present as "the
 *     header never appeared".
 *   - `nextErrorOverlay` — a thrown server component renders the overlay and
 *     no header, which would make this a product error rather than a timing
 *     one.
 *   - `detailRequests` — whether the RSC/document fetch for this URL happened
 *     at all, and how long it took. The ledger's capture recorded 424 requests
 *     then ZERO network for 29.4s; this says which side of that we are on.
 *
 * ## Why the formatting is a separate pure function
 *
 * It is the half that can be tested. The collector runs `page.evaluate` in a
 * browser against a page that has just failed, and cannot be exercised without
 * a built app and a server; the formatter is a total function from a plain
 * object to a string, so `tests/unit/detail-paint-state-format.test.ts` pins
 * it. That split matters more than usual here: a diagnostic that throws
 * replaces the real failure with its own and destroys the evidence it exists
 * to gather, which is the trap `describeListState` already records.
 */

/** Collected in-page. Every field optional: a partial read beats none. */
export interface DetailPaintState {
    url?: string;
    readyState?: string;
    navigationType?: string;
    swControlled?: boolean | null;
    contentCount?: number;
    h1?: string[];
    testids?: string[];
    testidTotal?: number;
    bodyTextLength?: number;
    nextErrorOverlay?: boolean;
    detailRequests?: Array<{ name: string; ms: number }>;
}

const UNKNOWN = '?';

function show(v: unknown): string {
    if (v === undefined || v === null) return UNKNOWN;
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return String(v);
}

/**
 * Render the collected state as indented lines for a failure message.
 *
 * Total by construction — `{}` must produce a readable block rather than
 * `undefined`s, because a page that is tearing down is exactly when fields go
 * missing and exactly when the message matters.
 */
export function formatDetailPaintState(s: DetailPaintState): string {
    const lines: string[] = [];
    lines.push(`  url at failure : ${show(s.url)}`);
    lines.push(`  readyState     : ${show(s.readyState)}`);
    lines.push(
        `  navigationType : ${show(s.navigationType)}`
            + (s.navigationType === 'reload'
                ? '   <- this document is a RELOAD; a mid-test reload drops a pending transition'
                : ''),
    );
    lines.push(`  SW controlling : ${show(s.swControlled)}`);
    lines.push(
        `  content nodes  : ${show(s.contentCount)}`
            + (s.contentCount === 0
                ? '   <- ABSENT, not hidden'
                : typeof s.contentCount === 'number' && s.contentCount > 0
                  ? '   <- PRESENT but not visible — a different bug from absent'
                  : ''),
    );
    lines.push(`  h1             : ${s.h1 && s.h1.length > 0 ? s.h1.join(' | ') : '(none)'}`);
    lines.push(
        `  body text len  : ${show(s.bodyTextLength)}`
            + (s.bodyTextLength === 0 ? '   <- nothing rendered at all' : ''),
    );
    lines.push(`  next error overlay: ${show(s.nextErrorOverlay)}`);
    lines.push(
        `  testids present: ${show(s.testidTotal)} total`
            + (s.testids && s.testids.length > 0 ? ` — ${s.testids.join(', ')}` : ''),
    );
    if (s.detailRequests === undefined) {
        lines.push(`  requests for this URL: ${UNKNOWN}`);
    } else if (s.detailRequests.length === 0) {
        lines.push(
            '  requests for this URL: NONE'
                + '   <- the navigation changed the URL without fetching this route',
        );
    } else {
        lines.push(`  requests for this URL: ${s.detailRequests.length}`);
        for (const r of s.detailRequests.slice(0, 6)) {
            lines.push(`    ${Math.round(r.ms)}ms  ${r.name}`);
        }
    }
    return lines.join('\n');
}
