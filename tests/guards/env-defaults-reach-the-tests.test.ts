/**
 * Every `.default()` in `src/env.ts` reaches the test environment — #2518.
 *
 * ## The defect
 *
 * `jest.setup.js` sets `SKIP_ENV_VALIDATION=1`, and `@t3-oss/env` then skips
 * zod ENTIRELY: it does not validate and it does not apply defaults. So every
 * `.default()` in the schema was inert in every jest test and the variable read
 * `undefined` rather than its declared value.
 *
 * The instance that found it: `AV_SCAN_MODE` declares `.default("strict")`, and
 * `isDownloadAllowed` refuses a PENDING (unscanned) download only when the mode
 * is `strict`. Measured before the fix:
 *
 *   AV_SCAN_MODE under test       undefined
 *   isDownloadAllowed('PENDING')  true        <- strict would be FALSE
 *
 * So the download gate was permissive in every unit test while declaring
 * strict. A test asserting "strict blocks a PENDING download" failed; a test
 * asserting one is served passed for a reason unrelated to the configured
 * default.
 *
 * ## Why this guard rather than trusting the mirror
 *
 * The mirror is a hand-written map in `tests/mocks/env.ts`, and a hand-written
 * map beside a schema is the thing that drifts — silently, and in the direction
 * of a variable going inert again. The 25th `.default()` will be added by
 * somebody who has never read this file.
 *
 * So the population is DERIVED from `src/env.ts` by parsing it, and the
 * assertion is about the PROPERTY rather than the mechanism: does the key
 * resolve to something through the `@/env` surface a test actually imports.
 * That accepts any route — `process.env`, the explicit test-value switch, or
 * `DECLARED_DEFAULTS` — which is right, because a test value that deliberately
 * differs from production (MICROSOFT_TENANT_ID is `test-tenant` here and
 * `common` in production) is not a defect and must not have to be restated.
 *
 * ## Parsed, not grepped
 *
 * A regex over `.default\(` finds 27 occurrences where 24 keys declare one, and
 * cannot extract the value from a chained declaration — `.default("common")`
 * followed by `.superRefine(...)` captured `"common")\n .superRe` on the first
 * attempt. The AST gives the call's first argument and nothing else.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { collectTrackedFiles } from '../helpers/collect-files';

import { DECLARED_DEFAULTS, env } from '../mocks/env';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ENV_SOURCE = 'src/env.ts';

/**
 * Keys that declare a zod `.default(...)`, with that value.
 *
 * Takes the SOURCE rather than reading the file, so the control at the bottom
 * can aim this exact function at a synthetic schema. The first version of that
 * control reimplemented the walk and immediately disagreed with it — it
 * reported `server` as a key, because `{ server: { … } }` is a property
 * assignment whose text contains `.default(`, and the real extractor filters
 * keys to SCREAMING_SNAKE. A control written in a second method certifies the
 * second method.
 */
function declaredDefaultsIn(fileName: string, source: string): Map<string, string> {
    const sourceFile = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    const found = new Map<string, string>();

    const defaultArgument = (node: ts.Node): string | null => {
        let literal: string | null = null;
        const walk = (n: ts.Node): void => {
            if (
                ts.isCallExpression(n)
                && ts.isPropertyAccessExpression(n.expression)
                && n.expression.name.text === 'default'
                && n.arguments.length === 1
            ) {
                const arg = n.arguments[0];
                // String and numeric literals only. A default computed at
                // runtime is not something a static mirror can hold, and
                // claiming otherwise is how a guard asserts the wrong thing.
                if (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg)) {
                    literal = arg.text;
                } else if (literal === null) {
                    literal = `__NON_LITERAL__${arg.getText(sourceFile).slice(0, 40)}`;
                }
            }
            ts.forEachChild(n, walk);
        };
        walk(node);
        return literal;
    };

    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && node.name) {
            const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
                ? node.name.text
                : null;
            // Schema keys are SCREAMING_SNAKE. `runtimeEnv`'s mappings use the
            // same names, so the first occurrence wins and a second does not
            // overwrite it with a different reading.
            if (key && /^[A-Z][A-Z0-9_]*$/.test(key) && !found.has(key)) {
                const value = defaultArgument(node.initializer);
                if (value !== null) found.set(key, value);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}

const DECLARED = declaredDefaultsIn(
    ENV_SOURCE,
    readFileSync(path.join(REPO_ROOT, ENV_SOURCE), 'utf8'),
);

/**
 * Keys whose production default deliberately does NOT reach the test
 * environment. Each needs a reason, and the no-stale-entries test below
 * removes the cover as soon as the key stops declaring a default.
 */
const DELIBERATELY_ABSENT: Readonly<Record<string, string>> = {};

describe('env defaults reach the tests (#2518)', () => {
    it('ranges over a real schema — not vacuously passing', () => {
        const raw = readFileSync(path.join(REPO_ROOT, ENV_SOURCE), 'utf8');
        const occurrences = (raw.match(/\.default\(/g) ?? []).length;
        console.log(
            `[env-defaults] ${DECLARED.size} key(s) declare a default in ${ENV_SOURCE} `
                + `(${occurrences} \`.default(\` occurrences — the gap is chained declarations)`,
        );
        console.log(
            `[env-defaults] ${Object.keys(DECLARED_DEFAULTS).length} mirrored in tests/mocks/env.ts, `
                + `${Object.keys(DELIBERATELY_ABSENT).length} deliberately absent`,
        );
        expect(DECLARED.size).toBeGreaterThanOrEqual(20);
    });

    it('every declared default resolves through the @/env surface', () => {
        // The property, not the mechanism: ANY route is acceptable —
        // `process.env`, the explicit test-value switch, or DECLARED_DEFAULTS.
        // What is not acceptable is `undefined`, which is what zod skipping
        // produced for all 24.
        const typed = env as unknown as Record<string, unknown>;
        const inert = [...DECLARED.keys()]
            .filter((key) => !(key in DELIBERATELY_ABSENT))
            .filter((key) => typed[key] === undefined);
        expect(inert).toEqual([]);
    });

    it('the mirrored VALUE matches the schema, so the mirror cannot drift', () => {
        // A mirror that holds the wrong value is worse than none: the test
        // environment then disagrees with production in a way nobody declared.
        // Only keys the mirror actually carries — a test-specific value in the
        // switch is deliberate and is covered by the test above.
        const drifted = Object.entries(DECLARED_DEFAULTS)
            .filter(([key]) => DECLARED.has(key))
            .filter(([key, mirrored]) => DECLARED.get(key) !== mirrored)
            .map(([key, mirrored]) => `${key}: schema ${JSON.stringify(DECLARED.get(key))} vs mirror ${JSON.stringify(mirrored)}`);
        expect(drifted).toEqual([]);
    });

    it('no DELIBERATELY_ABSENT entry outlives the default it exempts', () => {
        const stale = Object.keys(DELIBERATELY_ABSENT).filter((key) => !DECLARED.has(key));
        expect(stale).toEqual([]);
    });

    /**
     * A fallback on an already-defaulted key must not disagree with the
     * schema — #2518, and this is the half that makes the evidence.ts fix
     * detectable.
     *
     * `downloadEvidenceFile` read `env.AV_SCAN_MODE || 'permissive'` while the
     * schema declares `.default("strict")`. In production the `||` was
     * unreachable; under jest the default was absent, so it RESOLVED, and the
     * evidence download gate was permissive while declaring strict.
     *
     * Changing it to `?? 'strict'` is behaviourally undetectable now that the
     * default reaches the test env — the mutation back to `|| 'permissive'`
     * leaves every suite green, which I measured. A change nothing can detect
     * is a change nothing protects, so the property is asserted here directly:
     * where a fallback literal exists beside a defaulted key, the two must
     * agree. Derived from the schema rather than pinned to the one site, so it
     * covers the next one too.
     *
     * Non-literal fallbacks (`?? DEFAULT_SENDER`) are counted and not compared:
     * resolving an identifier means evaluating the module, and a guard that
     * half-resolves would report a disagreement that is not one. The two live
     * ones were checked by hand — `mailer.ts` defines
     * `DEFAULT_SENDER = 'noreply@agrent.bg'` and the schema declares
     * `.default("noreply@agrent.bg")`, so they agree. The COUNT is asserted
     * so a third appearing is visible in the reading even though its value is
     * not compared.
     */
    it('no fallback disagrees with its schema default', () => {
        const files = collectTrackedFiles({
            roots: ['src', 'scripts'],
            extensions: ['.ts', '.tsx'],
            exclude: (rel) => rel === 'src/env.ts',
            floor: 2000,
        });
        const disagreements: string[] = [];
        let literalFallbacks = 0;
        let identifierFallbacks = 0;
        for (const abs of files) {
            const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
            const source = readFileSync(abs, 'utf8');
            for (const key of DECLARED.keys()) {
                // The VALIDATED env only — `process.env.X` is the raw
                // environment and deliberately carries no default, which is
                // what `assertEmbeddingBackendConfigured` relies on. And a
                // leading `!` is an unset-CHECK, not a fallback. Both were
                // false positives on the first sweep: 11 hits became 5.
                const re = new RegExp(
                    String.raw`(?<!process\.)(?<![\w.])(!?)env\.` + key
                        + String.raw`\s*(?:\|\||\?\?)\s*(['"\`])([^'"\`]*)\2`,
                    'g',
                );
                for (const m of source.matchAll(re)) {
                    if (m[1] === '!') continue;
                    literalFallbacks += 1;
                    const declared = DECLARED.get(key);
                    if (declared !== m[3]) {
                        const line = source.slice(0, m.index ?? 0).split('\n').length;
                        disagreements.push(
                            `${rel}:${line}  env.${key} falls back to ${JSON.stringify(m[3])} `
                                + `but the schema declares ${JSON.stringify(declared)}`,
                        );
                    }
                }
                const ident = new RegExp(
                    String.raw`(?<!process\.)(?<![\w.])env\.` + key
                        + String.raw`\s*(?:\|\||\?\?)\s*[A-Z_][A-Z0-9_]*`,
                    'g',
                );
                identifierFallbacks += [...source.matchAll(ident)].length;
            }
        }
        console.log(
            `[env-defaults] ${literalFallbacks} literal fallback(s) on a defaulted key, `
                + `${identifierFallbacks} via a named constant (counted, not compared)`,
        );
        expect(disagreements).toEqual([]);
        // A floor: this ranges over the fallbacks it finds, and finding none
        // would satisfy the assertion for free.
        expect(literalFallbacks).toBeGreaterThanOrEqual(3);
    });

    it('CAN detect an inert default — the control the absence above needs', () => {
        // Every assertion here ranges over a population that is healthy now,
        // so a parser that stopped matching would satisfy all of them. This
        // aims the real extractor at a source it is not given, and at a key the
        // mock does not answer.
        const synthetic = [
            'const x = createEnv({ server: {',
            '    BRAND_NEW_SWITCH: z.string().default("on"),',
            '    CHAINED_ONE: z.string().default("common").superRefine(() => {}),',
            '} });',
        ].join('\n');
        const found = declaredDefaultsIn('synthetic.ts', synthetic);
        expect([...found.keys()].sort()).toEqual(['BRAND_NEW_SWITCH', 'CHAINED_ONE']);
        // And the VALUE comes out of the chained declaration intact, which a
        // regex does not manage: `.default("common").superRefine(…)` captured
        // `"common")\n  .superRe` on the first attempt.
        expect(found.get('CHAINED_ONE')).toBe('common');
        expect(found.get('BRAND_NEW_SWITCH')).toBe('on');
        // And the mock answers neither, so a key like these WOULD be reported.
        const typed = env as unknown as Record<string, unknown>;
        expect(typed.BRAND_NEW_SWITCH).toBeUndefined();
        expect(typed.CHAINED_ONE).toBeUndefined();
    });
});
