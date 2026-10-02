/**
 * The restore drill's remote half must ARRIVE, complete and valid.
 *
 * ## The two halves of #1179
 *
 * `infra/scripts/restore-test-gcp.sh` runs its whole validation battery — WAL
 * recovery, `_prisma_migrations`, the `tenant_isolation` policies, `app_user` —
 * on the throwaway VM, by building that battery into a string and handing it to
 * `gcloud compute ssh --command`. The heredoc that builds it was UNQUOTED until
 * #1225, because five values are interpolated per target; it is now `<<'REMOTE'`
 * with those five injected as a generated prelude.
 *
 * On 2026-10-01 both matrix legs died at step 4 with "PGDATA_HOST: unbound
 * variable" after a pile of "command not found". #990 had added a comment
 * carrying an ODD number of backticks, and a bare backtick in an unquoted
 * heredoc is a command substitution evaluated HERE, on the machine building the
 * string. The unterminated substitution swallowed the rest of the heredoc and
 * ran it on the GitHub runner — `apt-get update`, a real `docker build`, then
 * `docker run -v "$PGDATA_HOST"` with the variable unset. No SSH connection was
 * ever opened, so the restore was never attempted and every assertion in the
 * battery was silently unreachable.
 *
 * `tests/guards/shell-heredoc-no-live-backticks.test.ts` (#1212) fixed the CAUSE
 * and guards it: zero live backticks inside any unquoted heredoc, repo-wide.
 * **That guard and this one are not the same check**, and neither subsumes the
 * other:
 *
 *   · it asserts a property of the SOURCE TEXT — one known hazard, every shell
 *     script in the tree;
 *   · this asserts a property of the ARTIFACT — one script, whatever the cause.
 *
 * A text guard pinned to backticks cannot see the rest of the class an unquoted
 * heredoc leaves open: a `$(…)` or a `${VAR}` written in prose, a dropped `\$`
 * on a line meant for the remote shell (it expands locally, to nothing, and the
 * payload silently reads `test -d ""`), a body line that happens to equal the
 * terminator. Every one of those truncates or corrupts the payload with the
 * backtick count still at zero.
 *
 * ## What #1225 changed, and what it asks of this file
 *
 * #1212 removed the backtick INSTANCE. #1225 removed the local-expansion CLASS
 * by quoting the delimiter: `<<'REMOTE'` expands nothing, so the body's own
 * prose is prose again, and the five values the VM cannot know are injected as a
 * `printf %q` prelude ahead of it.
 *
 * That turns the central property of this guard from a list of symptoms into one
 * equality: **the payload is the prelude followed by the heredoc source, byte
 * for byte.** Nothing a future editor writes in the body can expand on the
 * machine building the string, because if anything expanded, the two would stop
 * matching. Un-quoting the delimiter fails it; a `$(…)` in a comment fails it; a
 * `${VAR}` in prose fails it. The symptom assertions below are kept anyway —
 * they name the real 2026-10-01 failure, and an equality that someone widens is
 * cheaper to notice next to four specific checks than alone.
 *
 * ## Why this EXECUTES the drill
 *
 * Because the thing that matters is a string the source PRODUCES, and no regex
 * over the source can see it. `bash -n` on the drill script cannot either — a
 * heredoc body is not parsed. Measured: with a deliberate unbalanced quote
 * planted inside the heredoc, `bash -n infra/scripts/restore-test-gcp.sh` exits
 * 0 while the payload is broken shell. The drill's remote half had never been
 * syntax-checked by anything, local or CI.
 *
 * So each case runs the real script with a stubbed `gcloud` on PATH and reads
 * the `--command` argument it was handed — the same technique as
 * `tests/unit/restore-drill-error-reporting.test.ts`, for the same reason.
 * Nothing is provisioned and no cloud call is made.
 *
 * Five properties. The first four were all FALSE on 2026-10-01:
 *
 *   1. the drill reaches the SSH step at all (a payload was captured);
 *   2. it gets there with a SILENT stderr — no "command not found", no
 *      "unexpected EOF", no "unbound variable", no "bad substitution";
 *   3. the payload is COMPLETE, ending on the battery's last assertion rather
 *      than wherever a runaway substitution happened to stop;
 *   4. the payload is valid shell, and references no variable it does not itself
 *      assign — the prelude included;
 *   5. the payload's body is the heredoc source VERBATIM, behind a prelude
 *      carrying this target's five host values `%q`-quoted (#1225).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'infra/scripts/restore-test-gcp.sh');

/**
 * The drill's last remote assertion. Asserting on the END of the payload is what
 * makes "complete" measurable: the 2026-10-01 payload stopped at the line the
 * runaway substitution began on, and every check after it had quietly ceased to
 * exist while the drill still looked like it ran.
 */
const LAST_REMOTE_LINE = 'echo "  ✓ pg_roles: app_user present"';

/**
 * BOTH matrix legs of `.github/workflows/restore-test.yml`, because they take
 * DIFFERENT branches and both failed on 2026-10-01.
 *
 * `PG_IMAGE` is the fork: empty builds agrent's postgis+pgvector image from the
 * nested `<<'DOCKERFILE'` heredoc, non-empty pulls a stock one.
 *
 * `prelude` is the EXACT set of lines the host must put in front of the body —
 * the whole host-supplied half of the payload since #1225, and the only place
 * this target's configuration can now enter it. Asserted as an equality rather
 * than as `toContain` probes: a sixth line appearing there is a new local
 * expansion nobody declared, and an equality is the only shape that notices one.
 *
 * Both legs are listed with `PG_IMAGE` on OPPOSITE sides of empty on purpose.
 * `PG_IMAGE=''` is the case `printf %q` exists for: bash renders an empty value
 * as `''`, and a format that dropped it would leave `PG_IMAGE=` missing
 * altogether, so `[ -n "${PG_IMAGE}" ]` on the VM would die under `set -u`.
 */
interface Leg {
    target: string;
    env: Record<string, string>;
    prelude: string[];
}

const LEGS: Leg[] = [
    {
        target: 'agrent',
        env: {
            SOURCE_DISK: 'agrent',
            SNAPSHOT_SCHEDULE: 'agrent-daily-snapshot',
            PGDATA_VOLUME: 'agrent-pgdata',
            STACK_DIR: '/opt/agrent',
            PG_IMAGE: '',
        },
        prelude: [
            'PGDATA_VOLUME=agrent-pgdata',
            'STACK_DIR=/opt/agrent',
            // empty ⇒ the build branch, and `''` rather than nothing at all
            "PG_IMAGE=''",
            'DB_USER_HINT=postgres',
            'DB_NAME_HINT=inflect_production',
        ],
    },
    {
        target: 'inflect-compliance',
        env: {
            SOURCE_DISK: 'inflect-compliance',
            SNAPSHOT_SCHEDULE: 'inflect-daily-snapshot',
            PGDATA_VOLUME: 'inflect_pgdata',
            STACK_DIR: '/opt/inflect',
            PG_IMAGE: 'postgres:16-alpine',
        },
        prelude: [
            'PGDATA_VOLUME=inflect_pgdata',
            'STACK_DIR=/opt/inflect',
            // non-empty ⇒ the pull branch
            'PG_IMAGE=postgres:16-alpine',
            'DB_USER_HINT=postgres',
            'DB_NAME_HINT=inflect_production',
        ],
    },
];

/** The payload's first body line, and so the boundary between prelude and body. */
const FIRST_BODY_LINE = 'set -euo pipefail';

/**
 * The `REMOTE` heredoc as the drill script writes it: whether its delimiter is
 * quoted, and the body verbatim.
 *
 * The other half of the byte-identity assertion. A QUOTED heredoc expands
 * nothing, so whatever follows the prelude in the payload must be this string
 * character for character — which is the property #1225 bought and the reason
 * no `$(…)` or `${VAR}` written in the body's prose can run on the host again.
 *
 * TWO details, both learned the hard way:
 *
 *   · it matches the UNQUOTED form too, and reports `quoted` as data rather
 *     than throwing. A module-scope throw does make the suite red, but it takes
 *     all 43 assertions down with it and reports `Tests: 0 total` — a shape a
 *     log grep for `Tests:.*failed` reads as clean. Quoting is asserted by a
 *     named test below instead, so un-quoting the delimiter fails with a
 *     sentence rather than a stack trace;
 *   · the opener must not be a `#` COMMENT. The design note above the heredoc
 *     contains the literal `<<'REMOTE'`, and anchoring on the first match of it
 *     reads the prose instead of the code — which is exactly how the companion
 *     text guard was silently measuring a comment until a mutation exposed it.
 */
interface RemoteHeredoc {
    quoted: boolean;
    body: string;
}

function remoteHeredoc(): RemoteHeredoc {
    const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n');
    const open = lines.findIndex(
        (l) => !l.trimStart().startsWith('#') && /^\s*cat <<'?REMOTE'?$/.test(l),
    );
    if (open === -1) {
        throw new Error(
            'no `cat <<REMOTE` line in infra/scripts/restore-test-gcp.sh — the opener was ' +
                'reshaped, and an empty body would make every assertion over it vacuous.',
        );
    }
    const close = lines.indexOf('REMOTE', open + 1);
    if (close === -1) {
        throw new Error('the REMOTE heredoc in infra/scripts/restore-test-gcp.sh is unterminated');
    }
    return {
        quoted: lines[open].includes("<<'REMOTE'"),
        body: lines.slice(open + 1, close).join('\n'),
    };
}

const REMOTE_HEREDOC = remoteHeredoc();
const HEREDOC_BODY = REMOTE_HEREDOC.body;

const COMMON_ENV: Record<string, string> = {
    GCP_PROJECT: 'p',
    GCP_ZONE: 'europe-west1-b',
};

/**
 * A `gcloud` that answers every subcommand the drill asks and records the
 * payload of the REAL `compute ssh` call.
 *
 * `--command true` is the sshd-readiness probe and must succeed on the first
 * attempt, or the drill sleeps 10s thirty times. Any OTHER `--command` value is
 * the remote script, and is written to `$DRILL_CAPTURE`.
 *
 * `create` must NOT read stdin: `instances create` is handed a startup script on
 * stdin but `disks create` is not, and a stub that `cat`s unconditionally blocks
 * forever on the first call.
 *
 * `describe` echoes a resource-policy URL built from `$SNAPSHOT_SCHEDULE` rather
 * than a literal, so step 1 passes for EITHER leg. A hardcoded agrent policy
 * made the inflect-compliance leg abort at step 1 with "running WITHOUT
 * automated backups" and never reach what this guard measures.
 */
const GCLOUD_STUB = `#!/usr/bin/env bash
is_ssh=0
for a in "$@"; do [ "$a" = "ssh" ] && is_ssh=1; done
if [ "$is_ssh" = 1 ]; then
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--command" ]; then
      if [ "$a" = "true" ]; then exit 0; fi
      printf '%s' "$a" > "$DRILL_CAPTURE"
      exit 0
    fi
    prev="$a"
  done
  exit 0
fi
for a in "$@"; do
  case "$a" in
    describe) echo "https://www.googleapis.com/compute/v1/projects/p/regions/europe-west1/resourcePolicies/$SNAPSHOT_SCHEDULE"; exit 0 ;;
    list)     echo "snap-1 $DRILL_SNAPSHOT_CREATED"; exit 0 ;;
    create)   exit 0 ;;
    delete)   exit 0 ;;
  esac
done
exit 0
`;

interface DrillRun {
    status: number;
    stdout: string;
    stderr: string;
    /** What `compute ssh --command` received, or null if that step was never reached. */
    payload: string | null;
}

function runDrill(legEnv: Record<string, string>): DrillRun {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-remote-'));
    try {
        fs.writeFileSync(path.join(dir, 'gcloud'), GCLOUD_STUB, { mode: 0o755 });
        const capture = path.join(dir, 'captured.sh');
        let status = 0;
        let stdout = '';
        let stderr = '';
        try {
            stdout = execFileSync('bash', [SCRIPT], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 60_000,
                env: {
                    ...process.env,
                    PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
                    DRILL_CAPTURE: capture,
                    // Computed here rather than with `date -u -d '-6 hours'` in
                    // the stub: `date -d` is GNU-only, and a stub that silently
                    // prints nothing on BSD date makes step 2 fail for a reason
                    // that has nothing to do with what this guard measures.
                    DRILL_SNAPSHOT_CREATED: new Date(Date.now() - 6 * 3600_000)
                        .toISOString()
                        .replace(/\.\d+Z$/, 'Z'),
                    ...COMMON_ENV,
                    ...legEnv,
                },
            });
        } catch (e: unknown) {
            const err = e as { status?: number; stdout?: string; stderr?: string };
            status = err.status ?? 1;
            stdout = err.stdout ?? '';
            stderr = err.stderr ?? '';
        }
        return {
            status,
            stdout,
            stderr,
            payload: fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : null,
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** `bash -n` on a string. Returns null when it parses, else bash's complaint. */
function shellSyntaxError(source: string): string | null {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-syntax-'));
    try {
        const file = path.join(dir, 'payload.sh');
        fs.writeFileSync(file, source);
        try {
            execFileSync('bash', ['-n', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            return null;
        } catch (e: unknown) {
            return (e as { stderr?: string }).stderr ?? 'bash -n failed with no output';
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Runs one prelude line through bash and reads the variable back.
 *
 * The only way to assert `%q` ROUND-TRIPS: `PGDATA_VOLUME=pg\ data\'\;\ echo\
 * PWNED\ #` is unreadable as a string literal, and re-deriving the expected
 * escaping in TypeScript would be asserting my model of bash against itself.
 * Bash is the authority on what bash reads, and `printf %s` is used rather than
 * `echo` so a value starting with `-` or containing a backslash survives.
 */
function evalAssignment(line: string, name: string): string {
    return execFileSync('bash', ['-c', `${line}\nprintf '%s' "$${name}"`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/**
 * The exact strings the 2026-10-01 run printed. Matched rather than paraphrased,
 * so this reads against the real failure and not against a description of it.
 */
const BUILD_TIME_SYMPTOMS = [
    'command not found',
    'unexpected EOF while looking for matching',
    'unbound variable',
    'bad substitution',
];

/**
 * Variables the payload must assign SOMEWHERE in itself — the body's own, plus
 * the five the prelude injects. A denominator control, not the rule: it exists
 * so that `unresolvedRefs` returning [] cannot mean "the scan found no
 * references at all".
 *
 * Since #1225 the prelude names are in this list because the PAYLOAD assigns
 * them (on the VM, before `set -u`), not because the host substituted them.
 */
const PAYLOAD_ASSIGNED = [
    // injected by the host as a `printf %q` prelude
    'PGDATA_VOLUME',
    'STACK_DIR',
    'PG_IMAGE',
    'DB_USER_HINT',
    'DB_NAME_HINT',
    // assigned by the remote script itself
    'PGDATA_HOST',
    'STACK_HOST',
    'RESTORE_IMAGE',
    'DB_USER',
    'DB_NAME',
    'TENANTS',
    'USERS',
    'MIGRATIONS',
    'RECENT',
    'POLICIES',
    'APP_USER',
    'i',
    'cand',
];

/**
 * Every name the payload itself assigns — DERIVED from the payload rather than
 * read off a hand list.
 *
 * Derived because the hand list is now the wrong instrument. Before #1225 an
 * unexpanded `${FOO}` meant the HOST failed to substitute, so a fixed list of
 * remote-assigned names was exactly the right denominator. With a quoted
 * delimiter the host substitutes nothing on purpose, and the only remaining
 * failure is a reference nothing in the payload ever assigns — which is a
 * question about the payload, answerable from the payload. A new prelude entry
 * then needs no edit here, and a body reference whose prelude line is MISSING
 * is caught without one.
 */
function assignedNames(text: string): Set<string> {
    const out = new Set<string>();
    // `NAME=…` at the start of a line (prelude entries and plain assignments)
    for (const m of text.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)=/gm)) out.add(m[1]);
    // `for NAME in …` — a loop variable is assigned by the loop
    for (const m of text.matchAll(/\bfor[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in\b/g)) out.add(m[1]);
    return out;
}

/** Scans a payload for variable references nothing in it ever assigns. */
function unresolvedRefs(text: string): string[] {
    const assigned = assignedNames(text);
    const out = new Set<string>();
    for (const m of text.replace(/^\s*#.*$/gm, '').matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
        if (!assigned.has(m[1])) out.add(m[1]);
    }
    return [...out];
}

/**
 * Lines whose `$` MUST reach the VM as a `$`. Under the old unquoted heredoc
 * each was written `\$`, and dropping one backslash expanded it LOCALLY to
 * nothing — a line that is still valid shell and still passes a backtick count,
 * where `test -d ""` succeeds on no directory and the drill reports a corrupt
 * backup. #1225 made that unreachable by construction, but these stay: they are
 * the cheapest readable statement of what the payload is FOR, and they fail
 * loudly if a future edit reintroduces host expansion by any route.
 */
const SURVIVING_REMOTE_REFS = [
    'sudo test -d "$PGDATA_HOST"',
    'sudo test -d "$STACK_HOST"',
    '-v "$PGDATA_HOST":/var/lib/postgresql/data',
    '[ "$APP_USER" = "1" ]',
];

/**
 * Both legs are run ONCE at module load rather than per test: the drill is
 * sub-second against the stub, and a per-test run would re-execute it twenty
 * times for no extra information.
 */
const RUNS = new Map(LEGS.map((leg) => [leg.target, runDrill({ ...leg.env })]));

describe.each(LEGS)('restore drill — the $target remote script arrives intact', (leg) => {
    const run = RUNS.get(leg.target) as DrillRun;

    describe('the harness is really running the drill', () => {
        it('the drill executed far enough to call `compute ssh --command`', () => {
            // THE CONTROL. Every assertion below is over `run.payload`, and a
            // null or empty payload satisfies "contains no \\$" and "bash -n is
            // clean" vacuously. On 2026-10-01 this is the assertion that fails
            // first: the drill died building the string, so the SSH step was
            // never reached and nothing was captured.
            const tail = run.stdout.slice(-400);
            expect({ payload: run.payload === null ? 'NOT CAPTURED' : 'captured', tail }).toEqual({
                payload: 'captured',
                tail,
            });
            expect((run.payload ?? '').split('\n').length).toBeGreaterThan(100);
        });

        it('the drill walked all five steps and exited 0', () => {
            expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
            expect(run.stdout).toContain('restore drill PASSED');
        });
    });

    describe('nothing in the heredoc executed on THIS machine', () => {
        it.each(BUILD_TIME_SYMPTOMS)('the drill printed no %p', (symptom) => {
            // Building the remote string must have no side effects at all. Each
            // of these four appeared in run 36851363940, from backticks inside
            // comments being evaluated locally.
            expect(`${run.stdout}${run.stderr}`).not.toContain(symptom);
        });
    });

    describe('the payload the VM receives', () => {
        const payload = run.payload ?? '';

        it('ends on the last assertion of the validation battery', () => {
            // Completeness, stated as a property of the END of the string. A
            // truncated payload still contains SELECT 1 and still looks like a
            // drill; what it loses is everything after the truncation point.
            expect(payload.trimEnd().split('\n').at(-1)).toBe(LAST_REMOTE_LINE);
        });

        it('carries every assertion of the battery, not just the last', () => {
            for (const probe of [
                'startup script never finished',
                'is not a Postgres data directory',
                'DATA_ENCRYPTION_KEY',
                'docker run -d --name restore-pg',
                'pg_isready',
                'FROM "Tenant"',
                'FROM "User"',
                '_prisma_migrations',
                'AuditLog',
                'tenant_isolation',
                'app_user',
            ]) {
                expect(payload).toContain(probe);
            }
        });

        it('is valid shell', () => {
            // The drill's remote half had never been syntax-checked by anything.
            // It is not a file any linter reads, and `bash -n` on the drill
            // script does not look inside a heredoc — verified by planting an
            // unbalanced quote in the body: the script stays `bash -n`-clean.
            expect(shellSyntaxError(payload)).toBeNull();
        });

        it("the prelude is EXACTLY this target's five host values, shell-quoted", () => {
            // The host-supplied half, and since #1225 the ONLY half the host
            // writes. A payload carrying the other stack's volume path would
            // report a missing data directory — a corrupt backup — on a backup
            // that is fine; a SIXTH line here is a local expansion nobody
            // declared, which is why this is an equality and not `toContain`.
            expect(payload.split('\n').slice(0, leg.prelude.length)).toEqual(leg.prelude);
        });

        it('the body is the heredoc source VERBATIM — the host substituted nothing', () => {
            // THE #1225 ASSERTION. A quoted heredoc expands nothing, so the
            // payload after the prelude must equal the source byte for byte.
            // That one equality subsumes the whole local-expansion class: a
            // `$(…)` or `${VAR}` written in prose, a `\$` whose backslash was
            // dropped, a backtick in a comment — each would make the two
            // differ. Un-quoting the delimiter fails it too (via heredocBody,
            // which throws rather than returning an empty string).
            const lines = payload.split('\n');
            const bodyStart = lines.indexOf(FIRST_BODY_LINE);
            expect(bodyStart).toBe(leg.prelude.length);
            expect(lines.slice(bodyStart).join('\n')).toBe(HEREDOC_BODY);
        });

        it.each(SURVIVING_REMOTE_REFS)('kept the remote reference %p intact', (ref) => {
            // Each of these must reach the VM with its `$` unexpanded. Before
            // #1225 a dropped backslash expanded it LOCALLY, to nothing: the
            // line stayed valid shell, the backtick count stayed zero, and the
            // drill asserted on an empty path.
            expect(payload).toContain(ref);
        });

        it('references no variable the payload does not itself assign', () => {
            // Under `set -u` on the VM, a reference nothing assigns is a hard
            // failure — the 2026-10-01 fatal symptom. Since #1225 the prelude
            // is what assigns the five host names, so a body reference whose
            // prelude line is missing lands here rather than silently
            // interpolating to the empty string.
            expect(unresolvedRefs(payload)).toEqual([]);
        });

        it('the assignment scan sees the prelude AND the body — control on the rule above', () => {
            // The denominator. `unresolvedRefs` asserts an EMPTY list, which a
            // scan that derives an over-broad `assigned` set satisfies for the
            // wrong reason. Requiring every name on the hand list to be found
            // by the DERIVED scan pins the two against each other: the list
            // cannot go stale silently, and the scan cannot quietly stop
            // matching assignments.
            const assigned = assignedNames(payload);
            expect([...PAYLOAD_ASSIGNED].filter((n) => !assigned.has(n))).toEqual([]);
        });
    });
});

/**
 * `printf %q` is what makes the prelude safe to paste into a script. A value
 * carrying a space, a quote or a `$(…)` arrives at the VM as DATA; without the
 * quoting it would arrive as SHELL — the host would not run it (the delimiter is
 * quoted), but the VM would.
 *
 * Run as its own leg rather than folded into the two real ones, because the
 * hostile value is not a configuration this project ever uses and the per-leg
 * prelude equalities should keep reading as the real matrix.
 */
describe('restore drill — a hostile host value cannot break the payload', () => {
    const NASTY = "pg data'; echo PWNED #";
    const run = runDrill({
        SOURCE_DISK: 'agrent',
        SNAPSHOT_SCHEDULE: 'agrent-daily-snapshot',
        PGDATA_VOLUME: NASTY,
        STACK_DIR: '/opt/a b$(echo X)',
        PG_IMAGE: '',
    });

    it('the drill still produces a payload', () => {
        expect(run.payload).not.toBeNull();
        expect(run.status).toBe(0);
    });

    it('the payload is still valid shell', () => {
        // `%q` → `%s` fails here: the unquoted value closes a quote and the
        // rest of the line becomes commands.
        expect(shellSyntaxError(run.payload ?? '')).toBeNull();
    });

    it('the hostile value arrives as DATA, not as shell', () => {
        const prelude = (run.payload ?? '').split('\n')[0];
        expect(prelude.startsWith('PGDATA_VOLUME=')).toBe(true);
        // Not the raw bytes: `%q` must have escaped them.
        expect(prelude).not.toBe(`PGDATA_VOLUME=${NASTY}`);
        // And `bash` must read them back as the original string.
        expect(evalAssignment(prelude, 'PGDATA_VOLUME')).toBe(NASTY);
    });

    it('the body is STILL the heredoc source verbatim', () => {
        // The quoting of the delimiter is independent of the values, and this
        // says so: even a value designed to break out changes only the prelude.
        const lines = (run.payload ?? '').split('\n');
        expect(lines.slice(lines.indexOf(FIRST_BODY_LINE)).join('\n')).toBe(HEREDOC_BODY);
    });
});

describe('restore drill — the source the payload is built from', () => {
    it("the REMOTE heredoc delimiter is QUOTED (<<'REMOTE')", () => {
        // The source-text statement of #1225, here as well as in
        // shell-heredoc-no-live-backticks, because this is where the reader
        // arrives when the byte-identity assertion fails and the two failures
        // together say WHY. An unquoted delimiter makes the body's own prose
        // expand on the machine building the string.
        expect(REMOTE_HEREDOC.quoted).toBe(true);
    });

    it('the extracted body is the real one, not an empty window', () => {
        // The extraction is the denominator of every byte-identity assertion
        // above: an empty or truncated body makes them compare short strings
        // and pass. Measured at 167 lines on 2026-10-02; floored, not pinned,
        // so an ordinary edit to the battery is not a failure.
        expect(HEREDOC_BODY.split('\n').length).toBeGreaterThan(150);
        expect(HEREDOC_BODY.split('\n')[0]).toBe(FIRST_BODY_LINE);
        expect(HEREDOC_BODY.trimEnd().split('\n').at(-1)).toBe(LAST_REMOTE_LINE);
    });
});

describe('restore drill — the detectors are not vacuous', () => {
    it('`bash -n` rejects broken shell', () => {
        // Positive control. Without it, a `shellSyntaxError` that always returns
        // null makes "is valid shell" above a green light over anything at all —
        // including the truncated 2026-10-01 payload.
        expect(shellSyntaxError('if [ 1 ]; then\n')).not.toBeNull();
        expect(shellSyntaxError('echo "unterminated\n')).not.toBeNull();
    });

    it('`bash -n` accepts the shell this drill actually writes', () => {
        // The other half of the control: a detector that rejects everything
        // would fail the real payload and look like a defect in the drill.
        expect(shellSyntaxError('set -euo pipefail\nfoo() { echo "$1"; }\nfoo bar\n')).toBeNull();
    });

    it('the unresolved-reference scan finds a name nothing assigns', () => {
        // Control on the per-leg rule. It asserts an EMPTY set, which a scan
        // that matches nothing — or one whose `assigned` set is everything —
        // satisfies for free. Both polarities are pinned.
        expect(unresolvedRefs('PGDATA_HOST=/mnt/restored/${PGDATA_VOLUME}/_data')).toEqual([
            'PGDATA_VOLUME',
        ]);
        // ...and it is satisfied once the prelude assigns it, which is exactly
        // the shape #1225 introduced.
        expect(
            unresolvedRefs('PGDATA_VOLUME=agrent-pgdata\nPGDATA_HOST=/mnt/${PGDATA_VOLUME}/_data'),
        ).toEqual([]);
        expect(unresolvedRefs('PGDATA_HOST=x\nsudo test -d "$PGDATA_HOST"')).toEqual([]);
        expect(unresolvedRefs('# a ${COMMENTED_PLACEHOLDER} is not a reference')).toEqual([]);
    });

    it('the assignment scan reads assignments and loop variables, and nothing else', () => {
        // `assignedNames` is the denominator of the rule above: a version that
        // returned every candidate would make "no unresolved references"
        // unfalsifiable. Pinned in both directions.
        expect([...assignedNames('FOO=1\n  BAR=2\nfor cand in a b; do :; done')].sort()).toEqual([
            'BAR',
            'FOO',
            'cand',
        ]);
        // A comparison is not an assignment, and neither is a reference.
        expect([...assignedNames('[ "$FOO" = "1" ] || echo "${BAR}"')]).toEqual([]);
    });

    it("`printf %q` round-trips a value that would otherwise be shell", () => {
        // Control on the hostile-value leg: without it, `evalAssignment`
        // returning '' would make that assertion pass over an empty prelude.
        const line = execFileSync('bash', ['-c', `printf '%s=%q' V "a b'c;d"`], {
            encoding: 'utf8',
        });
        expect(line).not.toBe("V=a b'c;d");
        expect(evalAssignment(line, 'V')).toBe("a b'c;d");
        // And an EMPTY value must still render as an assignment, or `set -u`
        // kills the drill at `[ -n "${PG_IMAGE}" ]` on the VM.
        const empty = execFileSync('bash', ['-c', `printf '%s=%q' V ""`], { encoding: 'utf8' });
        expect(empty).toMatch(/^V=(''|"")?$/);
        expect(evalAssignment(empty, 'V')).toBe('');
    });
});
