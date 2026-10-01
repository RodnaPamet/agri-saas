/**
 * The restore drill's remote half must actually ARRIVE, and must be valid shell.
 *
 * ## The failure this exists for
 *
 * `infra/scripts/restore-test-gcp.sh` runs its whole validation battery — WAL
 * recovery, `_prisma_migrations`, the `tenant_isolation` policies, `app_user` —
 * on the throwaway VM, by building that battery into a string and handing it to
 * `gcloud compute ssh --command`. Until #1179 the string was built with an
 * UNQUOTED heredoc (`<<REMOTE`), which means every `$` and every BACKTICK in
 * the body was expanded on the machine BUILDING it, including backticks inside
 * `#` comments.
 *
 * #990 added a comment — a comment warning the next reader about this very
 * heredoc — carrying an ODD number of backticks. The unterminated command
 * substitution swallowed every remaining line of the heredoc and ran it on the
 * GitHub runner: `apt-get update` as an unprivileged user, a real 9-second
 * `docker build`, and then `docker run -v "$PGDATA_HOST"` with PGDATA_HOST
 * unset, which tripped `set -u`. The drill died at step 4 with
 * "PGDATA_HOST: unbound variable", having never opened an SSH connection, so
 * the restore was never attempted at all. Both targets failed that way in run
 * 36851363940 (2026-10-01).
 *
 * The drill is monthly, so that shipped on 2026-09-18 and was first observed
 * thirteen days later. Nothing in the repo could have caught it: the body of
 * that heredoc is not code any linter reads, `bash -n` on the script does not
 * evaluate a heredoc, and every existing guard over this file is a regex over
 * its SOURCE. A regex over the source cannot see the string the source
 * PRODUCES, and the string is the artefact that matters.
 *
 * ## So this executes the drill
 *
 * With a stubbed `gcloud` on PATH that answers each subcommand and captures
 * what `compute ssh --command` is handed. Nothing is provisioned and no cloud
 * call is made — the same technique as
 * `tests/unit/restore-drill-error-reporting.test.ts`, for the same reason: a
 * guard asserting the ABSENCE of a pattern in source would have passed on
 * 2026-09-18 and every day since.
 *
 * Four properties, each of which was false on 2026-10-01:
 *
 *   1. the drill reaches the SSH step at all (the capture file exists);
 *   2. it gets there with a SILENT stderr — no "command not found", no
 *      "unexpected EOF", no "unbound variable";
 *   3. the captured payload is COMPLETE, ending on the last assertion of the
 *      battery rather than wherever a substitution happened to stop;
 *   4. the payload is valid shell (`bash -n`) and carries no leftover `\$` or
 *      `` \` `` — an escape that was load-bearing under the unquoted heredoc
 *      and ships a literal backslash under the quoted one.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'infra/scripts/restore-test-gcp.sh');

/**
 * The drill's last remote assertion. Asserting on the END of the payload is
 * what makes "complete" measurable: the 2026-10-01 payload was truncated at
 * the line the runaway substitution began on, and every check after it had
 * silently stopped existing while the drill still looked like it ran.
 */
const LAST_REMOTE_LINE = 'echo "  ✓ pg_roles: app_user present"';

/**
 * BOTH matrix legs of `.github/workflows/restore-test.yml`, because they take
 * DIFFERENT branches and both failed on 2026-10-01.
 *
 * `PG_IMAGE` is the fork: empty builds agrent's postgis+pgvector image from the
 * nested `<<'DOCKERFILE'` heredoc, non-empty pulls a stock one. An empty value
 * is also the case `printf %q` has to render as an ASSIGNMENT (`PG_IMAGE=''`)
 * rather than omit, or `[ -n "${PG_IMAGE}" ]` trips `set -u` on the VM.
 *
 * The prelude values are per-leg, so these double as the evidence that the
 * injection carries the TARGET's configuration and not a hardcoded agrent one —
 * a drill that restored the wrong stack's volume path would report a missing
 * data directory, i.e. a corrupt backup, on a backup that is fine.
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
            'PG_IMAGE=postgres:16-alpine',
            'DB_USER_HINT=postgres',
            'DB_NAME_HINT=inflect_production',
        ],
    },
];

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
 * `create` must NOT read stdin: `instances create` is handed a startup script
 * on stdin but `disks create` is not, and a stub that `cat`s unconditionally
 * blocks forever on the first call.
 *
 * `describe` echoes the resource-policy URL built from `$SNAPSHOT_SCHEDULE`
 * rather than a literal, so step 1 passes for EITHER leg; a hardcoded agrent
 * policy made the inflect-compliance leg abort at step 1 with "running WITHOUT
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
 * The exact strings the 2026-10-01 run printed. Matched rather than
 * paraphrased, so this reads against the real failure and not against a
 * description of it.
 */
const BUILD_TIME_SYMPTOMS = [
    'command not found',
    'unexpected EOF while looking for matching',
    'unbound variable',
    'bad substitution',
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
            // The drill's remote half had never been syntax-checked by
            // anything. It is not a file any linter reads, and `bash -n` on the
            // drill script does not look inside a heredoc.
            expect(shellSyntaxError(payload)).toBeNull();
        });

        it('has the host values injected, shell-quoted', () => {
            // The quoted heredoc expands nothing, so these arrive through the
            // generated prelude. An empty PG_IMAGE must still be an assignment
            // (`PG_IMAGE=''`) or `[ -n "${PG_IMAGE}" ]` trips `set -u`.
            expect(payload.split('\n').slice(0, leg.prelude.length)).toEqual(leg.prelude);
        });

        it('carries no leftover \\$ or backslash-backtick escape', () => {
            // Those escapes existed to survive the UNQUOTED heredoc. Under a
            // quoted one they ship a literal backslash, which breaks the line
            // while still reading as correct source.
            const offenders = payload
                .split('\n')
                .map((line, i) => ({ line: i + 1, text: line }))
                .filter(({ text }) => /\\\$|\\`/.test(text));
            expect(offenders).toEqual([]);
        });

        it('leaves no unexpanded ${...} that the prelude does not define', () => {
            // A `${FOO}` the prelude never assigns is an unbound variable on the
            // remote under `set -u`, which is how 2026-10-01 actually died.
            const defined = new Set([
                // injected by the prelude
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
            ]);
            const unknown = new Set<string>();
            for (const m of payload.replace(/^\s*#.*$/gm, '').matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
                if (!defined.has(m[1])) unknown.add(m[1]);
            }
            expect([...unknown]).toEqual([]);
        });
    });
});

describe('restore drill — the detectors are not vacuous', () => {
    it('`bash -n` rejects broken shell', () => {
        // Positive control. Without it, a `shellSyntaxError` that always
        // returns null makes "is valid shell" above a green light over
        // anything at all — including the truncated 2026-10-01 payload.
        expect(shellSyntaxError('if [ 1 ]; then\n')).not.toBeNull();
        expect(shellSyntaxError('echo "unterminated\n')).not.toBeNull();
    });

    it('`bash -n` accepts the shell this drill actually writes', () => {
        // The other half of the control: a detector that rejects everything
        // would fail the real payload and look like a defect in the drill.
        expect(shellSyntaxError('set -euo pipefail\nfoo() { echo "$1"; }\nfoo bar\n')).toBeNull();
    });

    it('the escape detector matches a real leftover escape', () => {
        expect(/\\\$|\\`/.test('sudo test -d "\\$PGDATA_HOST"')).toBe(true);
        expect(/\\\$|\\`/.test('sudo test -d "$PGDATA_HOST"')).toBe(false);
    });
});

describe('restore drill — the heredoc stays quoted', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');

    it("builds REMOTE_SCRIPT from a QUOTED heredoc (<<'REMOTE')", () => {
        // The structural half of the same property. The execution checks
        // above are the real teeth, but this one names the cause in the
        // place a future editor is standing when they break it.
        //
        // Read off the OPENER LINES, not the whole file: the note above
        // REMOTE_SCRIPT necessarily spells `<<REMOTE` while explaining what
        // it must never be again, and a substring search over the source
        // would flag the explanation as the defect.
        const openers = source
            .split('\n')
            .filter((l) => !l.trimStart().startsWith('#'))
            .filter((l) => /<<-?\s*'?REMOTE'?\s*$/.test(l));
        expect(openers).toEqual(["    cat <<'REMOTE'"]);
    });

    it('injects the host values through printf %q rather than interpolation', () => {
        expect(source).toMatch(/printf 'PGDATA_VOLUME=%q/);
    });
});
