/**
 * Dependency risk-review ratchet.
 *
 * `docs/dependency-risk-review.md` is a periodic security review of
 * dependencies with CVE-active history or a large blast radius. The
 * review verdict for each package is: which `package.json` section
 * it belongs in, and which major it must stay on.
 *
 * This guard locks that verdict structurally. If a future change:
 *
 *   - moves a reviewed runtime package into `devDependencies`
 *     (the `Dockerfile`'s `npm prune --omit=dev` would strip it
 *     from the production image → prod crash CI can't catch), or
 *   - drops a reviewed package entirely, or
 *   - changes its major in EITHER direction,
 *
 * the guard fails and points the author back at the review doc.
 *
 * It does NOT pin exact versions — in-major patch/minor bumps stay
 * free. It enforces the section + the exact reviewed major, which
 * is the part the review actually reasoned about.
 *
 * The major is a PIN, not a floor, and deliberately so: the review
 * reasons about a specific major's API and threat surface, so the
 * next major invalidates the verdict just as surely as a downgrade
 * does. A dependabot major bump landing silently is the outcome
 * this guard exists to prevent — the bump must arrive WITH a
 * re-review, in one diff.
 *
 * This docstring used to describe the rule as a "major floor" while
 * the assertion below was, and remains, an equality check. The
 * prose was wrong, not the code; it is recorded here because a
 * rationale that has been wrong once will be reworded into fiction
 * again unless it carries its own history. (Corrected 2026-07-28,
 * when the js-yaml v5 review made the contradiction load-bearing.)
 *
 * When a new package is audited, add it to REVIEWED in the same
 * diff that adds its section to docs/dependency-risk-review.md.
 * When a reviewed package moves major, update BOTH in one diff.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

/**
 * The reviewed RUNTIME dependencies, with the major they must stay on.
 * Section is always `dependencies` — each was proven runtime-needed in
 * docs/dependency-risk-review.md, so moving one to devDependencies is a
 * production-image regression.
 */
const REVIEWED: Record<string, { major: number }> = {
    jszip: { major: 3 },
    pdfkit: { major: 0 },
    nodemailer: { major: 9 },
};

/**
 * Reviewed packages that are DEV-ONLY, with the major they must stay on.
 *
 * `js-yaml` moved here when its last production call site went. It was
 * runtime-needed while three modules parsed YAML on the server —
 * `mapping-set-importer.ts` (gone in GRC teardown phase 2),
 * `prisma/catalog-loader.ts` (phase 3) and
 * `src/app-layer/libraries/library-loader.ts` (gone with the
 * framework-library subsystem). Nothing in `src/` imports it now; the only
 * consumers are `tests/guards/*` YAML lint.
 *
 * The direction is asserted BOTH ways: a dev-only reviewed package that
 * reappears in `dependencies` is as much a regression as a runtime one
 * that leaks out — it would put a package back into the production image
 * without a review saying why.
 */
const REVIEWED_DEV_ONLY: Record<string, { major: number }> = {
    'js-yaml': { major: 5 },
};

/**
 * Every TypeScript source file under `src/` — the CANDIDATE SET the
 * production-importer check classifies.
 *
 * Split out of the assertion so a positive control can require it to be
 * non-empty. `expect(hits).toEqual([])` is satisfied by a walk that selects
 * nothing at all, so the candidate set has to be observable on its own.
 *
 * `withFileTypes` rather than a `statSync` probe followed by a read: the entry
 * type comes from the SAME directory read, so there is no check-then-use
 * window. CodeQL flags the probe form as `js/file-system-race` (high), and it
 * is right to — the file it stat'd need not be the file it then reads.
 */
function sourceFiles(dir: string = path.join(ROOT, 'src')): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.tsx?$/.test(e.name)) out.push(full);
        }
    };
    walk(dir);
    return out;
}

/**
 * Which of `files` import `name`. `readFile` is a parameter so the positive
 * control can inject the defect into a REAL file's REAL bytes while the file
 * LIST still comes from the live walk above.
 */
function productionImporters(
    name: string,
    files: string[],
    readFile: (f: string) => string = (f) => fs.readFileSync(f, 'utf8'),
): string[] {
    return files
        .filter((f) => readFile(f).includes(`'${name}'`))
        .map((f) => f.replace(ROOT + '/', ''));
}

/** Major of a caret/tilde/plain semver range (`^8.0.7` → 8). */
function rangeMajor(range: string): number {
    const m = range.match(/(\d+)\./);
    if (!m) throw new Error(`unparseable version range: ${range}`);
    return Number(m[1]);
}

describe('dependency risk review — reviewed packages stay classified', () => {
    for (const [name, { major }] of Object.entries(REVIEWED)) {
        it(`${name} stays a runtime dependency`, () => {
            expect(pkg.dependencies?.[name]).toBeDefined();
            // Must NOT have leaked into devDependencies — npm prune
            // --omit=dev in the Dockerfile would strip it from prod.
            expect(pkg.devDependencies?.[name]).toBeUndefined();
        });

        it(`${name} stays on its reviewed major (${major})`, () => {
            const range = pkg.dependencies?.[name];
            expect(range).toBeDefined();
            expect(rangeMajor(range as string)).toBe(major);
        });
    }

    for (const [name, { major }] of Object.entries(REVIEWED_DEV_ONLY)) {
        it(`${name} stays dev-only`, () => {
            expect(pkg.devDependencies?.[name]).toBeDefined();
            expect(pkg.dependencies?.[name]).toBeUndefined();
        });

        it(`${name} stays on its reviewed major (${major})`, () => {
            const range = pkg.devDependencies?.[name];
            expect(range).toBeDefined();
            expect(rangeMajor(range as string)).toBe(major);
        });

        it(`${name} has no production importer`, () => {
            // The condition that justified the move. If a `src/` file starts
            // importing it again, the classification has to be revisited —
            // the production image no longer ships it.
            const hits = productionImporters(name, sourceFiles());
            expect({ productionImporters: hits }).toEqual({ productionImporters: [] });
        });

        it(`the ${name} importer walk actually selects sources (guard is not vacuous)`, () => {
            // The assertion above passes over an empty candidate set. This is
            // the set it is required to have walked — the live `src/` tree.
            const files = sourceFiles();
            expect(files.length).toBeGreaterThan(500);
            expect(files.every((f) => /\.tsx?$/.test(f))).toBe(true);
        });

        it(`an injected ${name} importer in the REAL src tree is selected`, () => {
            // The defect injected into production input rather than a fixture:
            // the file list is the live walk, and ONE real file's real bytes
            // gain the import that would put the package back in the image.
            const files = sourceFiles();
            const target = [...files].sort()[0];
            expect(target).toBeDefined();

            const injected = (f: string) => {
                const src = fs.readFileSync(f, 'utf8');
                return f === target ? `${src}\nimport _probe from '${name}';\n` : src;
            };
            expect(productionImporters(name, files, injected)).toEqual([
                target.replace(ROOT + '/', ''),
            ]);
        });
    }

    it('the review doc exists alongside this guard', () => {
        expect(
            fs.existsSync(path.join(ROOT, 'docs/dependency-risk-review.md')),
        ).toBe(true);
    });
});
