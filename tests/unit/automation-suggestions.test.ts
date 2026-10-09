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
import { rankRuleSuggestions, RULE_SUGGESTION_CANDIDATES, type Candidate } from '@/app-layer/usecases/automation-suggestions';

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
    /**
     * Two separate claims, deliberately not one test.
     *
     * The CATALOGUE is empty (#1479 took its only candidate, which triggered
     * on the retired `ISSUE_CREATED`). The RANKING still works and is now
     * testable against injected candidates (#1525) — before that seam existed
     * the list was a local const, so with it empty the three properties below
     * had no subject and the only honest assertion left was `toEqual([])`.
     *
     * Keeping them apart means adding a real candidate fails exactly one test
     * — the catalogue one — rather than silently changing what the ranking
     * tests range over.
     */
    it('the shipped catalogue is empty — see #1525 before adding one', () => {
        expect(RULE_SUGGESTION_CANDIDATES).toEqual([]);
        expect(rankRuleSuggestions({ coveredEvents: new Set() })).toEqual([]);
    });

    /** Injected candidates on LIVE events, so nothing here depends on the
     *  catalogue and none of these names a trigger with no producer. */
    const FIXTURES: Candidate[] = [
        {
            id: 'c-low',
            title: 'Low confidence',
            rationale: 'r',
            triggerEvent: 'TASK_CREATED',
            actionType: 'CREATE_TASK',
            confidenceScore: 0.3,
        },
        {
            id: 'c-high',
            title: 'High confidence',
            rationale: 'r',
            triggerEvent: 'SPRAY_JOB_STARTED',
            actionType: 'NOTIFY_USER',
            confidenceScore: 0.9,
        },
        {
            id: 'c-mid',
            title: 'Mid confidence',
            rationale: 'r',
            triggerEvent: 'HARVEST_YIELD_RECORDED',
            actionType: 'CREATE_TASK',
            confidenceScore: 0.6,
        },
    ];

    it('orders by descending confidence and ranks contiguously from 1', () => {
        const out = rankRuleSuggestions({ coveredEvents: new Set() }, FIXTURES);
        expect(out.map((s) => s.id)).toEqual(['c-high', 'c-mid', 'c-low']);
        expect(out.map((s) => s.rank)).toEqual([1, 2, 3]);
        for (let i = 1; i < out.length; i++) {
            expect(out[i - 1].confidenceScore).toBeGreaterThanOrEqual(out[i].confidenceScore);
        }
    });

    it('excludes a candidate whose trigger event an enabled rule already covers', () => {
        // Offered when nothing covers it...
        expect(
            rankRuleSuggestions({ coveredEvents: new Set() }, FIXTURES)
                .find((s) => s.triggerEvent === 'SPRAY_JOB_STARTED'),
        ).toBeDefined();
        // ...and withheld when a rule does.
        const out = rankRuleSuggestions(
            { coveredEvents: new Set(['SPRAY_JOB_STARTED']) },
            FIXTURES,
        );
        expect(out.find((s) => s.triggerEvent === 'SPRAY_JOB_STARTED')).toBeUndefined();
        expect(out).toHaveLength(FIXTURES.length - 1);
    });

    it('re-ranks contiguously after an exclusion — no gap where the dropped one sat', () => {
        const trimmed = rankRuleSuggestions(
            { coveredEvents: new Set(['SPRAY_JOB_STARTED']) },
            FIXTURES,
        );
        // The highest-scoring candidate was the one excluded, so this also
        // pins that rank 1 is REASSIGNED rather than left on a dropped row.
        expect(trimmed.map((s) => s.id)).toEqual(['c-mid', 'c-low']);
        trimmed.forEach((s, i) => expect(s.rank).toBe(i + 1));
    });

    it('caps a confidence score above 1 at exactly 1', () => {
        const out = rankRuleSuggestions({ coveredEvents: new Set() }, [
            { ...FIXTURES[0], id: 'c-over', confidenceScore: 1.4 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].confidenceScore).toBe(1);
    });

    // Kept as the catalogue-facing form of the cap assertion above: that one
    // proves the clamp with an injected 1.4, this one ranges over whatever the
    // shipped list holds. Vacuous while it is empty, and that is visible from
    // the test immediately above rather than hidden.
    it('never emits a confidence score above 1 (over the shipped catalogue)', () => {
        const out = rankRuleSuggestions({ coveredEvents: new Set() });
        for (const s of out) expect(s.confidenceScore).toBeLessThanOrEqual(1);
    });
});
