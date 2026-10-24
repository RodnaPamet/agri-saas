/**
 * Every static `t('key')` must resolve to a real message.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * The i18n guards this repo already has compare `en.json` against `bg.json`.
 * That catches a key present in one locale and missing from the other — but a
 * key missing from **BOTH** is perfectly symmetric, so every one of them passes:
 * `missing: 0`, `orphan: 0`, `drift: 0`.
 *
 * `src/i18n.ts` sets no `getMessageFallback`, so next-intl renders the key path
 * itself. The result is the literal string `admin.roles.createCustomRole`
 * displayed as a panel heading.
 *
 * That is not hypothetical. `admin.roles.createCustomRole` and
 * `admin.roles.createRole` were absent from both catalogues from #159
 * (2026-07-05) until 2026-08-21 — **six and a half weeks** — and every OWNER
 * and ADMIN who opened "create custom role" saw raw key paths where the
 * heading and the submit button should be. CI was green throughout.
 *
 * Worse, the no-hardcoded-UI-strings ratchet actively REWARDS the bug:
 * replacing a hard-coded label with `t('keyThatDoesNotExist')` lowers
 * `CURRENT_BASELINE` and turns every check greener. The two guards pulled in
 * opposite directions and the gap between them was invisible.
 *
 * ── Why this is an AST walk and not a regex ──
 *
 * A key is `<namespace>.<literal>`, and the namespace comes from whichever
 * `useTranslations('ns')` binding is in scope at the call site. A file-global
 * name→namespace map is the obvious shortcut and it is wrong: this repo has
 * files binding `const t` to different namespaces in different function
 * scopes, and `t` also appears as an ordinary callback parameter. An earlier
 * prototype built that way produced ~38 false positives out of ~40 reports.
 *
 * So bindings are resolved through a real scope chain: a call is only checked
 * when the nearest enclosing binding for that identifier is a translations
 * binding.
 *
 * ── What is deliberately NOT checked ──
 *
 * Dynamic keys — `t(someVariable)`, `t(`x.${y}`)` — cannot be resolved
 * statically and are SKIPPED, not guessed. Their count is asserted below so
 * that "we check almost everything" stays a measured claim rather than a hope:
 * if a refactor made most call sites dynamic, this guard would quietly stop
 * covering them, and the count is what makes that visible.
 */
import { readCatalogue } from '../helpers/catalogue';
import * as fs from 'fs';
import * as path from 'path';
import { resolveTranslationCalls } from '../helpers/i18n-key-resolver';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app', 'src/components', 'src/lib'];

interface Finding {
    file: string;
    line: number;
    key: string;
}

function loadMessageKeys(): Set<string> {
    const flat = new Set<string>();
    const walk = (node: unknown, prefix: string): void => {
        if (node === null || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            const full = prefix ? `${prefix}.${k}` : k;
            flat.add(full);
            walk(v, full);
        }
    };
    walk(readCatalogue('en'), '');
    return flat;
}

function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        if (!fs.existsSync(dir)) {
            throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
                walk(p);
            } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
                out.push(p);
            }
        }
    };
    for (const d of SCAN_DIRS) walk(path.join(REPO_ROOT, d));
    return out;
}

interface ScanResult {
    findings: Finding[];
    staticCalls: number;
    dynamicCalls: number;
}

/**
 * Resolve one file's keys and report the ones no catalogue has.
 *
 * The scope-chain resolution this used to carry inline now lives in
 * `tests/helpers/i18n-key-resolver.ts`, extracted for #2226 so
 * `destructive-vocabulary` could resolve `confirmLabel={t('key')}` through the
 * same code instead of a second copy. A copy would have drifted: this
 * resolution has been corrected twice already — #1703's positional
 * `Promise.all` destructuring, and the shadowing rule — and the extraction
 * immediately found a third defect the inline version had, where a
 * destructured name set a placeholder key that nothing read, so it never
 * shadowed at all. The helper's contract test pins all three.
 */
function scanFile(file: string, known: Set<string>, res: ScanResult): void {
    const { calls, counts } = resolveTranslationCalls(file);
    res.staticCalls += counts.staticCalls;
    res.dynamicCalls += counts.dynamicCalls;
    for (const call of calls) {
        if (!known.has(call.key)) {
            res.findings.push({
                file: path.relative(REPO_ROOT, file),
                line: call.line,
                key: call.key,
            });
        }
    }
}

describe('i18n — every static t() key resolves to a real message', () => {
    const known = loadMessageKeys();
    const res: ScanResult = { findings: [], staticCalls: 0, dynamicCalls: 0 };
    for (const f of sourceFiles()) scanFile(f, known, res);

    it('the scanner actually resolved a meaningful number of call sites', () => {
        // The positive control. Without it, a scanner that silently resolved
        // nothing — a renamed binder, a parse failure, a bad scope stack —
        // would report zero findings and look perfect.
        expect(res.staticCalls).toBeGreaterThan(2000);
    });

    it('no static key is missing from messages/en.json', () => {
        if (res.findings.length > 0) {
            const lines = res.findings
                .map((f) => `  ${f.file}:${f.line} → ${f.key}`)
                .sort()
                .join('\n');
            throw new Error(
                `${res.findings.length} t() call(s) reference a key that exists in NEITHER locale.\n` +
                    'next-intl has no fallback configured here, so each renders the key path ' +
                    'itself as user-facing text:\n\n' +
                    lines +
                    '\n\nAdd the key to BOTH messages/en.json and messages/bg.json.',
            );
        }
    });

    it('reports how many call sites it could NOT check, so coverage stays honest', () => {
        // Dynamic keys are skipped by design. This asserts they stay a small
        // minority: if a refactor pushed most call sites through variables,
        // the guard above would quietly stop covering the UI and nothing else
        // would say so.
        const total = res.staticCalls + res.dynamicCalls;
        expect(total).toBeGreaterThan(0);
        expect(res.dynamicCalls / total).toBeLessThan(0.2);
    });
});

describe('the scanner has teeth — synthetic fixtures', () => {
    // The real tree is (now) clean, so the suite above passes vacuously. These
    // run the real scanner over hand-built input, including the three shapes
    // that made an earlier regex/file-map prototype produce ~38 false
    // positives out of ~40 reports.
    const known = new Set(['ns.real', 'other.real', 'bare']);

    function scan(source: string): ScanResult {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'i18n-guard-'));
        try {
            const f = path.join(dir, 'fixture.tsx');
            fs.writeFileSync(f, source);
            const res: ScanResult = { findings: [], staticCalls: 0, dynamicCalls: 0 };
            scanFile(f, known, res);
            return res;
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    it('catches a key that exists in no catalogue', () => {
        const r = scan(`const t = useTranslations('ns');\nexport const A = () => <p>{t('missing')}</p>;`);
        expect(r.findings.map((f) => f.key)).toEqual(['ns.missing']);
    });

    it('accepts a key that does exist — the positive control', () => {
        const r = scan(`const t = useTranslations('ns');\nexport const A = () => <p>{t('real')}</p>;`);
        expect(r.findings).toEqual([]);
        expect(r.staticCalls).toBe(1);
    });

    it('resolves a translator destructured out of Promise.all', () => {
        // False-positive class 4 (#1703). Before this, the array pattern bound
        // nothing, `t` resolved to undefined, and the call was skipped — so a
        // reference to a deleted key in any of the four real files that use
        // this shape would have passed silently.
        const r = scan(
            `export default async function Page() {\n` +
                `    const [t, tc, ctx] = await Promise.all([\n` +
                `        getTranslations('ns'),\n` +
                `        getTranslations('other'),\n` +
                `        getTenantCtx({ tenantSlug }),\n` +
                `    ]);\n` +
                `    return <p>{t('missing')}{tc('real')}</p>;\n` +
                `}`,
        );
        // `ns.missing` is caught, `other.real` passes — so the fix resolves
        // BOTH positions rather than binding the first and defaulting the rest.
        expect(r.findings.map((f) => f.key)).toEqual(['ns.missing']);
        expect(r.staticCalls).toBe(2);
    });

    it('does not let a non-factory position inherit a namespace', () => {
        // `ctx` is position 2 and must bind null, not `other` — a positional
        // pairing that drifted by one would make this pass while attributing
        // every key to the wrong namespace.
        const r = scan(
            `export default async function Page() {\n` +
                `    const [t, ctx] = await Promise.all([\n` +
                `        getTranslations('ns'),\n` +
                `        getTenantCtx({ tenantSlug }),\n` +
                `    ]);\n` +
                `    return <p>{t('real')}{ctx('missing')}</p>;\n` +
                `}`,
        );
        expect(r.findings).toEqual([]);
        expect(r.staticCalls).toBe(1);
    });

    it('lets a non-factory position SHADOW an outer translator', () => {
        // The case the previous test cannot see. With no outer binding, "binds
        // null" and "binds nothing" are indistinguishable — removing the
        // shadowing branch left both green, so this adds the outer `ctx` that
        // makes them differ: unshadowed, `ctx('missing')` resolves against
        // `ns` and the guard reports a key the code never asks for.
        const r = scan(
            `const ctx = useTranslations('ns');\n` +
                `export default async function Page() {\n` +
                `    const [t, ctx] = await Promise.all([\n` +
                `        getTranslations('other'),\n` +
                `        getTenantCtx({ tenantSlug }),\n` +
                `    ]);\n` +
                `    return <p>{t('real')}{ctx('missing')}</p>;\n` +
                `}`,
        );
        expect(r.findings).toEqual([]);
        // Not vacuous: `other.real` IS checked, so the scan reached the body.
        expect(r.staticCalls).toBe(1);
    });

    it('resolves TWO namespaces bound to the same name in different scopes', () => {
        // False-positive class 1, and the reason a file-global map fails.
        const r = scan(
            `function A() { const t = useTranslations('ns'); return t('real'); }\n` +
                `function B() { const t = useTranslations('other'); return t('real'); }`,
        );
        expect(r.findings).toEqual([]);
        expect(r.staticCalls).toBe(2);
    });

    it('ignores `t` used as a callback parameter', () => {
        // False-positive class 2: `t` here is a list item, not a translator.
        const r = scan(
            `const t = useTranslations('ns');\n` +
                `export const A = () => items.map((t) => t('anything')).concat(t('real'));`,
        );
        expect(r.findings).toEqual([]);
    });

    it('ignores a local `t` that shadows an outer translations binding', () => {
        // False-positive class 3.
        const r = scan(
            `const t = useTranslations('ns');\n` +
                `function A() { const t = getSomethingElse(); return t('nonsense'); }`,
        );
        expect(r.findings).toEqual([]);
    });

    it('skips dynamic keys rather than guessing at them', () => {
        const r = scan(
            `const t = useTranslations('ns');\n` +
                'export const A = ({ k }) => t(k) + t(`ns.${k}`) + t(\'real\');',
        );
        expect(r.findings).toEqual([]);
        expect(r.dynamicCalls).toBe(2);
        expect(r.staticCalls).toBe(1);
    });

    it('checks t.rich() and t.raw(), which take a key in the same slot', () => {
        const r = scan(
            `const t = useTranslations('ns');\n` +
                `export const A = () => [t.rich('missing'), t.raw('real')];`,
        );
        expect(r.findings.map((f) => f.key)).toEqual(['ns.missing']);
    });

    it('handles an unnamespaced useTranslations() — keys are absolute', () => {
        const r = scan(`const t = useTranslations();\nexport const A = () => t('bare') + t('nope');`);
        expect(r.findings.map((f) => f.key)).toEqual(['nope']);
    });

    it('handles the async server form, await getTranslations()', () => {
        const r = scan(
            `export async function A() { const t = await getTranslations('ns'); return t('missing'); }`,
        );
        expect(r.findings.map((f) => f.key)).toEqual(['ns.missing']);
    });
});
