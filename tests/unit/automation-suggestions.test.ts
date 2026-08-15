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
    it('returns ranked suggestions ordered by descending confidence', () => {
        const out = rankRuleSuggestions({ coveredEvents: new Set() });
        expect(out.length).toBeGreaterThan(0);
        // ranks are 1-based + contiguous, ordered by descending confidence
        expect(out[0].rank).toBe(1);
        for (let i = 1; i < out.length; i++) {
            expect(out[i].rank).toBe(i + 1);
            expect(out[i - 1].confidenceScore).toBeGreaterThanOrEqual(out[i].confidenceScore);
        }
    });

    it('excludes suggestions whose trigger event is already covered by an enabled rule', () => {
        // Sanity: the candidate is offered when nothing covers it...
        expect(
            rankRuleSuggestions({ coveredEvents: new Set() })
                .find((s) => s.triggerEvent === 'ISSUE_CREATED'),
        ).toBeDefined();
        // ...and withheld when an enabled rule already handles that event.
        const out = rankRuleSuggestions({ coveredEvents: new Set(['ISSUE_CREATED']) });
        expect(out.find((s) => s.triggerEvent === 'ISSUE_CREATED')).toBeUndefined();
    });

    it('re-ranks contiguously after an exclusion (no gap where the dropped one sat)', () => {
        const full = rankRuleSuggestions({ coveredEvents: new Set() });
        const trimmed = rankRuleSuggestions({ coveredEvents: new Set(['ISSUE_CREATED']) });
        expect(trimmed.length).toBe(full.length - 1);
        trimmed.forEach((s, i) => expect(s.rank).toBe(i + 1));
    });

    it('never emits a confidence score above 1', () => {
        const out = rankRuleSuggestions({ coveredEvents: new Set() });
        for (const s of out) expect(s.confidenceScore).toBeLessThanOrEqual(1);
    });
});
