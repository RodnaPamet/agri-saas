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

import { blankNonCode } from '../helpers/blank-non-code';

/**
 * Only what this file reads out of the workflow: each job's steps, and the
 * `id` / `run` of one of them. `yaml.load` returns `unknown`, so SOMETHING has
 * to assert a shape; naming the shape beats `any`, because a typo in `st?.id`
 * then fails to compile instead of silently never matching — which for a guard
 * means an assertion that can never fire.
 */
interface WorkflowStep {
    id?: string;
    run?: string;
    name?: string;
    /** Quoted: a hyphenated YAML key is not a valid identifier. */
    'continue-on-error'?: boolean;
}

interface WorkflowDoc {
    jobs: Record<string, { steps?: WorkflowStep[] }>;
}

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => blankNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const WORKFLOW = '.github/workflows/restore-test.yml';

describe('OI-3 — the retired AWS drill stays retired', () => {
    it.each([
        ['infra/scripts/restore-test.sh', 'AWS RDS PITR drill — no RDS instance exists'],
        ['infra/scripts/pg-dump-to-s3.sh', 'AWS S3 dump fallback — no S3 bucket exists'],
    ])('%s is gone (%s)', (rel) => {
        expect(exists(rel)).toBe(false);
    });

    it('[oi-3-exists] the absence above is measured, not assumed', () => {
        // `exists` was reported as a DEAD selector by `scripts/selector-teeth`
        // and it was right: every assertion on it expects `false`, so gutting
        // it to `return false` satisfies all of them. The suite then cannot
        // tell "the retired drill is gone" from "the check is broken", and it
        // would report the reassuring answer either way.
        //
        // One positive control on the same population fixes that — a path the
        // repo definitely has, so a gutted predicate fails here.
        expect(exists(WORKFLOW)).toBe(true);
        expect(exists('package.json')).toBe(true);
        // And the negative side is reachable for a path nothing could create,
        // so this control cannot pass by `exists` being gutted to `true`
        // either.
        expect(exists('infra/scripts/this-path-does-not-exist.sh')).toBe(false);
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

/**
 * `describe('OI-3 — restore-test-gcp.sh shape')` stood here and is DELETED
 * with its subject (#2340). It asserted the retired snapshot drill's shape:
 * strict mode, a cleanup trap on EXIT/INT/TERM, timestamped resource names,
 * that the snapshot SCHEDULE was still attached, and that the newest snapshot
 * was fresh.
 *
 * Those last two are the reason the block could not simply be repointed at
 * the replacement: the dump drill asserts neither. The schedules were deleted
 * on 2026-10-12 and freshness moved to the daily `Backup exists` probe,
 * because a monthly cadence is what let a total absence of backups go
 * unreported for 13 days (#2329).
 *
 * The properties worth keeping moved rather than went:
 *
 *   - no orphaned resources → the dump drill creates none. It makes a
 *     container and a temp directory, both removed by its EXIT trap, and
 *     neither holds anything after the process. The timestamped-names rule
 *     existed so concurrent runs could not collide over a shared disk, and
 *     there is no shared resource left to collide over.
 *   - the validation battery, the error-reporting distinction and the
 *     no-remote-payload rule → `restore-drill-targets-what-exists.test.ts`,
 *     where the two deleted guards' lessons were ported before deletion.
 *
 * What remains below is the WORKFLOW wiring, which still has a subject.
 */

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
        expect(read(WORKFLOW)).toMatch(/infra\/scripts\/restore-test-dump\.sh/);
    });

    /**
     * "Drills EVERY stack in the project" lived here and asserted the matrix
     * contained both `agrent` and `inflect-compliance`. Its property — a live
     * database whose backup nobody restores must not be droppable from this
     * file — still matters and has MOVED, not lapsed: see
     * `tests/guards/restore-drill-targets-what-exists.test.ts`, which asserts
     * the stronger version (every stack with a backup is drilled, and any
     * stack NOT drilled is documented as unbacked).
     *
     * It could not stay as written. `inflect-compliance` has no backup at all
     * since 2026-10-12 — zero snapshots, no bucket, no timer — so a matrix
     * entry for it could only report its own impossibility, monthly, in red,
     * for something this repository cannot fix.
     *
     * `fail-fast: false` and `max-parallel: 1` went with the matrix:
     *
     *   - fail-fast's property ("one broken backup must not hide the other")
     *     returns the moment there is a second target, so the new guard
     *     asserts it CONDITIONALLY rather than dropping it.
     *   - max-parallel's stated reason was that "the drill names its temporary
     *     disk and VM from a to-the-second timestamp, so two legs starting in
     *     the same second would collide". The dump-based drill creates no disk
     *     and no VM, so the collision it prevented cannot occur. Removed with
     *     the reason recorded rather than carried forward as a rule whose
     *     justification had quietly gone false.
     */
    it('leaves no matrix behind without the protections a matrix needs', () => {
        // A future reader re-adding a second target must not get the old
        // fail-fast default by omission.
        //
        // The job's EXISTENCE is asserted first, positively. Without that, a
        // gutted reader makes `strategy` undefined and the else-branch below
        // passes — an assertion satisfied by absence, which is the dead
        // selector `scripts/selector-teeth.mjs` hunts and the reason a
        // conditional assertion needs a floor under it.
        const job = wf.jobs?.['restore-test'];
        expect({ jobPresent: Boolean(job), hasSteps: (job?.steps?.length ?? 0) > 0 })
            .toEqual({ jobPresent: true, hasSteps: true });

        const strategy = job.strategy;
        if (strategy?.matrix) {
            expect(strategy['fail-fast']).toBe(false);
        } else {
            expect(strategy).toBeUndefined();
        }
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

    it('a drill failure cannot go green', () => {
        /**
         * This replaces "re-raises the drill exit code instead of swallowing
         * it", which was the worst regression available in the old file: the
         * drill ran under `set +e` to capture 75 (EX_TEMPFAIL — "no capacity,
         * so the backup was never tested"), and deleting the final
         * `exit $code` sent every drill failure green while `job.status` still
         * read success.
         *
         * That machinery is GONE because 75 is unreachable: it existed for
         * `ZONE_RESOURCE_POOL_EXHAUSTED` when creating a pd-balanced disk, and
         * the dump-based drill creates no disk. A branch for an impossible
         * state is a lie in waiting.
         *
         * The PROPERTY it protected is the one asserted here, and it is now
         * stronger rather than weaker: with no `set +e` the step fails
         * natively, so the only ways to swallow a failure are the two checked
         * below. The summary reads `outcome` instead of a captured code.
         */
        // Locally typed, as the assertion this replaces did. The outer `wf`
        // is `as any`, and `Object.values` of an `any` infers its element as
        // `unknown` — so `j.steps` is an error under `tsc` while jest, on a
        // looser config, compiles it happily. Caught by CI's Typecheck job,
        // not by the suite passing locally.
        const typed = yaml.load(read(WORKFLOW)) as WorkflowDoc;
        const steps = Object.values(typed.jobs).flatMap((j) => j.steps ?? []);
        const drill = steps.find((st) => st?.id === 'drill');
        expect(drill).toBeDefined();
        if (!drill?.run) throw new Error('the `id: drill` step has no `run` block');

        // `continue-on-error` would mark the step failed and the JOB green.
        expect({ continueOnError: drill['continue-on-error'] ?? false })
            .toEqual({ continueOnError: false });
        // `set +e` disarms errexit; `|| true` swallows the script's status.
        expect({ disarmsErrexit: /set \+e|\|\|\s*true/.test(drill.run) })
            .toEqual({ disarmsErrexit: false });
        // And the summary must not be the thing deciding success.
        const summary = steps.find((st) => /summary/i.test(st?.name ?? ''));
        expect({ summaryDecidesNothing: !/exit \$?\{?code/.test(summary?.run ?? '') })
            .toEqual({ summaryDecidesNothing: true });
    });

    it('tells "could not run" apart from "restored and it was broken"', () => {
        /**
         * This replaces "reports a capacity abort as NOT TESTED rather than as
         * a bad backup". That assertion pinned the `75` arm and its
         * leaked-resource sweep, both of which are now unreachable:
         *
         *   - 75 (EX_TEMPFAIL) existed for `ZONE_RESOURCE_POOL_EXHAUSTED` when
         *     creating a pd-balanced disk. The dump-based drill creates no
         *     disk, so there is no capacity to exhaust.
         *   - the sweep listed `restore-test-*` disks and instances, because a
         *     capacity abort could leave a disk holding production data. The
         *     drill now creates a container and a temp directory, both removed
         *     by its EXIT trap, and neither holds anything after the process.
         *
         * The PROPERTY is what the 2026-09-01 failure was really about: the
         * summary announced "the production backup did not restore cleanly"
         * when in truth nobody had tried. A false alarm about the one control
         * standing between a backup and an unrecoverable database is as
         * damaging as a missed one, so the distinction is asserted here in the
         * form the new drill can express.
         */
        const src = read(WORKFLOW);

        // 1. Unconfigured says "nobody checked", and FAILS rather than skips —
        //    a skipped restore drill is indistinguishable from a passing one.
        expect(src).toMatch(/it is a statement that nobody checked/);
        expect(src).toMatch(/exit 1/);

        // 2. The summary separates a BACKUP failure from a RESTORE failure.
        //    "no dump, or no globals sibling" is not the drill's fault and must
        //    not be reported as one; a failed battery is a real restore defect.
        const failureArm = src.slice(src.indexOf('Restore drill failed'));
        expect(failureArm).toMatch(/BACKUP\n?\s*#?\s*failure, not a drill failure|BACKUP/);
        expect(failureArm).toMatch(/the battery failed/);

        // 3. And the dead branch is really gone, not merely unused — a branch
        //    for an impossible state is a lie in waiting.
        //
        //    Checked against COMMENT-STRIPPED yaml. The workflow header
        //    explains at length why the EX_TEMPFAIL arm was not carried over,
        //    so a raw search finds the word in the very prose that documents
        //    its removal and reports the arm as still present. Third instance
        //    of that mistake in this change alone.
        const code = src
            .split('\n')
            .filter((l) => !/^\s*#/.test(l))
            .join('\n');
        expect({ carriesDeadCapacityArm: /NOT TESTED|EX_TEMPFAIL|exit_code.*75/.test(code) })
            .toEqual({ carriesDeadCapacityArm: false });
    });
});
