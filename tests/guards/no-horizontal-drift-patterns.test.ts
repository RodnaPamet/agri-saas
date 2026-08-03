/**
 * Mobile horizontal-drift STATIC guard (bug class #210).
 *
 * The e2e ratchet at `tests/e2e/mobile/horizontal-drift.spec.ts` measures
 * live `scrollWidth` on a phone viewport — but it only covers the routes
 * listed in its `PAGES` array (a fraction of the ~130 in the product) and
 * needs a browser + DB to run. This test closes the gap on the CHEAP end:
 * a purely static text scan of `src/` that catches the ROOT-CAUSE markup
 * patterns behind horizontal drift, on every file, in milliseconds, with
 * no DOM.
 *
 * commit #210 ("fix(mobile): remove horizontal drift on dashboard cards +
 * app-wide sweep") fixed this class BY HAND — a negative-margin element
 * that pushes content past the viewport edge on a phone, the single worst
 * mobile-feel bug for a field user. Nothing structural stopped it
 * recurring. Three patterns are now locked:
 *
 *   (a) Uncompensated layout-scale horizontal negative margin.
 *       A `-mx-` / `-ml-` / `-mr-` of layout magnitude (>= 2 units) OR any
 *       horizontal negative margin sitting ON a scroll container
 *       (`overflow-y-auto` / `overflow-auto` in the same class list) pulls
 *       content outside its box. It is SAFE only when the SAME element also
 *       carries a compensating inner padding (`px-` / `pl-` / `pr-`) OR
 *       clips its overflow (`overflow-x-hidden` / `overflow-hidden`). An
 *       uncompensated one is the exact #210 shape and FAILS. Button-icon
 *       nudges (`icon={<Plus className="-ml-0.5 -mr-2.5" />}`) and hairline
 *       micro-margins (< 2 units, e.g. `-mx-1` separators) are exempt.
 *       The `COMPENSATED_SITES` baseline documents every current
 *       compensated site with a reason; a NEW compensated site must be
 *       added there in the same diff (completeness ratchet), and a stale
 *       entry (site removed, or its compensation stripped) fails too.
 *
 *   (b) Raw `<table>` without a horizontal-scroll ancestor.
 *       A bare `<table>` (not routed through the `<DataTable>` platform)
 *       whose file carries no `overflow-x-auto` / `overflow-auto` wrapper
 *       overflows a phone the instant its content is wider than the
 *       viewport. `RAW_TABLE_ALLOWLIST` carries the known offenders with a
 *       reason. Print-only surfaces (`/print/`) and the `src/components/ui`
 *       table primitives (where `<DataTable>` itself lives) are out of
 *       scope.
 *
 *   (c) The document-level `overscroll-behavior-x: none` guard in
 *       `globals.css` stays present — it stops an inner scroller's edge
 *       from chaining into a browser back-swipe on mobile.
 *
 * This is a STATIC scan, a sibling to the repo's other structural
 * ratchets. It does not replace the e2e drift ratchet — it front-runs it,
 * catching the pattern at author time on 100% of files.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

// ---------------------------------------------------------------------------
// Shared file walk
// ---------------------------------------------------------------------------

function walk(dir: string, exts: RegExp): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (
                entry.name === 'node_modules' ||
                entry.name === '__tests__' ||
                entry.name === '.next'
            )
                continue;
            out.push(...walk(full, exts));
        } else if (exts.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function isCommentLine(line: string): boolean {
    const t = line.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// ===========================================================================
// (a) Uncompensated layout-scale horizontal negative margins
// ===========================================================================

const NEG_MARGIN_RE = /-m[xlr]-(\d+(?:\.\d+)?)/g;
const LAYOUT_MAGNITUDE = 2; // >= 2 Tailwind units is a layout margin, not a nudge
const SCROLL_CONTAINER_RE = /overflow-(?:y-)?auto/;
const COMPENSATION_RE = /\b(?:px-|pl-|pr-)|overflow-x-hidden|overflow-hidden/;
const ICON_NUDGE_RE = /icon=\{/;

interface MarginHit {
    file: string; // repo-relative
    line: number;
    unit: number;
    scroll: boolean;
    compensated: boolean;
    text: string;
}

/**
 * Return every GUARDED horizontal negative-margin occurrence in a file.
 * "Guarded" = layout-magnitude (>= 2 units) OR sitting on a scroll
 * container — the two shapes that cause drift. Button-icon nudges are
 * excluded entirely. Each hit carries whether it is compensated.
 */
function scanNegativeMargins(rel: string, content: string): MarginHit[] {
    const hits: MarginHit[] = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (ICON_NUDGE_RE.test(line)) return; // button-icon nudge line, exempt
        NEG_MARGIN_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        let maxUnit = 0;
        let found = false;
        while ((m = NEG_MARGIN_RE.exec(line)) !== null) {
            found = true;
            maxUnit = Math.max(maxUnit, parseFloat(m[1]));
        }
        if (!found) return;
        const scroll = SCROLL_CONTAINER_RE.test(line);
        const guarded = maxUnit >= LAYOUT_MAGNITUDE || scroll;
        if (!guarded) return;
        hits.push({
            file: rel,
            line: i + 1,
            unit: maxUnit,
            scroll,
            compensated: COMPENSATION_RE.test(line),
            text: line.trim().slice(0, 140),
        });
    });
    return hits;
}

/**
 * Known compensated layout-negative-margin sites — each verified to carry
 * a compensating `px-`/`pl-`/`pr-` OR `overflow-x-hidden`/`overflow-hidden`
 * on the SAME element. Keyed `file:line`. A new compensated site must be
 * added here (completeness); a stale/uncompensated one fails.
 */
const COMPENSATED_SITES: ReadonlyArray<{
    key: string;
    reason: string;
}> = [
    {
        key: 'src/app/org/[orgSlug]/(app)/widget-dispatcher.tsx:284',
        reason: 'Scroll-container (overflow-y-auto) full-bleed coverage list; -mx-2 bleeds the rows to the card edge and is compensated by px-2.',
    },
    {
        key: 'src/components/frameworks/FrameworkExplorer.tsx:277',
        reason: 'Scroll-container (overflow-y-auto) tree pane; -mx-2 is compensated by px-1 AND clipped by overflow-x-hidden.',
    },
    {
        key: 'src/app/org/[orgSlug]/(app)/dashboard-sections.tsx:81',
        reason: 'Full-bleed hover row; -mx-3 widens the tap target to the card edge and is compensated by px-3.',
    },
    {
        key: 'src/app/t/[tenantSlug]/(app)/locations/[locationId]/page.tsx:658',
        reason: 'Full-bleed phone map; -mx-4 cancels the page px-4 for an edge-to-edge canvas and is clipped by overflow-hidden.',
    },
    {
        key: 'src/components/offline/OfflineFieldPanel.tsx:236',
        reason: 'Full-bleed phone map; -mx-4 gives an edge-to-edge canvas and is clipped by overflow-hidden.',
    },
];
const COMPENSATED_KEYS = new Set(COMPENSATED_SITES.map((s) => s.key));

describe('No horizontal drift — layout-scale negative margins (a)', () => {
    const allHits: MarginHit[] = [];
    for (const abs of walk(SRC, /\.(tsx|jsx)$/)) {
        const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
        allHits.push(...scanNegativeMargins(rel, fs.readFileSync(abs, 'utf-8')));
    }

    it('every guarded negative margin is compensated (px/pl/pr or overflow-x-hidden)', () => {
        const offenders = allHits.filter((h) => !h.compensated);
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 12)
                .map((o) => `  ${o.file}:${o.line}  (-m..${o.unit}${o.scroll ? ', on scroll container' : ''})\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} uncompensated layout-scale negative margin(s) — the #210 horizontal-drift shape.\n\n` +
                    `Fix each by adding a compensating inner padding (px-/pl-/pr-) that cancels the pull, OR clip with overflow-x-hidden / overflow-hidden on the SAME element.\n\n` +
                    `First offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('every compensated site is documented in COMPENSATED_SITES (completeness)', () => {
        const compensated = allHits.filter((h) => h.compensated);
        const undocumented = compensated
            .map((h) => `${h.file}:${h.line}`)
            .filter((k) => !COMPENSATED_KEYS.has(k));
        // De-dupe (a line may carry two margin tokens).
        const uniq = [...new Set(undocumented)];
        if (uniq.length > 0) {
            throw new Error(
                `Found compensated layout-negative-margin site(s) not in COMPENSATED_SITES.\n` +
                    `Add each to the baseline with a written reason in the same diff:\n  ${uniq.join('\n  ')}`,
            );
        }
        expect(uniq).toEqual([]);
    });

    it('every COMPENSATED_SITES entry still exists and is still compensated (no stale entries)', () => {
        const present = new Set(
            allHits.filter((h) => h.compensated).map((h) => `${h.file}:${h.line}`),
        );
        const stale = COMPENSATED_SITES.filter((s) => !present.has(s.key)).map(
            (s) => s.key,
        );
        if (stale.length > 0) {
            throw new Error(
                `Stale COMPENSATED_SITES entr${stale.length === 1 ? 'y' : 'ies'} — the site moved, was removed, or lost its compensation.\n` +
                    `Update the key/line or drop the entry in the same diff:\n  ${stale.join('\n  ')}`,
            );
        }
        expect(stale).toEqual([]);
    });

    it('SELF-TEST: the detector catches a synthetic uncompensated offender', () => {
        // A full-bleed -mx-4 with no px/pl/pr and no overflow clip — pure drift.
        const offender = `<div className="overflow-y-auto -mx-4 h-40">x</div>`;
        const flagged = scanNegativeMargins('synthetic.tsx', offender);
        expect(flagged).toHaveLength(1);
        expect(flagged[0].compensated).toBe(false);

        // The same element with compensating px-4 is NOT an offender.
        const safe = `<div className="overflow-y-auto -mx-4 px-4 h-40">x</div>`;
        const safeHits = scanNegativeMargins('synthetic.tsx', safe);
        expect(safeHits).toHaveLength(1);
        expect(safeHits[0].compensated).toBe(true);

        // A button-icon nudge is exempt entirely (no hit).
        const icon = `<Button icon={<Plus className="-ml-0.5 -mr-2.5" />}>Risk</Button>`;
        expect(scanNegativeMargins('synthetic.tsx', icon)).toHaveLength(0);

        // A hairline micro-margin (< 2 units, not on a scroll container) is exempt.
        const micro = `<Command.Separator className="-mx-1 my-1 h-px" />`;
        expect(scanNegativeMargins('synthetic.tsx', micro)).toHaveLength(0);
    });
});

// ===========================================================================
// (b) Raw <table> without a horizontal-scroll ancestor
// ===========================================================================

const TABLE_TAG_RE = /<table(?:\s+className|\s*>)/;
const OVERFLOW_ANCESTOR_RE = /overflow-(?:x-)?auto/;

interface TableHit {
    file: string;
    line: number;
    text: string;
}

/** Repo-relative-path predicate: is this file in scope for the table scan? */
function tableFileInScope(rel: string): boolean {
    // Skip the `<DataTable>` platform + table primitives (they legitimately
    // render real <table> and are the sanctioned surface).
    if (rel.replace(/\\/g, '/').includes('src/components/ui/')) return false;
    // Skip print-only render surfaces — paginated, non-scrolling, no drift.
    if (rel.replace(/\\/g, '/').includes('/print/')) return false;
    return true;
}

/** Return every bare `<table>` JSX tag in a file (comments excluded). */
function scanRawTables(rel: string, content: string): TableHit[] {
    const hits: TableHit[] = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        // Ignore prose/backtick references like `<table>` in doc comments.
        if (/`[^`]*<table/.test(line)) return;
        if (TABLE_TAG_RE.test(line)) {
            hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120) });
        }
    });
    return hits;
}

/**
 * Known raw-table offenders lacking an overflow-x ancestor.
 *
 * Emptied by P5.3: the three `TraceabilityPanel` linked-entity sub-tables
 * (risks / controls / assets) were migrated to `<DataTable
 * mobileFallback="card">`, so there are no raw `<table>` offenders left.
 * Any NEW bare `<table>` without an `overflow-x-auto` ancestor must be
 * wrapped or migrated to `<DataTable>` — add here only with a written
 * reason (the "no stale entries" test below keeps this honest).
 */
const RAW_TABLE_ALLOWLIST: ReadonlyArray<{ key: string; reason: string }> = [];
const RAW_TABLE_ALLOWKEYS = new Set(RAW_TABLE_ALLOWLIST.map((e) => e.key));

describe('No horizontal drift — raw tables need a scroll ancestor (b)', () => {
    const scanRoots = [path.join(SRC, 'app'), path.join(SRC, 'components')];
    const allTables: Array<TableHit & { fileHasOverflow: boolean }> = [];
    for (const root of scanRoots) {
        for (const abs of walk(root, /\.(tsx|jsx)$/)) {
            const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
            if (!tableFileInScope(rel)) continue;
            const content = fs.readFileSync(abs, 'utf-8');
            const fileHasOverflow = OVERFLOW_ANCESTOR_RE.test(content);
            for (const t of scanRawTables(rel, content)) {
                allTables.push({ ...t, fileHasOverflow });
            }
        }
    }

    it('every raw <table> has an overflow-x-auto/overflow-auto ancestor in its file', () => {
        const offenders = allTables.filter(
            (t) => !t.fileHasOverflow && !RAW_TABLE_ALLOWKEYS.has(`${t.file}:${t.line}`),
        );
        if (offenders.length > 0) {
            const sample = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} raw <table> with no horizontal-scroll ancestor — overflows a phone once content exceeds the viewport.\n\n` +
                    `Wrap it in a <div className="overflow-x-auto"> (or migrate to <DataTable>), OR allowlist it in RAW_TABLE_ALLOWLIST with a reason:\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('every RAW_TABLE_ALLOWLIST entry still lacks an overflow ancestor (no stale entries)', () => {
        const byKey = new Map(allTables.map((t) => [`${t.file}:${t.line}`, t]));
        const stale: string[] = [];
        for (const { key } of RAW_TABLE_ALLOWLIST) {
            const t = byKey.get(key);
            if (!t) {
                stale.push(`${key} (no raw <table> at that line — migrated or moved?)`);
            } else if (t.fileHasOverflow) {
                stale.push(`${key} (file now has an overflow ancestor — drop the allowlist entry)`);
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `Stale RAW_TABLE_ALLOWLIST entr${stale.length === 1 ? 'y' : 'ies'} — remove in the same diff that wraps/migrates the table:\n  ${stale.join('\n  ')}`,
            );
        }
        expect(stale).toEqual([]);
    });

    it('SELF-TEST: the detector catches a synthetic unwrapped table', () => {
        const bad = `<div className="p-4">\n  <table className="w-full min-w-[40rem]">x</table>\n</div>`;
        const hits = scanRawTables('synthetic.tsx', bad);
        expect(hits).toHaveLength(1);
        expect(OVERFLOW_ANCESTOR_RE.test(bad)).toBe(false); // → offender

        const good = `<div className="overflow-x-auto">\n  <table className="w-full min-w-[40rem]">x</table>\n</div>`;
        expect(scanRawTables('synthetic.tsx', good)).toHaveLength(1);
        expect(OVERFLOW_ANCESTOR_RE.test(good)).toBe(true); // → safe

        // A doc-comment reference to `<table>` is NOT a hit.
        expect(scanRawTables('synthetic.tsx', '// migrated the raw `<table>` here')).toHaveLength(0);
    });
});

// ===========================================================================
// (c) globals.css keeps the document-level overscroll guard
// ===========================================================================

describe('No horizontal drift — globals.css overscroll guard (c)', () => {
    it('globals.css declares overscroll-behavior-x: none', () => {
        const css = fs.readFileSync(path.join(SRC, 'app', 'globals.css'), 'utf-8');
        expect(css).toMatch(/overscroll-behavior-x:\s*none/);
    });
});
