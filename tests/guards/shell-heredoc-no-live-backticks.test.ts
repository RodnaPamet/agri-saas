/**
 * Prose inside an UNQUOTED heredoc must not be executable.
 *
 * ## The defect
 *
 * `infra/scripts/restore-test-gcp.sh` builds the remote half of the monthly
 * backup-restore drill as `REMOTE_SCRIPT=$(cat <<REMOTE … )`. The heredoc is
 * UNQUOTED on purpose — five values (`${STACK_DIR}`, `${PG_IMAGE}`,
 * `${PGDATA_VOLUME}`, `${DB_USER}`, `${DB_NAME}`) are injected per target —
 * so every `$` meant for the REMOTE shell is written `\$`.
 *
 * Backticks are the other substitution syntax and nobody remembered them. The
 * comments inside that heredoc are written in this repo's house style, which
 * marks code with markdown backticks, and a bare backtick in an unquoted
 * heredoc opens a command substitution that runs LOCALLY while the heredoc is
 * built.
 *
 * Measured on 2026-10-01: 19 live backticks, an ODD number, so the pairing
 * shifted and the last one never closed. The scheduled drill failed for BOTH
 * targets with, in order:
 *
 *     line 547: Acquire::Check-Valid-Until=false: command not found
 *     E: Could not open lock file /var/lib/apt/lists/lock (13: Permission denied)
 *     line 547: docker.io: command not found
 *     line 547: bad substitution: no closing "`" in `, which is a warning in a monthly
 *     line 563: PGDATA_HOST: unbound variable
 *
 * The last line is the fatal one and the subtlest: inside a backtick context
 * `\$` de-escapes to `$`, so `\$PGDATA_HOST` — escaped precisely so it would
 * reach the remote intact — expanded LOCALLY instead, was unset, and `set -u`
 * killed the drill. One root cause, two unrelated-looking symptoms.
 *
 * The comment that unbalanced the count was itself about this hazard:
 *
 *     # UNQUOTED outer heredoc, so its `\`-continuations collapse to one physical
 *
 * ## Why ZERO rather than an even number
 *
 * Balanced backticks still EXECUTE. An even count would have run `apt-get
 * update` and `psql` locally and spliced their output into the remote script
 * silently, which is worse than failing — the drill would have reported
 * success over a script nobody wrote. Reproduced locally against the unfixed
 * file: it ran `apt-get update` and invoked `sudo` on the machine running it.
 *
 * So the rule is zero live backticks, and escaping is the fix: `\`` renders as
 * a literal backtick in the heredoc output, so the prose survives.
 *
 * ## Why a guard at all
 *
 * This drill runs on a SCHEDULE. It has no PR page, so nothing but the
 * failure-notifier issue says it broke, and it is the only thing that proves a
 * GCE snapshot can actually be restored — booting a real Postgres over the
 * restored data directory rather than checking a snapshot exists. RPO is up to
 * 24 hours on a single disk with no replica, so a silently broken drill means
 * the backup guarantee is unverified. Same reasoning as
 * `caddyfile-divergence`: a file nothing executes in CI still needs its
 * properties asserted.
 */
import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT_DIRS = ['infra/scripts', 'scripts', 'deploy'];

interface Heredoc {
    file: string;
    delimiter: string;
    quoted: boolean;
    startLine: number;
    endLine: number;
    body: string[];
}

/** Every heredoc in `text`, with whether its delimiter was quoted. */
export function findHeredocs(file: string, text: string): Heredoc[] {
    const lines = text.split('\n');
    const out: Heredoc[] = [];
    // `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`. A quoted delimiter turns
    // off ALL expansion inside the body, which is what makes it safe.
    const opener = /<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/;
    for (let i = 0; i < lines.length; i += 1) {
        const m = opener.exec(lines[i]);
        if (!m) continue;
        const quoted = Boolean(m[1] ?? m[2]);
        const delimiter = m[1] ?? m[2] ?? m[3];
        const body: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j += 1) {
            if (lines[j].trim() === delimiter) break;
            body.push(lines[j]);
        }
        if (j >= lines.length) continue; // unterminated: not our business
        out.push({ file, delimiter, quoted, startLine: i + 1, endLine: j + 1, body });
        i = j;
    }
    return out;
}

/** Backticks that are NOT backslash-escaped, i.e. live substitution delimiters. */
export function liveBackticks(line: string): number {
    let n = 0;
    for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '\\') { i += 1; continue; } // escaped next char
        if (line[i] === '`') n += 1;
    }
    return n;
}

/**
 * Lines that carry a live backtick inside an UNQUOTED heredoc.
 *
 * Extracted so the `quoted` branch is exercised by a FIXTURE rather than only
 * by the repo's own corpus. Inverting it left the rule green — no quoted
 * heredoc here happens to contain a backtick, so "scan the quoted ones
 * instead" produced an empty list and passed. A condition only a real corpus
 * drives is a condition a mutation walks through.
 */
export function offendingLines(docs: Heredoc[]): string[] {
    const out: string[] = [];
    for (const h of docs) {
        if (h.quoted) continue;
        h.body.forEach((line, idx) => {
            const n = liveBackticks(line);
            if (n > 0) {
                out.push(
                    `${h.file}:${h.startLine + 1 + idx} (<<${h.delimiter}) ` +
                        `${n} live backtick(s): ${line.trim().slice(0, 70)}`,
                );
            }
        });
    }
    return out;
}

/**
 * The shell scripts to scan.
 *
 * `collectSourceFiles` rather than a hand-rolled walk, for two reasons it
 * enforces and I did not: it THROWS when a declared root does not exist
 * (#875 — a renamed root would scan zero files and pass), and it refuses a
 * result below `floor`. My first version wrote `if (!existsSync(abs))
 * continue`, which turns a missing root into an empty contribution — and
 * `tests/guards/scan-roots-resolve.test.ts` caught it as a NEW swallower,
 * correctly. Nothing here is special enough to justify its own walk.
 */
function shellFiles(): string[] {
    return collectSourceFiles({
        roots: SCRIPT_DIRS,
        extensions: ['.sh'],
        // MEASURED at 12 (2026-10-01), floored at 10 so one or two deletions
        // are legitimate while a collapse is not. I first guessed 20 from
        // memory and the suite failed to LOAD — `Test Suites: 1 failed,
        // Tests: 0 total`, which a grep for `Tests:.*failed` reads as clean.
        // Floor from a count you took, not from an impression.
        floor: 10,
    });
}

const files = shellFiles();
const heredocs = files.flatMap((f) =>
    findHeredocs(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')),
);

describe('no live backtick inside an unquoted heredoc', () => {
    // ── Controls ─────────────────────────────────────────────────────

    it('control: shell scripts were found', () => {
        expect(files.length).toBeGreaterThan(5);
    });

    it('control: heredocs were parsed, both quoted and unquoted', () => {
        // The rule below only looks at UNQUOTED ones. If the parser stopped
        // recognising quoting it would either scan nothing or scan everything.
        expect(heredocs.length).toBeGreaterThan(3);
        expect(heredocs.some((h) => h.quoted)).toBe(true);
        expect(heredocs.some((h) => !h.quoted)).toBe(true);
    });

    it('control: the drill script is in the population and its heredoc is unquoted', () => {
        // This rule exists for that file; if it stops being scanned the rule
        // passes for free.
        const drill = heredocs.filter((h) => h.file === 'infra/scripts/restore-test-gcp.sh');
        expect(drill.length).toBeGreaterThan(0);
        expect(drill.some((h) => h.delimiter === 'REMOTE' && !h.quoted)).toBe(true);
    });

    it('control: liveBackticks counts only UNESCAPED backticks', () => {
        expect(liveBackticks('no backticks here')).toBe(0);
        expect(liveBackticks('a `b` c')).toBe(2);
        expect(liveBackticks('a \\`b\\` c')).toBe(0);
        expect(liveBackticks('a \\`b` c')).toBe(1); // the odd case that broke the drill
    });

    it('control: the detector FIRES on a synthetic unquoted body and not a quoted one', () => {
        // The assertion in the rule below is "this list is empty", and
        // inverting its `h.quoted` test left it GREEN — because no quoted
        // heredoc in this repo happens to contain a backtick either. So the
        // polarity needs its own fixture: the detector must flag an unquoted
        // body and spare a quoted one, on the same text.
        const bad = ['X=$(cat <<REMOTE', '# a `live` backtick', 'REMOTE', ')'].join('\n');
        const good = ["X=$(cat <<'REMOTE'", '# a `live` backtick', 'REMOTE', ')'].join('\n');

        const badDocs = findHeredocs('synthetic-bad.sh', bad);
        expect(badDocs).toHaveLength(1);
        expect(badDocs[0].quoted).toBe(false);
        expect(badDocs[0].body.map(liveBackticks).reduce((a, b) => a + b, 0)).toBe(2);

        const goodDocs = findHeredocs('synthetic-good.sh', good);
        expect(goodDocs).toHaveLength(1);
        expect(goodDocs[0].quoted).toBe(true);
        // Same text, same backticks — harmless only because the delimiter is
        // quoted, which is exactly the distinction the rule turns on.
        expect(goodDocs[0].body.map(liveBackticks).reduce((a, b) => a + b, 0)).toBe(2);
    });

    it('control: the RULE flags an unquoted fixture and spares a quoted one', () => {
        // Drives `offendingLines`' own `quoted` branch. Without this the
        // branch is only ever exercised against this repo's corpus, where
        // inverting it is invisible because no quoted body carries a backtick.
        const text = (delim: string) =>
            [`X=$(cat <<${delim}`, '# a `live` backtick', 'REMOTE', ')'].join('\n');

        const unquoted = findHeredocs('fixture.sh', text('REMOTE'));
        const quoted = findHeredocs('fixture.sh', text("'REMOTE'"));

        expect(offendingLines(unquoted)).toHaveLength(1);
        expect(offendingLines(unquoted)[0]).toContain('live backtick');
        expect(offendingLines(quoted)).toEqual([]);
    });

    // ── The rule ─────────────────────────────────────────────────────

    it('every unquoted heredoc body is free of live backticks', () => {
        const offenders = offendingLines(heredocs);
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} line(s) carry a live backtick inside an UNQUOTED heredoc:\n` +
                    offenders.map((o) => `  ${o}`).join('\n') +
                    `\n\nA bare backtick there is a command substitution that runs LOCALLY while\n` +
                    `the heredoc is built. It broke the monthly restore drill for both targets:\n` +
                    `prose executed as commands, and — because \\\` de-escapes to \` inside a\n` +
                    `backtick context — a carefully escaped \\$PGDATA_HOST expanded locally and\n` +
                    `died under set -u.\n\n` +
                    `Write \\\` for a literal backtick, or quote the delimiter (<<'WORD') if the\n` +
                    `body needs no local expansion at all.`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
