/**
 * Epic OI-3 — backup + restore validation ratchet.
 *
 * ## What changed on 2026-08-01, and why this file was rewritten
 *
 * This guard used to assert the SHAPE of `infra/scripts/restore-test.sh`
 * — an AWS RDS point-in-time-recovery drill — in about 25 assertions:
 * the right teardown flags, `--no-publicly-accessible`, a timestamped
 * instance id, a psql validation battery. Every one of them passed,
 * every day, for months.
 *
 * None of it was true of production. The product does not run on RDS:
 * production is a single GCE VM (`agrent`) with Postgres in a local
 * Docker volume. The workflow that would have executed that script
 * died at the AWS credential step in 12 seconds on every run, so the
 * script was never executed once. And what the green guard concealed
 * was that production had **no automated backups at all** — no cron,
 * no systemd timer, no snapshot schedule, zero snapshots.
 *
 * That is the repo's own "green is not the same as executed" lesson
 * (see CLAUDE.md) in its most expensive form: a structural guard
 * proving a file has the right flags says nothing about whether the
 * thing runs, or whether the infrastructure it describes exists.
 *
 * So this file now guards the backup posture we ACTUALLY run:
 *   - daily GCE snapshot schedule on the `agrent` disk;
 *   - `infra/scripts/restore-test-gcp.sh`, which restores the newest
 *     snapshot to a throwaway VM, boots a real Postgres over the
 *     recovered data directory, and validates it;
 *   - a monthly workflow that runs that script, and that names its
 *     missing configuration explicitly rather than failing opaquely.
 *
 * It also asserts the AWS scripts stay retired, so the old shape
 * cannot quietly come back.
 *
 * **These are still source-text assertions and still prove nothing
 * about execution.** The execution evidence is the workflow run
 * itself; see docs/backup-restore.md for the drill's last-run record.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
const stat = (rel: string) => fs.statSync(path.join(ROOT, rel));

const SCRIPT = 'infra/scripts/restore-test-gcp.sh';
const WORKFLOW = '.github/workflows/restore-test.yml';

describe('OI-3 — the retired AWS drill stays retired', () => {
    it.each([
        ['infra/scripts/restore-test.sh', 'AWS RDS PITR drill — no RDS instance exists'],
        ['infra/scripts/pg-dump-to-s3.sh', 'AWS S3 dump fallback — no S3 bucket exists'],
    ])('%s is gone (%s)', (rel) => {
        expect(exists(rel)).toBe(false);
    });

    it('the workflow no longer references AWS', () => {
        const src = read(WORKFLOW);
        // Prose in the header explains the migration, so only assert
        // that no AWS ACTION or credential is wired up.
        expect(src).not.toMatch(/aws-actions\/configure-aws-credentials/);
        expect(src).not.toMatch(/AWS_ROLE_TO_ASSUME/);
        expect(src).not.toMatch(/secrets\.SOURCE_DB_INSTANCE_ID/);
    });
});

describe('OI-3 — restore-test-gcp.sh shape', () => {
    it('exists and is executable', () => {
        expect(exists(SCRIPT)).toBe(true);
        // owner-execute bit set (octal 0o100)
        expect((stat(SCRIPT).mode & 0o100) !== 0).toBe(true);
    });

    it('uses bash strict mode (set -euo pipefail)', () => {
        expect(read(SCRIPT)).toMatch(/^set\s+-euo\s+pipefail/m);
    });

    it('registers a cleanup trap on EXIT/INT/TERM (no orphaned VM or disk)', () => {
        expect(read(SCRIPT)).toMatch(/trap\s+cleanup\s+EXIT\s+INT\s+TERM/);
    });

    it('cleanup deletes BOTH the throwaway VM and the restored disk', () => {
        const src = read(SCRIPT);
        const cleanup = src.slice(src.indexOf('cleanup()'), src.indexOf('trap cleanup'));
        expect(cleanup).toMatch(/compute instances delete/);
        expect(cleanup).toMatch(/compute disks delete/);
    });

    it('uses TIMESTAMPED unique resource names (collision-proof under concurrent runs)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/TIMESTAMP="?\$\(date.*Y.*m.*d.*H.*M.*S\)"?/);
        expect(src).toMatch(/RESTORE_DISK_ID=.*\$\{?TIMESTAMP\}?/);
        expect(src).toMatch(/RESTORE_VM_ID=.*\$\{?TIMESTAMP\}?/);
    });

    it('asserts the snapshot SCHEDULE is still attached to the source disk', () => {
        // A detached resource policy stops all backups silently — the
        // exact failure this drill exists to catch before it matters.
        const src = read(SCRIPT);
        expect(src).toMatch(/compute disks describe/);
        expect(src).toMatch(/resourcePolicies/);
        expect(src).toMatch(/SNAPSHOT_SCHEDULE/);
    });

    it('asserts the newest snapshot is FRESH (a stale snapshot is a dead schedule)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/MAX_SNAPSHOT_AGE_HOURS/);
        expect(src).toMatch(/SNAPSHOT_AGE_HOURS\s*>\s*MAX_SNAPSHOT_AGE_HOURS/);
    });

    it('selects the NEWEST ready snapshot (sort-by descending creationTimestamp)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/status=READY/);
        expect(src).toMatch(/--sort-by=~creationTimestamp/);
        expect(src).toMatch(/--limit=1/);
    });

    it('the throwaway VM carries NO GCP identity (it briefly holds production data)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/--no-service-account/);
        expect(src).toMatch(/--no-scopes/);
    });

    it('boots a REAL Postgres over the restored data dir (WAL recovery is the point)', () => {
        const src = read(SCRIPT);
        // Crash-consistent snapshots land mid-transaction; proving the
        // cluster recovers is the whole correctness argument.
        expect(src).toMatch(/docker run -d --name restore-pg/);
        expect(src).toMatch(/agrent-pgdata/);
        expect(src).toMatch(/pg_isready/);
    });

    it('is parameterised per target — one drill, two stacks', () => {
        // The project runs two independent stacks whose only shared
        // property is the backup mechanism. Hardcoding either one's
        // volume / stack dir / image would silently make the drill
        // test the wrong disk, or fail on a disk that is in fact fine.
        const src = read(SCRIPT);
        for (const v of ['PGDATA_VOLUME', 'STACK_DIR', 'PG_IMAGE']) {
            expect(src).toMatch(new RegExp(`${v}="\\$\\{${v}:-`));
        }
    });

    it('finds the encryption key by SEARCHING the stack dir, not by naming a file', () => {
        // agrent keeps it in .env, inflect-compliance in .env.prod.
        // Pinning a filename made this check fail on a disk where the
        // key was perfectly recoverable — a false "unrecoverable
        // backup" verdict, which is the worst kind of wrong here.
        const src = read(SCRIPT);
        expect(src).toMatch(/grep -rlq 'DATA_ENCRYPTION_KEY/);
        expect(src).not.toMatch(/ENV_FILE=\/mnt\/restored\/opt\/agrent\/\.env/);
    });

    it('asks the RESTORED CLUSTER which role and database exist', () => {
        // Parsing credentials out of stack config is unreliable across
        // stacks (env file vs compose keys with ${VAR:-default}), and a
        // mis-parsed role reports "role does not exist" — which reads
        // like a corrupt backup when the backup is fine.
        const src = read(SCRIPT);
        expect(src).toMatch(/for cand in/);
        expect(src).toMatch(/FROM pg_database WHERE datname NOT IN/);
    });

    it('validates schema + migrations + recent rows + RLS via psql', () => {
        const src = read(SCRIPT);
        // Schema reachability
        expect(src).toMatch(/SELECT 1/);
        // Core tables
        expect(src).toMatch(/Tenant table reachable/);
        expect(src).toMatch(/User table reachable/);
        // Migrations actually applied
        expect(src).toMatch(/_prisma_migrations/);
        // Recent activity — catches a valid-but-ancient snapshot
        expect(src).toMatch(/AuditLog/);
        // The SQL is nested two quoting levels deep inside the remote
        // heredoc, so the literal reads INTERVAL '"'"'14 days. Match
        // loosely across the quote soup rather than pinning it.
        expect(src).toMatch(/INTERVAL['"\s]{0,8}14 days/);
        // RLS survived the restore — tenant isolation is the product's
        // core security property; losing it in a restore is a breach.
        expect(src).toMatch(/pg_policies/);
        expect(src).toMatch(/tenant_isolation/);
        // The role the policies GRANT to must exist or RLS is inert.
        expect(src).toMatch(/pg_roles.*app_user/);
    });
});

describe('OI-3 — restore-test.yml wiring', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = yaml.load(read(WORKFLOW)) as any;

    it('schedules monthly via cron', () => {
        // `on:` is a YAML 1.1 boolean, so some parsers key it as `true`
        // rather than `'on'`. Object keys are strings at runtime, so the
        // boolean key lands under `'true'` — which is also the only
        // spelling tsc accepts as an index (TS2538 on a literal `true`).
        const on = wf.on ?? (wf as Record<string, unknown>)['true'];
        const crons = (on.schedule ?? []).map((s: { cron: string }) => s.cron);
        expect(crons).toContain('0 4 1 * *');
    });

    it('is gated by the production GitHub Environment', () => {
        expect(wf.jobs['restore-test'].environment).toBe('production');
    });

    it('authenticates via Workload Identity Federation, not a long-lived key', () => {
        const src = read(WORKFLOW);

        // Pinned to a MAJOR, but deliberately not to a SPECIFIC major.
        //
        // The security property this test defends is the three assertions
        // below — federated short-lived credentials, no long-lived JSON key.
        // The action's major version is incidental to that: v2 and v3 both
        // declare `workload_identity_provider` / `service_account` /
        // `audience`, so a major bump changes the runtime, not the auth model.
        //
        // Hard-pinning `@v2` made every routine Dependabot major bump fail a
        // SECURITY guard for a reason that had nothing to do with security
        // (#582), which trains people to read a red security check as noise.
        // That is the expensive failure mode, not the version drift.
        //
        // `v[2-9]\d*` still refuses a downgrade to v1, whose input surface
        // predates the WIF flow this workflow relies on.
        expect(src).toMatch(/google-github-actions\/auth@v[2-9]\d*/);

        expect(src).toMatch(/workload_identity_provider/);
        expect(wf.permissions['id-token']).toBe('write');
        // A JSON key would be a long-lived credential in a PUBLIC repo.
        expect(src).not.toMatch(/credentials_json/);
    });

    it('actually invokes the drill script', () => {
        expect(read(WORKFLOW)).toMatch(/infra\/scripts\/restore-test-gcp\.sh/);
    });

    it('drills EVERY stack in the project, not just this repo\'s own', () => {
        // Both stacks sat with zero backups until 2026-08-01, and only
        // one of them is built from this repo. Dropping a target here
        // leaves a live database whose backup nobody ever restores.
        const targets = wf.jobs['restore-test'].strategy.matrix.include.map(
            (m: { target: string }) => m.target,
        );
        expect(targets).toEqual(expect.arrayContaining(['agrent', 'inflect-compliance']));
    });

    it('does not fail-fast — one broken backup must not hide the other', () => {
        expect(wf.jobs['restore-test'].strategy['fail-fast']).toBe(false);
    });

    it('serialises the matrix (the drill names resources from a per-second timestamp)', () => {
        expect(wf.jobs['restore-test'].strategy['max-parallel']).toBe(1);
    });

    it('preflights its configuration and NAMES what is missing', () => {
        // The old workflow's core defect was not that it failed — it is
        // that the failure did not say what was wrong. An unconfigured
        // drill must announce "nobody checked", not look like a broken
        // backup and not silently pass.
        const src = read(WORKFLOW);
        expect(src).toMatch(/Preflight/);
        expect(src).toMatch(/GCP_WORKLOAD_IDENTITY_PROVIDER/);
        expect(src).toMatch(/it is a statement that/);
        // And it must FAIL, not skip: a skipped restore drill is
        // indistinguishable from a passing one.
        expect(src).toMatch(/exit 1/);
    });

    it('re-raises the drill exit code instead of swallowing it', () => {
        // THE worst regression available in this file. The drill step runs
        // under `set +e` so it can capture 75 (EX_TEMPFAIL = "no capacity, so
        // the backup was never tested") and tell the summary apart from a
        // genuine restore failure. Delete the final `exit $code` and every
        // drill failure — including a real one — goes GREEN while
        // `job.status` still reads success. Nothing else here would notice:
        // the executing test never reads this YAML.
        const wf = yaml.load(read(WORKFLOW)) as any;
        const steps: any[] = Object.values(wf.jobs).flatMap((j: any) => j.steps ?? []);
        const drill = steps.find((st) => st?.id === 'drill');

        // `id: drill` is what lets the summary read the exit code.
        expect(drill).toBeDefined();
        expect(drill.run).toMatch(/exit_code=\$\{code\}"?\s*>>\s*"\$GITHUB_OUTPUT"/);
        // The run block must END by re-raising the captured code.
        expect(drill.run.trim().split('\n').pop()!.trim()).toBe('exit $code');
    });

    it('reports a capacity abort as NOT TESTED rather than as a bad backup', () => {
        // The 2026-09-01 failure: both targets got
        // ZONE_RESOURCE_POOL_EXHAUSTED and the summary announced "The
        // production backup did not restore cleanly" — a false alarm about
        // the one control that stands between a snapshot schedule and an
        // unrecoverable database. The 75 arm must exist AND must still carry
        // the leaked-resource sweep, since a capacity abort can happen after
        // a disk holding production data has been created.
        const src = read(WORKFLOW);
        expect(src).toMatch(/steps\.drill\.outputs\.exit_code.*==?\s*"75"|"75"/);
        expect(src).toMatch(/NOT TESTED/);
        const armIdx = src.indexOf('NOT TESTED');
        const arm = src.slice(armIdx, src.indexOf('elif', armIdx));
        expect(arm).toMatch(/compute disks list --filter='name~restore-test-'/);
        expect(arm).toMatch(/compute instances list --filter='name~restore-test-'/);
    });
});
