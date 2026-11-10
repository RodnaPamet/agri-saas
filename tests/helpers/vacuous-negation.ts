/**
 * Find guards whose only claims about a file's text are NEGATIONS — #2558.
 *
 * ## The property
 *
 * A guard that reads a file and asserts a negation over its text PASSES when
 * the read returns nothing. #2507 fixed six of those, one inert on main for 82
 * days. The remedy set is settled: a presence claim on the same read, a
 * denominator where the read feeds a loop, or nothing where a sibling already
 * fails on empty.
 *
 * ## Why this is an AST walk and not a pattern
 *
 * #2558 exists because the pattern version was not gate-worthy. Its control
 * matcher was `/expect\([^)]*\)\.toMatch\(/`, and `[^)]*` CANNOT CROSS A
 * NESTED PAREN — so `expect(fn(x)).toMatch(…)`, which is most real code, never
 * matched. Three sound guards were reported as broken, and fixing that one
 * character class moved the at-risk count from 6 to 0. A detector whose answer
 * halves on a regex fix must not redden other people's PRs, and its failure
 * direction was the bad one: healthy guards accused, which is how a ratchet
 * gets baselined or deleted instead of obeyed.
 *
 * `ts.createSourceFile` has no nesting problem because it is not matching
 * text, and #2537 measured it affordable at this scale (2,350 files / 23,873
 * object literals / 62,571 properties in ~5.4 s).
 *
 * ## The distinction that does the work
 *
 * Step 3 below, and #2507's own stated rule got it wrong — its comment thread
 * carries the correction:
 *
 *   subject is a FILE'S TEXT            -> negating it is vacuity-capable,
 *                                          whatever the matcher
 *   subject is a PREDICATE over supplied inputs -> a real assertion either way
 *
 * So `expect(legacy.test(content)).toBe(false)` is vacuity-capable and
 * `expect(isAllowed('/x')).toBe(false)` is not, even though both are
 * `.toBe(false)`.
 */
import * as ts from 'typescript';

/** Functions whose result is a file's text, directly or after blanking. */
const READ_CALLS = new Set([
    'readFileSync',
    'read',
    'readIfFile',
    'readJson',
    'blankNonCode',
    'blankComments',
]);

/**
 * Matchers that assert something is ABSENT or EMPTY.
 *
 * `toHaveLength` is NOT here, and that is the correction. Its sense depends on
 * the argument: `toHaveLength(0)` is an emptiness claim, `toHaveLength(3)`
 * asserts three things are PRESENT. Treating the name as negative reported
 * `webpack-bundler-pinning` and `acquisition-probe-is-inert`, both of which
 * assert a non-zero count over a read. Handled with the argument below,
 * alongside `toBe(0)` and `toEqual([])`, which have the same shape.
 */
const NEGATIVE_MATCHERS = new Set(['toBeFalsy', 'toBeNull', 'toBeUndefined']);

/** Matchers that assert something is THERE. */
const POSITIVE_MATCHERS = new Set([
    'toContain',
    'toMatch',
    'toContainEqual',
    'toBeGreaterThan',
    'toBeGreaterThanOrEqual',
    'toBeTruthy',
    'toBeDefined',
]);

/**
 * Collectors that REFUSE an empty result when given a `floor`.
 *
 * #2507's remedy set has three members and this is the third — "nothing where
 * a sibling already fails on empty". A guard whose population comes from
 * `collectSourceFiles({ …, floor: N })` cannot have read zero files, so a
 * negation over that population is not vacuity-capable however it is phrased.
 * Missing this was what falsely accused `passMe_hasDenominator`, and it is
 * most of the difference between 24 reported files and the 0 #2558 predicted.
 */
const FLOORED_COLLECTORS = new Set(['collectSourceFiles', 'collectTrackedFiles']);

export interface Verdict {
    /** Exported function or describe/it name the assertion sits in, for reporting. */
    readonly scope: string;
    readonly negated: number;
    readonly presence: number;
}

/**
 * `true` when the expression tree mentions any identifier bound to a read, or
 * calls a read function directly.
 *
 * Deliberately a REACHABILITY question rather than a type one: a subject built
 * from a read through any number of wrappers is still a claim about a file's
 * text, which is the thing that can be empty.
 */
function tracesToRead(node: ts.Node, readLocals: ReadonlySet<string>): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found) return;
        if (ts.isIdentifier(n) && readLocals.has(n.text)) {
            found = true;
            return;
        }
        if (ts.isCallExpression(n)) {
            const callee = n.expression;
            const name = ts.isIdentifier(callee)
                ? callee.text
                : ts.isPropertyAccessExpression(callee)
                  ? callee.name.text
                  : '';
            if (READ_CALLS.has(name)) {
                found = true;
                return;
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
}

/** Locals bound to a file read: `const content = readFileSync(…)`. */
function readLocalsIn(sf: ts.SourceFile): Set<string> {
    const names = new Set<string>();
    const visit = (n: ts.Node): void => {
        if (
            ts.isVariableDeclaration(n)
            && ts.isIdentifier(n.name)
            && n.initializer
            && tracesToRead(n.initializer, names)
        ) {
            names.add(n.name.text);
        }
        /*
         * `for (const m of src.matchAll(...))` — the loop VARIABLE carries the
         * read's text, and it is not a `VariableDeclaration` with an
         * initializer, so the clause above cannot see it. Missing this reported
         * `webpack-bundler-pinning`, whose presence claim is
         * `expect(m[1]).toMatch(/--webpack/)` on exactly such a variable.
         */
        if (ts.isForOfStatement(n) && tracesToRead(n.expression, names)) {
            const decl = n.initializer;
            if (ts.isVariableDeclarationList(decl)) {
                for (const d of decl.declarations) {
                    if (ts.isIdentifier(d.name)) names.add(d.name.text);
                    else if (ts.isArrayBindingPattern(d.name)) {
                        for (const el of d.name.elements) {
                            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                                names.add(el.name.text);
                            }
                        }
                    }
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    // Two passes: a local bound from an earlier local (`const SRC = blank(raw)`)
    // is only reachable once the earlier one is known. Two is enough for every
    // shape in the tree today and terminates; a fixed point would need a loop
    // and has no observed call for it.
    visit(sf);
    visit(sf);
    return names;
}

/**
 * `expect(<something>.length).toBeGreaterThan(n)` and friends — a positive
 * bound on a collection's SIZE, which an empty population fails.
 *
 * Deliberately independent of whether the subject traces to a read: the claim
 * is about the population behind the reads, not about any file's text.
 */
function isLengthDenominator(call: ts.CallExpression): boolean {
    const subject = call.arguments[0];
    if (
        !subject
        || !ts.isPropertyAccessExpression(subject)
        || !['length', 'size'].includes(subject.name.text)
    ) {
        return false;
    }
    let cur: ts.Node = call;
    let matcher = '';
    let negated = false;
    let arg: ts.Node | undefined;
    while (cur.parent) {
        const p: ts.Node = cur.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === cur) {
            if (p.name.text === 'not') negated = !negated;
            else matcher = p.name.text;
            cur = p;
            continue;
        }
        if (ts.isCallExpression(p) && p.expression === cur) {
            arg = p.arguments[0];
            cur = p;
            continue;
        }
        break;
    }
    if (negated) return false;
    if (matcher === 'toBeGreaterThan' || matcher === 'toBeGreaterThanOrEqual') return true;
    // `toBe(n)` / `toEqual(n)` for a NON-ZERO n is also a denominator; zero is
    // an emptiness claim and must not count.
    if (
        (matcher === 'toBe' || matcher === 'toEqual')
        && arg !== undefined
        && ts.isNumericLiteral(arg)
        && arg.text !== '0'
    ) {
        return true;
    }
    return false;
}

/**
 * Classify one `expect(...)` chain.
 *
 * Returns `null` when the subject does not trace to a read — a predicate over
 * supplied inputs is a real assertion and is not this detector's business.
 */
function classify(
    call: ts.CallExpression,
    readLocals: ReadonlySet<string>,
): 'negated' | 'presence' | null {
    const subject = call.arguments[0];
    if (!subject) return null;

    /*
     * THE DENOMINATOR IS TESTED FIRST, and it has to be.
     *
     * `expect(files.length).toBeGreaterThan(200)` is #2507's second remedy,
     * and its subject deliberately does NOT trace to a read — it is about the
     * POPULATION, which is the thing that can be empty. My first draft put
     * this check after the `tracesToRead` early return, which made it
     * unreachable for the exact shape it was written for, and
     * `no-raw-nul-bytes` was reported despite carrying the prescribed cure.
     * A branch that cannot be reached is the defect this whole file is about.
     */
    if (isLengthDenominator(call)) return 'presence';

    if (!tracesToRead(subject, readLocals)) return null;

    // Walk outward through the matcher chain, collecting `.not` and the final
    // matcher name. `expect(x).not.toContain(y)` parses as a call whose callee
    // is a property access on a property access on the expect call.
    let negatedByNot = false;
    let matcher = '';
    let literalArg: ts.Node | undefined;
    let cur: ts.Node = call;
    while (cur.parent) {
        const p: ts.Node = cur.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === cur) {
            if (p.name.text === 'not') negatedByNot = !negatedByNot;
            else matcher = p.name.text;
            cur = p;
            continue;
        }
        if (ts.isCallExpression(p) && p.expression === cur) {
            literalArg = p.arguments[0];
            cur = p;
            continue;
        }
        break;
    }
    if (!matcher) return null;

    // `toBe(false)` / `toEqual([])` / `toBe(0)` are negations by their ARGUMENT,
    // not their name — the distinction #2507's rule missed.
    const argIsFalsy =
        literalArg !== undefined
        && (literalArg.kind === ts.SyntaxKind.FalseKeyword
            || (ts.isNumericLiteral(literalArg) && literalArg.text === '0')
            || (ts.isArrayLiteralExpression(literalArg) && literalArg.elements.length === 0));
    const argIsTruthy =
        literalArg !== undefined && literalArg.kind === ts.SyntaxKind.TrueKeyword;

    // `toHaveLength(n)`: zero is emptiness, non-zero is presence.
    const argIsZero = literalArg !== undefined
        && ts.isNumericLiteral(literalArg)
        && literalArg.text === '0';
    const argIsNonZeroNumber = literalArg !== undefined
        && ts.isNumericLiteral(literalArg)
        && literalArg.text !== '0';

    const isNegative =
        NEGATIVE_MATCHERS.has(matcher)
        || (matcher === 'toHaveLength' && argIsZero)
        || ((matcher === 'toBe' || matcher === 'toEqual' || matcher === 'toStrictEqual')
            && argIsFalsy);
    const isPositive =
        POSITIVE_MATCHERS.has(matcher)
        || (matcher === 'toHaveLength' && argIsNonZeroNumber)
        || ((matcher === 'toBe' || matcher === 'toEqual' || matcher === 'toStrictEqual')
            && (argIsTruthy || argIsNonZeroNumber));

    if (negatedByNot) {
        // `.not.toContain` is a negation; `.not.toBe(false)` claims presence of
        // something other than false, which is not a presence claim about the
        // read's CONTENT either — so it counts as neither and returns null.
        if (isPositive) return 'negated';
        return null;
    }
    if (isNegative) return 'negated';
    if (isPositive) return 'presence';
    return null;
}

/**
 * Count negated and presence claims over file reads, per file.
 *
 * A file is AT RISK when it makes at least one negated claim about a read and
 * NO presence claim about one.
 */
export function assessSource(fileName: string, text: string): Verdict {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    const readLocals = readLocalsIn(sf);
    let negated = 0;
    let presence = 0;

    /*
     * A STRUCTURAL floor counts as the control, before any assertion is read.
     *
     * `collectSourceFiles({ roots, floor: N })` throws on an empty result, so
     * the population behind every read in the file cannot be zero. #2507 lists
     * exactly this as a sufficient remedy, and a detector that ignored it
     * would report the guards that took the prescribed cure.
     */
    const hasFlooredCollector = (() => {
        let found = false;
        const look = (n: ts.Node): void => {
            if (found) return;
            if (ts.isCallExpression(n)) {
                const callee = n.expression;
                const name = ts.isIdentifier(callee)
                    ? callee.text
                    : ts.isPropertyAccessExpression(callee)
                      ? callee.name.text
                      : '';
                if (FLOORED_COLLECTORS.has(name)) {
                    const arg = n.arguments[0];
                    if (
                        arg
                        && ts.isObjectLiteralExpression(arg)
                        && arg.properties.some(
                            (p) =>
                                ts.isPropertyAssignment(p)
                                && ts.isIdentifier(p.name)
                                && p.name.text === 'floor',
                        )
                    ) {
                        found = true;
                        return;
                    }
                }
            }
            ts.forEachChild(n, look);
        };
        look(sf);
        return found;
    })();
    const visit = (n: ts.Node): void => {
        if (
            ts.isCallExpression(n)
            && ts.isIdentifier(n.expression)
            && n.expression.text === 'expect'
        ) {
            const verdict = classify(n, readLocals);
            if (verdict === 'negated') negated += 1;
            else if (verdict === 'presence') presence += 1;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    // The floor stands in for a presence claim, so a guard that took the
    // structural cure is not reported for lacking the textual one.
    if (hasFlooredCollector && negated > 0) presence += 1;
    return { scope: fileName, negated, presence };
}

/** `true` when this file asserts only absences about the text it reads. */
export function isAtRisk(v: Verdict): boolean {
    return v.negated > 0 && v.presence === 0;
}
