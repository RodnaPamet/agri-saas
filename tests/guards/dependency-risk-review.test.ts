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
 * The reviewed runtime dependencies, with the major they must stay
 * on. Section is always `dependencies` — every entry here was proven
 * to be runtime-needed in docs/dependency-risk-review.md, so moving
 * any to devDependencies is a production-image regression.
 */
const REVIEWED: Record<string, { major: number }> = {
    'js-yaml': { major: 5 },
    jszip: { major: 3 },
    pdfkit: { major: 0 },
    nodemailer: { major: 9 },
};

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

    it('the review doc exists alongside this guard', () => {
        expect(
            fs.existsSync(path.join(ROOT, 'docs/dependency-risk-review.md')),
        ).toBe(true);
    });
});
