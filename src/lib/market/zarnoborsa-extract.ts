/**
 * Reading ZarnoBorsa's EXW and FOB price tables (#3081).
 *
 * ## Why a DOM and not a regex
 *
 * This repo ships no HTML parser in production — `sanitize-html` is a
 * sanitiser, not a queryable tree — and adding one would be a new production
 * dependency for a single caller. It is also unnecessary: the job runs a
 * headless Chromium, because a plain fetch cannot hold ZarnoBorsa's session
 * (measured — the login POST answers a greeting and the next request
 * redirects to `/login`, leaving price pages showing August data). So a real
 * DOM is already there.
 *
 * `extractZarnoBorsaRows` is therefore written against the standard DOM API
 * and is handed to Playwright, which STRINGIFIES it into the page. That
 * constraint is why it references nothing outside its own body — no imports,
 * no module-scope helpers, no shared constants. Breaking that rule does not
 * fail a typecheck; it throws inside the browser at runtime, where the only
 * symptom is a run that parses nothing. Keep it self-contained, and keep the
 * Node-side parsing (dates, decimals, signs) in the separate functions below,
 * which run on the extracted strings and are free to use anything.
 *
 * The same function runs under jsdom in the fixture tests, so what the tests
 * exercise is what the browser executes.
 */

/** One row as the page spells it — strings only, nothing interpreted yet. */
export interface ZarnoBorsaRawRow {
    /** `m` from `?p=graph&m=…&j=…`. The region. */
    marketId: number;
    /** `j` from the same link. The product. */
    productId: number;
    /** The product as written, for display. NEVER matched on — see below. */
    label: string;
    /** As printed, thousands separators and all: `1,150.70`. */
    priceText: string;
    /** As printed, including its sign when it has one: `-146.46`, `+150.50`, `156.56`. */
    changeText: string;
    /** `red` | `green` | `black`, which is how the page signals direction. */
    changeClass: string;
    /** As printed: `Nov, 14 2026`. */
    dateText: string;
}

/**
 * Pull every price row out of a loaded ZarnoBorsa market page.
 *
 * SELF-CONTAINED by requirement — see the module docblock.
 *
 * ## Three things this deliberately does not do
 *
 * **It does not track which region section it is inside.** Each page is ONE
 * table holding every region, sections separated by a header `<tr>` of `<th>`s
 * and an `<hr>` row — but every DATA row carries its own `m` and `j` in its
 * link, so the row is self-describing and no state machine is needed. That
 * also means a renamed or restyled section header breaks nothing.
 *
 * **It does not key on the `<hr>` separator, whose `colspan` lies.** The
 * separator is `colspan="4"` on BOTH pages even though FOB has five columns,
 * so anything deriving column count from it would be wrong on FOB.
 *
 * **It does not index cells by position.** An EXW row has four `<td>`s where a
 * FOB row has five — FOB carries a `colHidde` «Цени Напред» cell that EXW
 * leaves as a blank line — so the date is the fourth cell on one page and the
 * fifth on the other. Price is the cell AFTER the link cell, the change is the
 * cell carrying the direction class, and the date is the LAST cell. A column
 * appearing in the middle therefore cannot silently shift the date.
 *
 * ## And one thing it is careful about
 *
 * The `colHidde` cell may hold a SECOND anchor, to
 * `/forwardcurves/<otherMarketId>/<productId>` — whose first path segment is a
 * DIFFERENT market id (1141 for FOB RU, 1215 for FOB RO). Reading that as the
 * market would file one region's prices under another.
 *
 * **What prevents it is the QUERY-ANCHORED regexes, not the `p=graph`
 * check.** Measured by mutation: reversing the anchor order AND deleting the
 * `p=graph` filter leaves every test green, because `/forwardcurves/1141/1006`
 * carries no `?m=` or `&m=` and so fails `[?&]m=` outright — the loop skips it
 * and reaches the real link. Loosening those two regexes to match a bare path
 * number is what reddens the suite.
 *
 * So the `p=graph` filter is DEFENSIVE AND UNPROVEN. It would earn its place
 * only against a future anchor carrying `m=`/`j=` in a query while not being a
 * market link. It is kept for that and recorded as unproven rather than
 * credited with work it is not doing — a comment naming the wrong mechanism is
 * how the next reader deletes the one that matters.
 */
export function extractZarnoBorsaRows(doc: Document): ZarnoBorsaRawRow[] {
    const out: ZarnoBorsaRawRow[] = [];
    const rows = Array.from(doc.querySelectorAll('tr'));

    for (const row of rows) {
        // The market link, by its query shape — not by position among anchors.
        const anchors = Array.from(row.querySelectorAll('a'));
        let marketId = 0;
        let productId = 0;
        let label = '';
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (href.indexOf('p=graph') === -1) continue;
            const m = /[?&]m=(\d+)/.exec(href);
            const j = /[?&]j=(\d+)/.exec(href);
            if (!m || !j) continue;
            marketId = Number(m[1]);
            productId = Number(j[1]);
            label = (a.textContent || '').trim();
            break;
        }
        if (!marketId || !productId) continue;

        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 3) continue;

        // The cell holding the market link; price is the one after it.
        let linkIndex = -1;
        for (let i = 0; i < cells.length; i += 1) {
            const a = cells[i].querySelector('a');
            if (a && (a.getAttribute('href') || '').indexOf('p=graph') !== -1) {
                linkIndex = i;
                break;
            }
        }
        if (linkIndex === -1 || linkIndex + 1 >= cells.length) continue;

        const priceText = (cells[linkIndex + 1].textContent || '').trim();

        // The change cell announces itself by class, so it is found rather
        // than counted to.
        let changeText = '';
        let changeClass = '';
        for (const c of cells) {
            const cls = (c.getAttribute('class') || '').trim();
            if (cls === 'red' || cls === 'green' || cls === 'black') {
                changeText = (c.textContent || '').trim();
                changeClass = cls;
                break;
            }
        }

        const dateText = (cells[cells.length - 1].textContent || '').trim();

        out.push({
            marketId, productId, label, priceText, changeText, changeClass, dateText,
        });
    }

    return out;
}

/**
 * THE LOCK-OUT CONTROL, and the reason it cannot be a date check.
 *
 * The non-subscriber page serves the SAME table markup under a «ЗА ПЪЛЕН
 * ДОСТЪП» banner, with old dates. So a session that silently expires produces
 * a page that parses perfectly and would upsert August rows as though read
 * today.
 *
 * A date-freshness heuristic has NO discriminating power against that: the
 * fixtures carry an «Aug, 03 2026» row under EXW Украйна that is legitimately
 * old, so "I see an old date" is true both when we are locked out and when a
 * market simply has not traded. The banner is the only signal that separates
 * the two worlds, which is why it — and not the dates — gates writing.
 *
 * Matched on the rendered TEXT rather than on a container's class or id,
 * because the surrounding layout is the part of a page most likely to be
 * restyled, while the sentence a paywall shows a non-subscriber is the part
 * least likely to change silently.
 */
export const ZARNOBORSA_LOCKED_MARKER = 'ЗА ПЪЛЕН ДОСТЪП';

export function isZarnoBorsaLocked(doc: Document): boolean {
    const text = doc.body ? doc.body.textContent || '' : '';
    return text.indexOf(ZARNOBORSA_LOCKED_MARKER) !== -1;
}
