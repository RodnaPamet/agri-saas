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
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MESSAGES = path.join(REPO_ROOT, 'messages/en.json');
const SCAN_DIRS = ['src/app', 'src/components', 'src/lib'];

/** next-intl's two namespace-binding entry points. */
const BINDERS = new Set(['useTranslations', 'getTranslations']);

/** `t.rich('key', …)` / `t.raw` / `t.markup` take a key in the same slot. */
const KEYED_MEMBERS = new Set(['rich', 'raw', 'markup', 'has']);

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
    walk(JSON.parse(fs.readFileSync(MESSAGES, 'utf8')), '');
    return flat;
}

function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        if (!fs.existsSync(dir)) return;
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

/** Extracts `useTranslations('ns')` → 'ns'; `useTranslations()` → '' (absolute keys). */
function namespaceOf(init: ts.Node): string | null {
    let call: ts.CallExpression | null = null;
    if (ts.isCallExpression(init)) call = init;
    else if (ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)) call = init.expression;
    if (!call) return null;

    const callee = call.expression;
    const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
    if (!name || !BINDERS.has(name)) return null;

    const arg = call.arguments[0];
    if (arg === undefined) return '';
    if (ts.isStringLiteralLike(arg)) return arg.text;
    // `getTranslations({ locale, namespace: 'x' })`
    if (ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
            if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.text === 'namespace' &&
                ts.isStringLiteralLike(prop.initializer)
            ) {
                return prop.initializer.text;
            }
        }
    }
    return null; // dynamic namespace — unresolvable, so its calls are skipped
}

interface ScanResult {
    findings: Finding[];
    staticCalls: number;
    dynamicCalls: number;
}

/**
 * Scope-aware scan. A stack of maps; each entry is either a namespace string
 * (a translations binding) or `null` (any other binding of that name, which
 * SHADOWS an outer translations binding and must suppress checking).
 */
function scanFile(file: string, known: Set<string>, res: ScanResult): void {
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const scopes: Map<string, string | null>[] = [new Map()];

    const resolve = (name: string): string | null | undefined => {
        for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i].has(name)) return scopes[i].get(name);
        }
        return undefined;
    };

    const declare = (name: ts.BindingName, ns: string | null): void => {
        if (ts.isIdentifier(name)) scopes[scopes.length - 1].set(name.text, ns);
        // Destructuring never yields a translations function here.
        else scopes[scopes.length - 1].set('__destructured__', null);
    };

    const visit = (node: ts.Node): void => {
        const opensScope =
            ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isBlock(node) ||
            ts.isForStatement(node) ||
            ts.isForOfStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isCatchClause(node);

        if (opensScope) scopes.push(new Map());

        // Parameters shadow: `items.map((t) => …)` must not be read as a binding.
        if (ts.isFunctionLike(node)) {
            for (const p of node.parameters) declare(p.name, null);
        }

        if (ts.isVariableDeclaration(node) && node.initializer) {
            declare(node.name, namespaceOf(node.initializer));
        }

        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            let ident: string | null = null;
            if (ts.isIdentifier(callee)) {
                ident = callee.text;
            } else if (
                ts.isPropertyAccessExpression(callee) &&
                ts.isIdentifier(callee.expression) &&
                KEYED_MEMBERS.has(callee.name.text)
            ) {
                ident = callee.expression.text;
            }

            if (ident !== null) {
                const ns = resolve(ident);
                if (typeof ns === 'string') {
                    const arg = node.arguments[0];
                    if (arg !== undefined && ts.isStringLiteralLike(arg) && !ts.isTemplateExpression(arg)) {
                        res.staticCalls++;
                        const full = ns ? `${ns}.${arg.text}` : arg.text;
                        if (!known.has(full)) {
                            res.findings.push({
                                file: path.relative(REPO_ROOT, file),
                                line: sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1,
                                key: full,
                            });
                        }
                    } else {
                        res.dynamicCalls++;
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
        if (opensScope) scopes.pop();
    };

    visit(sf);
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
