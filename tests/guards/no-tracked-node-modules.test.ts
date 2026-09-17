/**
 * `node_modules` must never be tracked by git.
 *
 * This has now happened twice. Both times the mechanism was the same and it is
 * not obvious: `.gitignore` carried `node_modules/` — with a trailing slash,
 * which matches a **directory** only. A local setup that symlinks
 * `node_modules` at a shared install (common when several checkouts share one
 * install) produces a *symlink*, not a directory, so the pattern did not match
 * it and a `git add -A` swept it in as a 120000 blob.
 *
 * The damage is quiet but broad: every other checkout gets a symlink pointing
 * at one developer's home directory. It resolves to nothing on their machine
 * and on CI, so builds fail in ways that look unrelated to the commit that
 * caused them.
 *
 * The pattern is fixed (no trailing slash matches both forms). This test is the
 * backstop, because the failure mode is a one-character `.gitignore` edit away
 * from returning and nothing else would catch it.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'path';

import { collectTrackedFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');

function git(args: string[]): string {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

describe('node_modules is never tracked', () => {
    it('no tracked path is or lives under node_modules', () => {
        // `ls-files` lists the index, so this catches the symlink blob, a
        // committed directory, and any stray file beneath one.
        //
        // This is the inverted case the shared collector exists to keep
        // honest (#865). Everywhere else an empty selection is the defect;
        // here it is the PASS, so the floor is 0 — and `expectEmptyBecause`
        // is what makes that a stated decision rather than a floor nobody
        // got round to setting. Do NOT raise it to 1: a floor of 1 would
        // demand that node_modules BE tracked, inverting the guard.
        const tracked = collectTrackedFiles({
            roots: ['node_modules', '*/node_modules'],
            floor: 0,
            expectEmptyBecause:
                'this guard asserts node_modules is NOT tracked, so zero matching ' +
                'index entries is the healthy answer, not a broken selector',
        }).map((abs) => path.relative(ROOT, abs).replace(/\\/g, '/'));

        expect(tracked).toEqual([]);
    });

    it('.gitignore ignores node_modules as a SYMLINK, not just a directory', () => {
        // `check-ignore` is the real predicate git uses, so this asserts the
        // behaviour rather than the spelling of the pattern — a future rewrite
        // that still ignores both forms is free to change the text.
        let ignored = true;
        try {
            git(['check-ignore', '-q', 'node_modules']);
        } catch {
            ignored = false;
        }
        expect(ignored).toBe(true);
    });
});
