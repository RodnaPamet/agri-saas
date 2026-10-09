/**
 * VR-9 — automation-rule suggestion ranker (pure core).
 *
 * The `activeRiskCount` posture signal (and the two RISK_* candidates it
 * weighted) went with the risk register, so the "more risk raises
 * confidence" test has no subject. What survives — rank contiguity,
 * covered-event exclusion, and the score ceiling — is the part that
 * governs what a tenant actually sees in the suggestions rail.
 *
 * GRC teardown phase 2 then removed the `practice-test-failed-notify`
 * candidate, whose `TEST_RUN_FAILED` trigger pointed at an event family
 * whose models no longer exist (plan §8k). **That leaves the ranker with
 * exactly ONE candidate**, which makes the exclusion and re-rank tests
 * below degenerate — they exercise the code path, but with a candidate
 * list too short for contiguity to mean much. They are kept (the ranker
 * is still live and still reachable from the rail) and this note is here
 * so the next reader does not mistake a one-element pass for coverage.
 * The real follow-up is a product one: a suggestions rail with a single
 * hard-coded entry is worth either restocking with agri triggers
 * (SPRAY_JOB_STARTED, HARVEST_YIELD_RECORDED, EVIDENCE_EXPIRING) or
 * retiring.
 */
import { rankRuleSuggestions } from '@/app-layer/usecases/automation-suggestions';

describe('rankRuleSuggestions', () => {
    /**
     * The candidate list is EMPTY as of #1479, and this assertion is the
     * forcing function rather than a note.
     *
     * `rankRuleSuggestions` held exactly one candidate, triggering on
     * `ISSUE_CREATED`. That event lost its only producer when the
     * `/issues/**` surface was retired, so the suggestion would have led a
     * tenant to build a rule that could never fire — the defect CLAUDE.md
     * records against `TEST_PLAN_*`. The candidate went with the surface.
     *
     * Three tests stood here and asserted real behaviour this function still
     * implements: descending-confidence ordering, exclusion of an event an
     * enabled rule already covers, and contiguous re-ranking after an
     * exclusion. None of them can run against an empty list, and `candidates`
     * is a module-local const with no injection seam.
     *
     * So this asserts the empty state INSTEAD, which means **adding a
     * candidate fails this test** — and whoever adds one has to restore those
     * three in the same diff. A conditional skip was the alternative and it is
     * the worse one: it reads as a pass. See #1525.
     */
    it('offers no candidates at all — and adding one must restore the ranking tests', () => {
        expect(rankRuleSuggestions({ coveredEvents: new Set() })).toEqual([]);
    });

    // Vacuous while the candidate list is empty (it iterates nothing), kept
    // because it is the invariant that matters the moment one is added.
    it('never emits a confidence score above 1', () => {
        const out = rankRuleSuggestions({ coveredEvents: new Set() });
        for (const s of out) expect(s.confidenceScore).toBeLessThanOrEqual(1);
    });
});
