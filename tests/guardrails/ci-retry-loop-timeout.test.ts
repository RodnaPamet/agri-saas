/**
 * Structural ratchet — every CI retry loop must bound each attempt.
 *
 * On 2026-07-31 the `Semantic Release` job on main was reported as
 * `cancelled`. It was not cancelled by anyone: `npm ci` printed output
 * for ~2 minutes, then stalled silently for ~8 more until the job's
 * `timeout-minutes: 10` killed it (cleanup logged
 * `Terminate orphan process: pid (2205) (npm ci)`).
 *
 * The install step was already wrapped in a retry loop added as "CI
 * hardening", and that loop was inert:
 *
 *     for attempt in 1 2 3; do
 *       if npm ci; then exit 0; fi          # <- only re-enters when npm RETURNS
 *       ...
 *     done
 *
 * A hang never returns, so attempt 1 consumed the entire job budget and
 * attempts 2 and 3 never existed. The guard read as protective but had
 * no path to executing under the condition that actually occurred — it
 * defends against a fast failure (the ETIMEDOUT its comment cites), not
 * against a stall.
 *
 * The fix is a per-attempt cap (`timeout <n> npm ci`) so a hung attempt
 * is killed well inside the job budget and the retry actually gets to
 * run. That also demotes `timeout-minutes` back to being a runaway
 * backstop rather than the only bound in the system.
 *
 * This ratchet asserts the property structurally, for EVERY retry loop
 * in EVERY workflow — the same pattern is duplicated in `ci.yml`
 * (Security, a required check) and `release.yml`, and a third copy is
 * the obvious next step. The regression class it catches: someone
 * "simplifying" the `timeout` away, or adding a fourth retry loop
 * without one.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github/workflows');
/**
 * Composite actions were OUTSIDE this guard until 2026-09-04, and that gap is
 * the reason it is worth naming rather than quietly widening.
 *
 * This file exists because a `npm ci` hang ate a job budget in `release.yml`
 * on 2026-07-31 — attempts 2 and 3 never ran. The fix bounded the loop in the
 * workflow, and the guard was scoped to `.github/workflows`. But the SAME
 * unbounded loop lived in `.github/actions/setup-node-prisma`, which eight
 * jobs install through, and no scan ever looked there. The hazard the guard
 * was written for went on existing in the path most jobs actually take, while
 * the guard stayed green.
 *
 * A directory is not a boundary of behaviour. Scope a guard to where the
 * PATTERN can occur, not to where an instance of it was first found.
 */
const ACTION_DIR = path.join(REPO_ROOT, '.github/actions');

/**
 * Normal `npm ci` on these runners is 41-60s (measured across five
 * consecutive runs of both jobs). The observed hang ran 602s. Any
 * per-attempt cap between those two numbers separates the cases; the
 * ceiling here keeps a future edit from setting one so high it stops
 * distinguishing them.
 */
const MAX_ATTEMPT_TIMEOUT_SECONDS = 300;

interface RetryLoop {
    file: string;
    /** 1-indexed line of the `for attempt in ...` that opens the loop. */
    line: number;
    body: string;
}

/** Every YAML that can carry a shell retry loop: workflows AND composite actions. */
function candidateFiles(): Array<{ rel: string; abs: string }> {
    const out: Array<{ rel: string; abs: string }> = [];
    for (const name of fs.readdirSync(WORKFLOW_DIR)) {
        if (!/\.ya?ml$/.test(name)) continue;
        out.push({ rel: `.github/workflows/${name}`, abs: path.join(WORKFLOW_DIR, name) });
    }
    if (fs.existsSync(ACTION_DIR)) {
        for (const dir of fs.readdirSync(ACTION_DIR)) {
            for (const f of ['action.yml', 'action.yaml']) {
                const abs = path.join(ACTION_DIR, dir, f);
                if (fs.existsSync(abs)) out.push({ rel: `.github/actions/${dir}/${f}`, abs });
            }
        }
    }
    return out;
}

function findRetryLoops(): RetryLoop[] {
    const loops: RetryLoop[] = [];

    for (const { rel, abs } of candidateFiles()) {
        const lines = fs.readFileSync(abs, 'utf-8').split('\n');

        lines.forEach((text, i) => {
            if (!/^\s*for\s+attempt\s+in\b/.test(text)) return;
            // Body runs to the matching `done`, which the repo's shell
            // blocks always indent to the same column as the `for`.
            const indent = text.length - text.trimStart().length;
            const end = lines.findIndex(
                (l, j) => j > i && l.trimStart().startsWith('done') && l.length - l.trimStart().length === indent,
            );
            loops.push({
                file: rel,
                line: i + 1,
                body: lines.slice(i, end === -1 ? lines.length : end + 1).join('\n'),
            });
        });
    }

    return loops;
}

describe('CI retry loops bound each attempt', () => {
    const loops = findRetryLoops();

    it('finds the retry loops it is meant to police', () => {
        // Detector self-check. If the loops are ever restructured (or
        // renamed away from `for attempt in`), this fails loudly rather
        // than letting the suite pass vacuously over zero matches --
        // the exact failure mode the guard exists to prevent.
        expect(loops.length).toBeGreaterThanOrEqual(2);
        expect(loops.map((l) => l.file)).toEqual(
            expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/release.yml']),
        );
    });

    it.each(findRetryLoops().map((l) => [`${l.file}:${l.line}`, l] as const))(
        'caps each attempt in %s',
        (_label, loop) => {
            const match = loop.body.match(/\btimeout\s+(?:-k\s+\d+\s+)?(\d+)\b/);

            expect(match).not.toBeNull();

            const seconds = Number(match![1]);
            expect(seconds).toBeGreaterThan(0);
            expect(seconds).toBeLessThanOrEqual(MAX_ATTEMPT_TIMEOUT_SECONDS);
        },
    );

    it.each(findRetryLoops().map((l) => [`${l.file}:${l.line}`, l] as const))(
        'leaves room for a second attempt inside the job budget in %s',
        (_label, loop) => {
            // A cap that exceeds the job's own timeout is no cap at all:
            // the job dies first and the retry still never runs. Parse
            // the owning job's `timeout-minutes` and require that at
            // least two full attempts (plus the backoff sleeps) fit.
            const source = fs.readFileSync(path.join(REPO_ROOT, loop.file), 'utf-8');
            const upTo = source.split('\n').slice(0, loop.line).join('\n');
            const budgets = [...upTo.matchAll(/^\s*timeout-minutes:\s*(\d+)/gm)];

            // A COMPOSITE ACTION has no budget of its own — GitHub does not
            // allow `timeout-minutes` on a step inside one, which is precisely
            // why its loops had no ceiling and why they were worth pulling
            // into this guard. The budget that constrains them belongs to the
            // JOBS that use the action, and
            // `tests/guards/setup-job-budget-floor.test.ts` holds those at a
            // floor of 10 minutes. Compose against that floor rather than
            // skipping the file: the two guards together say "the loop fits
            // inside the smallest budget any caller is allowed to declare".
            const COMPOSITE_CALLER_FLOOR_SECONDS = 10 * 60;
            const isCompositeAction = loop.file.startsWith('.github/actions/');
            if (!isCompositeAction) expect(budgets.length).toBeGreaterThan(0);

            const budgetSeconds = isCompositeAction
                ? COMPOSITE_CALLER_FLOOR_SECONDS
                : Number(budgets[budgets.length - 1][1]) * 60;
            const capped = loop.body.match(/\btimeout\s+(?:-k\s+\d+\s+)?(\d+)\b/);

            // Reported as a plain assertion rather than an inherited
            // TypeError, so an uncapped loop reads the same way here as
            // it does in the sibling test above.
            expect(capped).not.toBeNull();

            const attemptSeconds = Number(capped![1]);
            const sleepSeconds = Number(loop.body.match(/^\s*sleep\s+(\d+)/m)?.[1] ?? 0);

            expect(attemptSeconds * 2 + sleepSeconds).toBeLessThan(budgetSeconds);
        },
    );
});
