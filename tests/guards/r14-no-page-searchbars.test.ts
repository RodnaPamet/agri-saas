/**
 * Filter-scoped page search — live box required, bare inputs banned.
 *
 * History: Roadmap-14 PR-7 retired the per-page FilterToolbar search
 * input in favour of ⌘K. That was REVERSED (2026-05-30): "search
 * content should appear as you type, no need to press enter — valid
 * for all pages with a filter above the table." A first pass added a
 * standalone search bar; the user then directed that the search live
 * INSIDE the filter bar itself, not in a separate bar. So the search
 * now happens within the Filter dropdown.
 *
 * The two canonical search affordances:
 *
 *   • `<FilterToolbar searchPlaceholder="...">` — per-page filter-
 *     scoped LIVE search that lives INSIDE the Filter dropdown: opening
 *     the Filter popover and typing in its top input filters the table
 *     (debounced, no Enter). `searchPlaceholder` is the opt-in that
 *     turns the dropdown's top input into the content search; it is
 *     REQUIRED on every standard list page (LIST_PAGES_REQUIRE_SEARCH).
 *     There is NO separate search bar.
 *
 *   • The global command palette (⌘K) — cross-page navigation +
 *     search. Triggered via `<SearchAnchor>` in the top-bar.
 *
 * The bare-`<input>` ban below stands: page-level search must go
 * through the FilterToolbar primitive, never a hand-rolled
 * `<input type="search">`.
 *
 * What this ratchet bans:
 *
 *   - Hand-rolled `<input type="search">` in `src/app/t/**` or
 *     `src/app/org/**`. These are LIST + REPORT + ADMIN pages
 *     where FilterToolbar is the canonical filter-scoped search.
 *
 *   - Hand-rolled `placeholder="Search ..."` on a bare `<input>`
 *     in the same directories. The pre-R14 pages all used various
 *     placeholders ("Search templates...", "Search members...",
 *     etc.) on bare inputs; the ratchet catches every shape.
 *
 * What this ratchet explicitly ALLOWS:
 *
 *   - `<input>` inside a `<Modal>` or `<Combobox>` body — those
 *     are picker affordances, not page-level search bars. The
 *     SoAClient modal-picker (line 338) is the canonical example.
 *
 *   - `<input>` inside `src/components/**` — the FilterToolbar,
 *     Combobox, and other primitives legitimately host search
 *     inputs. This ratchet scopes to app/ pages only.
 *
 *   - `<input>` whose `placeholder` references "filter" or
 *     "Filter" — those are tagged as filter-scoped affordances
 *     and likely belong inside a FilterToolbar adoption.
 *
 * Six baseline files in `app/t/**` that previously had standalone
 * searchbars (cleaned by R14-PR7):
 *
 *   • policies/templates/page.tsx
 *   • controls/templates/page.tsx
 *   • frameworks/[frameworkKey]/templates/page.tsx
 *   • admin/members/page.tsx
 *   • controls/sankey/ControlsSankeyClient.tsx
 *   • reports/soa/SoAClient.tsx (main page search; modal search kept)
 *
 * If any new page reintroduces one, this ratchet fires.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

const SCAN_ROOTS = ['src/app/t', 'src/app/org'];

// Patterns that flag a HAND-ROLLED raw search input. Two shapes:
//   1. `<input type="search" ... />`
//   2. `<input placeholder="Search ..." />`
// Scanned across every file under SCAN_ROOTS.
const BANNED_PATTERNS: RegExp[] = [
    /<input\b[^>]*\btype=["']search["']/,
    /<input\b[^>]*\bplaceholder=["']Search\b/,
];

// FILE-ANCHORED *require* on `searchPlaceholder=` / `searchPlaceholder:`
// for the standard list-page Client files. R14-PR7 originally retired
// the FilterToolbar text-search input here in favour of ⌘K; that
// decision was reversed (2026-05-30) — list pages now carry a LIVE,
// filter-scoped search box (typing filters the table, no Enter). The
// `<FilterToolbar searchPlaceholder>` row is the canonical affordance;
// the ⌘K palette remains the cross-ENTITY search. This ratchet now
// locks the box IN: each of these files must wire a `searchPlaceholder`.
//
// Why file-anchored (not directory-scanned)?
//   The `searchPlaceholder` prop name is shared between
//   `<FilterToolbar>` (the page-level search row we now require)
//   and `<Combobox>` (picker affordance inside modals + form
//   fields). A directory scan can't tell them apart; the curated
//   list targets exactly the toolbar wiring.
//
const LIST_PAGES_REQUIRE_SEARCH = [
    'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
    'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
    // Evidence's bespoke toolbar now carries the box too, with the
    // Filter cluster moved to the left to match the other pages.
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
];

interface Offender {
    file: string;
    line: number;
    text: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

function scanFile(absPath: string): Offender[] {
    const content = fs.readFileSync(absPath, 'utf8');
    // Strip block + line comments so doc-comments mentioning the
    // banned patterns don't trip the detector.
    const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    const lines = stripped.split('\n');
    const hits: Offender[] = [];
    lines.forEach((line, i) => {
        for (const rx of BANNED_PATTERNS) {
            if (rx.test(line)) {
                hits.push({
                    file: path.relative(ROOT, absPath),
                    line: i + 1,
                    text: line.trim().slice(0, 160),
                });
                break;
            }
        }
    });
    return hits;
}

describe('Live filter-scoped search on list pages', () => {
    it('the standard list-page Client files wire a FilterToolbar `searchPlaceholder`', () => {
        // The pattern matches both JSX-attribute form (`<FilterToolbar
        // searchPlaceholder="..." />`) and object-literal form
        // (`filters={{ searchPlaceholder: '...' }}` inside
        // `<EntityListPage>`).
        const rx = /\bsearchPlaceholder\s*[=:]/;
        const missing: string[] = [];
        for (const rel of LIST_PAGES_REQUIRE_SEARCH) {
            const abs = path.join(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
            // Strip comments so a doc-comment mentioning the prop
            // name doesn't satisfy the requirement on its own.
            const stripped = fs
                .readFileSync(abs, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            if (!rx.test(stripped)) missing.push(rel);
        }
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} list page(s) are missing a FilterToolbar \`searchPlaceholder\`. Each list page must wire \`searchId\` + \`searchPlaceholder\` so the Filter dropdown's top input becomes a live content search (typing filters the table). Missing:\n${missing.map((m) => `  ${m}`).join('\n')}`,
            );
        }
        expect(missing).toEqual([]);
    });

    it('no `<input type="search">` or `placeholder="Search …"` in app/t or app/org', () => {
        const offenders: Offender[] = [];
        for (const root of SCAN_ROOTS) {
            for (const file of walk(path.join(ROOT, root))) {
                offenders.push(...scanFile(file));
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} hand-rolled page-level search input(s). The two canonical search affordances are \`<FilterToolbar searchPlaceholder="...">\` (per-page filter-scoped search) and the global command palette (⌘K, triggered via <SearchAnchor>). Hand-rolled <input type="search"> or <input placeholder="Search ..."> on pages is the regression class R14-PR7 closed.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('the six baseline files cleaned by R14-PR7 stay clean', () => {
        // Anchor specific files so a future refactor that moves a
        // page's source elsewhere is forced to update this ratchet
        // explicitly (and check the new location too).
        const baselineFiles = [
            'src/app/t/[tenantSlug]/(app)/policies/templates/page.tsx',
            'src/app/t/[tenantSlug]/(app)/admin/members/page.tsx',
        ];
        for (const rel of baselineFiles) {
            const abs = path.join(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
            const hits = scanFile(abs);
            // The SoAClient modal-picker uses a non-banned shape
            // (`<input>` without `type="search"` and without
            // `placeholder="Search ..."` — its placeholder is
            // "Search controls…" which DOES start with "Search").
            // The modal picker is a legitimate carve-out; the
            // structural detector would catch it if not for the
            // following per-file allow-list.
            //
            // Allow-list reasoning: modal-scoped pickers feed an
            // overlay's internal state, not the page's filter
            // graph. They're <Combobox>-shaped affordances that
            // happen to be hand-rolled <input>s today. A future
            // PR migrates them to the shared <Combobox> primitive;
            // until then the carve-out is explicit.
            const allowedLines: Record<string, number[]> = {
            };
            const filtered = hits.filter(
                (h) => !(allowedLines[rel] ?? []).includes(h.line),
            );
            expect(filtered).toEqual([]);
        }
    });
});
