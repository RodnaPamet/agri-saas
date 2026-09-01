/**
 * The restore drill must not report "backups are missing" when it means
 * "I could not ask".
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `infra/scripts/restore-test-gcp.sh` is the monthly backup-restore drill, and
 * its first two assertions are the ones an operator will actually read at 3am.
 * Both used to capture their `gcloud` call as
 *
 *     X="$(gcloud ... 2>/dev/null || true)"
 *
 * which collapses **two different answers into one**. A permission error, an
 * IAM propagation delay, a wrong zone or an API blip all produce an empty
 * string — and an empty string fails the substring test, which prints:
 *
 *     ✗ ... Production is running WITHOUT automated backups.
 *
 * That fired for real on 2026-08-21 (issue #663), on two stacks whose backups
 * were working perfectly — daily snapshots, 14-day retention, most recent one
 * a few hours old. It was one message away from being reported to the operator
 * as fact. The actual cause was a stale Workload Identity binding, which the
 * `2>/dev/null` had thrown away.
 *
 * The drill is the thing you consult when you are already frightened. A check
 * that cannot distinguish "the answer is no" from "I could not ask" is worse
 * than no check, because it is confidently wrong in the alarming direction.
 *
 * ── Why these tests EXECUTE the script ──
 *
 * A `tests/guards/` regex asserting the absence of `2>/dev/null || true` would
 * pass forever while proving nothing about what the operator sees, which is
 * the exact failure class this repo calls "green is not the same as executed".
 * So each case runs the real script with a stubbed `gcloud` on PATH and
 * asserts on its real stderr. The script exits at step 1 or 2 in every case
 * here, so nothing is created and no cloud call is made.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'infra/scripts/restore-test-gcp.sh');

const DISK = 'agrent';
const SCHEDULE = 'agrent-daily-snapshot';
const POLICY_URL =
    'https://www.googleapis.com/compute/v1/projects/p/regions/europe-west1/resourcePolicies/' + SCHEDULE;

/** Runs the real drill with a stubbed `gcloud`, returning everything it printed. */
function runDrill(stub: string, envOverrides: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-stub-'));
    try {
        const bin = path.join(dir, 'gcloud');
        fs.writeFileSync(bin, stub, { mode: 0o755 });
        try {
            return execFileSync('bash', [SCRIPT], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
                    GCP_PROJECT: 'p',
                    GCP_ZONE: 'z',
                    SOURCE_DISK: DISK,
                    SNAPSHOT_SCHEDULE: SCHEDULE,
                    ...envOverrides,
                },
            });
        } catch (e: unknown) {
            // The drill exits non-zero in every case here — that is the point.
            const err = e as { stdout?: string; stderr?: string };
            return `${err.stdout ?? ''}${err.stderr ?? ''}`;
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** A stub that dispatches on the gcloud subcommand, so later steps can be reached. */
function stub(opts: { describe: string; snapshots?: string; create?: string }): string {
    return `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    describe) ${opts.describe}; exit $? ;;
    list)     ${opts.snapshots ?? 'exit 0'}; exit $? ;;
    create)   ${opts.create ?? 'exit 0'}; exit $? ;;
  esac
done
exit 0
`;
}

/**
 * gcloud's ACTUAL stderr from run 33491345028 (2026-09-01), pasted verbatim
 * rather than paraphrased.
 *
 * That distinction is the test. A hand-written approximation would prove the
 * classifier matches the string THIS FILE chose — the repo's own "a mocked
 * dependency cannot report that the dependency changed" failure class. Note
 * that `ZONE_RESOURCE_POOL_EXHAUSTED` appears only on the machine `code:`
 * line, while the human sentence says "is currently unavailable in the … zone"
 * and never uses the word EXHAUSTED. A classifier keyed on the code alone
 * works until gcloud reformats, and the fall-through is the misreport this
 * whole change exists to prevent.
 */
const GCLOUD_CAPACITY_STDERR = String.raw`ERROR: (gcloud.compute.disks.create) Could not fetch resource:
---
code: ZONE_RESOURCE_POOL_EXHAUSTED
errorDetails:
- localizedMessage:
    locale: en-US
    message: A 80GB pd-balanced disk is currently unavailable in the europe-west1-b
      zone. Please try your request again in another zone. For more information, see
      the troubleshooting documentation.
- errorInfo:
    domain: compute.googleapis.com
    reason: persistent_disk_availability
message: The zone 'projects/hazel-design-419410/zones/europe-west1-b' does not have
  enough resources available to fulfill the request.  Try a different zone, or try
  again later.
`;

/** A stub that gets past steps 1 and 2 so step 3 is reachable. */
function healthyThroughStep2(create: string): string {
    const fresh = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    return stub({
        describe: `echo "${POLICY_URL}"`,
        snapshots: `echo "snap-1 ${fresh}"`,
        create,
    });
}

const CANNOT_ASK_DISK = 'could not read disk';
const CANNOT_ASK_SNAPSHOTS = 'could not LIST snapshots';
const NO_BACKUPS = 'WITHOUT automated backups';
const NOTHING_TO_RESTORE = 'nothing to restore';

describe('restore drill — "I could not ask" is never reported as "the answer is no"', () => {
    it('a FAILING disk read says the check could not run, not that backups are missing', () => {
        const out = runDrill(
            stub({ describe: 'echo "ERROR: PERMISSION_DENIED: stubbed" >&2; exit 1' }),
        );

        expect(out).toContain(CANNOT_ASK_DISK);
        // The whole point. This is the sentence that must NOT appear.
        expect(out).not.toContain(NO_BACKUPS);
        // And gcloud's own words must survive, or the operator is left guessing
        // at which of permission / zone / propagation it was.
        expect(out).toContain('PERMISSION_DENIED');
    });

    it('a SUCCESSFUL read of a disk with no schedule DOES say backups are missing', () => {
        // The positive control. Without it, a script that never printed the
        // alarming sentence at all would pass the test above identically —
        // and this drill exists precisely to print it when it is true.
        const out = runDrill(stub({ describe: 'echo ""' }));

        expect(out).toContain(NO_BACKUPS);
        expect(out).not.toContain(CANNOT_ASK_DISK);
    });

    it('a FAILING snapshot list says the list failed, not that there is nothing to restore', () => {
        const out = runDrill(
            stub({
                describe: `echo "${POLICY_URL}"`,
                snapshots: 'echo "ERROR: RESOURCE_EXHAUSTED: stubbed" >&2; exit 1',
            }),
        );

        expect(out).toContain(CANNOT_ASK_SNAPSHOTS);
        expect(out).not.toContain(NOTHING_TO_RESTORE);
        expect(out).toContain('RESOURCE_EXHAUSTED');
    });

    it('a SUCCESSFUL but EMPTY snapshot list does say there is nothing to restore', () => {
        // Second positive control, for the second assertion.
        const out = runDrill(stub({ describe: `echo "${POLICY_URL}"`, snapshots: 'echo ""' }));

        expect(out).toContain(NOTHING_TO_RESTORE);
        expect(out).not.toContain(CANNOT_ASK_SNAPSHOTS);
    });

    it('the drill reached step 1 at all — the harness is not passing vacuously', () => {
        // If the script ever grew a prerequisite check that exits before step 1,
        // every assertion above would pass on an empty string.
        const out = runDrill(stub({ describe: 'exit 1' }));
        expect(out).toContain('1/5');
    });
});

describe('a zone with no capacity is NOT a broken backup', () => {
    it('exits 75 (EX_TEMPFAIL) and says the backup was NOT TESTED', () => {
        // 2026-09-01, both targets: ZONE_RESOURCE_POOL_EXHAUSTED, and the
        // summary announced "The production backup did not restore cleanly" —
        // a false alarm about the one control standing between a snapshot
        // schedule and an unrecoverable database.
        const out = runDrill(
            healthyThroughStep2(`cat <<'EOF' >&2
${GCLOUD_CAPACITY_STDERR}EOF
exit 1`),
        );

        // It got past the two checks that DO speak to backup health, and both
        // passed — which is exactly why this is not a backup failure.
        expect(out).toContain('✓ attached');
        expect(out).toContain('✓ fresh');
        // And it says so, in those words.
        expect(out).toContain('out of capacity');
        expect(out).toContain('NOT tested');
        expect(out).not.toContain('did not restore cleanly');
    });

    it('tries every zone in the region before giving up', () => {
        const out = runDrill(
            healthyThroughStep2(`cat <<'EOF' >&2
${GCLOUD_CAPACITY_STDERR}EOF
exit 1`),
            // A real zone name: the sibling candidates are DERIVED from it, and
            // the default harness zone is a placeholder with no region part.
            { GCP_ZONE: 'europe-west1-b' },
        );

        // A single pinned zone is the whole defect. The log must show the
        // fallback happening, or a future reader cannot tell a one-zone retry
        // from a real sweep.
        expect(out).toContain('zones to try:');
        for (const z of ['europe-west1-b', 'europe-west1-c', 'europe-west1-d']) {
            expect(out).toContain(z);
        }
    });

    it('a NON-capacity provisioning error still fails hard, and quotes gcloud', () => {
        // The classifier must not swallow real problems. An IAM error is not
        // something to retry into a confusing multi-zone trace.
        const out = runDrill(
            healthyThroughStep2(`echo "ERROR: PERMISSION_DENIED: stubbed" >&2; exit 1`),
        );

        expect(out).toContain('not a capacity problem');
        expect(out).toContain('PERMISSION_DENIED');
        expect(out).not.toContain('out of capacity');
    });
});

describe('the capacity classifier survives gcloud rewording', () => {
    it('recognises the HUMAN sentence even with no machine `code:` line', () => {
        // The forward-looking half, and the reason the patterns are not keyed
        // on ZONE_RESOURCE_POOL_EXHAUSTED alone.
        //
        // gcloud prints two descriptions of the same fact: a machine `code:`
        // and a human `localizedMessage`. Only the first carries the word
        // EXHAUSTED. If a future gcloud drops or renames the code line — a
        // formatting change, not a behaviour change — a code-only classifier
        // silently stops matching, and the fall-through is `fail`, which
        // prints "The production backup did not restore cleanly".
        //
        // So this case feeds ONLY the human sentence. It is a test about a
        // dependency we do not control, which is exactly the class this repo
        // warns cannot be covered by mocking our own side.
        const humanOnly = String.raw`ERROR: (gcloud.compute.disks.create) Could not fetch resource:
message: A 80GB pd-balanced disk is currently unavailable in the europe-west1-b zone.
  Please try your request again in another zone.
`;
        const out = runDrill(
            healthyThroughStep2(`cat <<'EOF' >&2\n${humanOnly}EOF\nexit 1`),
            { GCP_ZONE: 'europe-west1-b' },
        );

        expect(out).toContain('out of capacity');
        expect(out).toContain('NOT tested');
        expect(out).not.toContain('did not restore cleanly');
        expect(out).not.toContain('not a capacity problem');
    });
});

