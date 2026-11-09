/**
 * The scheduled selector audit's rotation — #2678.
 *
 * ## What has to be true, and what a green suite would otherwise hide
 *
 * The rotation's whole job is that EVERY guard is audited within one cycle. A
 * bucketing fault that returned a constant would audit the same eighth every
 * week for ever and leave the other seven eighths untouched — and from
 * outside, a weekly run that audits ~86 files and reports them clean looks
 * identical whether those are the same 86 files or a rotating set. So the
 * load-bearing assertion here is the PARTITION property across a full cycle,
 * not "a week selects something".
 *
 * That is the same defect one level up from the one #2678 reports: a scheduled
 * audit that examines nothing while reporting success.
 *
 * ## Spawned, never imported
 *
 * `spawnSync` on the real script, which is this repo's pattern for a `.mjs`
 * tool (see `tests/unit/coverage-tooling/coverage-scripts.test.ts`): jest here
 * cannot `require` an ES module, and the executable surface — including the
 * two refusals — is what CI actually invokes. `spawnSync` rather than
 * `execFileSync` so a non-zero status is a VALUE to assert on instead of an
 * exception whose stderr is awkward to reach.
 *
 * The cycle length is READ FROM THE CLI's own banner rather than restated
 * here. A second copy of the constant is the one that goes stale, and a test
 * that hardcoded 8 would keep passing after someone changed the script to 4
 * while silently checking the wrong cycle.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

const SCRIPT = path.join(__dirname, '../../../scripts/selector-teeth-rotation.mjs');

/** A population shaped like the real one — enough paths to fill every bucket. */
const FILES = Array.from({ length: 400 }, (_, i) => `tests/guards/guard-${i}.test.ts`);

function run(stdin: string, week: string) {
    return spawnSync('node', [SCRIPT], {
        input: stdin,
        encoding: 'utf8',
        env: { ...process.env, SELECTOR_TEETH_ROTATION_WEEK: week },
    });
}

/** The slice for a week, as the CLI prints it. */
function slice(files: string[], week: number): string[] {
    const r = run(files.join('\n'), String(week));
    expect(r.status).toBe(0);
    return r.stdout.split('\n').filter(Boolean);
}

/**
 * The cycle length, taken from the tool rather than restated.
 *
 * It asks with the FULL population on purpose. A single-file population is
 * empty for every week but one, which trips the tool's own empty-slice
 * refusal — the first draft of this helper did exactly that and the suite
 * failed to run at all.
 */
function cycleLength(): number {
    const r = run(FILES.join('\n'), '0');
    expect(r.status).toBe(0);
    const m = r.stderr.match(/bucket \d+ of (\d+)/);
    expect(m).not.toBeNull();
    return Number(m![1]);
}

/** Which week selects this file — derived, so no bucket maths is duplicated. */
function weekOf(file: string, buckets: number): number {
    for (let w = 0; w < buckets; w++) {
        if (run(file, String(w)).status === 0) return w;
    }
    throw new Error(`no week in 0..${buckets - 1} selects ${file}`);
}

const BUCKETS = cycleLength();

describe('the scheduled audit rotates over the whole guard population', () => {

    it('reports a cycle length at all', () => {
        // The control for every assertion below: they all range over BUCKETS,
        // so a banner that stopped printing would make this suite iterate zero
        // times and pass over nothing.
        expect(BUCKETS).toBeGreaterThan(1);
    });

    it('one full cycle covers every file EXACTLY once', () => {
        const seen = new Map<string, number>();
        for (let w = 0; w < BUCKETS; w++) {
            for (const f of slice(FILES, w)) seen.set(f, (seen.get(f) ?? 0) + 1);
        }
        // Union is the whole population: nothing is never audited.
        expect(seen.size).toBe(FILES.length);
        // And nothing twice in one cycle, which would mean something else zero
        // times. Named, so a failure says WHICH file rather than a count.
        expect([...seen.entries()].filter(([, n]) => n !== 1)).toEqual([]);
    });

    it('every week audits something, so no week is a free pass', () => {
        const sizes = Array.from({ length: BUCKETS }, (_, w) => slice(FILES, w).length);
        expect(Math.min(...sizes)).toBeGreaterThan(0);
        // Roughly even. Not a grade on the hash — it catches clustering, which
        // would make one week carry most of the cost and the rest carry none.
        expect(Math.max(...sizes)).toBeLessThan((FILES.length / BUCKETS) * 2);
    });

    it("a file's week does not move when the population grows", () => {
        // THE REASON THE BUCKET IS A PATH HASH AND NOT A LIST POSITION. With
        // `files[i::8]`, adding one guard shifts membership for everything
        // after it, so a file can be skipped for months or audited twice in a
        // row — and nothing would show it.
        const target = 'tests/guards/zz-stable.test.ts';
        const before = weekOf(target, BUCKETS);
        const grown = ['tests/guards/aaa-brand-new.test.ts', ...FILES, target];
        expect(slice(grown, before)).toContain(target);
        // And it is still absent from the other weeks.
        for (let w = 0; w < BUCKETS; w++) {
            if (w !== before) expect(slice(grown, w)).not.toContain(target);
        }
    });
});

describe('the rotation CLI fails loudly rather than auditing the wrong thing', () => {

    it('REFUSES a non-integer week instead of falling back to now', () => {
        // A typo'd override that silently audited the current bucket would be
        // indistinguishable from the rotation working.
        const r = run(FILES.join('\n'), 'last');
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/not an integer/);
    });

    it('REFUSES an empty slice over a non-empty population', () => {
        // One file, and a week whose bucket is not that file's: the slice is
        // empty through no fault of the population. Reporting that as
        // "nothing to audit" IS the #2678 defect.
        const one = 'tests/guards/only-one.test.ts';
        const wrong = (weekOf(one, BUCKETS) + 1) % BUCKETS;
        const r = run(one, String(wrong));
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/EMPTY over a non-empty population/);
    });

    it('an empty population is NOT an error — there is genuinely nothing', () => {
        const r = run('', '0');
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
    });

    it('a negative week still selects a real bucket', () => {
        // JS `%` is negative for negative input, so a bad override could ask
        // for bucket -3 and match nothing.
        const r = run(FILES.join('\n'), '-3');
        expect(r.status).toBe(0);
        expect(r.stdout.split('\n').filter(Boolean).length).toBeGreaterThan(0);
    });
});

/*
 * The WIRING, executed — not asserted about.
 *
 * The rotation above is correct in isolation and that proves nothing about CI:
 * #2678 is a defect in which event reaches which branch of the plan step, so
 * the only test that can see it runs the step. The `run:` block is lifted out
 * of `ci.yml` and executed under `bash -e`, the shell GitHub uses for a step
 * with no `shell:` — the same technique as
 * `tests/guards/ci-aggregate-upstream-failure.test.ts`.
 *
 * THREE EVENTS, THREE OUTCOMES, and the last two are why this is a trio. The
 * change restructured a `case` and wrapped the diff-based selection in an
 * `if`, so the ways to break it are to stop refusing a baseless
 * `pull_request` (which would report a green audit over nothing — the very
 * thing the step exists to prevent) or to start auditing on a first branch
 * push. A test of the schedule arm alone would miss both.
 */
describe('the plan step routes each baseless event to the right branch', () => {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const yaml = require('js-yaml') as typeof import('js-yaml');
    const ROOT = path.join(__dirname, '../../..');

    /** The plan step's shell script, straight out of the workflow. */
    function planScript(): string {
        const doc = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
            jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
        };
        const step = doc.jobs['selector-teeth-plan'].steps.find((s) => s.id === 'plan');
        expect(step?.run).toBeTruthy();
        return step!.run!;
    }

    function runPlan(event: string, extraEnv: Record<string, string> = {}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
        const script = path.join(dir, 'plan.sh');
        const output = path.join(dir, 'gh-output');
        fs.writeFileSync(script, planScript());
        fs.writeFileSync(output, '');
        const r = spawnSync('bash', ['-e', script], {
            cwd: ROOT,
            encoding: 'utf8',
            env: {
                ...process.env,
                GITHUB_EVENT_NAME: event,
                BASE: '',
                GITHUB_OUTPUT: output,
                FILES_PER_SHARD: '3',
                ...extraEnv,
            },
        });
        return { ...r, out: fs.readFileSync(output, 'utf8') };
    }

    /** `total=N` as the step wrote it. */
    const totalOf = (out: string) => Number(out.match(/^total=(\d+)$/m)?.[1]);

    it('schedule: audits a real slice instead of nothing', () => {
        const r = runPlan('schedule');
        expect(r.status).toBe(0);
        const total = totalOf(r.out);
        // THE #2678 ASSERTION. This was 0 — a green audit of an empty set.
        expect(total).toBeGreaterThan(0);

        // The shards must COVER the total, which is the step's own partition
        // invariant: a matrix green over a subset is the silent truncation
        // this job was rebuilt to remove.
        const shards = JSON.parse(r.out.match(/^shards=(.+)$/m)![1]) as { files: string }[];
        expect(shards.length).toBeGreaterThan(0);
        const covered = shards.reduce((n, s) => n + s.files.split(' ').filter(Boolean).length, 0);
        expect(covered).toBe(total);

        // And every selected path is a guard file that EXISTS — a rotation
        // over stale paths would die in `auditFile` on ENOENT.
        for (const f of shards.flatMap((s) => s.files.split(' ').filter(Boolean))) {
            expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
        }
    });

    it('pull_request with no base still FAILS loudly', () => {
        // Unchanged behaviour, and the one that must not regress: a baseless
        // PR means something is misconfigured, and a pass there is a green
        // tick over an audit that examined nothing.
        const r = runPlan('pull_request');
        expect(r.status).not.toBe(0);
        expect(r.stdout + r.stderr).toMatch(/no base sha on a pull_request event/);
    });

    it("a rotation that REFUSES fails the step — it does not write total=0", () => {
        /*
         * THE ASSERTION THIS SUITE WAS MISSING, and the bug it found was mine.
         *
         * The schedule arm first read the slice as
         * `mapfile -t ALL < <(... | node rotation.mjs)`. Process substitution
         * DISCARDS the exit status of the pipeline inside it, and `pipefail`
         * does not reach in there — measured directly: a node process exiting
         * 1 in that position leaves the step at exit 0 with the array empty.
         *
         * So both of the rotation script's refusals — an empty slice, and a
         * malformed week override — would have been swallowed, `total=0`
         * written, the audit matrix skipped on its `total != '0'` gate, and the
         * weekly run would have reported a clean audit of NOTHING. That is
         * precisely the defect #2678 is about, reintroduced one level down by
         * the fix for it.
         *
         * A non-integer week is the cheapest way to make the script refuse.
         */
        const r = runPlan('schedule', { SELECTOR_TEETH_ROTATION_WEEK: 'not-a-week' });
        expect(r.status).not.toBe(0);
        // And it must NOT have claimed an empty population on the way out.
        expect(totalOf(r.out)).not.toBe(0);
        expect(r.stdout + r.stderr).toMatch(/could not produce a slice/);
    });

    it('a first branch push is still a legitimate no-op', () => {
        const r = runPlan('push');
        expect(r.status).toBe(0);
        // Written, not unset: an unset output reaches the aggregate as the
        // empty string and failed a required check on main (#2676).
        expect(totalOf(r.out)).toBe(0);
        expect(r.out).toMatch(/^shards=\[\]$/m);
    });
});
