/**
 * No declaration appears twice in one file — object keys (#2537) and import
 * bindings (#2554).
 *
 * Renamed from `no-duplicate-object-keys` when the import half landed: the two
 * shapes have the same cause, the same blindness and the same population, and
 * splitting them would mean two parses of the same 2,350 files for one
 * question. The old name described half of what this does.
 *
 * ## The defect, which a merge produces and no merge tool reports
 *
 * Two branches independently added `DOCUMENT_STORAGE_LIMIT_BYTES` to
 * `src/env.ts` — the same variable, the same block, the same feature (#2495
 * step 3, split across #2534 and #2536). Git saw two NON-CONFLICTING additions
 * at different offsets and took both, so the merged file declared the key
 * twice in one object literal and mapped it twice in `runtimeEnv`.
 *
 * Nothing in the merge path reports that. It is not a conflict, so
 * `npm run merge:main` is silent BY CONSTRUCTION — that script's job is
 * conflicted files and generated artefacts, and this is neither. It has now
 * happened twice in one day, in two different files, on two different pairs of
 * branches.
 *
 * A duplicate key is not a runtime error either: the LATER declaration
 * silently wins. For a zod schema that means which side's validation survives
 * is decided by merge offsets rather than by review. Both instances happened
 * to be identical; `.positive()` against `.nonnegative()`, or one side with a
 * `.default()`, ships whichever landed second with both reviewers having
 * approved their own version.
 *
 * ## "Only the cold typecheck catches it" is true for src/ and FALSE for scripts/
 *
 * That is what #2537 says, and it is the premise worth correcting, because it
 * understates the gap for a third of the population. Measured with
 * `tsc -p tsconfig.json --listFilesOnly` (9,503 program files):
 *
 *   scripts/*.ts on disk                      51
 *   scripts/*.ts in the tsc program           17   (reachable via an import)
 *   => not typechecked at all                 34
 *
 * `tsconfig.json` EXCLUDES `scripts` (and `prisma/seed.ts`), and `exclude`
 * only suppresses root-file discovery — a file an included file imports is
 * still in the program, which is why 17 of them are. For the other 34, and for
 * `prisma/seed.ts`, there is no check anywhere: not jest, not `tsc`, not the
 * cold invocation. A duplicate key there ships.
 *
 * And for the files that ARE checked, the catching invocation is the one
 * people skip. From the issue, measured:
 *
 *   npx tsc --noEmit -p tsconfig.json   EXIT=134  errors=0   <- OOM, prints nothing
 *   npm run typecheck                   EXIT=2    errors=1   <- TS1117
 *
 * Exit 134 with zero errors is byte-identical to a clean pass, which is how a
 * second session verifying this very defect came within a message of
 * reporting it unguardable. `verify:changed` deliberately does not run
 * `typecheck` at all (two `tsc` invocations, ~8 minutes), so on the documented
 * pre-push path nothing looks for this.
 *
 * ## Parsed, not grepped
 *
 * `ts.createSourceFile` over 2,348 files / 23,732 object literals / 62,147
 * properties costs ~5.4s, so the exact tool is also the affordable one. A
 * regex cannot tell a key from a string value containing a colon, cannot see
 * nesting, and cannot tell `{a:1,'a':2}` (a duplicate) from `{a:1}` beside
 * `{a:2}` (the normal case, and most of the repo).
 *
 * Three shapes are deliberately NOT reported, each with a live count:
 * SPREADS overridden by a later key (918 — the point of `{...defaults, x}`),
 * COMPUTED keys (97 — a collision is knowable only at runtime), and get/set
 * ACCESSOR pairs on one name (0 live, so the control fixture is the only thing
 * exercising that branch).
 *
 * ## The control is a real file, because the population is healthy
 *
 * `src` + `scripts` + `prisma` carry ZERO duplicates today, and a guard
 * asserting an absence over a healthy population is satisfied perfectly by a
 * predicate that can no longer match. So the control is
 * `tests/fixtures/duplicate-object-key-control.ts.fixture`, read off disk and
 * parsed by the SAME `inspect()`, asserting both directions — the duplicates
 * reported AND the three legal shapes not. It is `.fixture` rather than `.ts`
 * because all 2,466 `.ts`/`.tsx` files under `tests/` are in the tsc program,
 * so a real TS1117 there would redden the required `Typecheck` job.
 *
 * ## The import half — #2554, and the rule is simpler than it looks
 *
 * Merging #2547 into the currency-conversion branch duplicated
 * `import { EXCHANGE_CURRENCY }`: both sides added it at different offsets, git
 * took both, not a conflict, `merge:main` silent by construction, and only the
 * cold typecheck noticed. Same cause as the object-key half, different
 * declaration.
 *
 * The obvious framing — "two imports from the same module" — is wrong in BOTH
 * directions, and the six probes that settle it are in the control fixture:
 *
 *   - two imports from one module are LEGAL when the bindings differ, and
 *     flagging that is how this guard would get itself baselined;
 *   - `import type` buys no exemption — the same local name imported twice is
 *     TS2300 whether or not one is type-only;
 *   - a collision does NOT require the same module, so a specifier-keyed
 *     detector misses `import { a } from './x'` beside `import { a } from
 *     './y'` entirely.
 *
 * One predicate covers every row: the LOCAL BINDING NAME. Every shape
 * TypeScript accepts, this accepts, for the same reason TypeScript does.
 *
 * Measured on main before the assertion was written: **11,082 import
 * declarations, 15,302 local bindings, 0 duplicates** — so it is a
 * `toEqual([])` and not a cap, and this guard would have gone red on the #2546
 * merge rather than waiting for a `tsc` nobody had time to run. The two counts
 * belong side by side because a declaration-keyed detector ranges over the
 * smaller one and over the wrong thing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { collectSourceFiles, collectTrackedFiles, REPO_ROOT } from '../helpers/collect-files';

type Finding = { file: string; line: number; key: string };
type Inspection = { keys: Finding[]; imports: Finding[] };
type Counts = {
    literals: number;
    properties: number;
    computed: number;
    spreads: number;
    importDecls: number;
    importBindings: number;
};

/**
 * Duplicate property names per OBJECT LITERAL, with the shapes TS1117 itself
 * permits left alone. `setParentNodes` is on because the position lookup needs
 * it.
 */
function inspect(relPath: string, source: string, counts: Counts): Inspection {
    const sourceFile = ts.createSourceFile(
        relPath,
        source,
        ts.ScriptTarget.Latest,
        true,
        relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const findings: Finding[] = [];
    const importFindings: Finding[] = [];

    /**
     * Duplicate LOCAL BINDING names across the file's import declarations —
     * #2554, the sibling shape, from the same parse because two walks of the
     * same 2,350 files would be two parses for one question.
     *
     * The rule is the local binding name and nothing else. Measured with six
     * `tsc --noEmit` probes: `import type` buys no exemption (the same name
     * imported twice is TS2300 whether or not one is type-only), two imports
     * from ONE module are legal when the bindings differ, and a collision does
     * not require the same module — so keying on the specifier would be wrong
     * in both directions. `el.name` is the LOCAL name (the alias when `as` is
     * present); `el.propertyName` is what was imported, and is not the subject.
     *
     * Top-level statements only. An import inside an ambient `declare module`
     * block is a different scope, and `export … from` introduces no local
     * binding at all — a re-export collision is a separate question.
     */
    const seenImports = new Map<string, number>();
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        counts.importDecls += 1;
        const clause = statement.importClause;
        if (!clause) continue; // `import './side-effect'` binds nothing
        const locals: string[] = [];
        if (clause.name) locals.push(clause.name.text); // default import
        if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
                locals.push(clause.namedBindings.name.text);
            } else {
                for (const element of clause.namedBindings.elements) {
                    locals.push(element.name.text);
                }
            }
        }
        const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
        for (const local of locals) {
            counts.importBindings += 1;
            if (seenImports.has(local)) {
                importFindings.push({ file: relPath, line: line + 1, key: local });
            } else {
                seenImports.set(local, line + 1);
            }
        }
    }

    const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
            counts.literals += 1;
            // 'value' | 'get' | 'set' | 'both' — the kind is what separates a
            // legal accessor PAIR from a genuine redeclaration.
            const seen = new Map<string, string>();
            for (const prop of node.properties) {
                counts.properties += 1;
                if (ts.isSpreadAssignment(prop)) {
                    counts.spreads += 1;
                    continue;
                }
                const nameNode = prop.name;
                if (!nameNode) continue;
                if (ts.isComputedPropertyName(nameNode)) {
                    counts.computed += 1;
                    continue;
                }
                // `.text` normalises a string key to its VALUE, so `'a'` and
                // `a` collide exactly as TypeScript treats them.
                let key: string | null = null;
                if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) {
                    key = nameNode.text;
                } else if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
                    key = nameNode.text;
                }
                if (key === null) continue;

                const kind = ts.isGetAccessor(prop) ? 'get' : ts.isSetAccessor(prop) ? 'set' : 'value';
                const previous = seen.get(key);
                if (previous === undefined) {
                    seen.set(key, kind);
                    continue;
                }
                // A get/set PAIR on one name is legal; a second `value` on a
                // name that already has one is not. Both directions, because
                // the setter may be written first.
                const isAccessorPair =
                    (previous === 'get' && kind === 'set') || (previous === 'set' && kind === 'get');
                if (isAccessorPair) {
                    seen.set(key, 'both');
                    continue;
                }
                const { line } = sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile));
                findings.push({ file: relPath, line: line + 1, key });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { keys: findings, imports: importFindings };
}

/**
 * `scripts` and `prisma` are in here deliberately, and are the half nothing
 * else covers — see the measurement in the docblock.
 */
const ROOTS = ['src', 'scripts', 'prisma'] as const;
const POPULATION = collectSourceFiles({
    roots: ROOTS,
    extensions: ['.ts', '.tsx'],
    // REPLACES the default, which excludes `coverage` and `dist` BY NAME and so
    // would hide a real route. `generated` is kept IN: `route-inventory.json` is
    // data, but a generated `.ts` is still a declaration point.
    skipDirs: ['node_modules', '.next', 'coverage', 'dist'],
    floor: 2000,
});

const COUNTS: Counts = {
    literals: 0,
    properties: 0,
    computed: 0,
    spreads: 0,
    importDecls: 0,
    importBindings: 0,
};
const INSPECTED = POPULATION.map((abs) => {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    return inspect(rel, readFileSync(abs, 'utf8'), COUNTS);
});
const FINDINGS = INSPECTED.flatMap((i) => i.keys);
const IMPORT_FINDINGS = INSPECTED.flatMap((i) => i.imports);

const CONTROL_TS = 'tests/fixtures/duplicate-object-key-control.ts.fixture';
const CONTROL_ENV = 'tests/fixtures/duplicate-env-key-control.env.fixture';
const CONTROL_IMPORTS = 'tests/fixtures/duplicate-import-control.ts.fixture';

/**
 * A throwaway counter for a control run, so the live denominator is untouched.
 *
 * The control tests ASSERT on what it counted, and that is not decoration:
 * `selector-teeth` reported this selector SURVIVED its mutation
 * (`return [] | new Set() | new Map() | {}`) because nothing read the result.
 * Every one of those variants leaves `counts.x += 1` evaluating to NaN rather
 * than throwing, so the fixture could have been parsed as empty and every
 * control below would still have passed. Reading the counters is also the
 * better test on its own terms: it proves the fixture was parsed, which is
 * what the controls assume.
 */
const scratchCounts = (): Counts => ({
    literals: 0,
    properties: 0,
    computed: 0,
    spreads: 0,
    importDecls: 0,
    importBindings: 0,
});

/** `KEY=`, `export KEY=`, never a comment and never a value containing `=`. */
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
function duplicateEnvKeys(source: string): string[] {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const rawLine of source.split('\n')) {
        if (/^\s*#/.test(rawLine)) continue;
        const match = ENV_ASSIGNMENT.exec(rawLine);
        if (!match) continue;
        const key = match[1];
        if (seen.has(key)) dupes.push(key);
        else seen.add(key);
    }
    return dupes;
}

/**
 * Env templates come from GIT, not from a filesystem walk, and that is not a
 * stylistic preference — a walk got this wrong twice in one attempt.
 *
 * `roots: ['.', 'deploy']` double-counts, because walking `.` already descends
 * into `deploy`: the printed denominator read **9 templates with repeats**
 * where the repo has 8. And `.claude/worktrees/` holds 24 live worktrees, each
 * a full copy of the repo, so a walk that forgot to skip it would have
 * reported ~200 templates and asserted on a peer's uncommitted state. The
 * skipDirs list needed to grow by one directory per unrelated top-level
 * addition, and excluding `infra` to shrink it dropped
 * `infra/observability/.env.example` from the population entirely — a floor of
 * 5 happily passed over the miss.
 *
 * `collectTrackedFiles` answers the question actually being asked — which
 * templates does this REPOSITORY ship — and is immune to all three.
 */
const ENV_TEMPLATES = collectTrackedFiles({
    roots: ['.'],
    extensions: ['.example'],
    // 8 → 7: #2552 deleted `deploy/.env.prod.example`, which was the inherited
    // inflect-compliance AWS template (Secrets Manager, RDS, and a
    // `REDIS_SECRET_NAME` naming the sibling product) rather than an agrent
    // one. Lowered to the measured count, never raised — and this is the floor
    // whose own docblock records that "a floor of 5 happily passed over the
    // miss", so leaving slack here is the documented failure mode.
    floor: 7,
}).map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/'));

describe('no duplicate declarations — object keys and imports (#2537, #2554)', () => {
    it('ranges over a real population — not vacuously passing', () => {
        console.log(
            `[no-duplicate-keys] ${POPULATION.length} file(s) across ${ROOTS.join(', ')}; `
                + `${COUNTS.literals} object literal(s), ${COUNTS.properties} propert(ies)`,
        );
        console.log(
            `[no-duplicate-keys] deliberately not reported: ${COUNTS.spreads} spread(s), `
                + `${COUNTS.computed} computed key(s)`,
        );
        console.log(
            `[no-duplicate-keys] ${COUNTS.importDecls} import declaration(s), `
                + `${COUNTS.importBindings} local binding(s)`,
        );
        console.log(`[no-duplicate-keys] ${ENV_TEMPLATES.length} env template(s): ${ENV_TEMPLATES.join(', ')}`);
        expect(POPULATION.length).toBeGreaterThanOrEqual(2000);
        expect(COUNTS.literals).toBeGreaterThanOrEqual(15000);
        expect(COUNTS.properties).toBeGreaterThanOrEqual(40000);
        // 11,082 declarations / 15,302 local bindings measured on main. The
        // two numbers belong side by side: a detector keyed on the
        // DECLARATION — "two imports from the same module" — ranges over the
        // smaller one and over the wrong thing.
        expect(COUNTS.importDecls).toBeGreaterThanOrEqual(9000);
        expect(COUNTS.importBindings).toBeGreaterThan(COUNTS.importDecls);
        // 8 tracked templates today; a walk reported 9 with repeats (see above).
        // 8 → 7 with the floor above, same change and same reason (#2552):
        // `deploy/.env.prod.example` was the inherited inflect-compliance AWS
        // template, not an agrent one. TWO numbers had to move, which is the
        // thing to notice — the `floor` is enforced inside the collector and
        // this is enforced here, so lowering only one leaves the suite failing
        // at a line that looks unrelated to the deletion.
        expect(ENV_TEMPLATES.length).toBeGreaterThanOrEqual(7);
        expect(new Set(ENV_TEMPLATES).size).toBe(ENV_TEMPLATES.length);
    });

    it('covers scripts/ and prisma/, which tsc does not', () => {
        // The correction to #2537's premise. `exclude` suppresses root-file
        // discovery, so 34 of 51 scripts are in no program at all and a
        // duplicate key there is caught by nothing. Dropping either root from
        // ROOTS would silently give that half back.
        expect(ROOTS).toContain('scripts');
        expect(ROOTS).toContain('prisma');
        const byRoot = Object.fromEntries(
            ROOTS.map((r) => [
                r,
                POPULATION.filter((p) => path.relative(REPO_ROOT, p).split(path.sep)[0] === r).length,
            ]),
        );
        console.log(`[no-duplicate-keys] by root: ${JSON.stringify(byRoot)}`);
        expect(byRoot.scripts).toBeGreaterThanOrEqual(40);
        expect(byRoot.prisma).toBeGreaterThanOrEqual(1);
    });

    it('REPORTS the duplicates in the control file, parsed the same way', () => {
        // A real file through the same `inspect()`. The population is healthy,
        // so without this the assertion below passes for free the moment the
        // walker stops matching.
        const source = readFileSync(path.join(REPO_ROOT, CONTROL_TS), 'utf8');
        const counts = scratchCounts();
        const found = inspect(CONTROL_TS, source, counts).keys;
        const keys = found.map((f) => f.key).sort();
        expect(keys).toEqual(['AV_SCAN_MODE', 'DOCUMENT_STORAGE_LIMIT_BYTES', 'inner']);
        // The fixture was really PARSED — 10 object literals / 22 properties
        // measured. Without this, a counter object that stopped counting (or a
        // parse that found nothing) leaves the assertion above passing over an
        // empty result set.
        expect(counts.literals).toBeGreaterThanOrEqual(10);
        expect(counts.properties).toBeGreaterThanOrEqual(22);
        // And the file still CONTAINS them, so a tidy-up that removes the
        // control fails loudly instead of disarming it.
        expect(source).toContain('DOCUMENT_STORAGE_LIMIT_BYTES');
        expect(source.match(/DOCUMENT_STORAGE_LIMIT_BYTES/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT report the three legal shapes, which is the other boundary', () => {
        // A control that only proves the detector FIRES can still be aimed one
        // level off: a walker keyed on the FILE rather than the LITERAL reports
        // `firstLiteral`/`secondLiteral`, and one ignoring property KIND
        // reports the accessor pair. Both are in the fixture.
        const source = readFileSync(path.join(REPO_ROOT, CONTROL_TS), 'utf8');
        const found = inspect(CONTROL_TS, source, scratchCounts()).keys;
        const keys = found.map((f) => f.key);
        expect(keys).not.toContain('plan'); // same key, two different literals
        expect(keys).not.toContain('timeout'); // explicit key overriding a spread
        expect(keys).not.toContain('value'); // get/set accessor pair
        expect(keys).not.toContain('EUR'); // two computed keys
    });

    it('no object literal in src/, scripts/ or prisma/ declares a key twice', () => {
        expect(FINDINGS.map((f) => `${f.file}:${f.line}  duplicate key \`${f.key}\``)).toEqual([]);
    });

    it('no env template assigns a key twice', () => {
        const offenders = ENV_TEMPLATES.flatMap((rel) => {
            const dupes = duplicateEnvKeys(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
            return dupes.map((key) => `${rel}  duplicate key \`${key}\``);
        });
        expect(offenders).toEqual([]);
    });

    it('REPORTS every duplicate local binding in the import control, parsed the same way', () => {
        // Four shapes TypeScript refuses, each measured with `tsc --noEmit`
        // rather than reasoned — see the fixture's docblock for the table.
        const source = readFileSync(path.join(REPO_ROOT, CONTROL_IMPORTS), 'utf8');
        const counts = scratchCounts();
        const found = inspect(CONTROL_IMPORTS, source, counts).imports;
        // 17 declarations / 17 local bindings measured. Equal here because
        // every import in the fixture carries exactly one binding — which is
        // why the live denominator's `bindings > declarations` assertion
        // belongs there and not on this fixture.
        expect(counts.importDecls).toBeGreaterThanOrEqual(17);
        expect(counts.importBindings).toBeGreaterThanOrEqual(17);
        expect(found.map((f) => f.key).sort()).toEqual([
            'EXCHANGE_CURRENCY', // the #2554 instance: same binding, same module, twice
            'Tenant', //            `import type` buys no exemption — still TS2300
            'logger', //            a default colliding with a named binding
            'shared', //            two aliases onto one local, from DIFFERENT modules
        ]);
        // And the fixture still carries them, so a tidy-up fails loudly
        // instead of disarming the control.
        expect(source.match(/EXCHANGE_CURRENCY/g)?.length).toBeGreaterThanOrEqual(3);
    });

    it('does NOT report the legal import shapes — the other boundary', () => {
        // A control proving only that the detector FIRES can be aimed one
        // level off. Flagging any of these would get the guard baselined
        // rather than the defect fixed, because all four are ordinary.
        const source = readFileSync(path.join(REPO_ROOT, CONTROL_IMPORTS), 'utf8');
        const keys = inspect(CONTROL_IMPORTS, source, scratchCounts()).imports.map((f) => f.key);
        expect(keys).not.toContain('writeFile'); // two bindings, one module
        expect(keys).not.toContain('parcelArea'); // type-only beside a value
        expect(keys).not.toContain('second'); // aliased APART — locals differ
        expect(keys).not.toContain('join'); // namespace beside a named import
        expect(keys).not.toContain('CURRENCY'); // `export … from` binds nothing
    });

    it('no file in src/, scripts/ or prisma/ imports the same binding twice', () => {
        expect(
            IMPORT_FINDINGS.map((f) => `${f.file}:${f.line}  duplicate import binding \`${f.key}\``),
        ).toEqual([]);
    });

    it('REPORTS a duplicate in the env control file, and reads the awkward lines right', () => {
        const source = readFileSync(path.join(REPO_ROOT, CONTROL_ENV), 'utf8');
        expect(duplicateEnvKeys(source)).toEqual(['AV_SCAN_MODE']);
        // A dotenv loader keeps the LAST assignment, so the `export` form has
        // to be read as a key (a naive `^KEY=` misses it) and a value that
        // merely contains `=` must not be read as a second one.
        expect(source).toContain('export PLATFORM_TENANT_SLUG=');
        expect(source).toContain('SMTP_OPTS=user=a;pass=b');
        expect(duplicateEnvKeys(source)).not.toContain('pass');
    });
});
