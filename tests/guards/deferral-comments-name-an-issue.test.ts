import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * A comment that says work is "tracked separately" without naming WHERE reads
 * as coverage and is not. #807 was filed because two such comments had stood
 * since #694 with nothing tracking either of them — a reader is told the
 * question is handled, and no issue exists to handle it.
 *
 * This is the same shape as an empty search treated as proof of absence: the
 * reassuring observable ("someone is on it") is produced identically whether
 * or not anyone is. The cheap defence is to require the pointer to resolve to
 * something — an issue number.
 */

const ROOT = join(__dirname, '..', '..');

/** Deferral phrasings that promise a tracker without naming one. */
const DEFERRAL = /tracked (separately|elsewhere|in a separate)|track(ed|ing) this separately|follow(ed)?[- ]up separately/i;

/** An issue reference: `#123`. */
const ISSUE = /#\d+/;

/**
 * A comment that CLAIMS a tracker — "tracked in X", "see X", "filed as X".
 *
 * The second question this guard asks, added after a comment reading
 * `Tracked in #BUG-retention-task-creator.` stayed green for as long as it
 * existed. That string appeared exactly twice, both in the comments of the
 * file whose broken write it described, and nowhere else in `src/`, `tests/`,
 * `docs/`, `scripts/` or `.github/`. It was never an issue number.
 *
 * `DEFERRAL` could not catch it, correctly: that pattern asks "does this defer
 * WITHOUT naming anything?", and this comment names something. So the guard
 * asked one question where there are two — *does it defer to nothing*, and
 * *if it names something, is the something real-shaped*. A known broken write
 * was recorded only in the comment that caused it, and the explanation is what
 * made it look handled.
 *
 * ## The anchor is the PHRASE, never the `#`
 *
 * The cheaper detector — "a `#` followed by non-digits is a fake tracker" —
 * was measured and rejected: it trips on **8** legitimate sites, seven of them
 * hex colours (`#FBFAF8`, `#F4F2ED`, the four Google brand colours on the
 * login page, `#FFFFFF` in an icon) plus the `#PwnedPasswords` doc anchor in
 * `password-check.ts`. That is the version somebody disables after the third
 * hex-colour report. Measured by agrent backend-1, along with the other
 * direction: **zero** legitimate non-numeric trackers exist in the tree today
 * (no Jira keys, no `owner/repo#123` upstream refs, no URL trackers) against
 * **6** compliant `tracked … #\d+` occurrences — so requiring `#\d+` inside a
 * matched claim has a false-alarm population of exactly zero.
 *
 * If an external tracker ever IS the right answer, widen this pattern's
 * accepted forms deliberately rather than deleting the arm.
 *
 * ## It is NARROW on purpose, and the wide version was measured
 *
 * A first version read `(tracked|filed|recorded|raised)\s+(in|on|at|as|under)`
 * and flagged **8** sites, every one of them ordinary prose or user-facing
 * copy: "any file reaching an AI provider must gate or be recorded as…",
 * "No activity was recorded under that handle.", "a content report filed on
 * an agricultural marketplace". None claims a tracker; all contain the words.
 *
 * So the arm matches `tracked` + a preposition and nothing else — the phrasing
 * that actually means "the work is held at X". `filed as #123` is a real thing
 * somebody might write and is deliberately NOT matched: a guard that reports
 * eight pieces of correct prose to catch one fake tracker is the guard that
 * gets deleted, and the narrow version still catches the only offender in the
 * tree.
 */
const TRACKER_CLAIM = /\btracked\s+(?:in|at|as|under|on)\b/i;

function sourceFiles(): string[] {
    // git ls-files, so the scan follows the repo rather than a hand-kept list.
    const out = execFileSync('git', ['ls-files', 'src'], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    return out
        .split('\n')
        .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
}

describe('a deferral comment names the issue that holds the work', () => {
    const files = sourceFiles();

    it('the scan actually selected files — an empty scan passes vacuously', () => {
        // The lesson from #806: for any tool whose unit of work is a
        // SELECTION, an empty selection is a PASS. Without this, a rename of
        // src/ turns this guard into a permanent green tick over nothing.
        expect(files.length).toBeGreaterThan(100);
    });

    it('the pattern still matches the shape it is meant to catch', () => {
        // Positive control for the regex itself, so a well-meaning tidy-up
        // that breaks it cannot leave the guard silently inert.
        expect(DEFERRAL.test('// unifying the two paths is tracked separately.')).toBe(true);
        // Load-bearing for BOTH arms now: this line is not a DEFERRAL, and it
        // is the case the tracker arm must still pass.
        expect(DEFERRAL.test('// unifying the two paths is tracked in #807.')).toBe(false);
    });

    it('the tracker arm matches a CLAIM and is indifferent to a bare #', () => {
        // Positive control for the second pattern.
        expect(TRACKER_CLAIM.test('// Tracked in #BUG-retention-task-creator.')).toBe(true);
        expect(TRACKER_CLAIM.test('// Tracked in #2729.')).toBe(true);
        expect(TRACKER_CLAIM.test('// tracked under #123')).toBe(true);
        // And the shapes the cheap `#`-token detector would have flagged.
        // These carry no claim, so this arm never looks at them.
        for (const line of ['const bg = \'#FBFAF8\';', 'fill="#FFFFFF"', '// see #PwnedPasswords']) {
            expect(TRACKER_CLAIM.test(line)).toBe(false);
        }
    });

    it('no src comment defers to an unnamed tracker', () => {
        const offenders: string[] = [];

        for (const file of files) {
            const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
            lines.forEach((line, i) => {
                // TWO questions, one population: does it defer to nothing,
                // and — if it claims a tracker — is the tracker real-shaped?
                if (!DEFERRAL.test(line) && !TRACKER_CLAIM.test(line)) return;
                // Allow the number to sit anywhere in the surrounding comment
                // block — these are wrapped prose comments, so the reference
                // is often on a neighbouring line.
                const context = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
                if (!ISSUE.test(context)) {
                    offenders.push(`${file}:${i + 1}  ${line.trim()}`);
                }
            });
        }

        expect(offenders).toEqual([]);
    });
});
