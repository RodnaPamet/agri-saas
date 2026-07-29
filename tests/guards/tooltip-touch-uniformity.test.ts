/**
 * Tooltip touch-path uniformity.
 *
 * PR #449 re-enabled tooltips app-wide and taught the primitive a second
 * open gesture: on a coarse pointer a tap toggles the tooltip, because
 * Radix deliberately gives touch users nothing (its Trigger early-returns
 * from `onPointerMove` for `pointerType === "touch"` and separately wires
 * `onPointerDown` + `onClick` to CLOSE). On a mobile-first product —
 * farmers and traders using this one-handed in a field — a tooltip that
 * only exists on desktop is a help icon that is pure decoration.
 *
 * THE NEW RISK THAT CREATES: a SECOND behaviour. Before #449 there was one
 * tooltip behaviour (hover/focus) and the only way to get it wrong was to
 * not use the primitive — already covered by `ui-canonical-tooltips`,
 * `no-ad-hoc-tooltip-title`, `edit-columns-no-tooltip-wrap`. Now there are
 * two behaviours inside one component, and the failure mode is the touch
 * path LEAKING OUT of the primitive: a call site that re-implements
 * tap-to-toggle with its own `matchMedia('(pointer: coarse)')`, a prop that
 * lets one caller opt out of it, a delegating component that intercepts the
 * trigger's pointer events. Any of those and the same control behaves
 * differently depending on where it appears — which is exactly what the
 * standing requirement forbids: tooltips must be uniform, canonical, and
 * must not differentiate from each other.
 *
 * It also creates a class of SILENT regression that no existing test would
 * catch:
 *
 *   - Drop the `preventDefault()` in the tap handler and Radix's own
 *     composed close-handlers stop being skipped. The tooltip opens and
 *     closes on the same tap. Nothing fails — `tests/rendered/tooltip.test.tsx`
 *     runs under a jsdom `matchMedia` stub that answers `matches: false` to
 *     every query, so the coarse-pointer branch is never entered there.
 *   - Drop any one of the three dismissal paths (outside pointerdown,
 *     scroll, timeout) and the popup can sit over the UI intercepting the
 *     next touch — the precise failure that got tooltips disabled app-wide
 *     for months (#395).
 *
 * So this guard asserts the INVERSE of the defect, the way
 * `tests/guards/tooltip-kill-switch-consistency.test.ts` and
 * `tests/guards/rls-coverage-skip-visibility.test.ts` do:
 *
 *   1. ONE OWNER — Radix Tooltip is imported in exactly one file, and no
 *      other file that consumes the primitive carries pointer-class logic.
 *   2. DERIVED, NOT SUPPLIED — the pointer class comes from the internal
 *      hook, never from a prop, and the prop surface is closed so no caller
 *      can inject a competing handler or a fork flag.
 *   3. THE preventDefault() SURVIVES — on both `onPointerDown` and
 *      `onClick`, gated on the pointer class, with the controlled-open
 *      wiring that makes the toggle mean anything.
 *   4. ALL THREE DISMISSALS SURVIVE — each add paired with its remove.
 *   5. ONE APPEARANCE — the rendered popup is not conditioned on pointer
 *      class, so touch and desktop see the identical surface.
 *   6. DELEGATES PASS THROUGH — they render `<Tooltip>`, they do not
 *      re-implement it and do not intercept its trigger.
 *
 * ─── WHAT THIS GUARD DOES NOT PROVE ───
 *
 * Everything here is a TEXT scan of source, like every other file in
 * `tests/guards/` — see "Green is not the same as executed" in CLAUDE.md.
 * It contributes ZERO runtime coverage and proves only that the SHAPE of
 * the code is intact: that the handler exists, that it calls
 * `preventDefault()`, that the listeners are added and removed. It does not
 * prove a tap opens a tooltip on a real phone.
 *
 * The behavioural half is `tests/rendered/tooltip.test.tsx` — and today
 * that half covers the HOVER/FOCUS path only. The coarse-pointer branch
 * added by #449 has no executing test in the repo (jsdom's `matchMedia`
 * stub answers `matches: false`, and no Playwright spec taps a tooltip in
 * the `mobile-android` / `mobile-iphone` projects). This guard is the
 * cheap, immediate lock on the shape; a rendered test that drives the
 * branch with a coarse-pointer `matchMedia` stub is the missing piece and
 * is deliberately NOT in this PR, which is guard-only.
 *
 * ─── THIS IS A LOCK, NOT A LAW ───
 *
 * The assertions below describe the touch contract as it shipped in #449.
 * They are deliberately strict so nobody drifts off it by accident — not
 * because the contract is beyond revision. A PR that deliberately changes
 * it updates this guard in the SAME diff, which is the repo convention for
 * every ratchet here.
 *
 * One such change is already known to be needed, and is filed as a
 * follow-up rather than fixed here (this PR is guard-only). The `onClick`
 * preventDefault cancels the DEFAULT ACTION of whatever element the
 * tooltip wraps. A rendered probe confirms it: on a fine pointer the click
 * reaching the wrapped element has `defaultPrevented === false`; on a
 * coarse pointer it is `true`. React `onClick` handlers on the child still
 * run (so `IconAction` / `Button` actions are fine), and the Popover
 * `triggerTooltip` path still opens — but `<Tooltip>` around a `<Link>` or
 * an `<a href>` loses BOTH client navigation (Next's app-dir Link returns
 * early when `e.defaultPrevented`) and the native default. On touch those
 * affordances do nothing but show their own tooltip. That is ~17 inline
 * call sites plus `src/components/layout/nav-item.tsx`, i.e. every
 * collapsed-sidebar nav link.
 *
 * When that fix lands, `tapHandlerDefects` below is what has to change with
 * it — edit the detector alongside the fix rather than working around it.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/**
 * The single file allowed to know that touch exists. Every assertion in
 * this guard is anchored to it; if the primitive moves, the reads below
 * throw and name the problem rather than passing vacuously.
 */
const TOUCH_OWNER = 'src/components/ui/tooltip.tsx';

/**
 * Components whose entire job is to hand a trigger to `<Tooltip>`. They
 * must stay pass-throughs — the moment one of them owns a gesture, the
 * control it wraps behaves differently from every other tooltip in the
 * app. `Tooltip` itself is listed because `InfoTooltip` and
 * `DynamicTooltipWrapper` live in the same file.
 *
 * This list is the CURATED half. The automatic half is
 * `tooltipConsumers()` below, which derives every file that imports the
 * primitive — a new delegate is covered the day it is written.
 */
const DELEGATES: readonly string[] = [
    'src/components/ui/tooltip.tsx',
    'src/components/ui/icon-action.tsx',
    'src/components/ui/timestamp-tooltip.tsx',
    'src/components/ui/entity-prev-next-nav.tsx',
];

/**
 * Tokens that mean "this code is making a decision about pointer class or
 * touch". Deliberately NARROW — a bare `matchMedia` is legitimate all over
 * the app (`src/app/providers.tsx` queries a breakpoint), so banning it
 * would produce noise instead of signal. These are the specific spellings
 * that would fork tooltip behaviour by device.
 */
const POINTER_CLASS_TOKENS: ReadonlyArray<{ re: RegExp; label: string }> = [
    { re: /\(\s*hover\s*:\s*none\s*\)/, label: '(hover: none) media query' },
    {
        re: /\(\s*(?:any-)?pointer\s*:\s*coarse\s*\)/,
        label: '(pointer: coarse) media query',
    },
    { re: /\bontouchstart\b/, label: 'ontouchstart probe' },
    { re: /\bmaxTouchPoints\b/, label: 'navigator.maxTouchPoints probe' },
    { re: /\buseCoarsePointer\b/, label: 'useCoarsePointer()' },
    { re: /\bcoarsePointer\b/, label: 'coarsePointer local' },
    { re: /\bpointerType\b/, label: 'PointerEvent.pointerType branch' },
    { re: /\bonTouch(?:Start|End|Move|Cancel)\b/, label: 'React touch handler' },
];

/** Prop names that would let ONE caller get a different touch behaviour. */
const FORK_PROP_RE = /touch|coarse|tap|mobile|gesture|pointer/i;

/**
 * Files that consume `<Tooltip>` AND legitimately carry a pointer-class
 * token for an unrelated reason. Each entry names the EXACT tokens it is
 * excused for, so the same file gaining a real tooltip-touch fork still
 * fails. Every entry carries a written reason; the "no stale entries" test
 * below deletes the excuse the moment the code does.
 */
const POINTER_LOGIC_ALLOWLIST: Readonly<
    Record<string, { tokens: readonly string[]; reason: string }>
> = {
    'src/components/ui/table/table.tsx': {
        tokens: ['React touch handler'],
        reason:
            "TanStack's column-resize handle needs `onTouchStart={header.getResizeHandler()}` " +
            'to be draggable on a phone. It sits on the resize grip <div>, not on a tooltip ' +
            'trigger, and makes no decision about pointer class — it is the same handler the ' +
            'mouse path uses.',
    },
};

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            walk(full, out);
        } else if (/\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/** Strip block + line comments so prose can't satisfy a code assertion. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Every file under `src/` that imports the tooltip module — by alias
 * (`@/components/ui/tooltip`) or relative path (`./tooltip`, `../tooltip`).
 * The final path segment must be exactly `tooltip`, so
 * `timestamp-tooltip` importers are not swept up by accident.
 */
function tooltipConsumers(): string[] {
    // The owner is a consumer of itself for the purposes of every sweep
    // below — it imports nothing named `tooltip`, so it has to be seeded.
    const hits = new Set<string>([TOUCH_OWNER]);
    for (const file of walk(SRC)) {
        const src = fs.readFileSync(file, 'utf-8');
        const re = /from\s+['"]([^'"]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
            if (m[1].split('/').pop() === 'tooltip') {
                hits.add(path.relative(ROOT, file));
                break;
            }
        }
    }
    return [...hits].sort();
}

/**
 * Balanced-brace extraction of a JSX attribute expression:
 * `onPointerDown={ … }` → the text between the outer braces.
 * Returns null when the attribute is absent — which is itself a finding.
 */
function jsxAttrExpression(src: string, attr: string, from = 0): string | null {
    const at = src.indexOf(`${attr}={`, from);
    if (at < 0) return null;
    let depth = 0;
    const start = src.indexOf('{', at);
    for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start + 1, i);
        }
    }
    return null;
}

/** Body of `export interface TooltipProps { … }`, comments stripped. */
function tooltipPropsBody(src: string): string {
    const at = src.indexOf('export interface TooltipProps {');
    if (at < 0) {
        throw new Error(
            `Could not find \`export interface TooltipProps {\` in ${TOUCH_OWNER}. ` +
                'If the prop surface was restructured, re-point this guard — do not delete it: ' +
                'the closed-interface assertion is what stops a caller injecting a competing ' +
                'pointer handler into the trigger.',
        );
    }
    let depth = 0;
    const start = src.indexOf('{', at);
    for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return stripComments(src.slice(start + 1, i));
        }
    }
    throw new Error(`Unbalanced braces reading TooltipProps in ${TOUCH_OWNER}.`);
}

function tooltipPropNames(src: string): string[] {
    const names: string[] = [];
    const re = /^\s*["']?([A-Za-z_$][\w$-]*)["']?\s*\??\s*:/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tooltipPropsBody(src))) !== null) names.push(m[1]);
    return names;
}

// ─── Detectors ──────────────────────────────────────────────────────
//
// Each is a pure function of source text so the mutation-regression
// suite at the bottom can feed it a known-bad input and prove it fires.
// A detector that only ever sees a clean file is decorative.

/** The pointer class must be read from the internal hook, not a prop. */
const DERIVED_POINTER_RE = /const\s+coarsePointer\s*=\s*useCoarsePointer\(\s*\)\s*;/;

/** Controlled-open wiring — without it the tap toggle sets state nothing reads. */
const CONTROLLED_OPEN_RE =
    /\{\s*\.\.\.\(\s*coarsePointer\s*\?\s*\{\s*open:\s*touchOpen\s*,\s*onOpenChange:\s*setTouchOpen\s*\}\s*:\s*\{\s*\}\s*\)\s*\}/;

/**
 * Comments are stripped first: this is a question about CODE. A file that
 * mentions `(pointer: coarse)` in a comment saying "don't do this here" is
 * doing the right thing and must not be flagged for it.
 */
function findPointerClassTokens(src: string): string[] {
    const code = stripComments(src);
    return POINTER_CLASS_TOKENS.filter((t) => t.re.test(code)).map((t) => t.label);
}

/**
 * Files other than the owner that make a pointer-class decision, minus the
 * tokens each one is explicitly excused for.
 */
function consumersWithPointerLogic(files: string[]): Array<{ file: string; tokens: string[] }> {
    return files
        .filter((f) => f !== TOUCH_OWNER)
        .map((f) => {
            const excused = POINTER_LOGIC_ALLOWLIST[f]?.tokens ?? [];
            return {
                file: f,
                tokens: findPointerClassTokens(read(f)).filter((t) => !excused.includes(t)),
            };
        })
        .filter((r) => r.tokens.length > 0);
}

/** Missing pieces of the tap handler contract. */
function tapHandlerDefects(src: string): string[] {
    const defects: string[] = [];
    const triggerAt = src.indexOf('<TooltipPrimitive.Trigger');
    if (triggerAt < 0) return ['<TooltipPrimitive.Trigger> not found'];

    const down = jsxAttrExpression(src, 'onPointerDown', triggerAt);
    if (down === null) defects.push('Trigger has no onPointerDown');
    else {
        if (!/\bcoarsePointer\b/.test(down))
            defects.push('onPointerDown is not gated on coarsePointer');
        if (!/\.preventDefault\(\s*\)/.test(down))
            defects.push(
                'onPointerDown does not call preventDefault() — Radix\'s composed ' +
                    'close-handlers will run and the tooltip closes on the tap that opened it',
            );
        if (!/setTouchOpen\s*\(/.test(down))
            defects.push('onPointerDown does not toggle touchOpen');
    }

    const click = jsxAttrExpression(src, 'onClick', triggerAt);
    if (click === null) defects.push('Trigger has no onClick');
    else {
        if (!/\bcoarsePointer\b/.test(click))
            defects.push('onClick is not gated on coarsePointer');
        if (!/\.preventDefault\(\s*\)/.test(click))
            defects.push(
                'onClick does not call preventDefault() — Radix closes on click after a tap',
            );
    }

    if (!CONTROLLED_OPEN_RE.test(src))
        defects.push('Root is not put under controlled open/onOpenChange for coarse pointers');

    return defects;
}

/**
 * The three dismissal paths, each with its cleanup. Losing any ONE
 * reintroduces "the popup sits over the UI intercepting the next touch".
 */
function dismissalDefects(src: string): string[] {
    const defects: string[] = [];
    const checks: ReadonlyArray<{ re: RegExp; miss: string }> = [
        {
            re: /document\.addEventListener\(\s*["']pointerdown["']\s*,\s*\w+\s*,\s*true\s*\)/,
            miss: 'outside-tap dismissal (capture-phase document pointerdown) is gone',
        },
        {
            re: /document\.removeEventListener\(\s*["']pointerdown["']\s*,\s*\w+\s*,\s*true\s*\)/,
            miss: 'outside-tap listener is never removed (leaks across tooltips)',
        },
        {
            re: /window\.addEventListener\(\s*["']scroll["']\s*,\s*\w+\s*,\s*true\s*\)/,
            miss: 'scroll dismissal is gone — the popup rides the page',
        },
        {
            re: /window\.removeEventListener\(\s*["']scroll["']\s*,\s*\w+\s*,\s*true\s*\)/,
            miss: 'scroll listener is never removed (leaks across tooltips)',
        },
        {
            re: /setTimeout\(\s*\w+\s*,\s*TOUCH_AUTO_DISMISS_MS\s*\)/,
            miss: 'auto-dismiss timeout is gone — a forgotten tooltip stays up forever',
        },
        {
            re: /clearTimeout\(/,
            miss: 'auto-dismiss timer is never cleared',
        },
        {
            re: /triggerNode\.current\?\.contains\(/,
            miss: 'the own-trigger carve-out is gone — the opening tap would immediately close it',
        },
        {
            re: /if\s*\(\s*!touchOpen\s*\)\s*return\s*;/,
            miss: 'the effect no longer early-returns while closed (global listeners always on)',
        },
    ];
    for (const c of checks) if (!c.re.test(src)) defects.push(c.miss);
    return defects;
}

// ─── Suites ─────────────────────────────────────────────────────────

describe('tooltip touch path — one owner', () => {
    const consumers = tooltipConsumers();

    it('the primitive is where this guard expects it', () => {
        expect(fs.existsSync(path.join(ROOT, TOUCH_OWNER))).toBe(true);
        expect(consumers).toContain(TOUCH_OWNER);
        // A sanity floor: the primitive is used app-wide, so a consumer
        // list that collapsed to a handful means the derivation broke and
        // every sweep below would pass vacuously.
        expect(consumers.length).toBeGreaterThan(20);
    });

    it('Radix Tooltip is imported by exactly one file in src/', () => {
        const importers = walk(SRC)
            .filter((f) => /@radix-ui\/react-tooltip/.test(fs.readFileSync(f, 'utf-8')))
            .map((f) => path.relative(ROOT, f));
        // A second Radix Tooltip is a second tooltip behaviour by
        // construction — different delay, different touch story, different
        // surface. Compose the primitive instead.
        expect(importers).toEqual([TOUCH_OWNER]);
    });

    it('no consumer of the primitive makes its own pointer-class decision', () => {
        const offenders = consumersWithPointerLogic(consumers);
        if (offenders.length > 0) {
            throw new Error(
                'Touch handling for tooltips lives in ' +
                    `${TOUCH_OWNER} and nowhere else. These files consume <Tooltip> and ` +
                    'also branch on pointer class, which is how the same control ends up ' +
                    'behaving differently depending on where it appears:\n' +
                    offenders
                        .map((o) => `  ${o.file}\n    ${o.tokens.join('\n    ')}`)
                        .join('\n'),
            );
        }
        expect(offenders).toEqual([]);
    });

    it('carries no stale allowlist entries', () => {
        // An excuse outlives the code it excused unless something deletes
        // it. Every entry must still be a real consumer that still carries
        // the token it is excused for, and must carry a written reason.
        for (const [file, entry] of Object.entries(POINTER_LOGIC_ALLOWLIST)) {
            expect(consumers).toContain(file);
            expect(entry.reason.length).toBeGreaterThan(40);
            const present = findPointerClassTokens(read(file));
            for (const token of entry.tokens) {
                expect(present).toContain(token);
            }
        }
    });
});

describe('tooltip touch path — derived, never supplied', () => {
    const src = read(TOUCH_OWNER);

    it('reads the pointer class from the internal hook, not from props', () => {
        // The `rls-coverage-skip-visibility` pattern: the condition must
        // stay DERIVED. `coarsePointer = props.forceTouch ?? useCoarsePointer()`
        // would let one call site pick a different behaviour.
        expect(DERIVED_POINTER_RE.test(src)).toBe(true);
    });

    it('keeps useCoarsePointer internal to the primitive', () => {
        expect(src).toMatch(/^function useCoarsePointer\(/m);
        expect(src).not.toMatch(/export\s+(?:function|const)\s+useCoarsePointer\b/);
        expect(src).not.toMatch(/export\s*\{[^}]*\buseCoarsePointer\b[^}]*\}/);
    });

    it('exposes no prop that could fork or disable the touch path', () => {
        const forking = tooltipPropNames(src).filter((n) => FORK_PROP_RE.test(n));
        expect(forking).toEqual([]);
    });

    it('keeps TooltipProps closed, so no caller can inject a trigger handler', () => {
        // No `extends`, no index signature, no props spread from a DOM
        // element type. If `TooltipProps` ever widened to
        // `React.ComponentProps<'button'>`, a call site could pass its own
        // `onPointerDown` straight through to the Trigger and race the
        // tap-toggle on that one control.
        expect(src).toMatch(/export interface TooltipProps \{/);
        expect(src).not.toMatch(/export interface TooltipProps\s+extends\b/);
        const body = tooltipPropsBody(src);
        expect(body).not.toMatch(/\[\s*key\s*:\s*string\s*\]/);
        for (const banned of ['onPointerDown', 'onClick', 'onTouchStart', 'onPointerUp']) {
            expect(tooltipPropNames(src)).not.toContain(banned);
        }
    });

    it('short-circuits on `disabled` without consulting pointer class', () => {
        // `disabled` is legitimate — it kills the tooltip for EVERYONE
        // (e.g. the offline-cadastre hint). What must never appear here is
        // a pointer-class term: `disabled || coarsePointer` is precisely
        // "tooltips, but not on phones".
        const m = src.match(/if\s*\(([^)]*TOOLTIPS_ENABLED[\s\S]*?)\)\s*\{\s*return\s*<>/);
        expect(m).not.toBeNull();
        expect(findPointerClassTokens(m![1])).toEqual([]);
    });
});

describe('tooltip touch path — the tap handler survives intact', () => {
    const src = read(TOUCH_OWNER);

    it('taps toggle, and preventDefault() still suppresses Radix\'s close handlers', () => {
        const defects = tapHandlerDefects(src);
        if (defects.length > 0) {
            throw new Error(
                'The coarse-pointer tap handler in ' +
                    `${TOUCH_OWNER} lost part of its contract. No existing test would ` +
                    'catch this — the rendered suite runs under a jsdom matchMedia stub ' +
                    'that never reports a coarse pointer:\n  ' +
                    defects.join('\n  '),
            );
        }
        expect(defects).toEqual([]);
    });

    it('says in source why preventDefault() is load-bearing', () => {
        // Same reasoning as the `kill-switch (temporary)` assertion in
        // tooltip-kill-switch-consistency: the next reader tidying this
        // handler has to be told, at the call site, that the line looks
        // redundant and is not.
        expect(src).toMatch(/`preventDefault\(\)` is load-bearing/);
    });
});

describe('tooltip touch path — every dismissal survives', () => {
    const src = read(TOUCH_OWNER);

    it('keeps outside-tap, scroll, and timeout dismissal with their cleanups', () => {
        const defects = dismissalDefects(src);
        if (defects.length > 0) {
            throw new Error(
                'A tooltip dismissal path was removed. Losing any one of these is how a ' +
                    'tapped-open popup ends up sitting over the UI intercepting the next ' +
                    'touch — the failure that had tooltips switched off app-wide (#395):\n  ' +
                    defects.join('\n  '),
            );
        }
        expect(defects).toEqual([]);
    });

    it('the auto-dismiss window stays readable-but-short', () => {
        const m = read(TOUCH_OWNER).match(
            /const TOUCH_AUTO_DISMISS_MS\s*=\s*(\d+)\s*;/,
        );
        expect(m).not.toBeNull();
        const ms = Number(m![1]);
        // Long enough to read a sentence one-handed; short enough that a
        // forgotten tooltip is not an obstruction. A 60s "fix" for a
        // flaky test would functionally restore the #395 failure.
        expect(ms).toBeGreaterThanOrEqual(2000);
        expect(ms).toBeLessThanOrEqual(15000);
    });
});

describe('tooltip touch path — one appearance for both pointer classes', () => {
    const src = read(TOUCH_OWNER);

    it('the rendered popup is not conditioned on pointer class', () => {
        // The requirement is that tooltips do not differentiate from each
        // other. Only the GESTURE that opens one may differ, because a
        // phone has no hover to offer. Side, align, offset, surface classes
        // and body must be identical, so the popup a farmer taps is the
        // popup a desk user hovers.
        const start = src.indexOf('<TooltipPrimitive.Portal>');
        const end = src.indexOf('</TooltipPrimitive.Portal>');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const portal = src.slice(start, end);
        expect(findPointerClassTokens(portal)).toEqual([]);
    });

    it('there is exactly one Trigger and one Content in the primitive', () => {
        // Two of either would mean two surfaces to keep in sync, and the
        // touch one would drift.
        expect(src.match(/<TooltipPrimitive\.Trigger\b/g)).toHaveLength(1);
        expect(src.match(/<TooltipPrimitive\.Content\b/g)).toHaveLength(1);
    });
});

describe('tooltip touch path — delegates pass through', () => {
    for (const delegate of DELEGATES) {
        describe(delegate, () => {
            const src = read(delegate);

            it('renders the canonical <Tooltip> rather than rebuilding one', () => {
                expect(src).toMatch(/<Tooltip\b/);
                if (delegate !== TOUCH_OWNER) {
                    expect(src).toMatch(
                        /import\s*\{[^}]*\bTooltip\b[^}]*\}\s*from\s*['"][^'"]*\/tooltip['"]/,
                    );
                }
            });

            it('owns no pointer-class logic of its own', () => {
                if (delegate === TOUCH_OWNER) return; // it IS the owner
                expect(findPointerClassTokens(src)).toEqual([]);
            });

            it('does not intercept the trigger it hands to <Tooltip>', () => {
                if (delegate === TOUCH_OWNER) return;
                // A delegate adding its own pointer handler to the trigger
                // races the primitive's tap-toggle, and the ordering between
                // them is Radix Slot's business, not ours. That is one
                // control behaving differently from every other tooltip.
                expect(stripComments(src)).not.toMatch(/\bonPointerDown\s*=/);
                expect(stripComments(src)).not.toMatch(/\bonPointerUp\s*=/);
            });
        });
    }
});

describe('mutation regression — every detector fires on known-bad input', () => {
    // Without these, a "simplification" of any regex above could stop
    // matching while the whole suite still passes vacuously against a
    // clean file. Each case mutates the REAL source in memory.
    const src = read(TOUCH_OWNER);

    it('(a) pointer class supplied by a prop instead of the hook', () => {
        const bad = src.replace(
            DERIVED_POINTER_RE,
            'const coarsePointer = forceTouch ?? useCoarsePointer();',
        );
        expect(bad).not.toBe(src); // sanity — the derived form was there
        expect(DERIVED_POINTER_RE.test(bad)).toBe(false);
    });

    it('(b) preventDefault() dropped from the tap handler', () => {
        expect(tapHandlerDefects(src)).toEqual([]);
        const bad = src.replace(/e\.preventDefault\(\);\s*\n\s*setTouchOpen/, 'setTouchOpen');
        expect(bad).not.toBe(src);
        expect(tapHandlerDefects(bad).join(' ')).toMatch(
            /onPointerDown does not call preventDefault/,
        );
    });

    it('(c) the controlled-open wiring removed', () => {
        const bad = src.replace(CONTROLLED_OPEN_RE, '');
        expect(bad).not.toBe(src);
        expect(tapHandlerDefects(bad).join(' ')).toMatch(/controlled open/);
    });

    it('(d) each dismissal path removed in turn', () => {
        expect(dismissalDefects(src)).toEqual([]);
        const removals: ReadonlyArray<[RegExp, RegExp]> = [
            [/document\.addEventListener\(\s*"pointerdown"[^;]*;/, /outside-tap dismissal/],
            [/window\.addEventListener\(\s*"scroll"[^;]*;/, /scroll dismissal/],
            [/dismissTimer\.current = setTimeout\([^;]*;/, /auto-dismiss timeout/],
            [/window\.removeEventListener\(\s*"scroll"[^;]*;/, /scroll listener is never removed/],
            [/if \(el && triggerNode\.current\?\.contains\(el\)\) return;/, /own-trigger carve-out/],
        ];
        for (const [cut, expected] of removals) {
            const bad = src.replace(cut, '');
            expect(bad).not.toBe(src);
            expect(dismissalDefects(bad).join(' ')).toMatch(expected);
        }
    });

    it('(e) a fork prop added to the public surface', () => {
        const bad = src.replace(
            /export interface TooltipProps \{/,
            'export interface TooltipProps {\n    disableTouch?: boolean;',
        );
        expect(bad).not.toBe(src);
        expect(tooltipPropNames(bad).filter((n) => FORK_PROP_RE.test(n))).toEqual([
            'disableTouch',
        ]);
    });

    it('(f) a call site re-implements the coarse-pointer branch', () => {
        for (const bad of [
            'const isTouch = window.matchMedia("(pointer: coarse)").matches;',
            'const isTouch = window.matchMedia("(hover: none)").matches;',
            'if ("ontouchstart" in window) setOpen(true);',
            'const isTouch = navigator.maxTouchPoints > 0;',
            '<span onTouchStart={() => setOpen(true)} />',
            'if (e.pointerType === "touch") return;',
        ]) {
            expect(findPointerClassTokens(bad).length).toBeGreaterThan(0);
        }
        // …and a benign breakpoint query is NOT flagged: a detector that
        // fires on everything gets exempted into uselessness.
        expect(
            findPointerClassTokens('window.matchMedia("(min-width: 768px)").matches'),
        ).toEqual([]);
    });

    it('(g) the popup surface forked by pointer class', () => {
        const bad = src.replace(
            /side=\{side\}/,
            'side={coarsePointer ? "bottom" : side}',
        );
        expect(bad).not.toBe(src);
        const start = bad.indexOf('<TooltipPrimitive.Portal>');
        const end = bad.indexOf('</TooltipPrimitive.Portal>');
        expect(findPointerClassTokens(bad.slice(start, end)).length).toBeGreaterThan(0);
    });

    it('(i) an allowlisted file is excused for its token only, not blanket', () => {
        const file = 'src/components/ui/table/table.tsx';
        const excused = POINTER_LOGIC_ALLOWLIST[file].tokens;
        // Clean today, once its one excused token is subtracted.
        expect(findPointerClassTokens(read(file)).filter((t) => !excused.includes(t))).toEqual(
            [],
        );
        // Add a real tooltip-touch fork to the SAME file and it is flagged.
        const bad =
            read(file) + '\nconst isTouch = window.matchMedia("(pointer: coarse)").matches;\n';
        expect(
            findPointerClassTokens(bad).filter((t) => !excused.includes(t)).length,
        ).toBeGreaterThan(0);
    });

    it('(h) a delegate re-implements the touch path', () => {
        const delegate = read('src/components/ui/icon-action.tsx');
        const bad = delegate.replace(
            /<Tooltip content=\{label\}>/,
            '<Tooltip content={label} onPointerDown={(e) => e.stopPropagation()}>',
        );
        expect(bad).not.toBe(delegate);
        expect(stripComments(bad)).toMatch(/\bonPointerDown\s*=/);
    });
});
