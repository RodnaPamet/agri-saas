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
        // `on:` parses as boolean true in YAML 1.1 — read both spellings.
        const on = wf.on ?? wf[true];
        const crons = (on.schedule ?? []).map((s: { cron: string }) => s.cron);
        expect(crons).toContain('0 4 1 * *');
    });

    it('is gated by the production GitHub Environment', () => {
        expect(wf.jobs['restore-test'].environment).toBe('production');
    });

    it('authenticates via Workload Identity Federation, not a long-lived key', () => {
        const src = read(WORKFLOW);
        expect(src).toMatch(/google-github-actions\/auth@v2/);
        expect(src).toMatch(/workload_identity_provider/);
        expect(wf.permissions['id-token']).toBe('write');
        // A JSON key would be a long-lived credential in a PUBLIC repo.
        expect(src).not.toMatch(/credentials_json/);
    });

    it('actually invokes the drill script', () => {
        expect(read(WORKFLOW)).toMatch(/infra\/scripts\/restore-test-gcp\.sh/);
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
});
