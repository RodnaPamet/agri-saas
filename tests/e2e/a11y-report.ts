/**
 * The axe report's TEXT, and the severity gate — separated from `a11y-scan.ts`
 * so it can be asserted without a browser.
 *
 * `a11y-scan.ts` imports `expect` and `AxeBuilder` from `@playwright/test`, so
 * anything living beside them is reachable only from a Playwright run. That is
 * precisely the wrong place for the code that decides what a CI failure TELLS
 * you: the report was wrong for months (it printed a bare CSS selector and
 * discarded the element HTML and axe's own failure summary) and no test could
 * see it, because seeing it meant reading a job log.
 *
 * Nothing here touches a page. See
 * `tests/guards/a11y-report-names-the-node.test.ts`.
 */
/**
 * `auto` — whatever `prefers-color-scheme` resolves to (dark or light).
 * `sunlight` — the «Слънце» high-contrast palette over the light one.
 */
export type ScanTheme = 'auto' | 'sunlight';

export interface AxeViolationNode {
    target: string[];
    failureSummary?: string;
    html?: string;
}
export interface AxeViolation {
    id: string;
    impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
    description: string;
    help: string;
    helpUrl: string;
    nodes: AxeViolationNode[];
}

/**
 * Build the console report for one surface. PURE, and exported, so the thing
 * CI prints can be asserted directly — `scanA11y` needs a live Playwright
 * page, so while this lived inside it the output was only observable by
 * reading a job log after the fact.
 *
 * Returns '' when there is nothing to report, so the caller's "did anything
 * fail" test stays in one place.
 */
export function formatAxeReport(
    surfaceLabel: string,
    theme: ScanTheme,
    url: string,
    violations: AxeViolation[],
): string {
    if (violations.length === 0) return '';

    const byImpact = new Map<string, AxeViolation[]>();
    for (const v of violations) {
        const k = v.impact ?? 'unknown';
        const arr = byImpact.get(k) ?? [];
        arr.push(v);
        byImpact.set(k, arr);
    }

    const ORDER = ['critical', 'serious', 'moderate', 'minor', 'unknown'];
    const lines: string[] = [
        '',
        `\u2500\u2500 axe report \u2014 ${surfaceLabel} [${theme}] (${url}) \u2500\u2500`,
        `   total violations: ${violations.length}`,
    ];
    for (const sev of ORDER) {
        const items = byImpact.get(sev) ?? [];
        if (items.length === 0) continue;
        lines.push(`   ${sev.padEnd(9)}: ${items.length}`);
    }
    for (const sev of ORDER) {
        for (const v of byImpact.get(sev) ?? []) {
            lines.push('');
            lines.push(`   [${sev}] ${v.id} \u2014 ${v.help}`);
            lines.push(`       ${v.helpUrl}`);
            for (const n of v.nodes.slice(0, 3)) {
                lines.push(`       node: ${n.target.join(' \u203a ')}`);
                // THE SELECTOR ALONE IS OFTEN UNRESOLVABLE back to source. axe
                // emits the shortest selector unique ON THE PAGE, which in a
                // Tailwind codebase is routinely a bare utility class: a real
                // failure on #2382 reported `node: .px-2`, and `px-2` appears in
                // dozens of components. Nothing in the log said which one, so
                // the only ways forward were a 160 MB Playwright artifact or
                // standing the whole E2E stack up locally — for a defect axe had
                // already pinpointed.
                //
                // axe hands us both missing halves ON THE NODE: `html` (the
                // element itself) and `failureSummary` (for a name rule, the
                // accessible name beside the visible text — the actual
                // discriminator). Both were declared on `AxeViolationNode` and
                // then dropped on the floor.
                if (n.html) {
                    lines.push(`         html: ${collapse(n.html, 240)}`);
                }
                // Multi-line, and axe's own line breaks are what make the
                // summary readable — so keep them rather than collapsing.
                for (const raw of (n.failureSummary ?? '').split('\n')) {
                    const t = raw.trim();
                    if (t) lines.push(`         ${t}`);
                }
            }
            if (v.nodes.length > 3) {
                lines.push(`       \u2026 and ${v.nodes.length - 3} more node(s)`);
            }
        }
    }
    return lines.join('\n');
}

/**
 * One line, bounded. Element HTML carries newlines and long class lists; a
 * raw dump buries the report it is meant to clarify, and an unbounded one can
 * be an entire subtree.
 */
function collapse(s: string, max: number): string {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}\u2026` : flat;
}

export const SEVERITY_GATE: Array<NonNullable<AxeViolation['impact']>> = [
    'serious',
    'critical',
];
