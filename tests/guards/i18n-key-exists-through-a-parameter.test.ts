/**
 * A `t()` key reached through a FUNCTION PARAMETER must resolve too.
 *
 * ## The hole this covers, named precisely
 *
 * `i18n-key-exists.test.ts` resolves every static `t('key')` through a real
 * scope chain, and it is right to. But it declares function parameters with a
 * `null` namespace:
 *
 *     if (ts.isFunctionLike(node)) {
 *         for (const p of node.parameters) declare(p.name, null);
 *     }
 *
 * and then only checks a call when `typeof ns === 'string'`. That is
 * deliberate and load-bearing — it is what stops `items.map((t) => …)` being
 * read as a translator, which is false-positive class 2 in that file's own
 * fixtures.
 *
 * The cost is that a helper which *receives* a translator is skipped — and
 * skipped SILENTLY. Dynamic keys at least land in `dynamicCalls`, whose ratio
 * that guard asserts precisely so coverage loss becomes visible. A
 * parameter-bound call increments neither counter: it is invisible to the
 * finding list and to the honesty check.
 *
 * ## The defect that was live in the hole
 *
 * `buildCostFilters(t)` in `grain/costs/filter-defs.ts` is handed a
 * `grainEnums` translator by `CostsClient.tsx`, and called `t('incurredOnFacet')`.
 * That key existed only at `grain.costs.incurredOnFacet`, so next-intl threw
 * `MISSING_MESSAGE: grainEnums.incurredOnFacet` and the date filter on the
 * grain costs page rendered its label as the raw key path — in BOTH languages.
 *
 * Four gates read it as fine. en↔bg parity compares the catalogues to each
 * other, so a key wrong in both ways is symmetric. The orphan check saw the
 * token in `src/` and called it used. `no-hardcoded-ui-strings` was satisfied
 * because the call *is* a `t()` call. And the guard above skipped it. It
 * surfaced only because an E2E test happened to render the page and the server
 * logged the throw; nothing went red (#1436).
 *
 * ## Why this detects by USE, not by type name
 *
 * The obvious detector is "a parameter annotated `Translator`". It would work
 * today and rot quietly: `Translator` is not a shared type — it is
 * re-declared, identically, as a local alias in four separate `filter-defs.ts`
 * files, and three other helpers annotate the same parameter as
 * `ReturnType<typeof useTranslations>` instead. A name-keyed detector goes
 * stale the moment someone renames the alias or adds a third spelling, and it
 * goes stale by reporting ZERO, which reads as success.
 *
 * So a candidate here is any parameter that is CALLED with a string literal
 * inside its own function body. That is behaviour, not nomenclature. Whether
 * it is really a translator is then decided by the CALLER: if a call site
 * passes a `useTranslations('ns')` binding in that argument slot, the keys are
 * checked against `ns`; if no caller passes one, it is not a translator and
 * there is nothing to check.
 *
 * ## What it cannot do, counted rather than hidden
 *
 * A helper whose callers pass something this file cannot statically resolve
 * (a prop, a re-export chain, a dynamically chosen namespace) yields no
 * namespace, so its keys go unchecked. That count is ASSERTED below — the
 * lesson from the guard this one complements. An unresolvable helper is a
 * reported number, never a silent pass.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const SCAN_DIRS = ['src/app', 'src/components', 'src/lib'];
const BINDERS = new Set(['useTranslations', 'getTranslations']);
/** `t.rich('key', …)` / `t.raw` / `t.markup` / `t.has` take a key in the same slot. */
const KEYED_MEMBERS = new Set(['rich', 'raw', 'markup', 'has']);

/**
 * Delegated to `collectSourceFiles` rather than hand-rolled, and the
 * meta-guards were right to insist. My first version did
 * `if (!fs.existsSync(dir)) return;` — so a renamed root contributed nothing
 * and every assertion built on the result still passed. That is the exact
 * shape `file-collection-is-not-silently-empty` measured at 81% of the guards
 * it could audit. The helper throws on an unresolvable root AND on a result
 * below the floor.
 *
 * The floor is set near the real population (1700 against a live 1762) rather than
 * at the default 1: a floor of one would still pass if an extension filter or
 * a skip list ate almost everything, which is the failure a floor is for.
 */
function sourceFiles(): string[] {
    return collectSourceFiles({ roots: SCAN_DIRS, extensions: ['.ts', '.tsx'], floor: 1700 });
}

function loadMessageKeys(file: string): Set<string> {
    const flat = new Set<string>();
    const walk = (node: unknown, prefix: string): void => {
        if (node === null || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            const full = prefix ? `${prefix}.${k}` : k;
            if (v !== null && typeof v === 'object') walk(v, full);
            else flat.add(full);
        }
    };
    walk(JSON.parse(fs.readFileSync(file, 'utf8')), '');
    return flat;
}

function parse(file: string, text?: string): ts.SourceFile {
    return ts.createSourceFile(
        file,
        text ?? fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
}

/** The namespace a `useTranslations('ns')` initializer binds, or null. */
function namespaceOf(init: ts.Node): string | null {
    if (!ts.isCallExpression(init)) return null;
    const callee = init.expression;
    const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
    if (!BINDERS.has(name)) return null;
    const arg = init.arguments[0];
    return arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** The identifier a call expression invokes, accounting for `t.rich(…)`. */
function calleeIdentifier(node: ts.CallExpression): string | null {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        KEYED_MEMBERS.has(callee.name.text)
    ) {
        return callee.expression.text;
    }
    return null;
}

interface Helper {
    file: string;
    fn: string;
    /** Position of the parameter the keys are called through. */
    idx: number;
    staticKeys: { key: string; line: number }[];
    dynamicKeys: number;
}

/**
 * Named functions with a parameter that is CALLED with a string literal in the
 * body. Detection by use — see the docblock.
 */
function findHelpers(sf: ts.SourceFile, rel: string): Helper[] {
    const found: Helper[] = [];
    const visit = (node: ts.Node): void => {
        const isNamed =
            (ts.isFunctionDeclaration(node) && node.name !== undefined) ||
            (ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.initializer !== undefined &&
                (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)));
        if (isNamed) {
            const fnNode = ts.isFunctionDeclaration(node)
                ? node
                : ((node as ts.VariableDeclaration).initializer as ts.FunctionLikeDeclaration);
            const fnName = ts.isFunctionDeclaration(node)
                ? (node.name as ts.Identifier).text
                : ((node as ts.VariableDeclaration).name as ts.Identifier).text;

            fnNode.parameters.forEach((p, idx) => {
                if (!ts.isIdentifier(p.name)) return;
                const pname = p.name.text;
                const staticKeys: { key: string; line: number }[] = [];
                let dynamicKeys = 0;
                const inner = (n: ts.Node): void => {
                    // Do not descend into a nested function that rebinds the
                    // name — otherwise a shadowing callback parameter would be
                    // attributed to this helper.
                    if (
                        n !== fnNode &&
                        ts.isFunctionLike(n) &&
                        n.parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === pname)
                    ) {
                        return;
                    }
                    if (ts.isCallExpression(n) && calleeIdentifier(n) === pname) {
                        const arg = n.arguments[0];
                        if (
                            arg !== undefined &&
                            ts.isStringLiteralLike(arg) &&
                            !ts.isTemplateExpression(arg)
                        ) {
                            staticKeys.push({
                                key: arg.text,
                                line: sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1,
                            });
                        } else {
                            dynamicKeys += 1;
                        }
                    }
                    ts.forEachChild(n, inner);
                };
                ts.forEachChild(fnNode, inner);
                if (staticKeys.length > 0) {
                    found.push({ file: rel, fn: fnName, idx, staticKeys, dynamicKeys });
                }
            });
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
}

/** Every namespace any call site passes to `fn` in argument slot `idx`. */
function namespacesPassedTo(fn: string, idx: number, files: string[]): Set<string> {
    const out = new Set<string>();
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        if (!text.includes(fn)) continue;
        const sf = parse(file, text);
        const scopes: Map<string, string | null>[] = [new Map()];
        const resolve = (name: string): string | null | undefined => {
            for (let i = scopes.length - 1; i >= 0; i -= 1) {
                if (scopes[i].has(name)) return scopes[i].get(name);
            }
            return undefined;
        };
        const visit = (node: ts.Node): void => {
            const opensScope =
                ts.isFunctionLike(node) || ts.isBlock(node) || ts.isSourceFile(node);
            if (opensScope) scopes.push(new Map());
            if (ts.isFunctionLike(node)) {
                for (const p of node.parameters) {
                    if (ts.isIdentifier(p.name)) scopes[scopes.length - 1].set(p.name.text, null);
                }
            }
            if (
                ts.isVariableDeclaration(node) &&
                node.initializer !== undefined &&
                ts.isIdentifier(node.name)
            ) {
                scopes[scopes.length - 1].set(node.name.text, namespaceOf(node.initializer));
            }
            if (ts.isCallExpression(node) && calleeIdentifier(node) === fn) {
                const arg = node.arguments[idx];
                if (arg !== undefined && ts.isIdentifier(arg)) {
                    const ns = resolve(arg.text);
                    if (typeof ns === 'string') out.add(ns);
                }
            }
            ts.forEachChild(node, visit);
            if (opensScope) scopes.pop();
        };
        visit(sf);
    }
    return out;
}

interface Audit {
    findings: string[];
    helpers: number;
    translatorHelpers: number;
    keysChecked: number;
    keysUnresolved: number;
}

function audit(messagesFile: string): Audit {
    const known = loadMessageKeys(messagesFile);
    const files = sourceFiles();
    const helpers: Helper[] = [];
    for (const f of files) helpers.push(...findHelpers(parse(f), path.relative(REPO_ROOT, f)));

    const res: Audit = {
        findings: [],
        helpers: helpers.length,
        translatorHelpers: 0,
        keysChecked: 0,
        keysUnresolved: 0,
    };
    for (const h of helpers) {
        const namespaces = namespacesPassedTo(h.fn, h.idx, files);
        if (namespaces.size === 0) {
            // Not a translator at all, OR a translator this file cannot trace.
            // Both land here; the count below keeps that honest.
            res.keysUnresolved += h.staticKeys.length;
            continue;
        }
        res.translatorHelpers += 1;
        for (const ns of namespaces) {
            for (const { key, line } of h.staticKeys) {
                res.keysChecked += 1;
                const full = `${ns}.${key}`;
                if (!known.has(full)) {
                    res.findings.push(`  ${h.file}:${line} → ${h.fn}(${ns}) wants ${full}`);
                }
            }
        }
    }
    return res;
}

describe('i18n — a key reached through a parameter resolves too', () => {
    const res = audit(path.join(REPO_ROOT, 'messages/en.json'));

    it('the scanner resolved a real population through call sites', () => {
        // The positive control. Without it a scanner that traced nothing —
        // a renamed binder, a broken scope stack, a changed helper idiom —
        // reports zero findings and looks perfect. At the time of writing the
        // tree has 11 such helpers carrying 62 static keys, every one of them
        // resolvable through its caller. Detecting by USE rather than by the
        // `Translator` annotation is what makes it 76 and not 62: three
        // helpers spell the parameter `ReturnType<typeof useTranslations>`
        // and some spell it nothing at all.
        expect(res.translatorHelpers).toBeGreaterThan(5);
        expect(res.keysChecked).toBeGreaterThan(40);
    });

    it('no key reached through a parameter is missing from messages/en.json', () => {
        if (res.findings.length > 0) {
            throw new Error(
                `${res.findings.length} key(s) reached through a function parameter resolve to ` +
                    'nothing. next-intl has no fallback here, so each renders the key path ' +
                    'itself as user-facing text:\n\n' +
                    res.findings.sort().join('\n') +
                    '\n\nThe namespace in brackets is the one the CALLER passes. Either add the ' +
                    'key under that namespace in BOTH catalogues, or pass the translator the ' +
                    'key actually lives under.',
            );
        }
    });

    it('reports the keys it could NOT trace to a caller, so coverage stays honest', () => {
        // A helper whose callers pass something unresolvable is unchecked. That
        // is acceptable; being unchecked SILENTLY is what let #1436 ship. This
        // bounds the untraced share rather than trusting it stays small.
        const total = res.keysChecked + res.keysUnresolved;
        expect(total).toBeGreaterThan(0);
        // 6 of 82 untraced at the time of writing (7.3%). The bound has
        // headroom for a new helper or two without being vacuous; crossing it
        // means this guard is covering less than it claims and the untraced
        // helpers need naming, not a raised ceiling.
        expect(res.keysUnresolved / total).toBeLessThan(0.3);
    });
});

describe('population report', () => {
    it('prints the denominator', () => {
        const res = audit(path.join(REPO_ROOT, 'messages/en.json'));
        console.log(
            `    candidate helpers (a param called with a literal): ${res.helpers}\n` +
                `    of those, traced to a useTranslations caller   : ${res.translatorHelpers}\n` +
                `    keys CHECKED                                  : ${res.keysChecked}\n` +
                `    keys untraced (no resolvable caller namespace) : ${res.keysUnresolved}\n` +
                `    findings                                      : ${res.findings.length}`,
        );
        expect(res.keysChecked).toBeGreaterThan(0);
    });
});
