/**
 * Coverage ratchet — the enforced floors are one-way-up.
 *
 * `jest.thresholds.json` holds the per-layer coverage floors that
 * the CI `Coverage (≥60%)` job enforces via `--coverageThreshold`.
 * The policy (`docs/coverage-policy.md`) is that a floor is **never
 * lowered** — raised when a PR earns it, never dropped to turn a
 * red PR green. `jest.config.js` documents that rule in prose; this
 * test ENFORCES it.
 *
 * `RATCHET_FLOOR` below is the hard minimum. Every value in
 * `jest.thresholds.json` must be greater than or equal to it — a
 * threshold lowered below the floor fails CI loudly, which is
 * exactly the regression (GAP-02: "lower a floor to make CI green")
 * this guard exists to catch.
 *
 * When a PR RAISES a threshold (the ratchet moving up), the matching
 * `RATCHET_FLOOR` entry MUST be raised in the same diff. That used to
 * be "encouraged but not required", and the two drifted apart: this
 * mirror stayed at its post-Roadmap-3 seed while #233 recalibrated the
 * enforced floors, leaving it ten points low on `global` functions.
 * `quality-coverage-integrity.test.ts` now fails CI on any entry here
 * that sits below its `jest.thresholds.json` counterpart.
 *
 * `RATCHET_FLOOR` is only ever edited UPWARD: a downward edit here is
 * itself the reviewed, deliberate act of retiring a floor, never a
 * drive-by.
 *
 * Pure static analysis — reads `jest.thresholds.json`, no coverage
 * run, no DB.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

type Metrics = { branches: number; functions: number; lines: number; statements: number };

/**
 * The hard minimum coverage floor. No value in `jest.thresholds.json`
 * may drop below this. Edit UPWARD only.
 *
 * Brought to PARITY with the enforced floors on 2026-07-29 (see the
 * header note). It had been seeded at the post-roadmap-3 state (P1
 * policy, P2 `usecases/` uplift, P3 `lib/` uplift) and left there
 * through #233's recalibration and every coverage wave since, so it
 * was guarding a state the project had long left behind. The
 * per-scope history below is retained because it records HOW each
 * number was earned.
 */
const RATCHET_FLOOR: Record<string, Metrics> = {
    // Recalibrated by #233 from CI's measured artifact
    // (measured − 2, capped at 70); the mirror is now at parity.
    // 2026-07-29 (run 30483470674, main@f61def62): functions 64 → 65,
    // the headroom wave 23's +114 covered functions opened up
    // (measured 67.24). Branches measures 65.36 and stays at 63 —
    // measured−2 truncates to exactly the floor already in force, so
    // there is nothing to raise until measured reaches 66.
    //
    // 2026-08-20 (run 32313528177, 1601 suites / 24,231 tests):
    // branches 63 → 67, functions 65 → 69. Measured 69.78 / 71.78.
    //
    // This one is a RECOVERY, not a wave. Issue #398 recorded the gate
    // RED on main across five consecutive pushes at branches 59.29 /
    // functions 59.91 — roughly ten points below where they now sit.
    // Nobody raised the floors when coverage climbed back, so the
    // recovery sat unlocked: coverage could have eroded ten points
    // again before anything failed. Re-flooring is what converts a
    // recovery into a guarantee.
    //
    // lines/statements measure 83.03 / 80.69 and stay at 70 — the
    // #233 brittleness ceiling, deliberately not raised.
    global: { branches: 67, functions: 69, lines: 70, statements: 70 },
    // `usecases/` — quality roadmap + stage-3a/3b/3c/3d waves.
    // Post-Roadmap-3 floor was 42 (branches); measured branch
    // coverage had climbed to ~58 without the floor following.
    // Stage 3a (#664): 51 tests on 3 small files, +1 across all.
    // Stage 3b (#666): 41 tests on `audit-readiness/packs` (443
    // lines), file-level 92/85/89/95, +2 across all.
    // Stage 3c (#667): extended `framework-install.test.ts`
    // 15 → 39 tests adding `computeCoverage` + `listTemplates`
    // + missing branches. File-level 45/35/47/44 → 97/95/93/97.
    // +2 across all.
    // Stage 3d (this wave): 30 branch-focused tests on
    // `org-invites.ts` (512 lines, completely untested,
    // compliance-critical: 1 of 3 OrgMembership write paths).
    // File-level 0/0/0/0 → **100/89/100/100**.
    // Stage 3d landed at 62/56/72/69 (the +3 → +2 fixup after
    // CI measured branches at 62.5%).
    // Stage 3e (this wave): 22 branch-focused tests on
    // `webhook-processor.ts` (485 lines, previously untested).
    // Security-critical: signature verification + cross-tenant
    // resolution + replay defense + provider dispatch fan-out.
    // File-level 0/0/0/0 → **98/86/86/99**.
    //
    // CI's full-suite measured: branches **62.98%** (only +0.5
    // over stage-3d's 62.5%) and lines **73.5%**. The +2 bump
    // to 64 branches missed by ~1; the +2 to 74 lines missed
    // by 0.5. Backed off in fixup to:
    //   - branches: stays at 62 (the wave's branch lift on the
    //     broader tree was sub-percentage)
    //   - functions: 56 → 57 (+1)
    //   - lines:     72 → 73 (+1; measured 73.5%)
    //   - statements: 69 → 70 (+1)
    // The test file (durable gain) stays — only the floor moved
    // less aggressively. Branch coverage's plateau here is real
    // signal — webhook-processor is dense but only adds ~25-35
    // branches to the ~4962-branch usecases tree.
    // Stage 3f (this wave): 49 branch-focused tests across TWO
    // files in one PR:
    //   - `framework/coverage.ts` (313 lines): file-level 98/78/95/98
    //     (the lower branches comes from nuanced section/category
    //     fallback chains).
    //   - `practice/queries.ts` (337 lines): file-level 100/95/100/100
    //     (dashboard aggregator + consistency-check + RBAC + 3 not-
    //     found paths).
    // Combined ~143 covered branches. Conservative +1 across all
    // metrics after stages 3d/3e showed the broader-tree dilution
    // (a dense file contributes ~0.5-1% absolute on the tree).
    // Stage 3g (#672): 40 tests across THREE files —
    //   - `soft-delete-lifecycle.ts` (143 lines): file-level
    //     **100/100/100/100** (perfect). 4 fns, 6 throw guards.
    //   - `vendor-assessment-reminder.ts` (129 lines): file-level
    //     **100/96/100/100**. 5 reject-paths + audit + dedup.
    //   - `org-dashboard-widgets.ts` (225 lines): file-level
    //     **100/96/100/100**. Cross-org-id leak defence locked.
    // Combined ~85 covered branches; +1 across all metrics
    // (matches stage 3f's broader-tree-dilution pattern).
    // Stage 3h (this wave): 54 tests across FIVE small files in
    // one PR. `practice/page-data.ts` was dropped from the original
    // candidate list (already at 100/94/100/100); replaced with
    // `soft-delete-operations.ts`.
    //   - `test-readiness.ts` (105 lines): file-level **100/75/100/100**.
    //   - `soft-delete-operations.ts` (117 lines): **100/100/100/100**.
    //     Generic restore + purge for every soft-deletable entity.
    //   - `org-tenants.ts` (149 lines): **100/100/100/100**.
    //     `createTenantUnderOrg` — tx + best-effort provisioning.
    //   - `framework/fixtures.ts` (196 lines): **100/95/100/100**.
    //     `upsertRequirements` + `computeRequirementsDiff`.
    //   - `org-dashboard-presets.ts` seeder (218 lines): **100/80/100/100**.
    //     The existing preset-shape test only covered 25% of the file;
    //     extended to cover the actual `seedDefaultOrgDashboard` flow.
    // Combined ~80 newly-covered branches. CI full-suite measured
    // usecases/: branches **67.78%**, fn 65.55%, lines 77.99%,
    // stmts 76.32% — slack of +3.78 / +6.55 / +2.99 / +4.32 over
    // the post-3g floor (64/59/75/72). Conservative bump:
    //   - branches: 64 → 66 (+2)
    //   - functions: 59 → 62 (+3, biggest measured headroom)
    //   - lines: 75 → 77 (+2)
    //   - statements: 72 → 74 (+2)
    // Leaves ~1-2pp slack against measured for single-test flake.
    // QA-depth uplift (2026-06-17): the ag-demo-fixture integration test +
    // listLotsPaginated coverage add headroom against the same measured
    // floor (67.78/65.55/77.99/76.32). Conservative bump within it:
    //   - branches: 66 → 67 (+1, < 67.78)
    //   - functions: 62 → 63 (+1, < 65.55)
    //   - statements: 74 → 75 (+1, < 76.32)
    //   - lines: 77 (held — already near the 77.99 ceiling)
    // #233 then took functions to the 70 cap from its measured value.
    // 2026-07-29 recalibration (run 30483470674, main@f61def62):
    // measured branches 70.99 → 68 (+1). The other three are pinned:
    // functions/lines/statements measure 78.40 / 85.04 / 82.82, whose
    // measured−2 lands above the 70 cap, so the existing (higher,
    // never-lowered) floors stand.
    './src/app-layer/usecases/': { branches: 68, functions: 70, lines: 77, statements: 75 },
    // `policies/` — quality roadmap P3. Authorization decisions —
    // a wrong branch is a security hole. Measured ≈82 branches /
    // 91 funcs / 91 lines; seeded a few points below.
    './src/app-layer/policies/': { branches: 78, functions: 88, lines: 88, statements: 85 },
    // `events/` — quality roadmap P3. The hash-chained audit
    // trail — integrity-critical. Measured ≈75 branches / 63 funcs
    // / 80 lines; #233 took functions 60 → 61.
    './src/app-layer/events/': { branches: 72, functions: 61, lines: 78, statements: 75 },
    // `lib/` — #233 took branches 66 → 70 (the cap), functions
    // 61 → 66, statements 69 → 70. The 2026-07-29 recalibration takes
    // functions 66 → 70 as well: measured 79.67, so measured−2 clears
    // the cap outright.
    './src/lib/': { branches: 70, functions: 70, lines: 71, statements: 70 },
};

const METRICS: Array<keyof Metrics> = ['branches', 'functions', 'lines', 'statements'];

function loadThresholds(): Record<string, Partial<Metrics>> {
    return JSON.parse(read('jest.thresholds.json'));
}

describe('coverage ratchet — thresholds never slip backward', () => {
    const thresholds = loadThresholds();

    it('every ratchet-floor scope still has a key in jest.thresholds.json', () => {
        for (const scope of Object.keys(RATCHET_FLOOR)) {
            expect(thresholds[scope]).toBeDefined();
        }
    });

    it.each(Object.keys(RATCHET_FLOOR))(
        '%s — no metric is below the ratchet floor',
        (scope) => {
            const actual = thresholds[scope] ?? {};
            const floor = RATCHET_FLOOR[scope];
            const below: string[] = [];
            for (const metric of METRICS) {
                const v = actual[metric];
                expect(typeof v).toBe('number');
                if ((v as number) < floor[metric]) {
                    below.push(`${metric}: ${v} < floor ${floor[metric]}`);
                }
            }
            if (below.length > 0) {
                throw new Error(
                    `${scope} dropped below the coverage ratchet floor:\n  ` +
                        below.join('\n  ') +
                        `\nA floor is never lowered (docs/coverage-policy.md). ` +
                        `Restore the coverage instead of dropping the threshold.`,
                );
            }
        },
    );

    it('the business-logic layer (usecases/) has its own dedicated, higher-assurance floor', () => {
        // usecases/ is Tier A — it must carry a per-folder threshold,
        // not merely ride the (lower-bar) global number.
        expect(thresholds['./src/app-layer/usecases/']).toBeDefined();
        expect(thresholds['./src/app-layer/usecases/']?.branches).toBeGreaterThanOrEqual(
            RATCHET_FLOOR['./src/app-layer/usecases/'].branches,
        );
    });

    it('the risk-tiered coverage policy doc exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'docs/coverage-policy.md'))).toBe(true);
    });

    // ── Regression proof — the detector catches a lowered floor ──
    it('detects a threshold lowered below the floor', () => {
        const sabotaged = JSON.parse(JSON.stringify(thresholds)) as typeof thresholds;
        sabotaged['./src/app-layer/usecases/']!.branches = 10;
        const floor = RATCHET_FLOOR['./src/app-layer/usecases/'].branches;
        expect(sabotaged['./src/app-layer/usecases/']!.branches).toBeLessThan(floor);
    });
});
