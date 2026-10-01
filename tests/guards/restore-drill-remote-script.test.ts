/**
 * The restore drill's remote half must ARRIVE, complete and valid.
 *
 * ## The two halves of #1179
 *
 * `infra/scripts/restore-test-gcp.sh` runs its whole validation battery — WAL
 * recovery, `_prisma_migrations`, the `tenant_isolation` policies, `app_user` —
 * on the throwaway VM, by building that battery into a string and handing it to
 * `gcloud compute ssh --command`. The heredoc that builds it is UNQUOTED on
 * purpose, because five values are interpolated per target.
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
 * Four properties, every one of which was FALSE on 2026-10-01:
 *
 *   1. the drill reaches the SSH step at all (a payload was captured);
 *   2. it gets there with a SILENT stderr — no "command not found", no
 *      "unexpected EOF", no "unbound variable", no "bad substitution";
 *   3. the payload is COMPLETE, ending on the battery's last assertion rather
 *      than wherever a runaway substitution happened to stop;
 *   4. the payload is valid shell, carries this target's interpolated paths, and
 *      references no variable the remote script does not itself assign.
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
 * nested `<<'DOCKERFILE'` heredoc, non-empty pulls a stock one. `interpolated`
 * is what the host must have substituted INTO the payload — the evidence that
 * the heredoc carried this target's configuration and not the other one's. A
 * drill that mounted the wrong stack's volume path would report a missing data
 * directory, i.e. a corrupt backup, on a backup that is fine.
 */
interface Leg {
    target: string;
    env: Record<string, string>;
    interpolated: string[];
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
        interpolated: [
            'PGDATA_HOST=/mnt/restored/var/lib/docker/volumes/agrent-pgdata/_data',
            'STACK_HOST=/mnt/restored/opt/agrent',
            // empty PG_IMAGE ⇒ the build branch, with the nested heredoc
            "sudo docker build -t \"$RESTORE_IMAGE\" - <<'DOCKERFILE'",
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
        interpolated: [
            'PGDATA_HOST=/mnt/restored/var/lib/docker/volumes/inflect_pgdata/_data',
            'STACK_HOST=/mnt/restored/opt/inflect',
            // non-empty PG_IMAGE ⇒ the pull branch
            'if [ -n "postgres:16-alpine" ]; then',
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
 * Variables the REMOTE script assigns itself. Anything else surviving in the
 * payload is unbound on the VM under `set -u` — which is how 2026-10-01 actually
 * died, and the one symptom that was fatal rather than merely noisy.
 */
const REMOTE_ASSIGNED = [
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

/** Scans a payload for variable references the remote script does not assign. */
function unresolvedRefs(text: string): string[] {
    const out = new Set<string>();
    for (const m of text.replace(/^\s*#.*$/gm, '').matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
        if (!REMOTE_ASSIGNED.includes(m[1])) out.add(m[1]);
    }
    return [...out];
}

/**
 * Lines whose `$` MUST have survived the build. Under the unquoted heredoc each
 * is written `\$`; drop one backslash and it expands LOCALLY to nothing, leaving
 * a line that is still valid shell and still passes a backtick count — `test -d
 * ""` succeeds on no directory and the drill reports a corrupt backup. This is
 * the half of the class a source-text guard cannot reach.
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

        it("carries THIS target's interpolated configuration", () => {
            // The host-supplied half. A payload carrying the other stack's
            // volume path would report a missing data directory — a corrupt
            // backup — on a backup that is fine.
            for (const probe of leg.interpolated) {
                expect(payload).toContain(probe);
            }
        });

        it.each(SURVIVING_REMOTE_REFS)('kept the remote reference %p intact', (ref) => {
            // A dropped `\` on one of these expands the variable LOCALLY, to
            // nothing. The line stays valid shell, the backtick count stays
            // zero, and the drill then asserts on an empty path.
            expect(payload).toContain(ref);
        });

        it('references no variable the remote script does not assign', () => {
            // Under `set -u` on the VM an unexpanded `${FOO}` the host failed to
            // substitute is a hard failure — the 2026-10-01 fatal symptom.
            expect(unresolvedRefs(payload)).toEqual([]);
        });
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

    it('the unresolved-reference scan finds a placeholder the host failed to substitute', () => {
        // Control on the last rule above. It asserts an EMPTY set, which a scan
        // that matches nothing satisfies.
        expect(unresolvedRefs('PGDATA_HOST=/mnt/restored/${PGDATA_VOLUME}/_data')).toEqual([
            'PGDATA_VOLUME',
        ]);
        expect(unresolvedRefs('sudo test -d "$PGDATA_HOST"')).toEqual([]);
        expect(unresolvedRefs('# a ${COMMENTED_PLACEHOLDER} is not a reference')).toEqual([]);
    });
});
