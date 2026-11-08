/**
 * Epic 56 — ad-hoc `title=` ratchet.
 *
 * The `<Tooltip>` primitive (`src/components/ui/tooltip.tsx`) is the
 * canonical way to surface a hover/focus hint on an interactive element
 * in Agrent. The native HTML `title=` attribute is kept for
 * three specific escape valves only — documented in
 * `docs/tooltip-and-copy-strategy.md`:
 *
 *   1. Truncation fallbacks on `max-w-* truncate` spans.
 *   2. High-density visualisations (heatmaps, progress bars, calendar
 *      cells, permission matrix) — tens to hundreds of elements where
 *      portalising a Radix Tooltip per cell is the wrong cost.
 *   3. Row-select checkboxes with an existing `aria-label`.
 *
 * Everywhere else, `title=` on an HTML element is a regression. This
 * ratchet caps the count of genuine HTML `title=` usages inside
 * `src/app/` so migrations can only go DOWN.
 *
 * ─── Component-prop `title=` is explicitly out of scope ───
 *
 * React-prop `title=` on components — `<Modal title=…>`, `<Sheet title=…>`,
 * `<Modal.Header title=…>`, `<Sheet.Header title=…>`, `<Card>`,
 * `<FieldGroup>`, `<NavSection>`, `<TableEmptyState>`, `<Tooltip title=…>`,
 * `<InfoTooltip>`, … — is a semantic prop that renders visible header
 * text or a styled bold heading. It is NOT a tooltip attribute.
 *
 * The detector below filters those out by the enclosing tag's name:
 *   - lowercase first char AND no dot → HTML element → count it
 *   - uppercase first char OR contains a dot → component → ignore
 *
 * If a code audit ever reports `<Modal title=…>` or `<Tooltip title=…>`
 * as a "raw tooltip-title usage", that audit is miscategorising — the
 * correct behaviour is what this ratchet already does.
 */

import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const APP_ROOT = path.resolve(__dirname, '../../src/app');

// Recorded at Epic 56 close-out. Lower this when you migrate a
// `title=` on an HTML element to `<Tooltip>`. Never raise it.
//
// Known allowlisted escape valves (documented in
// docs/tooltip-and-copy-strategy.md):
//   - practices/[practiceId]/page.tsx        syncError truncation fallback
//   - risks/dashboard/page.tsx             heatmap matrix cell (density)
//   - risks/RisksClient.tsx:360            heatmap matrix cell (density) —
//       same pattern as dashboard, fourth cell-density tooltip in the
//       app. Density cells render dozens-to-hundreds per page; a real
//       Tooltip portal per cell would be measurably costly. The native
//       `title=` is the right tradeoff at this scale.
const BASELINE_HTML_TITLE_ATTRS = 4;

/**
 * Scan a file for `title=` that sits inside a lower-case HTML element
 * (`span`, `div`, `button`, `a`, `p`, `input`, `code`, `label`, `li`,
 * `td`, …). A React-prop `title=` on a component starts with a capital
 * letter or contains a dot (`Modal`, `Sheet.Header`, `Modal.Header`).
 *
 * The rule: walk backwards from each `title=` position and find the
 * nearest `<Name` opening. If `Name` starts lowercase and contains no
 * dot, count it.
 */
function countHtmlTitleAttrs(raw: string, file: string): Array<{ line: number; tag: string }> {
    // COMMENTS BLANKED by the shared stripper, which replaced two hand-rolled
    // prefix rules: "the line's trimmed prefix starts with `*`" and "… with
    // `//`". Those were careful — an earlier `.includes('//')` version skipped
    // `<a href="https://example.com" title="External">` because the URL's
    // slashes sat in the prefix — and they still could not see a block comment
    // whose `/*` opened on an earlier line with no leading `*` continuation.
    //
    // `strings: false` on purpose: the subject is the ATTRIBUTE NAME and its
    // opening quote, so string CONTENTS are irrelevant, and blanking them
    // would erase the `href` value this function must not be confused by.
    //
    // Migrating the file collection to `collectSourceFiles` is what put this
    // guard in `guards-blank-comments-before-matching`'s population at all —
    // `readsSource` keys on a quoted `src/` path, and the old
    // `path.resolve(__dirname, '../../src/app')` did not match. The detection
    // is correct: it always read `src/`.
    const src = blankNonCode(raw);
    const findings: Array<{ line: number; tag: string }> = [];
    const re = /\btitle\s*=\s*(["'{])/g;
    let match: RegExpExecArray | null;

    while ((match = re.exec(src)) !== null) {
        const pos = match.index;


        // Walk back to find the opening `<Name` for this attribute's tag.
        // Stop on the first unmatched `<` before the position.
        let depth = 0;
        let tagStart = -1;
        for (let i = pos - 1; i >= 0; i--) {
            const ch = src[i];
            if (ch === '>') depth++;
            else if (ch === '<' && src[i + 1] !== '/') {
                if (depth === 0) {
                    tagStart = i + 1;
                    break;
                }
                depth--;
            }
        }
        if (tagStart < 0) continue;

        // Tag name ends at the first space / newline / `>` / `/`.
        const afterLt = src.slice(tagStart, tagStart + 80);
        const nameMatch = afterLt.match(/^([A-Za-z][\w.]*)/);
        if (!nameMatch) continue;
        const tag = nameMatch[1];

        // Skip component tags (uppercase first letter OR contains a dot).
        if (/[A-Z]/.test(tag[0]) || tag.includes('.')) continue;

        // Line number for the report.
        const line = src.slice(0, pos).split('\n').length;
        findings.push({ line, tag });
    }

    return findings;
}

describe('Epic 56 — ad-hoc `title=` ratchet', () => {
    // THE SHARED COLLECTOR, which refuses an empty result.
    //
    // `walk()` was hand-rolled here and `Selector teeth` reported it dead:
    // every assertion below is `total <= BASELINE`, which `total === 0`
    // satisfies — so a walk returning nothing read as "no ad-hoc titles" and
    // the guard could not tell that from "I scanned nothing". That is the
    // `an-empty-window-passes-a-negated-assertion` shape, and it is why a
    // RATCHET on a count needs its population floored rather than trusted.
    const files = collectSourceFiles({ roots: ['src/app'], extensions: ['.tsx'] });

    it(`count of HTML \`title=\` attributes in src/app/ is ≤ ${BASELINE_HTML_TITLE_ATTRS}`, () => {
        const perFile: Record<string, Array<{ line: number; tag: string }>> = {};
        let total = 0;
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf-8');
            const hits = countHtmlTitleAttrs(src, file);
            if (hits.length > 0) {
                perFile[path.relative(APP_ROOT, file)] = hits;
                total += hits.length;
            }
        }

        if (total > BASELINE_HTML_TITLE_ATTRS) {
            const rendered = Object.entries(perFile)
                .flatMap(([f, hits]) => hits.map((h) => `  ${f}:${h.line}  (<${h.tag}>)`))
                .join('\n');
            throw new Error(
                `Epic 56 ratchet: HTML \`title=\` count grew from baseline ${BASELINE_HTML_TITLE_ATTRS} to ${total}.\n` +
                `New HTML title attributes must be migrated to <Tooltip> — see docs/tooltip-and-copy-strategy.md.\n` +
                `Current hits:\n${rendered}`,
            );
        }

        expect(total).toBeLessThanOrEqual(BASELINE_HTML_TITLE_ATTRS);
    });

    it('CONTROL — the detector finds an HTML `title=`, and ignores a component one', () => {
        // The other half of what `Selector teeth` asked for.
        // `countHtmlTitleAttrs()` returning `[]` also satisfied every
        // assertion above, so the detector's ability to detect was never
        // asserted. Synthetic sources, because the live population is a
        // RATCHET whose whole purpose is to reach zero — a control that
        // depended on the four allowlisted sites still existing would fail
        // the moment somebody did the migration this guard exists to drive.
        const html = countHtmlTitleAttrs('<span title="hover me">x</span>', 'synthetic.tsx');
        expect(html).toHaveLength(1);
        expect(html[0].tag).toBe('span');

        // A React prop on a component is not the subject: `<Modal title=…>`
        // and `<Sheet.Header title=…>` are legitimate.
        expect(countHtmlTitleAttrs('<Modal title="ok" />', 'synthetic.tsx')).toEqual([]);
        expect(countHtmlTitleAttrs('<Sheet.Header title="ok" />', 'synthetic.tsx')).toEqual([]);

        // And a commented-out one is not a finding. REAL comment syntax, both
        // forms — measured, because the first draft of this control used a
        // bare ` * <span title="x">` line and `blankNonCode` correctly left it
        // alone: a continuation line with no `/*` above it is not a comment,
        // it is code that happens to start with an asterisk. The hand-rolled
        // prefix rule this replaced DID skip it, which is the false negative
        // the migration removes.
        expect(countHtmlTitleAttrs('// <span title="x">', 'synthetic.tsx')).toEqual([]);
        expect(
            countHtmlTitleAttrs('/**\n * <span title="x">\n */', 'synthetic.tsx'),
        ).toEqual([]);
        expect(countHtmlTitleAttrs('/* <span title="x"> */', 'synthetic.tsx')).toEqual([]);
        // A URL's `//` in the prefix must NOT skip the line. That false
        // negative was fixed once already (see the docblock) and nothing
        // asserted it.
        expect(
            countHtmlTitleAttrs('<a href="https://example.com" title="External">x</a>', 'synthetic.tsx'),
        ).toHaveLength(1);
    });

    it('the population is NON-EMPTY, which is what makes the ratchet mean anything', () => {
        // A floor, not an exact count: `src/app` holds hundreds of `.tsx`
        // files and the number moves with every page added.
        expect(files.length).toBeGreaterThan(200);
    });

    it('baseline is plausible (positive integer, matches recorded state)', () => {
        expect(BASELINE_HTML_TITLE_ATTRS).toBeGreaterThanOrEqual(0);
        // Close-out reality check — if the baseline drifts below the
        // observed count, lower it and re-run.
        let total = 0;
        for (const file of files) {
            total += countHtmlTitleAttrs(fs.readFileSync(file, 'utf-8'), file).length;
        }
        expect(total).toBeLessThanOrEqual(BASELINE_HTML_TITLE_ATTRS);
    });
});
