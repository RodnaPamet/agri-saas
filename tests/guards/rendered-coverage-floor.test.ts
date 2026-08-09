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
// control-roi-card, control-exceptions-panel, test-plan-schedule-section and
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
//   control exoskeleton, already accounted for above (4)
//   schemes-disclosure (1) — the certification /schemes page it asserted on
//     was replaced by the support-measures page.
// No surviving component lost its rendered coverage. The floor resumes its
// upward-only ratchet from 207.
const RENDERED_TEST_FLOOR = 207;
// Lowered 55 → 54 in the risk-quantification uproot (2026-08-08).
// `ai-risk-assessment.spec.ts` and `new-risk-modal.spec.ts` were both
// wholly about the deleted register; the specs that merely REFERENCED a
// risk route were edited rather than deleted, and one of them —
// ciso-portfolio's AUDITOR read-only invariant — was repointed to the
// controls page because the assertion is about the ROLE, not the entity.
// Net: 56 → 54. The floor resumes its upward-only ratchet from 54.
//
// Lowered again 54 → 52 once CI's E2E job produced a real signal for the
// first time since the seed was repaired. Two more specs were asserting on
// surfaces this PR deleted, so they had no subject left:
//   frameworks.spec.ts    — drove `/t/<slug>/frameworks` (the certification
//                           catalogue UI), which is gone; only the
//                           `GET /frameworks` API it never called survives.
//   control-tests.spec.ts — drove the test-of-control plan/run UI
//                           (`#create-test-plan-btn`, `#test-plan-*`),
//                           deleted with the control exoskeleton.
// Everything else that merely REFERENCED a dead route was repointed, not
// deleted, and so still counts: core-flow's steps D-F moved from Risk onto
// Asset, entity-detail-layout's representative surface moved from Risk to
// Control, reporting.spec.ts kept its audit-cycle scenario (E-G) and lost
// only the three read-only tests whose pages are gone, and
// mobile/horizontal-drift dropped three risk rows from its path table.
// No surviving surface lost its E2E coverage. Upward-only from 52.
const E2E_SPEC_FLOOR = 52;
const REGISTRY_FLOOR = 5;

/** Max a live count may exceed its floor before the floor must rise. */
const SLACK = { rendered: 8, e2e: 4, registry: 3 } as const;

function countFiles(rel: string, suffix: string): number {
    const dir = path.join(ROOT, rel);
    return fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).length;
}

function registrySize(): number {
    const src = fs.readFileSync(
        path.join(ROOT, 'tests/guards/behavioural-coverage-registry.test.ts'),
        'utf8',
    );
    return (src.match(/primitive:\s*'/g) ?? []).length;
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

    it.each([
        ['RENDERED_TEST_FLOOR', rendered, RENDERED_TEST_FLOOR, SLACK.rendered],
        ['E2E_SPEC_FLOOR', e2e, E2E_SPEC_FLOOR, SLACK.e2e],
        ['REGISTRY_FLOOR', registry, REGISTRY_FLOOR, SLACK.registry],
    ])('%s has no accumulated slack — raise it as coverage grows', (name, count, floor, slack) => {
        if (count - floor > slack) {
            throw new Error(
                `${name} is ${floor} but the live count is ${count} ` +
                    `(slack ${count - floor} > ${slack}). Raise ${name} to ` +
                    `${count} in this PR so the added verification is locked ` +
                    `in as the new minimum — an upward ratchet only works if ` +
                    `the floor tracks the gains.`,
            );
        }
        expect(count - floor).toBeLessThanOrEqual(slack);
    });

    it('the floors are a genuine population, not a vacuous zero', () => {
        // Guards against the whole ratchet being neutered to 0/0/0.
        expect(RENDERED_TEST_FLOOR).toBeGreaterThan(100);
        expect(E2E_SPEC_FLOOR).toBeGreaterThan(20);
        expect(REGISTRY_FLOOR).toBeGreaterThanOrEqual(5);
    });
});
