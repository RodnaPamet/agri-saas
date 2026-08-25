/**
 * The parity proof must be RE-RUN when the merge mechanism changes.
 *
 * ## Why this guard exists
 *
 * The coverage gate scores its floors on a map that `scripts/merge-coverage.mjs`
 * assembled from six shards — not on a live jest run. That is only sound because
 * the merge was proven decimal-identical to a single-process reference run:
 *
 *     parity run 32769512898, commit fe56063d, 2026-08-24
 *     file set 1382 = 1382 · all 1382 files identical · all five groups identical
 *
 * Re-run because the POPULATION changed, not the mechanism: coverage moved into
 * the `test` job, which has redis, so `bullmq-real-api.test.ts` now executes and
 * enters the denominator for the first time. The mechanism inputs this file pins
 * were all unchanged, so the guard stayed green — and that is exactly why the
 * re-run was worth doing by hand. A constant that is merely DEFENSIBLE is not
 * the same as one that is TRUE.
 *
 * That proof is a snapshot. It says nothing about a merge mechanism that has
 * since changed — a jest major that alters `_checkThreshold`, an istanbul major
 * that changes how `CoverageMap.merge` keys entries, an edit to the merge script
 * itself, or a different shard count.
 *
 * CLAUDE.md and `coverage-reference.yml` both TELL a reader to re-run the proof
 * when that happens. This makes it self-enforcing instead: change any input and
 * CI stops and asks, rather than relying on somebody remembering a sentence in a
 * docblock six months from now.
 *
 * ## Deliberately NOT a content hash of whole files
 *
 * Hashing `merge-coverage.mjs` wholesale would fire on a typo fix in a comment,
 * which trains people to bump the constant without thinking — the exact failure
 * mode that makes a ratchet worthless. This pins the things that can actually
 * change the NUMBERS: the major versions of the two libraries whose algorithms
 * the merge depends on, and the shard count the merge asserts with `--expect`.
 *
 * ## When this fails
 *
 * Run the `Coverage parity (reference run)` workflow on a merged commit with a
 * live `coverage-report` artifact. If it reports PARITY PROVEN, update
 * `PARITY_PROOF` below with the new run id, commit and date, plus whichever
 * input changed. **If it fails, find the divergence — do not update this
 * constant, and do not move the floors in `jest.thresholds.json`.**
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The last time sharded and unsharded coverage were proven identical, and the
 * mechanism inputs that proof was valid for.
 */
const PARITY_PROOF = {
    runId: '32769512898',
    commit: 'fe56063d',
    date: '2026-08-24',
    /** Majors only — a patch bump cannot change merge semantics. */
    jestMajor: 30,
    istanbulLibCoverageMajor: 3,
    shardCount: 6,
} as const;

function installedMajor(pkg: string): number {
    const { version } = require(`${pkg}/package.json`) as { version: string };
    return Number(version.split('.')[0]);
}

const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

const REMEDY =
    'Re-run the "Coverage parity (reference run)" workflow on a merged commit, ' +
    'then update PARITY_PROOF in this file with the new run id, commit and date. ' +
    'If the parity run FAILS, find the divergence — do not update this constant, ' +
    'and do not move the floors in jest.thresholds.json.';

describe('coverage parity proof is still current', () => {
    it('jest major is unchanged since the proof', () => {
        const major = installedMajor('jest');
        expect({ major, remedy: major === PARITY_PROOF.jestMajor ? '' : REMEDY }).toEqual({
            major: PARITY_PROOF.jestMajor,
            remedy: '',
        });
    });

    it('istanbul-lib-coverage major is unchanged since the proof', () => {
        // CoverageMap.merge is the algorithm the whole gate rests on: it keys on
        // SOURCE LOCATION, so hit counts sum and covered/total sets union. A major
        // bump is exactly where that could stop being true.
        const major = installedMajor('istanbul-lib-coverage');
        expect({ major, remedy: major === PARITY_PROOF.istanbulLibCoverageMajor ? '' : REMEDY }).toEqual({
            major: PARITY_PROOF.istanbulLibCoverageMajor,
            remedy: '',
        });
    });

    it('the shard count is unchanged since the proof', () => {
        // Scoped to the job that COLLECTS coverage, which is `test` — coverage
        // was folded into it so the gate could run on pull requests. ci.yml
        // declares more than one shard matrix (`test` 6-way, `e2e-shard` 2-way),
        // and an unanchored /shard:\s*\[/ matches whichever comes first,
        // silently asserting against the wrong job. The first draft of this
        // guard did exactly that and read 4 where it meant 6.
        //
        // This anchor previously pointed at a standalone `coverage:` job. That
        // job was deleted by the fold, and because the two changes touched no
        // file in common, git merged them cleanly and the guard would have
        // failed on main — a semantic collision git cannot see. Caught by
        // merging main into the fold branch and re-running, before either
        // landed.
        // The end anchor is found STRUCTURALLY — the next top-level job — not by
        // name. A hardcoded next-job name is worse than no anchor: `indexOf`
        // returns -1 for a name that does not exist, `slice(start, -1)` then runs
        // to the end of the FILE, and the assertion passes only because `test`'s
        // matrix happens to be the first one it meets. That is a guard passing by
        // accident, which is indistinguishable from one passing on purpose until
        // the job order changes. (Observed while writing this: an end anchor of
        // `test-gate:` — a job that does not exist — did exactly that.)
        const jobStart = ci.indexOf('\n  test:\n');
        expect(jobStart).toBeGreaterThan(-1);
        const rest = ci.slice(jobStart + 1);
        const nextJob = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
        expect(nextJob).toBeGreaterThan(-1);
        const jobBlock = rest.slice(0, nextJob + 1);
        const matrix = jobBlock.match(/shard:\s*\[([0-9,\s]+)\]/);
        expect(matrix).not.toBeNull();
        const count = (matrix as RegExpMatchArray)[1].split(',').filter((x) => x.trim()).length;
        expect({ count, remedy: count === PARITY_PROOF.shardCount ? '' : REMEDY }).toEqual({
            count: PARITY_PROOF.shardCount,
            remedy: '',
        });
    });

    it('--expect matches the shard count, so a dead shard still refuses', () => {
        // Not about staleness — about the two numbers never drifting apart. If
        // --expect were lowered to match a reduced matrix by accident, a missing
        // shard would pass silently and RAISE the reported percentages.
        const expectFlag = ci.match(/--expect\s+(\d+)/);
        expect(expectFlag).not.toBeNull();
        expect(Number((expectFlag as RegExpMatchArray)[1])).toBe(PARITY_PROOF.shardCount);
    });

    it('the gate is actually enforcing — --report-only is not passed', () => {
        // The whole proof exists to justify enforcement. If the flag came back,
        // the proof would be certifying a gate that cannot fail.
        const gateStep = ci.slice(ci.indexOf('name: "Gate: test coverage thresholds"'));
        const runBlock = gateStep.slice(0, gateStep.indexOf('- name:', 10));
        const executable = runBlock
            .split('\n')
            .filter((l) => !l.trim().startsWith('#'))
            .join('\n');
        expect(executable).toContain('check-coverage-thresholds.mjs');
        expect(executable).not.toContain('--report-only');
    });

    it('names a real parity run, so the claim is checkable', () => {
        expect(PARITY_PROOF.runId).toMatch(/^\d{8,}$/);
        expect(PARITY_PROOF.commit).toMatch(/^[0-9a-f]{7,40}$/);
        expect(PARITY_PROOF.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});
