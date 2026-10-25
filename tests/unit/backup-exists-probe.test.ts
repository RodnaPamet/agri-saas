/**
 * The daily backup-existence probe — #2329.
 *
 * Drives `.github/scripts/backup-exists.sh` against a stubbed `gcloud` and
 * `gh`, asserting the verdict and the exit code. No network, no GCP, no
 * GitHub.
 *
 * ## Why this file is not optional
 *
 * The probe was written in a project that had NO backup, so the only verdict
 * reachable by running it was `MISSING`. A check whose passing branch has
 * never executed is not a check — it is a constant that happens to read like
 * one, and it stays that way until the day it matters, which is the day
 * somebody fixes the backups and wants to know whether the alarm clears.
 *
 * So `OK` is exercised here through both mechanisms, and so is the boundary.
 *
 * ## The exit code is a separate assertion from the verdict
 *
 * `MISSING` exits **0** on purpose: the issue it files is the signal, and a red
 * run would make `ci-failure-issue.yml` file a second issue about the same
 * outage. `UNANSWERABLE` exits **non-zero**, because a probe that could not
 * read its subject must never be filed under the same heading as one that read
 * it and found things well. Those two live one branch apart and the verdict
 * string alone does not distinguish them, so both are checked.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/backup-exists.sh');

/** Pinned "now". Ambient time cannot be allowed to pick the verdict. */
const NOW_ISO = '2026-10-25T12:00:00Z';
const NOW_EPOCH = Math.floor(Date.parse(NOW_ISO) / 1000);

interface Scenario {
    /** `value(name,creationTimestamp)` output, tab-separated, or '' for none. */
    snapshot?: string;
    /** Bucket names, newline-separated, or '' for none. */
    buckets?: string;
    /** `gcloud storage ls -l` output. */
    objects?: string;
    /** An already-open issue number, or '' for none. */
    openIssue?: string;
    /** Make every gcloud call fail, as an auth or API error would. */
    gcloudFails?: boolean;
}

interface Result {
    out: string;
    status: number;
    verdict: string;
    calls: string[];
}

function run(s: Scenario): Result {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-probe-'));
    try {
        const callLog = path.join(dir, 'calls.txt');

        // `%b`, not `%s`. JSON.stringify emits a tab as the two characters
        // `\` `t`, and `printf '%s'` does not interpret escapes in its
        // ARGUMENT — only in its format. With `%s` the stub handed the script
        // one unsplittable field, every snapshot scenario came back
        // UNANSWERABLE, and the multi-line bucket listing was silently a
        // single line, so the TOTAL-line case below asserted nothing. The stub
        // was lying to the script; the script was right.
        const gcloud = `#!/usr/bin/env bash
${s.gcloudFails ? 'echo "ERROR: (gcloud.compute) PERMISSION_DENIED" >&2; exit 1' : ''}
case "$*" in
  *"compute snapshots list"*) printf '%b' ${JSON.stringify(s.snapshot ?? '')} ;;
  *"storage buckets list"*)   printf '%b' ${JSON.stringify(s.buckets ?? '')} ;;
  *"storage ls"*)             printf '%b' ${JSON.stringify(s.objects ?? '')} ;;
esac
exit 0
`;
        // Newlines squashed to spaces so one invocation stays one log line —
        // the issue body is multi-line and would otherwise split across
        // entries, hiding which command was actually run.
        const gh = `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "\${args//$'\\n'/ }" >> ${JSON.stringify(callLog)}
case "$1 $2" in
  "issue list") printf '%s' ${JSON.stringify(s.openIssue ?? '')} ;;
esac
exit 0
`;
        const gcloudBin = path.join(dir, 'gcloud');
        const ghBin = path.join(dir, 'gh');
        fs.writeFileSync(gcloudBin, gcloud, { mode: 0o755 });
        fs.writeFileSync(ghBin, gh, { mode: 0o755 });

        let out = '';
        let status = 0;
        try {
            out = execFileSync('bash', [SCRIPT], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GCLOUD: gcloudBin,
                    GH: ghBin,
                    GITHUB_REPOSITORY: 'RodnaPamet/agri-saas',
                    NOW_OVERRIDE_EPOCH: String(NOW_EPOCH),
                    TARGET_DISK: 'agrent',
                    MAX_AGE_HOURS: '26',
                    // Never inherited: a real value in the environment would
                    // silently replace discovery in every scenario below.
                    BACKUP_BUCKET: '',
                },
            });
        } catch (e) {
            const err = e as { status?: number; stdout?: string };
            status = err.status ?? -1;
            out = err.stdout ?? '';
        }

        const calls = fs.existsSync(callLog)
            ? fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean)
            : [];
        const verdict = (/^BACKUP_RESULT=(\w+)/m.exec(out) ?? [])[1] ?? 'NO_VERDICT_LINE';
        return { out, status, verdict, calls };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const hoursAgo = (h: number) => new Date((NOW_EPOCH - h * 3600) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const created = (c: string[]) => c.some((l) => l.startsWith('issue create'));
const commented = (c: string[]) => c.some((l) => l.startsWith('issue comment'));
const closed = (c: string[]) => c.some((l) => l.startsWith('issue close'));

describe('backup-exists probe — the daily half of the backup question (#2329)', () => {
    it('finds nothing when there is nothing, and FILES — the state this repo was in', () => {
        const r = run({ snapshot: '', buckets: '' });
        expect(r.verdict).toBe('MISSING');
        expect(r.out).toContain('snapshot: ABSENT');
        expect(r.out).toContain('bucket: ABSENT');
        expect(created(r.calls)).toBe(true);
        // Zero on purpose: the issue is the signal. See the script header.
        expect(r.status).toBe(0);
    });

    it('a FRESH snapshot reports OK and files nothing', () => {
        const r = run({ snapshot: `agrent-snap-1\t${hoursAgo(6)}`, buckets: '' });
        expect(r.verdict).toBe('OK');
        expect(r.out).toContain('snapshot: PRESENT and fresh');
        expect(created(r.calls)).toBe(false);
        expect(r.status).toBe(0);
    });

    it('a FRESH BUCKET OBJECT alone reports OK — the mechanisms are independent', () => {
        // The load-bearing case for enumerating mechanisms. A probe hard-coded
        // to snapshots would call this MISSING while a perfectly good
        // application-consistent dump sat in a bucket.
        const r = run({
            snapshot: '',
            buckets: 'agrent-db-backups',
            objects: `412890  ${hoursAgo(11)}  gs://agrent-db-backups/agrent/x.dump\nTOTAL: 1 objects, 412890 bytes`,
        });
        expect(r.verdict).toBe('OK');
        expect(r.out).toContain('bucket: PRESENT and fresh');
        expect(r.out).toContain('gs://agrent-db-backups/agrent/x.dump');
        expect(created(r.calls)).toBe(false);
    });

    it("the TOTAL line is not read as an object", () => {
        // `gcloud storage ls -l` ends with `TOTAL: n objects, n bytes`, which
        // has no date. Parsed as a row it yields a junk timestamp, and the
        // script dies UNANSWERABLE on an unparseable stamp — so a bucket with
        // ONLY a total line must come out ABSENT, not unanswerable.
        const r = run({ snapshot: '', buckets: 'agrent-db-backups', objects: 'TOTAL: 0 objects, 0 bytes' });
        expect(r.verdict).toBe('MISSING');
        expect(r.out).toContain('bucket: ABSENT');
    });

    it('a 13-day-old snapshot is STALE, not present — the real 2026-10-12 shape', () => {
        const r = run({ snapshot: `agrent-snap-old\t${hoursAgo(13 * 24)}`, buckets: '' });
        expect(r.verdict).toBe('MISSING');
        expect(r.out).toMatch(/snapshot: STALE .*312h old, limit 26h/);
        expect(created(r.calls)).toBe(true);
    });

    it('the 26h boundary admits 25h and rejects 27h', () => {
        // A threshold nobody tested either side of is a number, not a limit.
        expect(run({ snapshot: `s\t${hoursAgo(25)}`, buckets: '' }).verdict).toBe('OK');
        expect(run({ snapshot: `s\t${hoursAgo(27)}`, buckets: '' }).verdict).toBe('MISSING');
    });

    it('a gcloud failure is UNANSWERABLE and exits NON-ZERO, and files nothing', () => {
        const r = run({ gcloudFails: true });
        expect(r.verdict).toBe('UNANSWERABLE');
        // The distinction the whole issue is about: nobody looked must not be
        // filed, or read, as nothing is wrong.
        expect(r.status).not.toBe(0);
        expect(created(r.calls)).toBe(false);
        expect(commented(r.calls)).toBe(false);
    });

    it('an unparseable timestamp is UNANSWERABLE, never silently old', () => {
        // Treating a format change as "very old" would file a plausible,
        // permanent, wrong issue and train everyone to ignore this probe.
        const r = run({ snapshot: 'agrent-snap-1\tnot-a-timestamp', buckets: '' });
        expect(r.verdict).toBe('UNANSWERABLE');
        expect(r.status).not.toBe(0);
    });

    it('an open issue gets a COMMENT, not a duplicate', () => {
        const r = run({ snapshot: '', buckets: '', openIssue: '4242' });
        expect(r.verdict).toBe('MISSING');
        expect(commented(r.calls)).toBe(true);
        expect(created(r.calls)).toBe(false);
    });

    it('a recovered backup CLOSES the open issue — the alarm clears itself', () => {
        const r = run({ snapshot: `agrent-snap-1\t${hoursAgo(2)}`, buckets: '', openIssue: '4242' });
        expect(r.verdict).toBe('OK');
        expect(closed(r.calls)).toBe(true);
        expect(r.calls.some((l) => l.includes('4242'))).toBe(true);
    });

    it('always emits exactly one verdict line, whatever happens', () => {
        // The step that consumes this greps for the line. A path that returns
        // without one is indistinguishable from a probe nobody ran.
        for (const s of [
            { snapshot: '', buckets: '' },
            { snapshot: `s\t${hoursAgo(1)}`, buckets: '' },
            { gcloudFails: true },
            { snapshot: 's\tbroken', buckets: '' },
        ] as Scenario[]) {
            const r = run(s);
            expect((r.out.match(/^BACKUP_RESULT=/gm) ?? []).length).toBe(1);
        }
    });
});
