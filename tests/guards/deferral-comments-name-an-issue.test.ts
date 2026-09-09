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
        expect(DEFERRAL.test('// unifying the two paths is tracked in #807.')).toBe(false);
    });

    it('no src comment defers to an unnamed tracker', () => {
        const offenders: string[] = [];

        for (const file of files) {
            const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (!DEFERRAL.test(line)) return;
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
