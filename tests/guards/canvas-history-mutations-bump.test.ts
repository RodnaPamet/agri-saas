/**
 * Every canvas-history mutation bumps — #1471.
 *
 * ## The pattern this exists to hold
 *
 * `useCanvasHistory` keeps its undo/redo stacks in refs, not state:
 *
 * ```ts
 * const pastRef   = useRef<Snapshot[]>([]);
 * const futureRef = useRef<Snapshot[]>([]);
 * const [, setTick] = useState(0);
 * const bump = useCallback(() => setTick((t) => (t + 1) & 0xffff), []);
 * ```
 *
 * Refs are deliberate: a snapshot stack mutated on every edit would, as
 * state, re-render the canvas on each push for no visual reason. But the
 * hook also returns values DERIVED from those refs, read during render:
 *
 * ```ts
 * canUndo: pastRef.current.length > 0,
 * canRedo: futureRef.current.length > 0,
 * depth:   pastRef.current.length,
 * ```
 *
 * A ref mutation does not re-render, so those three would go stale — the
 * undo button staying disabled after the first push. `bump()` is what
 * closes that loop: every path that mutates a stack also forces a render,
 * so the next read of `canUndo` is fresh.
 *
 * ## Why a guard and not a conversion
 *
 * `react-hooks/refs` flags the three reads above ("cannot access refs
 * during render"), and the obvious fix is `useState`/`useReducer`, which is
 * what this hook is hand-rolling. That conversion was considered and
 * deliberately not taken (#1471): the refs are load-bearing for exactly the
 * reason above, and the findings are a true description of a pattern that
 * is correct here.
 *
 * What was NOT true is that anything enforced it. All five mutation paths
 * bump today — verified, not assumed, when this guard was written:
 *
 * ```
 * push      mutates=true  bumps=true
 * pushRedo  mutates=true  bumps=true
 * undo      mutates=true  bumps=true
 * redo      mutates=true  bumps=true
 * reset     mutates=true  bumps=true
 * ```
 *
 * So there is no bug. A SIXTH path added without a `bump()` would desync
 * the UI from the stack silently — no test would fail, and the symptom
 * (a stale undo button) is the kind a reviewer reads as a CSS problem.
 * That is the gap this closes.
 *
 * ## Why the AST and not a grep
 *
 * A text scan cannot tell which `bump()` belongs to which callback: the
 * calls are one line apart inside sibling `useCallback` bodies. Attributing
 * a mutation to the wrong path is the failure mode that would make this
 * guard green while the invariant is broken, so the pairing is done on the
 * tree.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const ROOT = join(__dirname, '..', '..');
const SRC = 'src/lib/processes/use-canvas-history.ts';

/** The two ref-held stacks. A mutation of either must be followed by a bump. */
const STACK_REFS = ['pastRef', 'futureRef'];
/** Array methods that mutate in place. `concat`/`slice`/`map` do not. */
const MUTATORS = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill'];
const BUMP = 'bump';

interface PathFacts {
    name: string;
    mutates: boolean;
    bumps: boolean;
    /** How it mutates, for a failure message that says what to fix. */
    how: string[];
}

/**
 * `X.current` where X is one of the stack refs — the expression every
 * mutation goes through, whether by method call or by assignment.
 */
function isStackRefCurrent(node: ts.Node): boolean {
    return (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        STACK_REFS.includes(node.expression.text) &&
        node.name.text === 'current'
    );
}

/** Walks one callback body and records whether it mutates and whether it bumps. */
function analyseBody(body: ts.Node, name: string): PathFacts {
    const facts: PathFacts = { name, mutates: false, bumps: false, how: [] };

    const visit = (node: ts.Node): void => {
        // pastRef.current.push(...) / .pop() / .splice(...)
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            isStackRefCurrent(node.expression.expression) &&
            MUTATORS.includes(node.expression.name.text)
        ) {
            facts.mutates = true;
            const ref = (node.expression.expression as ts.PropertyAccessExpression)
                .expression as ts.Identifier;
            facts.how.push(`${ref.text}.current.${node.expression.name.text}()`);
        }

        // pastRef.current = []
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            isStackRefCurrent(node.left)
        ) {
            facts.mutates = true;
            const ref = (node.left as ts.PropertyAccessExpression).expression as ts.Identifier;
            facts.how.push(`${ref.text}.current = …`);
        }

        // bump()
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === BUMP
        ) {
            facts.bumps = true;
        }

        ts.forEachChild(node, visit);
    };

    ts.forEachChild(body, visit);
    return facts;
}

/**
 * Every `const NAME = useCallback(fn, deps)` in the file, paired with what
 * its body does. Nested callbacks are not separated out — a `bump()` inside
 * a `setNodes` updater still belongs to the path that mutated.
 */
function readPathsFrom(text: string, label = SRC): PathFacts[] {
    const sf = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out: PathFacts[] = [];

    const visit = (node: ts.Node): void => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            node.initializer.expression.text === 'useCallback' &&
            node.initializer.arguments.length > 0
        ) {
            const fn = node.initializer.arguments[0];
            if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
                out.push(analyseBody(fn.body, node.name.text));
            }
        }
        ts.forEachChild(node, visit);
    };

    ts.forEachChild(sf, visit);
    return out;
}

function readPaths(): PathFacts[] {
    return readPathsFrom(readFileSync(join(ROOT, SRC), 'utf8'));
}

describe('canvas history — every mutation forces a render', () => {
    const paths = readPaths();
    const mutating = paths.filter((p) => p.mutates);

    it('the pattern this guard describes is still the implementation', () => {
        // If the hook is converted to useState/useReducer, the refs and the
        // render-time reads both go away and this guard becomes vacuous —
        // green while checking nothing. These assertions make that conversion
        // DELETE the guard loudly instead of hollowing it out quietly.
        const text = readFileSync(join(ROOT, SRC), 'utf8');
        for (const ref of STACK_REFS) {
            expect(text).toContain(`${ref} = useRef`);
        }
        expect(text).toMatch(/const\s+bump\s*=\s*useCallback/);
        // The reads that make a bump NECESSARY. Without these, a missing
        // bump would be harmless and this guard would be enforcing a rule
        // with no consequence behind it.
        expect(text).toContain('canUndo: pastRef.current.length > 0');
        expect(text).toContain('canRedo: futureRef.current.length > 0');
    });

    it('found the mutation paths at all', () => {
        // A rename of the refs, or a switch to a mutator not in MUTATORS,
        // would empty `mutating` — and an empty list satisfies the per-path
        // check below by having nothing to check. The floor is what turns
        // that silence into a failure.
        //
        // 5 is today's count (push, pushRedo, undo, redo, reset). Asserted as
        // a floor rather than an equality so adding a sixth path does not
        // fail here instead of failing the check that matters.
        expect(mutating.length).toBeGreaterThanOrEqual(5);
        expect(paths.map((p) => p.name).sort()).toEqual(
            expect.arrayContaining(['push', 'pushRedo', 'redo', 'reset', 'undo']),
        );
    });

    it.each(STACK_REFS)('%s is only ever mutated inside a useCallback', (ref) => {
        // A mutation at the top level of the hook body, or inside a plain
        // helper, would never be seen by the per-path check — it has no
        // callback to attribute it to.
        const text = readFileSync(join(ROOT, SRC), 'utf8');
        const sf = ts.createSourceFile(SRC, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        let outside = 0;

        const walk = (node: ts.Node, insideCallback: boolean): void => {
            let nowInside = insideCallback;
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === 'useCallback'
            ) {
                nowInside = true;
            }
            const mutatesThisRef =
                (ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    isStackRefCurrent(node.expression.expression) &&
                    MUTATORS.includes(node.expression.name.text) &&
                    ((node.expression.expression as ts.PropertyAccessExpression)
                        .expression as ts.Identifier).text === ref) ||
                (ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    isStackRefCurrent(node.left) &&
                    ((node.left as ts.PropertyAccessExpression).expression as ts.Identifier)
                        .text === ref);

            if (mutatesThisRef && !nowInside) outside += 1;
            ts.forEachChild(node, (c) => walk(c, nowInside));
        };

        ts.forEachChild(sf, (n) => walk(n, false));
        expect(outside).toBe(0);
    });

    describe('the ref matcher discriminates (selector-teeth control)', () => {
        // WHY THIS EXISTS. `scripts/selector-teeth.mjs` stubbed
        // `isStackRefCurrent()` to return `[]` and every assertion above
        // still passed. `[]` is TRUTHY, so the stub does not break the
        // predicate — it makes it accept EVERYTHING. That only ever ADDS
        // mutation paths, and since every real path bumps, nothing failed.
        //
        // So the checks above prove the matcher FIRES. They cannot prove it
        // DISCRIMINATES, and a matcher that accepts everything would count a
        // mutation of any unrelated ref as a history mutation. These cases
        // run the analyser over synthetic source where the right answer
        // differs from the accept-everything answer.
        const SYNTHETIC = `
            const good = useCallback(() => {
                pastRef.current.push(snap);
                bump();
            }, [bump]);
            const unrelated = useCallback(() => {
                scrollRef.current.push(snap);
            }, []);
            const readOnly = useCallback(() => {
                return pastRef.current.slice(0, 2).concat(futureRef.current);
            }, []);
        `;

        const paths = readPathsFrom(SYNTHETIC, 'synthetic.ts');
        const byName = (n: string) => paths.find((p) => p.name === n)!;

        it('reads all three synthetic callbacks', () => {
            expect(paths.map((p) => p.name)).toEqual(['good', 'unrelated', 'readOnly']);
        });

        it('counts a history-stack mutation', () => {
            expect(byName('good').mutates).toBe(true);
            expect(byName('good').bumps).toBe(true);
        });

        it('does NOT count a mutation of an unrelated ref', () => {
            // `scrollRef.current.push(...)` with no bump. An accept-everything
            // matcher counts this and, because it does not bump, would also
            // turn the main assertion into a false alarm on real code.
            expect(byName('unrelated').mutates).toBe(false);
        });

        it('does NOT count non-mutating array methods on a history stack', () => {
            // `slice`/`concat` return new arrays. Treating a read as a
            // mutation would demand a bump where none is needed.
            expect(byName('readOnly').mutates).toBe(false);
        });
    });

    it('every mutating path calls bump()', () => {
        const offenders = mutating.filter((p) => !p.bumps);
        expect(
            offenders.map((p) => `${p.name} mutates ${p.how.join(', ')} without calling bump()`),
        ).toEqual([]);
    });
});
