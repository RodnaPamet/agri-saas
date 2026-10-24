/**
 * `merge-main-regenerating.sh` re-applies a dependency delta without
 * reformatting the lockfile — #2253.
 *
 * ## The defect
 *
 * That script exists to protect `package-lock.json` from a full `npm install`,
 * whose glibc-host rewrite drops all 34 `libc` platform entries. Its header
 * documents that measurement. It then wrote the file back with
 * `JSON.stringify(lock, null, 2)` while the file is indented with **four**
 * spaces — so the tool written to avoid a whole-file rewrite performed one,
 * reflowing every line and tripping
 * `tests/guards/lockfile-formatting-is-pinned.test.ts`, the guard written for
 * exactly that.
 *
 * Measured, re-applying one dependency onto the real lockfile:
 *
 * ```
 *                indent  libc   bytes      changed lines
 *   fixed        4       34     1,188,244        1 to 3
 *   old (null,2) 2       34     1,009,988        56,769
 * ```
 *
 * 1 or 3 depending only on where the new name SORTS: a dependency that lands
 * last also puts a trailing comma on the entry it displaced, which is a fact
 * about JSON and not about formatting. `libc` survives both, because a
 * surgical JSON patch is not what drops it — a full `npm install` is.
 *
 * It had never fired because the block exits early whenever a main merge
 * brings no dependency delta, which is the common case. A latent bug on the
 * uncommon path is one nobody has a reason to look for.
 *
 * ## Why this EXECUTES the block instead of reading it
 *
 * The property is "writing this file does not reformat it", which is about
 * bytes. A source assertion — "the script does not contain `null, 2`" — would
 * pass against a script that reads the indent and then ignores it, and would
 * fail on a harmless mention in a comment. So the block is extracted from the
 * shell script and run against copies of the REAL `package.json` and
 * `package-lock.json`, in a temp directory, with a dependency delta that is
 * not in either file.
 *
 * Extraction is asserted non-vacuous: there are two `node -e` blocks in that
 * script and the first one computes the delta. Picking the wrong one produced
 * a run that changed nothing and reported zero diff lines, which reads
 * identically to a perfect pass.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/merge-main-regenerating.sh');

/**
 * The RE-APPLY block, not the delta-computing one.
 *
 * Anchored on a line only the re-apply block has, then widened to the nearest
 * enclosing `node -e '`. Both guards below assert the extraction, because an
 * extraction that silently takes the wrong block makes every assertion here
 * pass over a program that does nothing.
 */
function reapplyBlock(): string {
    const shell = fs.readFileSync(SCRIPT, 'utf8');
    const marker = 'const added = JSON.parse(process.argv[1]);';
    const at = shell.indexOf(marker);
    if (at < 0) throw new Error(`${SCRIPT} no longer contains the re-apply block's argv marker`);
    const open = shell.lastIndexOf("node -e '", at);
    const close = shell.indexOf('\' "$ADDED_DEPS"', at);
    if (open < 0 || close < 0) throw new Error('could not bound the re-apply block');
    return shell.slice(open + "node -e '".length, close);
}

/** Copy the real manifests into a temp dir and run the block over them. */
function runReapply(delta: [string, string][]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-'));
    for (const f of ['package.json', 'package-lock.json']) {
        fs.copyFileSync(path.join(REPO_ROOT, f), path.join(dir, f));
    }
    // `node -e`, exactly as the script invokes it — under `node file.js arg`,
    // `process.argv[1]` is the FILE, so running it as a script would feed the
    // program its own path and throw on JSON.parse.
    const out = execFileSync('node', ['-e', reapplyBlock(), JSON.stringify(delta)], {
        cwd: dir,
        encoding: 'utf8',
    });
    const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
    const result = { out, pkg: read('package.json'), lock: read('package-lock.json') };
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
}

const indentOf = (text: string) => /^([ \t]*)\S/.exec(text.split('\n')[1] ?? '')?.[1].length ?? -1;
const countLibc = (text: string) => (text.match(/"libc"/g) ?? []).length;
/** Lines present in one and not the other, in both directions. */
function changedLines(before: string, after: string): number {
    const a = before.split('\n');
    const b = after.split('\n');
    const bag = new Map<string, number>();
    for (const l of a) bag.set(l, (bag.get(l) ?? 0) + 1);
    let added = 0;
    for (const l of b) {
        const n = bag.get(l) ?? 0;
        if (n === 0) added += 1;
        else bag.set(l, n - 1);
    }
    const removed = [...bag.values()].reduce((s, n) => s + n, 0);
    return added + removed;
}

const ORIGINAL_PKG = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
const ORIGINAL_LOCK = fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8');
const DELTA: [string, string][] = [['zzz-regen-probe', '^9.9.9']];

describe('merge-main-regenerating re-apply (#2253)', () => {
    it('extracts the RE-APPLY block, not the delta-computing one', () => {
        // The control over this whole file. The first `node -e` block in that
        // script shells out to git; running it instead of the re-apply block
        // changes nothing and reports a clean diff.
        const block = reapplyBlock();
        expect(block).toContain('assertRoundTrips');
        expect(block).toContain('libcBefore');
        expect(block).not.toContain('git merge-base');
        expect(block).not.toContain('execSync');
    });

    it('the manifests this guards really are 4-space indented', () => {
        // The premise. If npm ever starts writing 2, the assertions below
        // should change with it rather than keep asserting a stale number —
        // which is why the script reads the indent instead of pinning it.
        expect(indentOf(ORIGINAL_PKG)).toBe(4);
        expect(indentOf(ORIGINAL_LOCK)).toBe(4);
    });

    it('re-applying one dependency leaves every other line BYTE-identical', () => {
        // The exact property, rather than a line count. Counting lines is
        // sort-position dependent: a probe that sorts LAST also puts a
        // trailing comma on the previously-last entry, so the honest count is
        // 3 and not 1 — which is a fact about JSON commas, not about
        // reformatting.
        //
        // So: drop the probe's own line and normalise trailing commas, and the
        // result must be the original file byte for byte. That admits the
        // comma churn an insertion legitimately causes and admits nothing
        // else — a reflow fails it at the first line.
        const { pkg, lock } = runReapply(DELTA);
        const normalise = (t: string) =>
            t
                .split('\n')
                .filter((l) => !l.includes('zzz-regen-probe'))
                .map((l) => l.replace(/,$/, ''))
                .join('\n');
        expect(normalise(pkg)).toBe(normalise(ORIGINAL_PKG));
        expect(normalise(lock)).toBe(normalise(ORIGINAL_LOCK));
    });

    it('and the churn is bounded to the insertion itself', () => {
        // The denominator beside the claim. 3 is one added line plus the
        // comma flip on the entry it displaced from last position; the bug
        // this guards produced 56,769.
        const { pkg, lock } = runReapply(DELTA);
        expect(changedLines(ORIGINAL_PKG, pkg)).toBeLessThanOrEqual(3);
        expect(changedLines(ORIGINAL_LOCK, lock)).toBeLessThanOrEqual(3);
    });

    it('the one line is the dependency, in both files', () => {
        // So "one line changed" cannot be satisfied by changing the wrong one.
        const { pkg, lock } = runReapply(DELTA);
        expect(pkg).toContain('"zzz-regen-probe": "^9.9.9"');
        expect(lock).toContain('"zzz-regen-probe": "^9.9.9"');
    });

    it('preserves the indent rather than pinning one', () => {
        const { pkg, lock, out } = runReapply(DELTA);
        expect(indentOf(pkg)).toBe(4);
        expect(indentOf(lock)).toBe(4);
        // And says so, because a silent correct answer and a silent wrong one
        // look the same in a log.
        expect(out).toContain('at indent 4/4');
    });

    it('preserves every libc platform entry, and reports the count', () => {
        // The reason this script exists instead of `npm install`. 34 on a
        // glibc host today; asserted against the file rather than the
        // constant so a legitimate dependency change moves both together.
        //
        // NOTE ON COVERAGE, because the mutation sweep found it: the script
        // also carries its own `libc !== libcBefore` tripwire, and disabling
        // that tripwire fails NOTHING here. That is not a gap in this test —
        // it is that a surgical JSON patch cannot drop a `libc` key by
        // construction, so no input reachable through this surface makes the
        // tripwire fire. Its value is against a FUTURE edit that rebuilds
        // `lock.packages` instead of patching it, which is exactly how a full
        // `npm install` loses them. Stated rather than left looking covered.
        const { lock, out } = runReapply(DELTA);
        expect(countLibc(lock)).toBe(countLibc(ORIGINAL_LOCK));
        expect(out).toContain(`libc entries preserved: ${countLibc(ORIGINAL_LOCK)}`);
    });

    it('does nothing at all when there is no delta', () => {
        const { pkg, lock, out } = runReapply([]);
        expect(out).toContain('no dependency delta to re-apply');
        expect(pkg).toBe(ORIGINAL_PKG);
        expect(lock).toBe(ORIGINAL_LOCK);
    });

    it('REFUSES to write a file its serialiser cannot reproduce', () => {
        // The round-trip control inside the script. A measured indent is still
        // a guess about key order, escaping and the trailing newline, so if
        // re-serialising the UNMODIFIED file does not reproduce it, writing a
        // modified one would reformat the whole thing.
        //
        // Provoked by handing it a manifest that is valid JSON but not in the
        // serialiser's shape — here, a trailing newline removed.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-bad-'));
        fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(dir, 'package.json'));
        fs.writeFileSync(path.join(dir, 'package-lock.json'), ORIGINAL_LOCK.trimEnd());
        let code: number | null = 0;
        let out = '';
        try {
            out = execFileSync('node', ['-e', reapplyBlock(), JSON.stringify(DELTA)], {
                cwd: dir,
                encoding: 'utf8',
                stdio: 'pipe',
            });
        } catch (e) {
            const err = e as { status: number; stdout?: string; stderr?: string };
            code = err.status;
            out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
        }
        const after = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8');
        fs.rmSync(dir, { recursive: true, force: true });

        expect(code).not.toBe(0);
        expect(out).toContain('does not reproduce the file');
        expect(out).toContain('Refusing to write it');
        // And it really did not write: the damaged file is untouched.
        expect(after).toBe(ORIGINAL_LOCK.trimEnd());
    });
});
