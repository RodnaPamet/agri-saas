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
    /**
     * The URL the transition was waiting FOR.
     *
     * `detailRequests` is filtered on `location.pathname` read at failure
     * time, and the measured failure has the URL back on the LIST — so "this
     * URL" is the page the test navigated away from, and the report could not
     * say whether the destination was ever fetched. Carrying the expected URL
     * separately is what makes that question answerable.
     */
    expectedUrl?: string;
    /**
     * Requests that FAILED or were aborted during the transition.
     *
     * Not available from inside the page: a Resource Timing entry is created
     * on response end, so an aborted fetch leaves no entry and
     * `getEntriesByType('resource')` cannot see the one event that would
     * explain a rolled-back navigation. Collected from Playwright's
     * `requestfailed`, which does.
     */
    failedRequests?: string[];
}

const UNKNOWN = '?';

function show(v: unknown): string {
    if (v === undefined || v === null) return UNKNOWN;
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return String(v);
}

/**
 * How many of a page's own resource requests the paint diagnostic prints.
 *
 * 12 rather than 6: the list page prefetches one `?_rsc=` per visible row, so
 * on an assets list with a handful of rows the prefetches alone can fill a
 * smaller window and push the navigation's own fetch out of the report. Large
 * enough to clear the prefetch noise, small enough that a runaway page does
 * not bury the message.
 */
const REQUEST_TAIL = 12;

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
    if (s.expectedUrl !== undefined) {
        lines.push(`  expected url   : ${s.expectedUrl}   <- what the wait was FOR`);
    }
    // ABSENT and NOT-COLLECTED kept apart, exactly as `detailRequests` does
    // below: "no request failed" and "nobody looked" are different facts and
    // the first is the interesting one.
    if (s.failedRequests === undefined) {
        lines.push(`  failed/aborted requests: ${UNKNOWN}`);
    } else if (s.failedRequests.length === 0) {
        lines.push(
            '  failed/aborted requests: NONE'
                + '   <- nothing was aborted, so a dropped flight request is NOT the cause',
        );
    } else {
        lines.push(`  failed/aborted requests: ${s.failedRequests.length}`);
        for (const f of s.failedRequests.slice(-REQUEST_TAIL)) lines.push(`    ${f}`);
        const omitted = s.failedRequests.length - Math.min(s.failedRequests.length, REQUEST_TAIL);
        if (omitted > 0) lines.push(`    (${omitted} earlier failure(s) not shown)`);
    }
    if (s.detailRequests === undefined) {
        lines.push(`  requests for this URL: ${UNKNOWN}`);
    } else if (s.detailRequests.length === 0) {
        lines.push(
            '  requests for this URL: NONE'
                + '   <- the navigation changed the URL without fetching this route',
        );
    } else {
        lines.push(`  requests for this URL: ${s.detailRequests.length}`);
        // The TAIL, not the head. `getEntriesByType('resource')` is in
        // start-time order and the failure is at the END, so the requests
        // closest to it are the last ones — which a `slice(0, 6)` was
        // dropping. Measured on run 38700294675: the header printed
        // `requests for this URL: 8` and listed 6, hiding the two most
        // recent. The navigation's own RSC fetch was among what survived
        // only by luck of ordering.
        //
        // And the omission is NAMED. A count beside a truncated list reads
        // as the whole list to anybody not counting rows, which is how this
        // instrumentation came to be trusted for a month while withholding
        // the two entries its reader most needed.
        const shown = s.detailRequests.slice(-REQUEST_TAIL);
        const omitted = s.detailRequests.length - shown.length;
        if (omitted > 0) {
            lines.push(`    (${omitted} earlier request(s) not shown — most recent ${shown.length} follow)`);
        }
        for (const r of shown) {
            lines.push(`    ${Math.round(r.ms)}ms  ${r.name}`);
        }
    }
    return lines.join('\n');
}
