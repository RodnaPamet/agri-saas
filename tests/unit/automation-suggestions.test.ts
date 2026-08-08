/**
 * VR-9 — automation-rule suggestion ranker (pure core).
 *
 * The `activeRiskCount` posture signal (and the two RISK_* candidates it
 * weighted) went with the risk register, so the "more risk raises
 * confidence" test has no subject. What survives — rank contiguity,
 * covered-event exclusion, and the score ceiling — is the part that
 * governs what a tenant actually sees in the suggestions rail.
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
        const covered = new Set(['TEST_RUN_FAILED']);
        const out = rankRuleSuggestions({ coveredEvents: covered });
        expect(out.find((s) => s.triggerEvent === 'TEST_RUN_FAILED')).toBeUndefined();
        // non-covered ones survive
        expect(out.find((s) => s.triggerEvent === 'ISSUE_CREATED')).toBeDefined();
    });

    it('re-ranks contiguously after an exclusion (no gap where the dropped one sat)', () => {
        const full = rankRuleSuggestions({ coveredEvents: new Set() });
        const trimmed = rankRuleSuggestions({ coveredEvents: new Set(['TEST_RUN_FAILED']) });
        expect(trimmed.length).toBe(full.length - 1);
        trimmed.forEach((s, i) => expect(s.rank).toBe(i + 1));
    });

    it('never emits a confidence score above 1', () => {
        const out = rankRuleSuggestions({ coveredEvents: new Set() });
        for (const s of out) expect(s.confidenceScore).toBeLessThanOrEqual(1);
    });
});
