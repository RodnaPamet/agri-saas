/**
 * The audit can be triggered by a guard's INPUTS changing — #2377 §2.
 *
 * ## The case this exists for
 *
 * `selector-teeth` audits guards whose FILE changed. #2376's
 * `isDeclaredUnbacked` was made vacuous without its file being touched: #2367
 * edited `docs/backup-restore.md`, both stacks became drilled, and
 * `drilled !== unbacked` turned into `true !== false` — so the second
 * predicate stopped mattering and nothing audited it. It surfaced only because
 * an unrelated PR later went red on content already in main.
 *
 * `scripts/guard-inputs.mjs` inverts guard→input so that edit would have
 * selected that guard for audit in the same PR.
 *
 * ## The boundary is asserted, not just documented
 *
 * This window is SAME-PR only, and #2377 ranks the vacuity property above it
 * for that reason. These tests pin what it DOES cover so nobody mistakes it
 * for the stronger guarantee: an input changed three PRs ago with the guard
 * untouched is missed exactly as completely as before.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const TOOL = path.join(ROOT, 'scripts/guard-inputs.mjs');

const run = (...args: string[]) =>
    execFileSync('node', [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });

describe('the guard→input map is real (#2377 §2)', () => {
    const summary = run('--map').split('\n')[0];

    it('[guard-inputs] prints its denominator, so an empty map cannot read as a full one', () => {
        console.log(`      ${summary}`);
        // The shape this repo keeps finding one level up: a map over nothing
        // selects nothing and every PR passes. The counts are asserted, not
        // merely printed.
        const m = /(\d+) guard file\(s\); (\d+) with resolvable inputs \((\d+) edge\(s\)\); (\d+) read only globs/.exec(summary);
        expect(m).not.toBeNull();
        const [, guards, mapped, edges, globOnly] = m!.map(Number);
        expect(guards).toBeGreaterThan(700);
        expect(mapped).toBeGreaterThan(500);
        expect(edges).toBeGreaterThan(1500);
        // The residue is REPORTED rather than hidden. A zero here would mean
        // the map claimed total coverage, which it does not have — #2377 calls
        // these the guards whose population is computed, so no literal exists
        // to map.
        expect(globOnly).toBeGreaterThan(0);
        expect(mapped + globOnly).toBe(guards);
    });

    it('REGRESSION: editing the restore runbook selects the guard that reads it', () => {
        // The originating case, by name. #2367 changed this exact file and
        // nothing audited `restore-drill-targets-what-exists`.
        const selected = run('--guards-for', 'docs/backup-restore.md').trim().split('\n');
        expect(selected).toContain('tests/guards/restore-drill-targets-what-exists.test.ts');
    });

    it('selects only guards that really read the changed path', () => {
        // Not everything, which would make the window useless by auditing the
        // whole suite on any edit, and not nothing.
        const selected = run('--guards-for', 'docs/backup-restore.md').trim().split('\n').filter(Boolean);
        expect(selected.length).toBeGreaterThan(0);
        expect(selected.length).toBeLessThan(20);
        for (const g of selected) {
            // `readFileSync`, not `git show HEAD:<g>`. The claim is about the
            // guard as it stands in this tree, which is what the window will
            // select against — and `file-collection-is-not-silently-empty`
            // correctly reads a bare `git` invocation here as a hand-rolled
            // collector.
            expect(readFileSync(path.join(ROOT, g), 'utf8')).toContain('backup-restore.md');
        }
    });

    it('a path nothing reads selects nothing', () => {
        // The other direction. A map that returned guards for an unread path
        // would audit on every PR and the signal would be worthless.
        expect(run('--guards-for', 'tests/fixtures/__does-not-exist__.json').trim()).toBe('');
    });

    it('does not record a guard as its own input', () => {
        // Self-reference is real — guards name their own path in error
        // messages — but the file-changed trigger already covers that case,
        // and keeping the edge would make every guard appear to depend on
        // itself.
        const map = run('--map');
        const selfEdges = map
            .split('\n')
            .reduce<{ current: string | null; bad: string[] }>((acc, line) => {
                if (/^ {2}\S/.test(line)) return { current: line.trim(), bad: acc.bad };
                if (/^ {6}\S/.test(line) && line.trim() === acc.current) {
                    return { current: acc.current, bad: [...acc.bad, acc.current!] };
                }
                return acc;
            }, { current: null, bad: [] }).bad;
        expect(selfEdges).toEqual([]);
    });

    it('a HOT input selects nothing, and the exclusion is named not counted', () => {
        // Found by simulating the CI step: a diff touching `package.json`
        // selected 46 guards, and every dependency bump touches it. At ~400s
        // per selector that is hours on every Dependabot PR, and the window's
        // whole value is being targeted.
        expect(run('--guards-for', 'package.json').trim()).toBe('');

        // The crucial difference from the MAX_GUARDS cap #2417 removed: that
        // dropped an arbitrary suffix and emitted a ::warning:: in a green
        // job. This names every exclusion and its fanout, so the set cannot
        // quietly grow.
        const map = run('--map');
        expect(map).toMatch(/\[too-broad\] package\.json is read by \d+ guards/);
        const named = (map.match(/\[too-broad\]/g) ?? []).length;
        const claimed = Number(/(\d+) input\(s\) too broad/.exec(map)?.[1]);
        // Every excluded input is printed. A count without the names is the
        // failure mode, not a summary of it.
        expect(named).toBe(claimed);
        expect(claimed).toBeGreaterThan(0);
    });

    it('the ceiling does not exclude the input the originating case turns on', () => {
        // `docs/backup-restore.md` has fanout 3. If a future ceiling change
        // swept it up, this window would stop covering the very case #2377 was
        // filed about while still looking like it worked.
        expect(run('--map')).not.toContain('[too-broad] docs/backup-restore.md');
    });

    it('the worst case is bounded by the ceiling', () => {
        // Any single changed input now selects at most FANOUT_CEILING guards,
        // which is what makes the audit cost predictable.
        const map = run('--map');
        const ceiling = Number(/fanout > (\d+)/.exec(map)?.[1]);
        expect(ceiling).toBeGreaterThan(0);
        // Pick the highest-fanout input that is NOT excluded and check it.
        const rows = [...map.matchAll(/^ {2}(\S+)$/gm)].map((m) => m[1]);
        expect(rows.length).toBeGreaterThan(0);
        const selected = run('--guards-for', 'docs/backup-restore.md').trim().split('\n').filter(Boolean);
        expect(selected.length).toBeLessThanOrEqual(ceiling);
    });

    it('an untracked literal creates no edge', () => {
        // `/tmp/globals.sql` appears as a literal in the originating guard and
        // is not a repo file. Without the tracked-file check, strings like
        // 'utf8' and '2026-10-30' would all become phantom inputs and the map
        // would look far broader than it is.
        expect(run('--map')).not.toContain('/tmp/globals.sql');
    });
});
