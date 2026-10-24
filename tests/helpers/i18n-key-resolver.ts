/**
 * Resolve `t('key')` to its full catalogue key, through a real scope chain.
 *
 * ## Why this is a shared helper and not a regex
 *
 * A key is `<namespace>.<literal>`, and the namespace comes from whichever
 * `useTranslations('ns')` binding is in scope AT THE CALL SITE. A file-global
 * name→namespace map is the obvious shortcut and it is wrong: this repo has
 * files binding `const t` to different namespaces in different function
 * scopes, so the resolution has to follow scopes.
 *
 * Extracted from `tests/guards/i18n-key-exists.test.ts` for #2226, where
 * `destructive-vocabulary` needed the same resolution and had been reading
 * labels with `/confirmLabel\s*=\s*["']([^"']+)["']/` — a LITERAL-only match.
 * Every i18n-migrated call site writes `confirmLabel={t('key')}`, which that
 * regex cannot see, so fourteen of fifteen danger-tone dialogs had been moved
 * into an exemption map with a prose note. A note is not a check.
 *
 * Copying the resolver into a second suite was the alternative, and the two
 * would have drifted: this one has already been corrected twice (`#1703`'s
 * positional `Promise.all` destructuring, and the shadowing rule) and a copy
 * would not have received either fix.
 *
 * ## What it does NOT resolve, deliberately
 *
 * A dynamic key — `t(someVariable)`, `t(`x.${y}`)` — cannot be resolved
 * statically and is COUNTED, not guessed. A dynamic NAMESPACE
 * (`useTranslations(someVar)`) makes every call through that binding
 * unresolvable, and those are skipped entirely rather than attributed to a
 * guessed namespace. Callers that need to know how much they are missing read
 * `counts`.
 *
 * @module tests/helpers/i18n-key-resolver
 */
import * as fs from 'fs';
import * as ts from 'typescript';

/** next-intl's two namespace-binding entry points. */
const BINDERS = new Set(['useTranslations', 'getTranslations']);

/** `t.rich('key', …)` / `t.raw` / `t.markup` / `t.has` take a key in the same slot. */
const KEYED_MEMBERS = new Set(['rich', 'raw', 'markup', 'has']);

export interface TranslationCall {
    /** Full catalogue key — `<namespace>.<literal>`, or the bare literal when the binding has no namespace. */
    key: string;
    /** The namespace in scope at the call site. `''` for an absolute-key binding. */
    namespace: string;
    /** The key literal as written. */
    literal: string;
    /**
     * Character offsets of the CALL EXPRESSION in the file.
     *
     * The call, not the argument: a caller matching this against the range of a
     * JSX attribute (`confirmLabel={t('x')}`) needs the whole expression to
     * fall inside the attribute, and the argument alone would also match a
     * nested call it did not mean.
     */
    start: number;
    end: number;
    /** 1-based line of the key argument, for a failure message a person can follow. */
    line: number;
}

export interface ResolverCounts {
    /** Calls resolved to a literal key. */
    staticCalls: number;
    /** Calls through a resolved binding whose KEY was not a literal. */
    dynamicCalls: number;
}

/** Extracts `useTranslations('ns')` → 'ns'; `useTranslations()` → '' (absolute keys). */
function namespaceOf(init: ts.Node): string | null {
    let call: ts.CallExpression | null = null;
    if (ts.isCallExpression(init)) call = init;
    else if (ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)) {
        call = init.expression;
    }
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

/**
 * Every resolvable translation call in one file, with its position.
 *
 * `text` is optional so a caller that already has the source (or wants to
 * resolve a fixture) does not have to write it to disk.
 */
export function resolveTranslationCalls(
    file: string,
    text?: string,
): { calls: TranslationCall[]; counts: ResolverCounts } {
    const src = text ?? fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const calls: TranslationCall[] = [];
    const counts: ResolverCounts = { staticCalls: 0, dynamicCalls: 0 };

    /**
     * A stack of maps; each entry is either a namespace string (a translations
     * binding) or `null` (any other binding of that name, which SHADOWS an
     * outer translations binding and must suppress resolution).
     */
    const scopes: Map<string, string | null>[] = [new Map()];

    const resolve = (name: string): string | null | undefined => {
        for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i].has(name)) return scopes[i].get(name);
        }
        return undefined;
    };

    const declare = (name: ts.BindingName, ns: string | null): void => {
        if (ts.isIdentifier(name)) {
            scopes[scopes.length - 1].set(name.text, ns);
            return;
        }
        /**
         * A destructured name that is NOT resolved positionally below still has
         * to shadow an outer translations binding, or `const [t] = pair()` lets
         * an enclosing `t` answer for it.
         *
         * The version this was extracted from SAID that and did not do it: it
         * set a literal `'__destructured__'` key, which `resolve()` — only ever
         * called with an identifier from a call site — could never read. So
         * every destructured `t` fell through to the outer binding and its
         * calls were attributed to a namespace that does not apply. Found by
         * the contract test when the resolver was extracted for #2226, which
         * is what a contract test is for; nothing in `src/` happens to be
         * shaped this way today, so no guard was failing over it.
         *
         * Each bound identifier now shadows explicitly. Nested patterns are
         * walked, because `const { a: { t } } = x` binds `t` just as much.
         */
        const shadow = (binding: ts.BindingName): void => {
            if (ts.isIdentifier(binding)) {
                scopes[scopes.length - 1].set(binding.text, null);
                return;
            }
            for (const el of binding.elements) {
                if (ts.isBindingElement(el)) shadow(el.name);
            }
        };
        shadow(name);
    };

    /**
     * Pair an array pattern with `Promise.all([...])` by POSITION (#1703).
     *
     * Four page files do this:
     *
     *     const [t, tc, ctx] = await Promise.all([
     *         getTranslations('evidence'),
     *         getTranslations('common'),
     *         getTenantCtx({ tenantSlug }),
     *     ]);
     *
     * Before this, the pattern bound nothing for `t`, so resolution returned
     * `undefined` and all 56 literal calls in those files were SKIPPED — by a
     * guard whose whole job was to catch a key that is not in the catalogue,
     * blind to the files most at risk of one. A position that is not a
     * translator factory binds `null`, keeping the shadowing rule above.
     */
    const declarePositional = (pattern: ts.ArrayBindingPattern, init: ts.Expression): boolean => {
        let call: ts.Expression = init;
        if (ts.isAwaitExpression(call)) call = call.expression;
        if (!ts.isCallExpression(call)) return false;
        if (!ts.isPropertyAccessExpression(call.expression)) return false;
        if (call.expression.name.text !== 'all') return false;
        const arr = call.arguments[0];
        if (arr === undefined || !ts.isArrayLiteralExpression(arr)) return false;

        pattern.elements.forEach((el, i) => {
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) return;
            const part = arr.elements[i];
            scopes[scopes.length - 1].set(
                el.name.text,
                part === undefined ? null : namespaceOf(part),
            );
        });
        return true;
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
            const positional =
                ts.isArrayBindingPattern(node.name) &&
                declarePositional(node.name, node.initializer);
            if (!positional) declare(node.name, namespaceOf(node.initializer));
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
                    if (
                        arg !== undefined &&
                        ts.isStringLiteralLike(arg) &&
                        !ts.isTemplateExpression(arg)
                    ) {
                        counts.staticCalls++;
                        calls.push({
                            key: ns ? `${ns}.${arg.text}` : arg.text,
                            namespace: ns,
                            literal: arg.text,
                            start: node.getStart(sf),
                            end: node.getEnd(),
                            line: sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1,
                        });
                    } else {
                        counts.dynamicCalls++;
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
        if (opensScope) scopes.pop();
    };

    visit(sf);
    return { calls, counts };
}

/**
 * The single resolvable key inside a character range, or `null`.
 *
 * For a caller holding a JSX attribute's span — `confirmLabel={t('x')}` — and
 * wanting the key it resolves to. Returns `null` when the range holds no
 * resolvable call OR more than one, because "which key is the label" has no
 * answer in the second case and a guess is worse than an exemption.
 */
export function keyInRange(
    calls: readonly TranslationCall[],
    start: number,
    end: number,
): TranslationCall | null {
    const inside = calls.filter((c) => c.start >= start && c.end <= end);
    return inside.length === 1 ? inside[0] : null;
}
