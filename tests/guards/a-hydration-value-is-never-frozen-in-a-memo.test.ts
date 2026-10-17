/**
 * Guard: no `useMemo`/`useCallback` captures a `useHydratedNow()` value while
 * omitting it from its dependency array (#2033, found reading #1730).
 *
 * ## The defect this is named after
 *
 * `useHydratedNow()` returns `null` on the server and on the first client
 * render, then a `Date` — exactly once, on mount (its own deps are `[]`, so it
 * never ticks). Its docblock states the contract: consumers "skip rendering
 * time-dependent affordances while it's `null` … and the real values paint on
 * the next frame".
 *
 * A memo that reads the value but does not list it never gets that next frame.
 * The closure captures `null` for the lifetime of the page. In
 * `EvidenceClient` the captured value reached `getRetentionStatus`, whose
 * first line is
 *
 *     if (!now) return { label: t('client.retentionActive'), badge: 'success' };
 *
 * so the `daysLeft <= 0 → Expired` and `daysLeft <= 30 → Expiring` branches
 * were unreachable from the table and every retained record rendered as a
 * green "Active" badge — in a БАБХ compliance product, the wrong answer in the
 * direction that matters.
 *
 * ## Why the page looked fine
 *
 * The same function is called a second time in the JSX, for the gallery, where
 * it is re-evaluated every render and therefore CORRECT. Desktop table and
 * mobile gallery disagreed about the same record. Nothing was red: a frozen
 * closure produces a plausible badge, just the wrong one.
 *
 * ## What this costs
 *
 * One extra rebuild of the memo per mount — the single `null → Date`
 * transition — which is why "it would rebuild the columns" is not a reason to
 * omit it. A hook that TICKED would be a different trade; `useHydratedNow`
 * does not tick, and this guard would want revisiting if that changed.
 */
import { readFileSync } from 'node:fs';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const HOOK = /\b(useMemo|useCallback)\s*\(/g;

/** The balanced `(...)` beginning at or after `from`. */
function extent(code: string, from: number): { text: string; end: number } {
    const open = code.indexOf('(', from);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') {
            depth--;
            if (depth === 0) return { text: code.slice(open, i + 1), end: i };
        }
    }
    return { text: code.slice(open), end: code.length };
}

/** The dependency array: the last top-level `[...]` before the closing paren. */
function deps(callText: string): string {
    const all = [...callText.matchAll(/\[([^[\]]*)\]\s*\)\s*$/g)];
    return all.length ? all[all.length - 1][1] : '';
}

const used = (name: string, hay: string) =>
    new RegExp(`(?<![.\\w])${name}(?![\\w])`).test(hay);

interface Frozen {
    file: string;
    line: number;
    name: string;
}

function scan(): { closures: number; files: number; frozen: Frozen[] } {
    const files = collectSourceFiles({ roots: ['src'], extensions: ['.ts', '.tsx'], floor: 500 });
    const frozen: Frozen[] = [];
    let closures = 0;
    let seen = 0;
    for (const abs of files) {
        const raw = readFileSync(abs, 'utf8');
        if (!raw.includes('useHydratedNow')) continue;
        seen++;
        // Comments blanked: this file's own docblock names the variable, and a
        // `a-scar-is-not-a-wound` hit would report the explanation as the bug.
        const code = blankNonCode(raw);
        const decl = /const\s+(\w+)\s*=\s*useHydratedNow\(\)/.exec(code);
        if (!decl) continue;
        const name = decl[1];
        const rel = abs.slice(REPO_ROOT.length + 1);
        for (const m of code.matchAll(HOOK)) {
            const { text } = extent(code, m.index);
            if (!used(name, text)) continue;
            closures++;
            if (!used(name, deps(text))) {
                frozen.push({ file: rel, line: code.slice(0, m.index).split('\n').length, name });
            }
        }
    }
    return { closures, files: seen, frozen };
}

describe('a hydration value is never frozen in a memo (#2033)', () => {
    const { closures, files, frozen } = scan();

    it('ranges over a real population — the denominator', () => {
        console.log(
            `[hydration-freeze] ${files} file(s) call useHydratedNow, ${closures} memo/callback closure(s) capture it, ${frozen.length} frozen`,
        );
        // The guard is only meaningful while something actually captures the
        // value. If this drops to zero the guard has stopped covering
        // anything and should be deleted rather than left passing — the
        // `a-gate-narrow-enough-to-always-pass` failure.
        expect(files).toBeGreaterThanOrEqual(1);
        expect(closures).toBeGreaterThanOrEqual(1);
    });

    it('detects a frozen closure — the control that makes the assertion mean something', () => {
        // The real EvidenceClient memo as it stood before #2033, reduced. If
        // the extractor ever stops finding the deps array this fixture fails
        // loudly instead of the guard passing on an empty scan.
        const broken = `
            const hydratedNow = useHydratedNow();
            const cols = useMemo(() => createColumns([
                { cell: ({ row }) => getRetentionStatus(row.original, hydratedNow, tr) },
            ]), [t, tr, permissions]);
        `;
        const fixed = broken.replace('[t, tr, permissions]', '[t, tr, permissions, hydratedNow]');
        const check = (src: string) => {
            const m = /\b(useMemo|useCallback)\s*\(/.exec(src)!;
            const { text } = extent(src, m.index);
            return { captures: used('hydratedNow', text), listed: used('hydratedNow', deps(text)) };
        };
        expect(check(broken)).toEqual({ captures: true, listed: false });
        expect(check(fixed)).toEqual({ captures: true, listed: true });
    });

    it('no closure captures a hydration value it does not depend on', () => {
        expect(
            frozen.map((f) => `  ${f.file}:${f.line} captures \`${f.name}\` but omits it`).join('\n'),
        ).toBe('');
    });
});
