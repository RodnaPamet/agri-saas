/**
 * Prose inside an UNQUOTED heredoc must not be executable.
 *
 * ## The defect
 *
 * `infra/scripts/restore-test-gcp.sh` builds the remote half of the monthly
 * backup-restore drill as `REMOTE_SCRIPT=$(cat <<REMOTE … )`. That heredoc was
 * UNQUOTED — five values (`${STACK_DIR}`, `${PG_IMAGE}`, `${PGDATA_VOLUME}`,
 * `${DB_USER}`, `${DB_NAME}`) were injected per target — so every `$` meant for
 * the REMOTE shell had to be written `\$`.
 *
 * **It is quoted now (#1225), and that file is pinned below.** The repo-wide
 * rule still earns its keep: five other unquoted heredocs remain in the tree
 * (`deploy/init-roles.sh`, `scripts/detect-secrets.sh` ×2,
 * `scripts/perf/parcel-list-bench.sh` ×2 — measured 2026-10-02), each
 * interpolating on purpose, and a backtick in any of their bodies would do
 * there what it did here.
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
 * So the rule is zero live backticks, and escaping was the fix: `\`` renders as
 * a literal backtick in the heredoc output, so the prose survives.
 *
 * ## Why the drill went further
 *
 * Escaping closes the backtick INSTANCE; the unquoted heredoc leaves the CLASS
 * open. A `$(…)` or a `${VAR}` written in prose expands locally too, and a
 * dropped backslash on a `\$` expands locally to NOTHING — shipping
 * `sudo test -d ""`, which succeeds and reports a corrupt backup on a backup
 * that is fine. None of those moves the backtick count. #1225 therefore quoted
 * that one delimiter and injected its five host values as a `printf %q`
 * prelude, and the rule below is joined by a pin on that file: no heredoc in
 * the drill script may be unquoted. `restore-drill-remote-script.test.ts`
 * asserts the consequence behaviourally — the payload's body is the heredoc
 * source byte for byte.
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

/**
 * Every heredoc in `text`, with whether its delimiter was quoted.
 *
 * A line that is entirely a `#` comment is NOT an opener, and that skip is
 * load-bearing rather than tidy. This repo's shell scripts document their own
 * heredocs in prose, so `# \`<<'REMOTE'\` expands nothing` reads as an opener to
 * a regex — and because the scan then consumes forward to the first line equal
 * to the delimiter, a mentioned-in-prose opener SWALLOWS the real one that
 * follows and reports the body under the comment's quoting. Measured: adding
 * that sentence to `restore-test-gcp.sh` made the parser see one QUOTED REMOTE
 * heredoc starting at the comment, so un-quoting the actual `cat <<REMOTE`
 * fourteen lines below changed nothing this file could see. Caught by a
 * mutation, not by reading.
 *
 * It is a deliberately shallow rule: a trailing comment on a line that also
 * carries code (`foo # see <<EOF`) would still match, and a `#` inside a string
 * is not a comment at all. Being a shell parser is out of scope; covering the
 * shape that actually occurs is not.
 */
export function findHeredocs(file: string, text: string): Heredoc[] {
    const lines = text.split('\n');
    const out: Heredoc[] = [];
    // `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`. A quoted delimiter turns
    // off ALL expansion inside the body, which is what makes it safe.
    const opener = /<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/;
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].trimStart().startsWith('#')) continue;
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

    it('control: the drill script is in the population', () => {
        // This rule exists for that file; if it stops being scanned the rule
        // passes for free. It used to assert the REMOTE heredoc was UNQUOTED,
        // as a proxy for "the rule's subject is still in scope". #1225 quoted
        // it, so that premise is false — the pin below replaces it rather than
        // dropping it, and the in-scope question is answered by the OTHER
        // unquoted heredocs, which the control above counts.
        const drill = heredocs.filter((h) => h.file === 'infra/scripts/restore-test-gcp.sh');
        expect(drill.map((h) => h.delimiter).sort()).toEqual(['REMOTE', 'STARTUP']);
    });

    it('control: a heredoc MENTIONED in a comment is not mistaken for the real one', () => {
        // The defect this fixture exists for, measured on the real file: the
        // drill script's design note contains the literal `<<'REMOTE'`, and a
        // scan that treats a comment as an opener consumes forward to the
        // terminator — reporting ONE quoted heredoc that starts at the comment
        // and never examining the `cat <<REMOTE` below it. Every assertion
        // about that heredoc's quoting then describes the prose.
        const text = [
            '# the design note says `<<\'REMOTE\'` expands nothing',
            'X=$(cat <<REMOTE',
            '# a `live` backtick',
            'REMOTE',
            ')',
        ].join('\n');
        const docs = findHeredocs('fixture.sh', text);
        expect(docs).toHaveLength(1);
        // The REAL opener, on line 2 — not the comment on line 1.
        expect({ startLine: docs[0].startLine, quoted: docs[0].quoted }).toEqual({
            startLine: 2,
            quoted: false,
        });
        expect(offendingLines(docs)).toHaveLength(1);
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

    it('the restore drill builds its remote payload from a QUOTED heredoc', () => {
        // The companion to the rule below, and the source-text half of #1225.
        //
        // The two are not the same check and neither subsumes the other: the
        // rule below tolerates an unquoted heredoc as long as it carries no
        // backtick, which is exactly the state the drill was in between #1212
        // and #1225 — green, with `$(…)` and `${VAR}` in its prose still live.
        // For THIS file the delimiter itself is the invariant, because the body
        // is 167 lines of prose-heavy shell that nobody writes with escaping in
        // mind, and because the payload is never read by a human before it runs
        // on a VM holding a copy of production data.
        //
        // The STARTUP heredoc is in scope for the same reason: it is a GCE
        // startup script built on the host and executed on the VM, so a live
        // expansion there is the same hazard with a different blast radius.
        const drill = heredocs.filter((h) => h.file === 'infra/scripts/restore-test-gcp.sh');
        const unquoted = drill.filter((h) => !h.quoted);
        if (unquoted.length > 0) {
            throw new Error(
                `infra/scripts/restore-test-gcp.sh has ${unquoted.length} UNQUOTED heredoc(s): ` +
                    unquoted.map((h) => `<<${h.delimiter} at line ${h.startLine}`).join(', ') +
                    `\n\nThe drill's heredocs must stay quoted (<<'WORD'). An unquoted one makes ` +
                    `the body's own prose expand on the machine building the string — a backtick ` +
                    `in a comment killed the drill for a month (#1179), and a \`$(…)\` or ` +
                    `\`\${VAR}\` in prose, or a dropped backslash on a \\$, does the same without ` +
                    `moving the backtick count (#1225).\n\nHost values belong in the \`printf %q\` ` +
                    `prelude ahead of the body, not inside it.`,
            );
        }
        expect(unquoted).toEqual([]);
    });

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
