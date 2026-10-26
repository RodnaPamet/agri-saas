/**
 * No mutation may be left lying in the tree.
 *
 * `scripts/selector-teeth.mjs` writes a mutation into a real source file and
 * restores it afterwards. A SIGKILL — a CI timeout, a `pkill`, an OOM — skips
 * `finally`, leaving the file MUTATED and a `.teeth-bak` beside it. That
 * happened while the script was being written: a two-minute command timeout
 * killed it mid-run and left `no-legacy-peer-deps.test.ts` gutted in the
 * working tree. Nothing would have stopped that being committed.
 *
 * The script self-heals on its next run, and catches every signal it can. This
 * is the backstop for the one it cannot catch.
 *
 * ## The hint used to be an instruction, and it could destroy work — #2365
 *
 * It read: *"a killed selector-teeth run left a MUTATED source file here;
 * restore it from its .teeth-bak"*. Following that on 2026-10-25 would have
 * reverted a merged fix. Measured:
 *
 *     restore-drill-targets-what-exists.test.ts          20:13  12173 B
 *     restore-drill-targets-what-exists.test.ts.teeth-bak 14:43  10228 B
 *
 * The source was identical to `HEAD`. The backup predated `d73edaa7e` — the
 * commit that ADDED the repair the backup lacked — so copying it back would
 * have silently restored a guard that graded nothing.
 *
 * The faulty assumption is that a `.teeth-bak` is always NEWER than the
 * mutation it protects against. True within one run; false for a backup
 * orphaned by a kill in an earlier session, after which the source moves on
 * and gets committed while the stale backup still LOOKS like the rescue copy.
 *
 * So this no longer instructs. It compares both sides against `HEAD` and says
 * which way to go, or refuses to advise when it cannot tell.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * What to do about one stray backup, from the three facts that decide it.
 *
 * Pure, and exported so the controls below can feed it combinations the repo
 * does not currently contain — which is the whole reason the original hint was
 * never caught being wrong: there was no stray in the tree to test it against
 * until one appeared for real.
 */
export type StrayVerdict = 'delete-the-backup' | 'restore-from-the-backup' | 'inspect-both' | 'untracked';

export function classifyStray(facts: {
    tracked: boolean;
    sourceMatchesHead: boolean;
    backupMatchesHead: boolean;
}): StrayVerdict {
    // Nothing to compare against, so no advice can be derived.
    if (!facts.tracked) return 'untracked';
    // The source is committed and intact: the backup is a leftover from an
    // earlier run and is the older artefact. This is the #2365 case.
    if (facts.sourceMatchesHead) return 'delete-the-backup';
    // The source was mutated and the backup is the committed state — the case
    // the original hint assumed was the only one.
    if (facts.backupMatchesHead) return 'restore-from-the-backup';
    // Neither side is HEAD. Could be a real edit plus a stale backup, or a
    // mutation on top of uncommitted work. Refusing to advise is the only
    // honest answer; guessing here is what the old hint did.
    return 'inspect-both';
}

const ADVICE: Readonly<Record<StrayVerdict, string>> = {
    'delete-the-backup':
        'the SOURCE matches HEAD, so this backup is a stale leftover from an earlier run '
        + '— DELETE the .teeth-bak. Do NOT copy it over the source: it may predate commits to it.',
    'restore-from-the-backup':
        'the source differs from HEAD and the backup IS HEAD — a killed run left a mutation. '
        + 'Restore the source from the .teeth-bak, then delete it.',
    'inspect-both':
        'NEITHER the source nor the backup matches HEAD. This may be your own uncommitted work '
        + 'with a mutation on top. Inspect both by hand; do not copy either blindly.',
    untracked: 'the source is not tracked, so nothing can be compared to HEAD. Inspect by hand.',
};

/** `git show HEAD:<rel>`, or null when the path is not in HEAD. */
function headBlob(rel: string): string | null {
    try {
        return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
        return null;
    }
}

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        // A throw, not a silent return: a renamed root would empty this
        // selection and the assertion below would pass over nothing.
        throw new Error(`scan root does not exist: ${dir}`);
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

describe('selector-teeth leaves no mutation behind', () => {
    const files = walk(path.join(ROOT, 'tests')).concat(walk(path.join(ROOT, 'scripts')));

    it('the scan actually read files — a control on the emptiness below', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    describe('the advice is DERIVED, not assumed — the controls (#2365)', () => {
        // Every combination, on synthetic facts. None of these states exists in
        // the tree right now, which is precisely why the wrong advice sat here
        // unchallenged until a real stray appeared: a guard that can only read
        // the repo can only be tested against what the repo happens to hold.

        it('a stale backup beside a committed source says DELETE THE BACKUP', () => {
            // The #2365 case, and the one the old hint got exactly backwards.
            expect(classifyStray({ tracked: true, sourceMatchesHead: true, backupMatchesHead: false }))
                .toBe('delete-the-backup');
            // Also when the backup happens to equal HEAD: the source is still
            // intact, so there is still nothing to restore.
            expect(classifyStray({ tracked: true, sourceMatchesHead: true, backupMatchesHead: true }))
                .toBe('delete-the-backup');
        });

        it('a mutated source with a HEAD backup says RESTORE', () => {
            expect(classifyStray({ tracked: true, sourceMatchesHead: false, backupMatchesHead: true }))
                .toBe('restore-from-the-backup');
        });

        it('neither side matching HEAD refuses to advise', () => {
            // Uncommitted work with a mutation on top. Copying either way loses
            // something, so the only honest output is "inspect".
            expect(classifyStray({ tracked: true, sourceMatchesHead: false, backupMatchesHead: false }))
                .toBe('inspect-both');
        });

        it('an untracked source cannot be compared, and says so', () => {
            expect(classifyStray({ tracked: false, sourceMatchesHead: false, backupMatchesHead: false }))
                .toBe('untracked');
        });

        it('every verdict has advice, and none of it says restore unconditionally', () => {
            const verdicts: StrayVerdict[] = [
                'delete-the-backup',
                'restore-from-the-backup',
                'inspect-both',
                'untracked',
            ];
            for (const v of verdicts) {
                expect({ v, hasAdvice: (ADVICE[v]?.length ?? 0) > 60 }).toEqual({ v, hasAdvice: true });
            }
            // The regression pin: the DELETE case must warn against copying,
            // because that is the action the previous message prescribed and
            // the one that would have reverted a merged fix.
            expect(ADVICE['delete-the-backup']).toMatch(/Do NOT copy/);
            expect(ADVICE['delete-the-backup']).toMatch(/predate/);
        });

        it('headBlob answers for a tracked file and null for a missing one', () => {
            // A control on the git read itself. If it threw for everything, every
            // stray would be classified `untracked` and the diagnosis would be
            // uniformly useless while the assertion still passed on an empty tree.
            expect(typeof headBlob('package.json')).toBe('string');
            expect(headBlob('this/path/does/not/exist/in/head.txt')).toBeNull();
        });
    });

    it('no .teeth-bak is left in the tree', () => {
        const stray = files.filter((f) => f.endsWith('.teeth-bak')).map((f) => path.relative(ROOT, f));

        // A DIAGNOSIS per stray rather than one instruction for all of them.
        // The failure message is the only thing a reader acts on, so it has to
        // be derived from this tree's state and not from an assumption about
        // which copy is newer.
        const diagnosis = stray.map((bak) => {
            const rel = bak.replace(/\.teeth-bak$/, '');
            const head = headBlob(rel);
            const source = fs.existsSync(path.join(ROOT, rel))
                ? fs.readFileSync(path.join(ROOT, rel), 'utf8')
                : null;
            const backup = fs.readFileSync(path.join(ROOT, bak), 'utf8');
            const verdict = classifyStray({
                tracked: head !== null,
                sourceMatchesHead: head !== null && source === head,
                backupMatchesHead: head !== null && backup === head,
            });
            return `${bak}: ${ADVICE[verdict]}`;
        });

        expect(diagnosis).toEqual([]);
    });
});
