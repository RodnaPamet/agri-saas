/**
 * Guard: nothing in the type system depends on an OPTIONAL package (#1392).
 *
 * ## The failure this prevents
 *
 * `onnxruntime-node` is a platform-specific native addon in
 * `optionalDependencies`, so `npm ci` is free to skip it. When it does, `tsc`
 * cannot resolve the package and `Typecheck` fails:
 *
 *     src/app-layer/ai/vision/onnx-provider.ts(20,47): error TS2307:
 *       Cannot find module 'onnxruntime-node' or its corresponding type declarations.
 *
 * It fired on #1385, a **docs-only** PR, which is the only reason anybody
 * looked. Across the six `main` runs before that, Typecheck failed zero times
 * — so this is not a standing breakage but an install that usually succeeds,
 * landing at random on whoever happens to be pushing.
 *
 * That makes it worse than a hard failure, not better. A re-run clears it, and
 * the lesson a re-run teaches is to re-run.
 *
 * ## Why it is easy to get wrong, and what this guard actually checks
 *
 * The code was already right about the RUNTIME — the import was dynamic, so
 * nothing was pulled in for callers that only wanted the types. What nobody
 * accounted for is that **the types share the package's fate**: a type-only
 * import still needs the package on disk at compile time.
 *
 * The issue named one line. Reproducing the state — moving
 * `node_modules/onnxruntime-node` aside and running the real typecheck — found
 * THREE:
 *
 *     (20,47)  import type { … } from 'onnxruntime-node'
 *     (106,57) Promise<typeof import('onnxruntime-node')>
 *     (108,29) await import('onnxruntime-node')
 *
 * A dynamic `import()` is still statically resolved when its specifier is a
 * literal. That it runs late says nothing about when it is TYPED, and fixing
 * only the first would have left the build failing in exactly the same
 * intermittent way while looking correct. So this guard bans all three forms
 * rather than the one that was reported.
 *
 * ## Both questions
 *
 * The population is DERIVED from `package.json`'s `optionalDependencies`, not
 * listed, so a newly-optional package is in scope the moment it is made
 * optional. And the suite asserts the population is non-empty — with no
 * optional dependencies there is nothing to check, and that must look
 * different from "checked and clean".
 *
 * **Both of those count inputs, and neither touches the DETECTOR.** That gap
 * shipped: gutting `formsFor()` to `return []` left every assertion in this
 * file green, so the guard could not fail — measured by
 * `scripts/selector-teeth.mjs` on the push run after #1454 merged, having also
 * failed on #1454's own head commit where nobody was reading non-required
 * checks. Two denominators over the inputs and none over the selector is the
 * empty-selection defect this guard's own docblock is about, one level up.
 * The third control closes it, and anchors on real bytes rather than a
 * synthetic fixture — see the test for why that anchor exists at all.
 *
 * The escape hatch is a non-literal specifier: `import(ID)` where `ID` is
 * typed `string` is not resolved by the compiler and yields `any`. That is
 * what `onnx-provider.ts` does now, and the guard permits it because it is the
 * mechanism, not a loophole.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const REPO = process.cwd();

/** Optional packages, read from the manifest so the population cannot drift. */
function optionalPackages(): string[] {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
        optionalDependencies?: Record<string, string>;
    };
    return Object.keys(pkg.optionalDependencies ?? {});
}

interface Offence {
    file: string;
    pkg: string;
    form: string;
    line: number;
}

/** The three forms `tsc` must resolve, in order of how obvious they are. */
function formsFor(pkg: string): Array<{ label: string; re: RegExp }> {
    const q = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
        { label: "import type … from '<pkg>'", re: new RegExp(`import\\s+type\\s[^;]*?from\\s*['"]${q}['"]`, 'g') },
        { label: "import … from '<pkg>' (static)", re: new RegExp(`import\\s+(?!type\\s)[^;]*?from\\s*['"]${q}['"]`, 'g') },
        { label: "typeof import('<pkg>')", re: new RegExp(`typeof\\s+import\\(\\s*['"]${q}['"]\\s*\\)`, 'g') },
        { label: "import('<pkg>') with a literal specifier", re: new RegExp(`(?<!typeof\\s)import\\(\\s*['"]${q}['"]\\s*\\)`, 'g') },
    ];
}

describe('an optional dependency does not gate Typecheck (#1392)', () => {
    const optional = optionalPackages();
    const files = collectSourceFiles({
        roots: ['src', 'scripts'],
        extensions: ['.ts', '.tsx'],
        exclude: (rel) => rel.startsWith('src/generated/'),
        // 2000+ at the time of writing; a floor near reality catches an
        // exclude predicate that ate the tree rather than reporting it clean.
        floor: 1500,
    });

    const offences: Offence[] = [];
    beforeAll(() => {
        for (const full of files) {
            // Comments blanked so a docblock EXPLAINING the banned form — this
            // guard's own subject matter, and `onnx-provider.ts` now carries
            // exactly such a docblock quoting all three — is not read as the
            // form itself. Strings are kept: the module specifier IS a string.
            const code = blankNonCode(readFileSync(full, 'utf8'));
            for (const pkg of optional) {
                for (const { label, re } of formsFor(pkg)) {
                    for (const m of code.matchAll(re)) {
                        offences.push({
                            file: relative(REPO, full),
                            pkg,
                            form: label,
                            line: code.slice(0, m.index).split('\n').length,
                        });
                    }
                }
            }
        }
    });

    it('the FORM regexes can actually select — the control formsFor() needs', () => {
        // The two denominators below count files and packages. Neither touches
        // `formsFor`, so gutting it to `return []` left every assertion in this
        // file passing — measured by `scripts/selector-teeth.mjs`, which
        // reported the selector dead on the push run AFTER #1454 merged. The
        // guard could not have failed, which is the defect its own docblock is
        // about: an empty selection is a PASS.
        //
        // The control cannot look for a real offence, because a clean tree has
        // none and that is the point of the guard. It anchors on the one place
        // in the real population where the banned forms DO occur as bytes:
        // `onnx-provider.ts`'s docblock quotes `typeof import('onnxruntime-node')`
        // and `await import('onnxruntime-node')` while explaining why neither
        // may appear as code. So the forms must match the RAW file and must not
        // match the BLANKED one — which proves two things at once, on real bytes
        // from the tree this guard scans: the regexes select, and the
        // comment-blanking is what makes the file clean rather than luck.
        const PROVIDER = join(REPO, 'src/app-layer/ai/vision/onnx-provider.ts');
        const raw = readFileSync(PROVIDER, 'utf8');
        const forms = formsFor('onnxruntime-node');

        const countIn = (text: string): number =>
            forms.reduce((n, { re }) => n + [...text.matchAll(re)].length, 0);

        expect(forms.length).toBeGreaterThanOrEqual(4);
        // The docblock quotes two of the banned forms verbatim.
        expect(countIn(raw)).toBeGreaterThanOrEqual(2);
        // And they are reachable only because they are comments.
        expect(countIn(blankNonCode(raw))).toBe(0);
    });

    it('there ARE optional dependencies to check — the denominator', () => {
        // With none, every assertion below is vacuous, and that state must not
        // read the same as a clean one.
        expect(optional.length).toBeGreaterThan(0);
        expect(optional).toContain('onnxruntime-node');
        expect(files.length).toBeGreaterThan(1500);
    });

    it('no module reference forces the compiler to resolve an optional package', () => {
        if (offences.length) {
            throw new Error(
                `${offences.length} compile-time reference(s) to an optional package:\n\n` +
                    offences
                        .map((o) => `    ${o.file}:${o.line}  ${o.pkg}  —  ${o.form}`)
                        .join('\n') +
                    `\n\nnpm MAY SKIP an optional dependency and still report success, so ` +
                    `every form above makes Typecheck fail at random on unrelated PRs ` +
                    `(#1392). A type-only import is not exempt: the types share the ` +
                    `package's fate. Nor is a dynamic import with a literal specifier — ` +
                    `the compiler resolves that too.\n\n` +
                    `Declare the slice of the API you use as a local interface, and load ` +
                    `the module through a \`string\`-typed id so the specifier is not a ` +
                    `literal:\n\n` +
                    `    const MODULE_ID: string = '<pkg>';\n` +
                    `    const mod = (await import(MODULE_ID)) as MyLocalShape;\n\n` +
                    `See src/app-layer/ai/vision/onnx-provider.ts. Do NOT move the package ` +
                    `to \`dependencies\` — it is optional because it is a large ` +
                    `platform-specific binary whose absence the feature already handles.`,
            );
        }
    });
});
