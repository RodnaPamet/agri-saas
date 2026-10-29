/**
 * No tracked text file carries a raw NUL byte — #2446.
 *
 * ## Why this is worth a guard rather than care
 *
 * `grep` on a developer machine here is **ugrep**, which classifies a file
 * containing a NUL as BINARY and skips it silently: no match, no warning,
 * exit 0. One NUL anywhere therefore makes the file invisible to every
 * grep-based tool, for every pattern. Three things stop working at once:
 *
 *   - **`scripts/detect-secrets.sh`** — the pre-commit secret scan runs
 *     `grep -nP`, so the file is exempt from it entirely. Measured with a
 *     positive control: the same planted AWS-key-shaped string is found in a
 *     clean file (1) and not found in a NUL-bearing copy (0), while Node reads
 *     it in both. The `Security` gate in CI uses `readFileSync` and is NOT
 *     blinded, so the backstop holds — but a first layer that silently exempts
 *     a file is worse than one that fails loudly.
 *   - **`file(1)`** reports the file as `data`.
 *   - **every ad-hoc `grep -r`** over the tree, which is how this was found at
 *     all: a grep for a string the file demonstrably contained returned
 *     nothing, on a direct file argument.
 *
 * Git is unaffected (`--numstat` counted the lines rather than printing a
 * dash), so diffs and review stay readable — which is precisely why nobody
 * notices.
 *
 * It arose from ordinary authoring, not carelessness: two NULs reached
 * `contentFingerprint`'s template literal in the #2020 calendar client, where
 * a terminal renders them as nothing, `tsc` accepts them and jest runs the
 * file fine. Nothing in the repo said the file had gone dark. A rule that
 * depends on noticing an invisible character is not a rule.
 *
 * ## Where a NUL is genuinely wanted
 *
 * As a hash field separator it is the right choice — it cannot occur in the
 * inputs, so the digest is unambiguous and `{a: 'x y', b: 'z'}` cannot collide
 * with `{a: 'x', b: 'y z'}`. Write it as the escape sequence, which is
 * identical at runtime and leaves the source as text. That is what
 * `contentFingerprint` does now.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT, resolveScanRoots } from './_helpers/scan-roots';

/** Built, not typed, so this file cannot be the thing it forbids. */
const NUL = String.fromCharCode(0);

/**
 * Extensions whose files are TEXT and therefore must not contain a NUL.
 *
 * An allowlist rather than a binary-extension denylist: the repo tracks real
 * binaries (woff2, png, the 38-byte vector-tile fixture) and a forgotten
 * denylist entry fails this guard on a legitimate file, while a forgotten
 * allowlist entry costs only coverage of one extension — and the denominator
 * printed below is what makes that visible.
 */
const TEXT_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.sh',
    '.yml', '.yaml', '.css', '.prisma', '.sql', '.html', '.txt', '.snap', '.env',
]);

const ROOTS = ['src', 'tests', 'scripts', 'messages', 'prisma', 'deploy', 'docs'];

/**
 * One floor, used BOTH as `resolveScanRoots`'s `minFiles` and as the printed
 * reading's assertion — deliberately one constant rather than two, so there is
 * no second number to drift against the first.
 *
 * Measured 5,964 text files of 5,984 tracked (2026-10-29). Set well below that
 * on purpose: this is a COLLAPSE detector, not a tight ratchet. The population
 * is "every tracked text file", which grows steadily, so a floor within a few
 * percent would redden on ordinary churn and teach people to raise it without
 * reading it — the failure mode [[a-gate-narrow-enough-to-always-pass]] warns
 * about from the other direction.
 *
 * **What this floor does NOT catch, stated rather than implied:** lowering it.
 * At a live count of 5,964 any floor below that passes, so the mutation
 * "set the floor to 0" survives — no floor can detect its own slack without a
 * drift allowance or a base-delta, and both cost churn this population would
 * generate weekly. What IS mutation-caught is every realistic failure: a
 * detector that cannot say yes, a detector that always says yes, a population
 * narrowed to nothing, and a raw NUL returning to a real source file. The
 * primary teeth are `resolveScanRoots` itself, which THROWS when any root
 * matches no tracked files — a rename, which is how this class of guard
 * actually dies.
 */
const TEXT_FILE_FLOOR = 5000;

/** Does this text carry a raw NUL? The detector, isolated so it can be proved. */
function hasRawNul(text: string): boolean {
    return text.includes(NUL);
}

describe('no tracked text file carries a raw NUL byte (#2446)', () => {
    // `resolveScanRoots` THROWS when a root contributes nothing, which is what
    // keeps this from passing over an empty population after a rename.
    const { files, perRoot } = resolveScanRoots(ROOTS, { minFiles: TEXT_FILE_FLOOR });
    const scanned = files.filter((f) => TEXT_EXTENSIONS.has(path.extname(f)));

    it('[nul-byte-scan] prints its denominator', () => {
        // A READING, not a gate — the floor below is what fails the build.
        // Printed because a population quietly shrinking while staying above
        // its floor is the failure this convention exists to surface.
        const byRoot = Object.entries(perRoot)
            .map(([r, n]) => `${r}=${n}`)
            .join(' ');
        console.log(`[nul-byte-scan] ${scanned.length} text files of ${files.length} tracked · ${byRoot}`);
        expect(scanned.length).toBeGreaterThan(TEXT_FILE_FLOOR);
    });

    it('finds none', () => {
        // Read as BYTES and decode latin1, so a NUL survives into the string.
        // `readFileSync(f, 'utf8')` would also keep it, but going through
        // bytes says plainly that this is a question about bytes.
        const offenders = scanned.filter((rel) =>
            hasRawNul(fs.readFileSync(path.join(REPO_ROOT, rel)).toString('latin1')),
        );
        expect(offenders).toEqual([]);
    });

    it('POSITIVE CONTROL: the detector flags a NUL and spares a clean file', () => {
        // Without this, "finds none" is satisfied by a detector that can never
        // say yes — and a detector over a correct population that cannot
        // express failure is the exact shape of guard this repo keeps finding.
        expect(hasRawNul(`const a = 1;${NUL}`)).toBe(true);
        expect(hasRawNul('const a = 1;')).toBe(false);
        // And the escape sequence — six printable characters — must NOT trip
        // it, or the sanctioned way to write a NUL would be unavailable.
        expect(hasRawNul('const a = `x' + String.fromCharCode(92) + 'u0000y`;')).toBe(false);
    });
});
