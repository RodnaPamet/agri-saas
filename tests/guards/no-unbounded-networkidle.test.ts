/**
 * `waitForLoadState('networkidle')` must carry an explicit timeout.
 *
 * #748's larger half was "55 swallowed `networkidle` waits across 26 files".
 * Most were drained incrementally by other PRs; the last two lived in
 * `loginAndGetTenant`, the helper EVERY spec routes through, in this shape:
 *
 * ```ts
 * await page.waitForLoadState('networkidle').catch(() => {});
 * ```
 *
 * Two independent faults, and it is the combination that makes it invisible:
 *
 * - **Unbounded.** No `timeout:` means Playwright's 30s navigation default.
 * - **Swallowed.** `.catch(() => {})` discards the timeout, so the 30s is
 *   spent and nothing is reported. The spec still passes.
 *
 * So the cost is real wall clock that reads as a slow runner. That is exactly
 * the misdiagnosis #748 was opened on — `cancelled` looked like infrastructure
 * noise, and in one case a cancellation concealed two genuine failures.
 *
 * ── Why a timeout, rather than banning `networkidle` ──
 *
 * `networkidle` is occasionally the RIGHT condition. `fonts-self-hosted.spec.ts`
 * collects `.woff2` response events and genuinely needs the requests to have
 * finished; `mobile/horizontal-drift.spec.ts` keeps one because late-arriving
 * markup can only make its assertion FAIL, so measuring early would be a false
 * green rather than a flake. Both are legitimate. What is never legitimate is
 * not saying how long you are prepared to wait — an unbounded wait cannot be
 * budgeted, and a swallowed unbounded wait cannot even be observed.
 *
 * ── The latent version of this, which is worse ──
 *
 * `tests/guards/notif-sse-streaming-wiring.test.ts` records that the SSE client
 * cutover is deliberately held OFF so that "E2E specs that wait on
 * `networkidle` aren't blocked by a long-lived stream". A server-sent-event
 * stream never goes idle. So on the day that flag flips, every unbounded
 * `networkidle` in this tree stops being slow and starts being INFINITE —
 * bounded only by the 180s per-test budget, times three retries.
 *
 * This guard is what makes that flip safe: the population it can affect is
 * enumerated, and each member has already declared its own ceiling.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ROOTS = ['tests/e2e'];

/**
 * A `waitForLoadState('networkidle' …)` call, capturing its OWN argument list
 * up to the matching close paren.
 *
 * Anchored on the literal rather than on a fixed character window: a window
 * that overshoots picks up a neighbouring `timeout:` and declares an unbounded
 * call compliant, which is the direction that hides work. The same mistake
 * cost `no-server-authored-user-copy` 66 false exemptions.
 */
const CALL = /waitForLoadState\(\s*(['"`])networkidle\1/g;
/** Hard stop so a malformed file cannot make the scan run away. */
const MAX_ARG_SCAN = 300;

/** The remainder of the call's arguments, from `start` to its close paren. */
function argsAfter(src: string, start: number): string {
    let depth = 1;
    const end = Math.min(src.length, start + MAX_ARG_SCAN);
    for (let i = start; i < end; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return src.slice(start, i);
        }
    }
    return src.slice(start, end);
}

export interface NetworkIdleCall {
    file: string;
    line: number;
    bounded: boolean;
    swallowed: boolean;
}

/**
 * Every `waitForLoadState('networkidle')` under `dirs`, with its two
 * properties. Returns ALL calls, not just the bad ones — a guard whose
 * collector returns only violations cannot tell "clean" from "blind",
 * and the positive control below needs the full population.
 */
export function collectNetworkIdleCalls(root: string, dirs: string[] = ROOTS): NetworkIdleCall[] {
    const files = collectSourceFiles({
        roots: dirs.map((d) => path.join(root, d)),
        extensions: ['.ts'],
        // `floor` refuses a selection that has collapsed. tests/e2e is ~60
        // files; 20 is comfortably under it and far above zero.
        floor: root === REPO_ROOT ? 20 : 1,
    });

    const calls: NetworkIdleCall[] = [];
    for (const full of files) {
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(CALL)) {
            const idx = m.index ?? 0;
            const args = argsAfter(src, idx + m[0].length);
            // The tail after the call decides whether a rejection is observed.
            const tail = src.slice(idx + m[0].length + args.length, idx + m[0].length + args.length + 40);
            calls.push({
                file: path.relative(root, full),
                line: src.slice(0, idx).split('\n').length,
                bounded: /\btimeout\s*:/.test(args),
                swallowed: /^\s*\)?\s*\.catch\s*\(/.test(tail),
            });
        }
    }
    return calls;
}

describe('every networkidle wait declares its own ceiling', () => {
    const calls = collectNetworkIdleCalls(REPO_ROOT);

    it('no unbounded waitForLoadState(networkidle)', () => {
        const unbounded = calls.filter((c) => !c.bounded);
        if (unbounded.length > 0) {
            const shown = unbounded
                .map((c) => `  ${c.file}:${c.line}${c.swallowed ? '  (and SWALLOWED)' : ''}`)
                .join('\n');
            throw new Error(
                `${unbounded.length} unbounded networkidle wait(s):\n\n${shown}\n\n` +
                    `Pass an explicit { timeout: N } saying how long this is worth. ` +
                    `Unbounded means Playwright's 30s default; combined with ` +
                    `.catch(() => {}) it is 30s spent silently, which is #748's ` +
                    `"swallowed networkidle" half. And see ` +
                    `notif-sse-streaming-wiring.test.ts: when the SSE cutover lands, ` +
                    `an unbounded networkidle stops being slow and becomes infinite.`,
            );
        }
        expect(unbounded).toEqual([]);
    });

    it('nothing is both unbounded AND swallowed — the invisible combination', () => {
        // Stated separately from the rule above because it is the shape that
        // costs wall clock while reporting nothing at all. If the rule above is
        // ever relaxed, this one still has to hold.
        expect(calls.filter((c) => !c.bounded && c.swallowed)).toEqual([]);
    });

    it('the scan reaches tests/e2e and can still see the pattern (positive control)', () => {
        // An empty selection satisfies both assertions above. This is what says
        // "the scanner still works" rather than "the tree happens to be clean" —
        // the two are byte-identical from a green run.
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((c) => c.bounded)).toBe(true);
    });
});

describe('the rule itself', () => {
    /** Writes `body` into a throwaway tree and scans it. */
    function scan(body: string): NetworkIdleCall[] {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'netidle-'));
        try {
            fs.mkdirSync(path.join(dir, 'tests/e2e'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'tests/e2e/sample.spec.ts'), body);
            return collectNetworkIdleCalls(dir, ['tests/e2e']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    it('flags an unbounded call and accepts a bounded one', () => {
        const found = scan(
            [
                `await page.waitForLoadState('networkidle');`,
                `await page.waitForLoadState('networkidle', { timeout: 5_000 });`,
            ].join('\n'),
        );
        expect(found).toHaveLength(2);
        expect(found[0].bounded).toBe(false);
        expect(found[1].bounded).toBe(true);
    });

    it('detects the swallow, and does not confuse it with the bound', () => {
        // The exact shape removed from e2e-utils.ts, plus the three neighbours
        // that separate the two axes. A detector that collapsed them would pass
        // the assertion above while missing the combination that matters.
        const found = scan(
            [
                `await page.waitForLoadState('networkidle').catch(() => {});`,
                `await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);`,
                `await page.waitForLoadState('networkidle');`,
                `await page.waitForLoadState('networkidle', { timeout: 1_000 });`,
            ].join('\n'),
        );
        expect(found.map((c) => [c.bounded, c.swallowed])).toEqual([
            [false, true],
            [true, true],
            [false, false],
            [true, false],
        ]);
    });

    it('a neighbouring timeout does not exempt an unbounded call', () => {
        // The window bug this guard was written to avoid: `timeout:` belonging
        // to the NEXT statement must not be read as this call's bound.
        const found = scan(
            [`await page.waitForLoadState('networkidle');`, `await thing.waitFor({ timeout: 9_000 });`].join(
                '\n',
            ),
        );
        expect(found).toHaveLength(1);
        expect(found[0].bounded).toBe(false);
    });

    it('a goto(waitUntil) is a different API and is not counted', () => {
        // `page.goto(..., { waitUntil: 'networkidle' })` carries goto's own
        // timeout and surfaces its failure. Counting it here would force a
        // pointless edit on fonts-self-hosted.spec.ts, whose networkidle is
        // the actual condition under test.
        expect(scan(`await page.goto('/login', { waitUntil: 'networkidle' });`)).toEqual([]);
    });
});
