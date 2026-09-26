/**
 * Rendered / browser coverage floor — a STAGED UPWARD ratchet.
 *
 * Roadmap-4 made the behavioural-coverage registry an append-only
 * list of named high-risk primitives. What it did NOT do is stop the
 * rendered- and E2E-test *population* from shrinking: a PR could
 * delete a dozen `tests/rendered/` files and every structural
 * ratchet would stay green.
 *
 * This guard is the opposite of the `as any` ratchet. That one is a
 * downward ratchet — debt must only shrink. This is an UPWARD
 * ratchet — real-behaviour verification must only grow:
 *
 *   1. The count of rendered behavioural tests, E2E specs, and
 *      registered high-risk primitives must each stay AT OR ABOVE a
 *      floor. Deleting verification trips CI.
 *   2. A slack sentinel: when the live count runs well above its
 *      floor, the floor MUST be raised in the same PR. That is the
 *      "staged" part — added verification is locked in as the new
 *      minimum, so a later PR cannot silently spend the surplus.
 *
 * Floors only ever move UP. After a PR that adds rendered/E2E tests,
 * raise the matching floor here to the new count.
 *
 * See docs/verification-policy.md and docs/frontend-assurance-model.md.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Coverage floors. UPWARD ratchet — only ever edited higher, in the
 * same PR that adds the tests. History:
 *   • 2026-05-22 — Roadmap-7 P4: established at the post-roadmap-4
 *     population (126 rendered / 36 E2E / 5 registered primitives).
 */
// Bumped 126 → 135 by the edit-columns gear-fix repro test +
// other recent additions across the parity roadmap PRs.
//
// R31 (Bundle 1) — adjusted 135 → 134. The
// `tests/rendered/canvas-help-strip.test.tsx` rendered test
// was retired alongside the `CanvasHelpStrip` component (the
// "one message per state" design verdict moved the onboarding
// affordance into the empty-state hint at canvas-bottom-centre).
// This is the documented exception the rendered-floor ratchet
// explicitly contemplates: "if a test was legitimately merged
// or renamed, account for it." The floor will resume its
// upward-only ratchet from 134 on the next addition.
// Raised 134 → 143 (2026-06-03): button icon-as-child row test +
// accumulated rendered-test gains since the last bump.
// Raised 143 → 152 (2026-06-06): asset/risk modal-field, asset-criticality,
// and asset-KPI-trendline rendered tests.
// Raised 173 → 181 + 36 → 41 (2026-06-16): offline operator PWA harden —
// the offline-field-panel rendered test (cold-reload snapshot + offline
// mark→queue→reconnect→sync) + the offline-field-sync Playwright E2E, plus
// accumulated rendered/e2e gains since the last bump. Locked to the live
// counts so the added real-behaviour verification can't silently regress.
// Raised 41 → 50 (2026-06-17): the QA-depth ag E2E suite — 9 new
// tests/e2e/ag-*.spec.ts (location-import, spray-operation, inventory-
// traceability, harvest-yield, crop-plan, grain-contracts, agro-signals,
// offline-queue, and the parcel/spray-map visual baseline). Locked to the
// live count of 50.
// Raised 181 → 190 (feat/ai-vision): the PestSuggestionCard rendered test
// (tests/rendered/pest-suggestion-card.test.tsx) locks the advisory
// invariants — confidence %, the "not a diagnosis" disclaimer, the
// lab-vs-field caveat, low-confidence flagging, and the absence of an
// "apply" mutation — plus accumulated rendered gains.
// Lowered 190 → 184 when the risk-matrix UI was removed: the deleted
// RiskMatrix component + admin editor took 6 rendered tests with them
// (risk-matrix-{cell,legend,engine,movement,ale-overlay} + admin editor).
// Lowered 184 → 183 in the agricultural-assets rework: the asset CIA
// triad was removed, so `asset-criticality.test.tsx` (the CIA criticality
// component test) was deleted with it.
// Documented downward exceptions; the floor resumes its upward ratchet here.
// Raised 192 → 201 (feat/trends-page): the Trends UI adds rendered coverage —
// trends-prices-tab (loading/empty+operator/ready states + commodity & range
// refetch wiring), trends-page-client (two-tab shell, Prices default),
// market-trends-widget (headline + sparkline + tap-through), plus accumulated
// rendered gains. Locked to the live count of 201.
// Raised 201 → 210 (grain-contracts defect fixes): the contracts list error
// surface adds rendered coverage — grain-contracts-error-state locks that a
// failed list read renders the error copy rather than the "no results" empty
// state (for both an HTTP failure and a network throw), that stale rows
// survive a failed background refetch, and that the multi-select facet still
// goes out comma-joined — plus accumulated rendered gains.
// Raised 219 → 223 (coverage wave 23): the `NewCropPlanModal` and
// `InventoryClient` rendered suites — crop-plan request shaping + inline
// season/crop-type/variety creation + the parcel picker, and the inventory
// cursor accumulator + dual-mode product modal + the receive/adjust
// movement endpoints — plus accumulated rendered gains. Locked to the live
// count of 223.
// Raised 223 → 224 (#464, rendered-suite viewport audit): `viewport-helper`
// locks the jsdom viewport mechanism by EXECUTING it — the `matchMedia` stub
// in `tests/rendered/setup.ts` answers `matches: false` to every query, which
// makes `useMediaQuery` resolve to `mobile`, which makes every
// `<DataTable mobileFallback="card">` render cards and leaves the desktop
// `<table>` branch unreachable. That coupling spans two directories and was
// silently deciding which branch ~223 tests exercised; the suite asserts the
// default resolves to a phone, that each `setViewport` band resolves to its
// device, that `restoreViewport` restores, and that the DataTable branch
// follows.
//
// Raised 224 → 225 (#465, combobox stable accessible name): the
// `combobox-stable-accessible-name` rendered suite locks the trigger's
// accessible NAME to the FormField label — stable across a selection
// change — plus the aria-label > aria-labelledby > selected-text/
// placeholder precedence chain and the axe `button-name` fallback that
// must survive it.
//
// Both landed the same day and each independently raised the floor to 224;
// the conflict resolution is 225, the live count with both suites present.
// Lowered 225 → 223 in the compliance uproot (2026-08-07): four rendered
// suites were deleted alongside the components they verify —
// practice-roi-card, practice-exceptions-panel, test-plan-schedule-section and
// test-dashboard-g2-section. This is the documented exception the ratchet
// contemplates ("if a test was legitimately merged or renamed, account for
// it").
//
// Lowered 223 → 207 in the risk-quantification uproot (2026-08-08). The same
// exception, and the count is exact: 21 suites are gone versus main, and every
// one of them verified a component that no longer exists —
//   risk register / scoring UI (9): risk-assessment-panel, risk-board-page,
//     risk-dashboard-portfolio-honesty, risk-modal-fields,
//     risk-score-explainer-escape, risk-score-explainer-provenance,
//     risk-treatment-plan-card, score-explainer-retry,
//     polish-15-assessment-conflict
//   FAIR / Monte-Carlo (3): fair-calibration-panel, monte-carlo-stage,
//     ale-histogram
//   charts + rails whose only consumer was a risk surface (4):
//     loss-exceedance-reference-lines, sankey-chart, ai-assist-rail,
//     org-drilldown-load-more
//   practice exoskeleton, already accounted for above (4)
//   schemes-disclosure (1) — the certification /schemes page it asserted on
//     was replaced by the support-measures page.
// No surviving component lost its rendered coverage. The floor resumes its
// upward-only ratchet from 207.
//
// Raised 207 → 216 (2026-08-13). Six of the nine are
// `trends-operator-hint.test.tsx`, covering the Prices tab's empty-state hint
// per commodity feed — the branch that told an operator staring at an empty
// urea chart to configure two env vars that cannot produce a urea row.
//
// Lowered 216 → 211 in GRC teardown phase 2 (2026-08-13). Five rendered
// suites lost their subject entirely — every one is a deleted GRC surface,
// and each was verified to have no surviving component to re-point at:
//   audit-cycle-date-range   — the AuditCycle period picker (/audits gone)
//   create-finding-modal     — the Finding create modal (/findings gone)
//   policies-list-columns    — PoliciesClient's column set (/policies gone)
//   traceability-panel-link  \ TraceabilityPanel, the cross-entity link/
//   traceability-panel-undo  / unlink surface, deleted with the component
// The Epic 67 undo-toast contract the two traceability suites also carried
// survives on the other registered sites (see epic-67-rollout-coverage).
// Raised 229 -> 231 by #921. Two suites, both about a write the operator was
// told had succeeded: `offline-conflict-is-not-queued` (a 409-parked journal
// edit reported as 'queued' and closed like a save) and the delete-confirm
// suite already on disk. Raised WITH the tests rather than spending the slack —
// the slack exists for a lag, not as a budget.
// Raised 231 -> 232 by #924 (outbox-first-attempt-idempotency): the first
// online attempt now carries the same Idempotency-Key its replays carry, so a
// response lost after the server committed can no longer duplicate the write.
// Raised 232 -> 233 by #923 (offline-refused-work-banner): a write the server
// refuses is parked instead of destroyed, and the banner is what makes the
// park an improvement rather than a silently stuck row.
// Raised 233 -> 234 by #926 (journal-entry-modal-submit-outcomes): the first
// rendered test to MOUNT JournalEntryModal. #922 fixed a refused edit closing
// the modal like a save and proved it at the hook only — the surface where the
// defect actually lived had no behavioural cover at all.
// Raised 234 -> 235 by #933 (field-panel-failed-enqueue-reverts): a failed
// enqueue used to leave a phantom DONE on screen and in the persisted
// snapshot while telling the operator it had been reverted.
// Raised 235 -> 236 by the parcel-archive page test: the page shipped with
// its STRUCTURE pinned (detail shell, MetaStrip, one primary per file) and
// nothing asserting what a farmer sees. The first run of that test found a
// real defect — the harvest-year rule ("an autumn-sown crop belongs to the
// FOLLOWING year") was passed as `hint`, which FormField renders behind an
// info icon, so the one sentence that decides whether wheat is filed under
// 2025 or 2026 was invisible by default.
// 236 → 237: exchange-messaging-ui covers the two messaging screens. Its
// value is the retraction assertion, which was added with a `body: null`
// fixture, passed, and did NOT redden when the component was mutated to
// `m.body ?? tombstone` — behaviourally identical for that row. The
// fixture is adversarial now (deleted AND carrying a body) so the test
// pins the flag rather than body-nullity.
// 237 → 240: the insurance calculator (#1120). Three files, each carrying its
// own kind of proof rather than three views of one flow — `step-wizard`
// mutation-proves the five primitive fixes one test apiece,
// `insurance-quote-wizard` prices the reference figures on the phone default
// AND desktop, and `insurance-quote-wizard-bg` renders the same flow in
// Bulgarian, which is the app's DEFAULT locale and so the screen most farmers
// actually see.
// 240 → 241: the calculator's accessibility pass (#1122) — axe across all three
// steps on the phone default, the keyboard-only walk, and the live region. It is
// its own file rather than more cases in `insurance-quote-wizard` because the
// dismissal assertions have to force the DESKTOP path: on a phone `Modal` is a
// Vaul drawer whose dismissal jsdom cannot drive, so an Escape assertion there
// passes whether or not the confirm exists.
//
// Raised because this PR ADDS verification, which is what this ratchet asks of a
// PR that adds rendered tests. Nothing here lowers a floor or widens a baseline
// to go green — #1122's brief forbids that, and the two are opposite moves.
const RENDERED_TEST_FLOOR = 241;
// Lowered 55 → 54 in the risk-quantification uproot (2026-08-08).
// `ai-risk-assessment.spec.ts` and `new-risk-modal.spec.ts` were both
// wholly about the deleted register; the specs that merely REFERENCED a
// risk route were edited rather than deleted, and one of them —
// ciso-portfolio.spec.ts's AUDITOR read-only invariant — was repointed to the
// practices page because the assertion is about the ROLE, not the entity.
// Net: 56 → 54. The floor resumes its upward-only ratchet from 54.
//
// Lowered again 54 → 52 once CI's E2E job produced a real signal for the
// first time since the seed was repaired. Two more specs were asserting on
// surfaces this PR deleted, so they had no subject left:
//   frameworks.spec.ts    — drove `/t/<slug>/frameworks` (the certification
//                           catalogue UI), which is gone; only the
//                           `GET /frameworks` API it never called survives.
//   practice-tests.spec.ts — drove the test-of-practice plan/run UI
//                           (`#create-test-plan-btn`, `#test-plan-*`),
//                           deleted with the practice exoskeleton.
// Everything else that merely REFERENCED a dead route was repointed, not
// deleted, and so still counts: core-flow's steps D-F moved from Risk onto
// Asset, and mobile/horizontal-drift dropped three risk rows from its path
// table.
//
// Lowered 52 → 44 in GRC teardown phase 2 (2026-08-13). Eight specs drove
// deleted routes end-to-end with no surviving half:
//   practices, create-practice-modal, practice-toggle-pills,
//   practices-filter-epic53  — /practices and its modals
//   policies, vendors                  — /policies, /vendors
//   audit-readiness, reporting         — /audits/{cycles,packs} + the
//                                        anonymous /audit/shared/<token>
//                                        page, all deleted
// Fourteen more that merely REFERENCED a dead route were EDITED and still
// count — data-table-platform, entity-detail-layout, epic54-crud-smoke,
// filters, search-affordances, core-flow, auth, a11y, responsive,
// tooltip-and-copy, ciso-portfolio and the three ex-`practice-*` specs
// (now asset-edit-modal / asset-evidence / entity-detail-activity-tab) whose
// surviving halves were re-pointed at /assets and /journal.
//
// NOTE the two prose claims above this line that the teardown falsified:
// `entity-detail-layout`'s representative surface is no longer Practice
// (re-pointed again), and `reporting.spec.ts` no longer "kept its
// audit-cycle scenario" — it is deleted, its last remaining test having
// driven the freeze→share→anonymous-view journey that is now gone.
//
// Upward-only from 44.
// 61 → 62: `insurance-quote.spec.ts` (#1122) — the calculator's real POST on a
// phone, and "Request sent" surviving a RELOAD, which is the whole reason
// `listInquiredParcelIds` exists and the one thing no rendered test can show.
// Tagged `@mobile`, so it runs on both phone projects and not on desktop, where
// `.tap()` would fail for want of `hasTouch`.
//
// Raised because this PR ADDS a spec. Nothing here lowers a floor to go green.
const E2E_SPEC_FLOOR = 62;
const REGISTRY_FLOOR = 5;

/** Max a live count may exceed its floor before the floor must rise. */
const SLACK = { rendered: 8, e2e: 4, registry: 3 } as const;

/**
 * Every matching file under `rel`, RECURSIVELY.
 *
 * `readdirSync` is not recursive, and that mattered (#994): Playwright's
 * `testDir` is `./tests/e2e`, so it runs every spec beneath it — but this
 * floor counted only the top level. Measured before the fix: 47 counted
 * against 61 present, so the 13 specs in `tests/e2e/mobile/` and the 1 in
 * `tests/e2e/security/` were invisible to the ratchet. Every one of them
 * could have been deleted without moving it, including the offline-eviction,
 * offline-photo and 44px touch-target specs that cover the operator's actual
 * device.
 *
 * `tests/rendered` has no subdirectories, so its count is unchanged at 235;
 * the hole was live only for e2e.
 */
function countFiles(rel: string, suffix: string): number {
    const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const full = path.join(dir, e.name);
            return e.isDirectory() ? walk(full) : [full];
        });
    return walk(path.join(ROOT, rel)).filter((f) => f.endsWith(suffix)).length;
}

function registrySize(): number {
    const src = fs.readFileSync(
        path.join(ROOT, 'tests/guards/behavioural-coverage-registry.test.ts'),
        'utf8',
    );
    return (src.match(/primitive:\s*'/g) ?? []).length;
}

/**
 * The commit this branch is measured AGAINST.
 *
 * CI supplies it explicitly (`RATCHET_BASE_SHA`), using the same expression
 * the selector-teeth job already proved:
 * `github.event.pull_request.base.sha || github.event.before`. That is better
 * than deriving one here — GitHub knows the PR's base exactly, while
 * `merge-base --fork-point` is a guess that goes wrong on a branch that is
 * behind, reporting a PEER's merged work as YOUR deletions.
 *
 * Locally there is no such env, so fall back to a merge-base against
 * `origin/main`. A developer running jest is not the enforcement point; CI is.
 */
function baseSha(): string | null {
    const fromCi = process.env.RATCHET_BASE_SHA?.trim();
    if (fromCi && /^[0-9a-f]{7,40}$/i.test(fromCi)) return fromCi;
    try {
        const sha = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    } catch {
        return null;
    }
}

/**
 * The same population `countFiles` counts, as it was at `sha`.
 *
 * `git ls-tree` WITHOUT `-r` on purpose: `countFiles` uses `readdirSync`,
 * which is not recursive, so a recursive count here would compare two
 * different populations and produce a delta out of thin air. Measured today:
 * `tests/e2e` is 47 non-recursive and 61 recursive — the 14 specs under
 * `tests/e2e/mobile` and `tests/e2e/security` are invisible to this floor
 * (tracked separately in #994, deliberately NOT changed here).
 */
function countFilesAt(sha: string, rel: string, suffix: string): number | null {
    try {
        // `-r` to match `countFiles` above, which is recursive since #994.
        // These two MUST agree: the delta is (head - base), so counting the
        // head recursively and the base flat would report 14 phantom new e2e
        // specs on the very PR that widened it.
        const out = execFileSync('git', ['ls-tree', '-r', '--name-only', sha, `${rel}/`], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.split('\n').filter((f) => f.trim().endsWith(suffix)).length;
    } catch {
        return null;
    }
}

/** A floor constant as it read at `sha`, so the DELTA can be compared. */
function floorAt(sha: string, name: string): number | null {
    try {
        const src = execFileSync('git', ['show', `${sha}:tests/guards/rendered-coverage-floor.test.ts`], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const m = src.match(new RegExp(`const ${name} = (\\d+);`));
        return m ? Number(m[1]) : null;
    } catch {
        return null;
    }
}

describe('rendered / browser coverage floor — staged upward ratchet', () => {
    const rendered = countFiles('tests/rendered', '.test.tsx');
    const e2e = countFiles('tests/e2e', '.spec.ts');
    const registry = registrySize();

    it.each([
        ['rendered behavioural tests', rendered, RENDERED_TEST_FLOOR],
        ['E2E specs', e2e, E2E_SPEC_FLOOR],
        ['registered high-risk primitives', registry, REGISTRY_FLOOR],
    ])('%s count (%d) stays at or above its floor (%d)', (label, count, floor) => {
        if (count < floor) {
            throw new Error(
                `${label}: count ${count} fell below the floor ${floor}. ` +
                    `Real-behaviour verification must not shrink — restore ` +
                    `the deleted test(s), or, if a test was legitimately ` +
                    `merged/renamed, account for it. This floor only moves up.`,
            );
        }
        expect(count).toBeGreaterThanOrEqual(floor);
    });

    describe('the floor moves with the gain THIS PR introduces (#914)', () => {
        /**
         * The old rule fired on `count - floor > slack`, i.e. on the slack MAIN
         * had accumulated. A PR that added tests and did not bump the floor was
         * GREEN; the red landed later on whoever happened to cross the
         * threshold — frequently a PR that added no rendered tests at all.
         * #912 is the worked example: it had to raise the floor because main
         * went red on debt created by three earlier PRs that all passed.
         *
         * The signal arrived at someone other than the cause, which is this
         * repo's recurring shape.
         *
         * Firing on the PR's own delta fixes the attribution BY CONSTRUCTION:
         *   - a PR that adds tests without bumping goes red in its own CI,
         *     first time, every time;
         *   - a PR that adds none can never go red for someone else's
         *     omission;
         *   - nobody is forced to rebase because a peer merged, because the
         *     assertion never references main's absolute count. That is why
         *     this is not simply `slack = 0`, which would redden every
         *     in-flight test-adding PR the moment any other one merged, and
         *     churn on a guard is how guards get waived.
         */
        const base = baseSha();

        it('the counting helpers actually work — control on the delta below', () => {
            // selector-teeth proved this was needed: gutting `countFilesAt`,
            // `floorAt` or `baseSha` to null landed in the "no base" path, and
            // the delta check then passed having compared nothing. All three
            // SURVIVED every mutation. The degradation that keeps local runs
            // working is the same shape as a vacuous pass, so the helpers have
            // to be exercised against something that ALWAYS resolves.
            //
            // HEAD is that thing, and asserting equality with the live counts
            // does double duty: it pins the ls-tree/readdirSync equivalence
            // this check depends on. `ls-tree` without `-r` must agree with
            // `readdirSync` exactly, or every delta is noise.
            // Always true, and enough to kill a gutted helper: null/undefined
            // fails both of these.
            expect(countFilesAt('HEAD', 'tests/rendered', '.test.tsx')).toBeGreaterThan(0);
            expect(countFilesAt('HEAD', 'tests/e2e', '.spec.ts')).toBeGreaterThan(0);
            expect(floorAt('HEAD', 'RENDERED_TEST_FLOOR')).toBeGreaterThan(0);
            expect(floorAt('HEAD', 'E2E_SPEC_FLOOR')).toBeGreaterThan(0);

            // The EQUIVALENCE — ls-tree at HEAD agreeing exactly with the
            // working tree — only holds when the tree is clean, so it is
            // asserted only then. The first version asserted it
            // unconditionally and failed on any UNCOMMITTED floor edit, which
            // is precisely the change this guard tells you to make ("raise it
            // in THIS PR"). CI never saw it because CI's tree is committed;
            // the only people it punished were the ones following the
            // instruction.
            const dirty = execFileSync('git', ['status', '--porcelain'], {
                cwd: ROOT,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            if (dirty === '') {
                expect(countFilesAt('HEAD', 'tests/rendered', '.test.tsx')).toBe(rendered);
                expect(countFilesAt('HEAD', 'tests/e2e', '.spec.ts')).toBe(e2e);
                expect(floorAt('HEAD', 'RENDERED_TEST_FLOOR')).toBe(RENDERED_TEST_FLOOR);
                expect(floorAt('HEAD', 'E2E_SPEC_FLOOR')).toBe(E2E_SPEC_FLOOR);
            }
        });

        it('a base commit is resolvable in this repository', () => {
            // Gutting `baseSha()` to null makes every assertion below inert
            // while staying green, so "no base" cannot be treated as an
            // acceptable resting state here. Both CI contexts can resolve one
            // (the guards step is handed RATCHET_BASE_SHA; the selector-teeth
            // job checks out with fetch-depth: 0), and so can any clone with
            // an `origin/main`.
            expect(baseSha()).toMatch(/^[0-9a-f]{7,40}$/i);
        });

        it('the base commit was resolved — otherwise nothing below is checked', () => {
            // A skip that looks like a pass is the defect this guard family
            // exists to catch, so absence is REPORTED, and in CI it is fatal.
            if (!base) {
                const detail =
                    'no base commit: RATCHET_BASE_SHA is unset and `git merge-base origin/main HEAD` ' +
                    'failed (a shallow clone has no merge-base). The per-PR delta check below did NOT run.';
                if (process.env.RATCHET_DELTA_REQUIRE_BASE === '1') {
                    throw new Error(
                        `${detail}\n  CI sets RATCHET_BASE_SHA and needs history (fetch-depth: 0), ` +
                            `so here this is a configuration failure, not an environment fact.`,
                    );
                }
                console.warn(`[rendered-coverage-floor] ${detail}`);
            }
            expect(true).toBe(true);
        });

        it.each([
            ['RENDERED_TEST_FLOOR', 'tests/rendered', '.test.tsx', rendered, RENDERED_TEST_FLOOR],
            ['E2E_SPEC_FLOOR', 'tests/e2e', '.spec.ts', e2e, E2E_SPEC_FLOOR],
        ])('%s rises by at least what this PR adds', (name, dir, suffix, headCount, headFloor) => {
            if (!base) return; // reported by the test above
            const baseCount = countFilesAt(base, dir as string, suffix as string);
            const baseFloor = floorAt(base, name as string);
            if (baseCount === null || baseFloor === null) {
                // The base RESOLVED but its objects are not readable — the
                // shallow-clone case, where `RATCHET_BASE_SHA` names a commit
                // the local repo never fetched. Silently returning here would
                // be a vacuous pass WITH the require-flag on, which is the
                // exact hole this guard is about, so it is fatal in CI.
                const detail =
                    `${name}: base ${base.slice(0, 9)} is set but unreadable ` +
                    `(count=${baseCount}, floor=${baseFloor}) — the delta was NOT checked.`;
                if (process.env.RATCHET_DELTA_REQUIRE_BASE === '1') {
                    throw new Error(
                        `${detail}\n  Deepen the checkout (fetch-depth: 0) so the base commit is present.`,
                    );
                }
                console.warn(`[rendered-coverage-floor] ${detail}`);
                return;
            }

            const gained = (headCount as number) - baseCount;
            if (gained <= 0) return; // removals are covered by the floor test above

            const raised = (headFloor as number) - baseFloor;
            if (raised < gained) {
                throw new Error(
                    `${name}: this PR adds ${gained} ${suffix} file(s) under ${dir} ` +
                        `(${baseCount} → ${headCount}) but raises the floor by only ${raised} ` +
                        `(${baseFloor} → ${headFloor}).\n` +
                        `  Raise ${name} to ${baseFloor + gained} in THIS PR so the added ` +
                        `verification is locked in as the new minimum.\n` +
                        `  Measured against ${base.slice(0, 9)} — your PR's base, not main's ` +
                        `current tip, so a peer merging cannot make this fire.`,
                );
            }
            expect(raised).toBeGreaterThanOrEqual(gained);
        });
    });

    it('the floors are a genuine population, not a vacuous zero', () => {
        // Guards against the whole ratchet being neutered to 0/0/0.
        expect(RENDERED_TEST_FLOOR).toBeGreaterThan(100);
        expect(E2E_SPEC_FLOOR).toBeGreaterThan(20);
        expect(REGISTRY_FLOOR).toBeGreaterThanOrEqual(5);
    });
});
