/**
 * The axe scan both a11y specs run — ONE oracle, two viewports.
 *
 * Extracted from `a11y.spec.ts` by P2.9, which needed the same scan at a
 * phone viewport. Copying it would have produced a second, divergent oracle:
 * the settle logic below is the accumulated answer to four separate flake
 * classes (#266 and its successors — read the comments inside `runA11yScan`,
 * they are the record), and a mobile copy would have drifted from it the
 * first time one of those was revised.
 *
 * ── what the P2.9 split added ──
 *
 * `theme`. The scan forces a settled theme immediately before analysing, and
 * forcing it meant choosing one: `'auto'` keeps the pre-existing behaviour
 * (whatever `prefers-color-scheme` resolves to, which is what the desktop
 * gate has always asserted against), and `'sunlight'` forces the «Слънце»
 * palette — `data-theme="light"` PLUS `data-contrast="high"` on the same
 * element, per `attributesFor` in `src/lib/theme/theme-cookie.ts`.
 *
 * There is NO `data-theme="sunlight"`. Emitting that name selects no palette
 * at all, so a scan that set it would be auditing the dark default while
 * reporting a «Слънце» label — green for the wrong reason. `assertThemeApplied`
 * exists for that: it reads back the attributes it set and fails if the
 * document does not carry them, so a label can never outrun the palette.
 */
import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

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

export const SEVERITY_GATE: Array<NonNullable<AxeViolation['impact']>> = [
    'serious',
    'critical',
];

/**
 * Read back the theme attributes and fail if they are not the ones asked for.
 *
 * The scan's whole claim is "these findings are from THIS palette". An
 * attribute write that silently did not take — a late client navigation
 * replacing the documentElement attributes, a typo'd theme name selecting no
 * palette — leaves the scan reporting a «Слънце» label over the dark default.
 * A read-back is the only thing that separates the two.
 */
async function assertThemeApplied(page: Page, theme: ScanTheme, label: string) {
    const got = await page.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        contrast: document.documentElement.getAttribute('data-contrast'),
    }));
    if (theme === 'sunlight') {
        expect(
            `${label}: data-theme=${got.theme} data-contrast=${got.contrast}`,
        ).toBe(`${label}: data-theme=light data-contrast=high`);
    } else {
        // `auto` must be one of the two REAL palettes and must NOT be carrying
        // the high-contrast overlay, or it is scanning «Слънце» under an
        // `auto` label.
        expect(['dark', 'light']).toContain(got.theme);
        expect(`${label}: data-contrast=${got.contrast}`).toBe(
            `${label}: data-contrast=null`,
        );
    }
}

/**
 * Run axe against the current page. Logs all violations grouped by
 * impact, then asserts no `serious` or `critical` issues remain.
 */
export async function runA11yScan(
    page: Page,
    surfaceLabel: string,
    opts: { theme?: ScanTheme } = {},
) {
    const theme: ScanTheme = opts.theme ?? 'auto';
    // ThemeProvider mounts after hydration: SSR seeds `data-theme="dark"`,
    // then a useEffect flips to whichever palette `prefers-color-scheme`
    // resolves to (Playwright's default is `light`). If axe runs during
    // that transition window, it samples a mix of dark-theme and
    // light-theme tokens against the in-flight cream backgrounds and
    // produces phantom contrast failures (e.g. `#737372` foregrounds
    // that match neither documented palette). Wait until the theme
    // attribute matches the emulated colorScheme so the scan runs on a
    // settled DOM.
    // Navigation settle, FIRST. Some surfaces arrive via a redirect —
    // `/no-tenant` is `redirect('/login')` when unauthenticated
    // (src/app/no-tenant/page.tsx), which is why its axe report is
    // labelled `no-tenant` but carries a `/login` URL. A scan that
    // begins while the page is still moving samples one document and
    // asserts about another, and the theme guarantee established below
    // is discarded by the navigation that follows it. Settle the
    // navigation before establishing anything else.
    await page.waitForLoadState('domcontentloaded').catch(() => {
        /* already settled, or torn down — the scan will report either way */
    });

    // Theme settle. Under CI load (multiple workers, dev server
    // compiling on demand) the post-hydration ThemeProvider effect
    // can run later than 10 s — the previous timeout caused
    // intermittent flakes on the coverage-page scan in particular,
    // which has heavy compute of its own. Bump to 20 s and tolerate
    // a no-show: if the attribute genuinely never settles, axe
    // still produces a reproducible report against whatever theme
    // IS in the DOM, which is more useful than a hard error.
    await page
        .waitForFunction(
            () => {
                const want = matchMedia('(prefers-color-scheme: dark)').matches
                    ? 'dark'
                    : 'light';
                return (
                    document.documentElement.getAttribute('data-theme') === want
                );
            },
            undefined,
            { timeout: 20_000 },
        )
        .catch(() => {
            // Settle window expired — under heavy CI load, or a slow /
            // failed hydration (a stray ChunkLoadError blocking the
            // ThemeProvider effect), `data-theme` can stay on the
            // SSR-seeded value past 20 s.
            //
            // Nothing is done about it HERE any more. #266 forced the
            // resolved theme at this point, which fixed the timeout path
            // and only the timeout path. The force now runs
            // unconditionally further down, immediately before the scan,
            // so this branch exists purely to tolerate the no-show:
            // a theme that never settles is no longer a distinct case.
        });

    // Animation settle. Entry animations (R17's dashboard rise-in,
    // card fade-ins) leave elements mid-transition: axe then samples
    // a half-faded foreground against the background and reports a
    // phantom `color-contrast` failure — the `#6f6f6e` / `#777776`
    // greys that match no documented token, varying run-to-run with
    // exactly the timing-flake signature. Zero out every animation /
    // transition so each element snaps to its settled, fully-opaque
    // colour before the scan; the brief repaint pause lets the
    // recalculated styles land.
    await page.addStyleTag({
        content: `*, *::before, *::after {
            animation-duration: 0s !important;
            animation-delay: 0s !important;
            transition-duration: 0s !important;
            transition-delay: 0s !important;
        }`,
    });
    await page.waitForTimeout(150);

    // Theme force — UNCONDITIONAL, and deliberately the LAST thing before
    // the scan.
    //
    // #266 introduced this force but placed it inside the settle's
    // `.catch()`, so it fired only when the 20 s wait TIMED OUT. That
    // covers "the theme never settles" and leaves "the theme settles, and
    // then something re-establishes it" wide open — which is the failure
    // that survived: a wait that SUCCEEDS forces nothing, and any later
    // client-side navigation or re-render can put `data-theme` back to the
    // SSR-seeded value with the scan still to come.
    //
    // Running it here is idempotent by construction: on `auto` the value
    // written is the same one the settle above waits FOR, so on the happy
    // path this is a no-op assignment. It only does work in the case that
    // used to slip through. Placing it after the animation/transition
    // zeroing matters too — with transitions live, re-asserting the
    // attribute would itself start a colour transition for axe to sample
    // mid-flight.
    //
    // On `sunlight` it is NOT a no-op: it establishes the palette this
    // scan is about. Both attributes are written, because «Слънце» is the
    // light palette plus the high-contrast overlay and either one alone is
    // a different theme.
    await page
        .evaluate((wantTheme: 'auto' | 'sunlight') => {
            const el = document.documentElement;
            if (wantTheme === 'sunlight') {
                if (el.getAttribute('data-theme') !== 'light') {
                    el.setAttribute('data-theme', 'light');
                }
                if (el.getAttribute('data-contrast') !== 'high') {
                    el.setAttribute('data-contrast', 'high');
                }
                return;
            }
            const want = matchMedia('(prefers-color-scheme: dark)').matches
                ? 'dark'
                : 'light';
            if (el.getAttribute('data-theme') !== want) {
                el.setAttribute('data-theme', want);
            }
            // An `auto` scan must not inherit a high-contrast overlay left by
            // a cookie or an earlier scan in the same context.
            if (el.hasAttribute('data-contrast')) {
                el.removeAttribute('data-contrast');
            }
        }, theme)
        .catch(() => {
            /* context destroyed by a late navigation — axe reports on what is there */
        });

    // And prove the palette is the one the label claims. Deliberately AFTER
    // the force and BEFORE the scan, so a force that did not take is a
    // failure rather than a mislabelled report.
    await assertThemeApplied(page, theme, surfaceLabel);

    const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        // See the docblock in a11y.spec.ts for why these are disabled.
        .disableRules(['region'])
        .analyze();

    const violations = results.violations as unknown as AxeViolation[];

    const byImpact = new Map<string, AxeViolation[]>();
    for (const v of violations) {
        const k = v.impact ?? 'unknown';
        const arr = byImpact.get(k) ?? [];
        arr.push(v);
        byImpact.set(k, arr);
    }

    if (violations.length > 0) {
        const lines: string[] = [
            '',
            `── axe report — ${surfaceLabel} [${theme}] (${page.url()}) ──`,
            `   total violations: ${violations.length}`,
        ];
        for (const sev of ['critical', 'serious', 'moderate', 'minor', 'unknown']) {
            const items = byImpact.get(sev) ?? [];
            if (items.length === 0) continue;
            lines.push(`   ${sev.padEnd(9)}: ${items.length}`);
        }
        for (const sev of ['critical', 'serious', 'moderate', 'minor', 'unknown']) {
            const items = byImpact.get(sev) ?? [];
            for (const v of items) {
                lines.push('');
                lines.push(`   [${sev}] ${v.id} — ${v.help}`);
                lines.push(`       ${v.helpUrl}`);
                for (const n of v.nodes.slice(0, 3)) {
                    lines.push(`       node: ${n.target.join(' › ')}`);
                }
                if (v.nodes.length > 3) {
                    lines.push(`       … and ${v.nodes.length - 3} more node(s)`);
                }
            }
        }

        console.log(lines.join('\n'));
    }

    // Hard fail on the severity gate; everything else is logged.
    const gating = violations.filter(
        (v) => v.impact !== null && SEVERITY_GATE.includes(v.impact),
    );

    expect(
        gating,
        `Found ${gating.length} ${SEVERITY_GATE.join('/')} accessibility violation(s) on ${surfaceLabel} [${theme}]. ` +
            `See console output above for rule IDs, help URLs, and DOM nodes.`,
    ).toEqual([]);
}
