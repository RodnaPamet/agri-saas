/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Vendor Assessment Lifecycle Tests
 *
 * Validates the VendorAssessment domain's adoption of the generic editable
 * lifecycle, covering:
 * - Phase mapping (AssessmentStatus ↔ EditablePhase)
 * - Payload validation (must have answers)
 * - Full lifecycle through generic service (draft → submit → approve → re-assess)
 * - History/version snapshot integrity
 * - Domain-specific workflow semantics (scoring, risk rating)
 * - Regression guards for existing behavior
 */

import { LifecycleError } from '@/app-layer/domain/editable-lifecycle.types';
import {
    createEditableState,
    updateDraft,
    publish,
    revertToVersion,
    hasPendingChanges,
    hasBeenPublished,
    getHistoryEntry,
    getRecentHistory,
} from '@/app-layer/services/editable-lifecycle';
import type { VendorAssessmentPayload } from '@/app-layer/services/vendor-assessment-lifecycle-adapter';
import {
    assessmentStatusToPhase,
    phaseToAssessmentStatus,
    validateAssessmentPayload,
    VENDOR_ASSESSMENT_AUDIT_CONFIG,
    deriveRiskRating,
} from '@/app-layer/services/vendor-assessment-lifecycle-adapter';

// ═════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═════════════════════════════════════════════════════════════════════

const ASSESSMENT_V1: VendorAssessmentPayload = {
    templateKey: 'vendor-security-v1',
    templateName: 'Vendor Security Questionnaire',
    answers: [
        { questionId: 'q1', answerJson: { selected: 'yes' }, computedPoints: 10 },
        { questionId: 'q2', answerJson: { selected: 'no' }, computedPoints: 0 },
        { questionId: 'q3', answerJson: { selected: 'partial' }, computedPoints: 5 },
    ],
    score: 15,
    riskRating: 'MEDIUM',
    notes: 'Initial assessment — vendor has basic security program',
};

const ASSESSMENT_V2: VendorAssessmentPayload = {
    templateKey: 'vendor-security-v1',
    templateName: 'Vendor Security Questionnaire',
    answers: [
        { questionId: 'q1', answerJson: { selected: 'yes' }, computedPoints: 10 },
        { questionId: 'q2', answerJson: { selected: 'yes' }, computedPoints: 10 },
        { questionId: 'q3', answerJson: { selected: 'yes' }, computedPoints: 10 },
    ],
    score: 30,
    riskRating: 'LOW',
    notes: 'Re-assessment — vendor improved security practices',
};

const ASSESSMENT_V3: VendorAssessmentPayload = {
    templateKey: 'vendor-security-v2',
    templateName: 'Vendor Security Questionnaire v2',
    answers: [
        { questionId: 'q1', answerJson: { selected: 'yes' }, computedPoints: 10 },
        { questionId: 'q2', answerJson: { selected: 'no' }, computedPoints: 0 },
    ],
    score: 10,
    riskRating: 'HIGH',
    notes: null,
};

const EMPTY_ASSESSMENT: VendorAssessmentPayload = {
    templateKey: 'vendor-security-v1',
    templateName: 'Vendor Security Questionnaire',
    answers: [],
    score: null,
    riskRating: null,
    notes: null,
};

// ═════════════════════════════════════════════════════════════════════
// Phase Mapping
// ═════════════════════════════════════════════════════════════════════

describe('VendorAssessment Phase Mapping', () => {
    describe('assessmentStatusToPhase', () => {
        it.each([
            ['DRAFT', 'DRAFT'],
            ['IN_REVIEW', 'DRAFT'],
            ['APPROVED', 'PUBLISHED'],
            ['REJECTED', 'DRAFT'],
        ])('maps AssessmentStatus %s → EditablePhase %s', (status, expected) => {
            expect(assessmentStatusToPhase(status)).toBe(expected);
        });

        it('maps unknown status to DRAFT', () => {
            expect(assessmentStatusToPhase('UNKNOWN')).toBe('DRAFT');
        });
    });

    describe('phaseToAssessmentStatus', () => {
        it.each([
            ['DRAFT', 'DRAFT'],
            ['PUBLISHED', 'APPROVED'],
            ['ARCHIVED', 'APPROVED'],
        ] as const)('maps EditablePhase %s → AssessmentStatus %s', (phase, expected) => {
            expect(phaseToAssessmentStatus(phase)).toBe(expected);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════
// Audit Config
// ═════════════════════════════════════════════════════════════════════

describe('VendorAssessment Audit Config', () => {
    it('uses VendorAssessment entity type', () => {
        expect(VENDOR_ASSESSMENT_AUDIT_CONFIG.entityType).toBe('VendorAssessment');
    });

    it('uses ASSESSMENT action prefix', () => {
        expect(VENDOR_ASSESSMENT_AUDIT_CONFIG.actionPrefix).toBe('ASSESSMENT');
    });
});

// ═════════════════════════════════════════════════════════════════════
// Payload Validation
// ═════════════════════════════════════════════════════════════════════

describe('VendorAssessment Payload Validation', () => {
    it('passes for assessment with answers', () => {
        expect(() => validateAssessmentPayload(ASSESSMENT_V1, {} as any)).not.toThrow();
    });

    it('rejects assessment with zero answers', () => {
        expect(() => validateAssessmentPayload(EMPTY_ASSESSMENT, {} as any))
            .toThrow('at least one answered question');
    });

    it('passes for assessment with single answer', () => {
        const singleAnswer: VendorAssessmentPayload = {
            ...EMPTY_ASSESSMENT,
            answers: [{ questionId: 'q1', answerJson: { selected: 'yes' }, computedPoints: 5 }],
        };
        expect(() => validateAssessmentPayload(singleAnswer, {} as any)).not.toThrow();
    });
});

// ═════════════════════════════════════════════════════════════════════
// Risk Rating
// ═════════════════════════════════════════════════════════════════════

describe('Risk Rating Helper', () => {
    it.each([
        [0, 'CRITICAL'],
        [25, 'CRITICAL'],
        [26, 'HIGH'],
        [50, 'HIGH'],
        [51, 'MEDIUM'],
        [75, 'MEDIUM'],
        [76, 'LOW'],
        [100, 'LOW'],
    ])('deriveRiskRating(%i) → %s', (score, expected) => {
        expect(deriveRiskRating(score)).toBe(expected);
    });
});

// ═════════════════════════════════════════════════════════════════════
// Assessment Lifecycle (Pure, via generic service)
// ═════════════════════════════════════════════════════════════════════

describe('VendorAssessment Lifecycle (generic service integration)', () => {

    // ─── Draft Editing (Answer Filling) ──────────────────────────

    describe('draft editing (answer filling)', () => {
        it('creates initial assessment in DRAFT phase', () => {
            const state = createEditableState(ASSESSMENT_V1);

            expect(state.phase).toBe('DRAFT');
            expect(state.currentVersion).toBe(1);
            expect(state.draft).toEqual(ASSESSMENT_V1);
            expect(state.published).toBeNull();
        });

        it('updates draft answers without changing version', () => {
            let state = createEditableState(EMPTY_ASSESSMENT);
            state = updateDraft(state, ASSESSMENT_V1);

            expect(state.draft).toEqual(ASSESSMENT_V1);
            expect(state.currentVersion).toBe(1);
        });

        it('progressively adds answers to draft', () => {
            let state = createEditableState(EMPTY_ASSESSMENT);

            // Add first answer
            const oneAnswer: VendorAssessmentPayload = {
                ...EMPTY_ASSESSMENT,
                answers: [{ questionId: 'q1', answerJson: { selected: 'yes' }, computedPoints: 10 }],
                score: 10,
            };
            state = updateDraft(state, oneAnswer);
            expect(state.draft!.answers).toHaveLength(1);

            // Add more answers
            state = updateDraft(state, ASSESSMENT_V1);
            expect(state.draft!.answers).toHaveLength(3);
            expect(state.currentVersion).toBe(1); // still no publish
        });
    });

    // ─── Submit/Approve (Publish) ────────────────────────────────

    describe('submit/approve (publish workflow)', () => {
        it('first approval publishes assessment result', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'reviewer-1', changeSummary: 'Initial assessment approved' });

            expect(state.phase).toBe('PUBLISHED');
            expect(state.currentVersion).toBe(2);
            expect(state.published).toEqual(ASSESSMENT_V1);
            expect(state.draft).toBeNull();
        });

        it('published assessment has no history on first approval', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'reviewer-1' });

            expect(state.history).toHaveLength(0);
        });

        it('marks assessment as published', () => {
            let state = createEditableState(ASSESSMENT_V1);
            expect(hasBeenPublished(state)).toBe(false);

            state = publish(state, { publishedBy: 'reviewer-1' });
            expect(hasBeenPublished(state)).toBe(true);
        });
    });

    // ─── Re-Assessment (Version History) ─────────────────────────

    describe('re-assessment (version history)', () => {
        it('re-assessment snapshots prior approved result to history', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'reviewer-1' }); // v1 approved

            // Vendor is re-assessed with improved results
            state = updateDraft(state, ASSESSMENT_V2);
            state = publish(state, { publishedBy: 'reviewer-2', changeSummary: 'Annual re-assessment' }); // v2

            expect(state.currentVersion).toBe(3);
            expect(state.published).toEqual(ASSESSMENT_V2);
            expect(state.history).toHaveLength(1);
            expect(state.history[0].version).toBe(2);
            expect(state.history[0].payload).toEqual(ASSESSMENT_V1);
        });

        it('preserves score and risk rating in history snapshots', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'reviewer-1' }); // v1: score=15, MEDIUM
            state = updateDraft(state, ASSESSMENT_V2);
            state = publish(state, { publishedBy: 'reviewer-2' }); // v2: score=30, LOW

            const historicV1 = state.history[0].payload;
            expect(historicV1.score).toBe(15);
            expect(historicV1.riskRating).toBe('MEDIUM');

            const currentV2 = state.published!;
            expect(currentV2.score).toBe(30);
            expect(currentV2.riskRating).toBe('LOW');
        });

        it('preserves template info across re-assessments', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'reviewer-1' }); // v1: template v1
            state = updateDraft(state, ASSESSMENT_V3); // template v2
            state = publish(state, { publishedBy: 'reviewer-2' }); // v2: template v2

            expect(state.history[0].payload.templateKey).toBe('vendor-security-v1');
            expect(state.published!.templateKey).toBe('vendor-security-v2');
        });

        it('3-year assessment history is ordered correctly', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'r1' }); // Year 1

            state = updateDraft(state, ASSESSMENT_V2);
            state = publish(state, { publishedBy: 'r2' }); // Year 2

            state = updateDraft(state, ASSESSMENT_V3);
            state = publish(state, { publishedBy: 'r3' }); // Year 3

            expect(state.currentVersion).toBe(4);
            expect(state.history).toHaveLength(2);

            // Oldest first
            expect(state.history[0].version).toBe(2);
            expect(state.history[0].payload.score).toBe(15); // MEDIUM
            expect(state.history[1].version).toBe(3);
            expect(state.history[1].payload.score).toBe(30); // LOW

            // Current
            expect(state.published!.score).toBe(10); // HIGH
        });

        it('answer-level detail is preserved in history', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'r1' }); // v1
            state = updateDraft(state, ASSESSMENT_V2);
            state = publish(state, { publishedBy: 'r2' }); // v2

            const v1Answers = state.history[0].payload.answers;
            expect(v1Answers).toHaveLength(3);
            expect(v1Answers[0].questionId).toBe('q1');
            expect(v1Answers[1].answerJson).toEqual({ selected: 'no' });
            expect(v1Answers[1].computedPoints).toBe(0);
        });
    });

    // ─── Revert to Prior Assessment ──────────────────────────────

    describe('revert to prior assessment', () => {
        it('loads prior assessment result into draft', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'r1' }); // v1
            state = updateDraft(state, ASSESSMENT_V2);
            state = publish(state, { publishedBy: 'r2' }); // v2

            state = revertToVersion(state, { targetVersion: 2 });

            expect(state.draft).toEqual(ASSESSMENT_V1);
            expect(state.published).toEqual(ASSESSMENT_V2); // v2 still live
            expect(state.phase).toBe('DRAFT');
        });

        it('reverted result can be re-approved', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'r1' }); // v1
            state = updateDraft(state, ASSESSMENT_V2);
            state = publish(state, { publishedBy: 'r2' }); // v2

            state = revertToVersion(state, { targetVersion: 2 });
            state = publish(state, { publishedBy: 'r1', changeSummary: 'Reverted to year 1 results' }); // v4

            expect(state.currentVersion).toBe(4);
            expect(state.published!.score).toBe(15); // v1's score
            expect(state.history).toHaveLength(2);
        });

        it('rejects revert to non-existent version', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'r1' });

            expect(() => revertToVersion(state, { targetVersion: 99 }))
                .toThrow(LifecycleError);
        });
    });

    // ─── Query Helpers ───────────────────────────────────────────

    describe('query helpers', () => {
        it('hasPendingChanges after draft update', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'r1' });
            expect(hasPendingChanges(state)).toBe(false);

            state = updateDraft(state, ASSESSMENT_V2);
            expect(hasPendingChanges(state)).toBe(true);
        });

        it('getHistoryEntry returns correct assessment', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'r1' }); // v1
            state = updateDraft(state, ASSESSMENT_V2);
            state = publish(state, { publishedBy: 'r2' }); // v2

            const v1 = getHistoryEntry(state, 2);
            expect(v1?.payload.score).toBe(15);
            expect(v1?.payload.riskRating).toBe('MEDIUM');
        });

        it('getRecentHistory returns most-recent-first', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'r1' });
            state = updateDraft(state, ASSESSMENT_V2);
            state = publish(state, { publishedBy: 'r2' });
            state = updateDraft(state, ASSESSMENT_V3);
            state = publish(state, { publishedBy: 'r3' });

            const recent = getRecentHistory(state, 2);
            expect(recent).toHaveLength(2);
            expect(recent[0].version).toBe(3); // most recent first
            expect(recent[1].version).toBe(2);
        });
    });

    // ─── Existing Behavior Regression Guards ─────────────────────

    describe('existing workflow regression guards', () => {
        it('cannot approve without answers (no draft)', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'r1' });

            // No draft → cannot publish again
            expect(() => publish(state, { publishedBy: 'r1' }))
                .toThrow(LifecycleError);
        });

        it('editing answers after approval moves phase back to DRAFT', () => {
            let state = createEditableState(ASSESSMENT_V1);
            state = publish(state, { publishedBy: 'r1' });

            state = updateDraft(state, ASSESSMENT_V2);
            expect(state.phase).toBe('DRAFT');
            // This mirrors: assessment must be re-submitted and re-approved
        });

        it('version increments only on approval/publish', () => {
            let state = createEditableState(ASSESSMENT_V1);
            expect(state.currentVersion).toBe(1);

            // Multiple answer updates don't increment version
            state = updateDraft(state, ASSESSMENT_V2);
            expect(state.currentVersion).toBe(1);

            state = updateDraft(state, ASSESSMENT_V1);
            expect(state.currentVersion).toBe(1);

            // Only publish increments
            state = publish(state, { publishedBy: 'r1' });
            expect(state.currentVersion).toBe(2);
        });
    });

    // ─── Full Assessment Lifecycle (E2E) ─────────────────────────

    describe('full vendor assessment lifecycle (end-to-end)', () => {
        it('complete lifecycle: create → fill → approve → re-assess → approve → revert → approve', () => {
            // 1. Start assessment with empty answers
            let state = createEditableState<VendorAssessmentPayload>(EMPTY_ASSESSMENT);
            expect(state.phase).toBe('DRAFT');

            // 2. Fill in answers progressively
            state = updateDraft(state, ASSESSMENT_V1);
            expect(state.draft!.answers).toHaveLength(3);
            expect(state.draft!.score).toBe(15);

            // 3. Submit & approve (first assessment)
            state = publish(state, { publishedBy: 'reviewer-1', changeSummary: 'Initial assessment' });
            expect(state.phase).toBe('PUBLISHED');
            expect(state.currentVersion).toBe(2);
            expect(state.history).toHaveLength(0); // no prior

            // 4. Annual re-assessment — better results
            state = updateDraft(state, ASSESSMENT_V2);
            expect(state.phase).toBe('DRAFT');
            expect(state.published!.score).toBe(15); // v1 still live

            // 5. Approve re-assessment — v1 is snapshotted to history
            state = publish(state, { publishedBy: 'reviewer-2', changeSummary: 'Annual re-assessment — improved' });
            expect(state.currentVersion).toBe(3);
            expect(state.published!.score).toBe(30); // v2 live
            expect(state.published!.riskRating).toBe('LOW');
            expect(state.history).toHaveLength(1);
            expect(state.history[0].payload.score).toBe(15); // v1 preserved
            expect(state.history[0].payload.riskRating).toBe('MEDIUM');

            // 6. Audit concern — revert to v1 results for review
            state = revertToVersion(state, { targetVersion: 2 });
            expect(state.draft!.score).toBe(15);
            expect(state.published!.score).toBe(30); // v2 still live

            // 7. After review, re-approve v1 results as v4
            state = publish(state, { publishedBy: 'ciso', changeSummary: 'Reverted per audit finding' });
            expect(state.currentVersion).toBe(4);
            expect(state.published!.score).toBe(15); // v1 content back as live
            expect(state.history).toHaveLength(2);

            // Verify complete history chain
            expect(state.history[0].version).toBe(2);
            expect(state.history[0].payload.score).toBe(15);
            expect(state.history[1].version).toBe(3);
            expect(state.history[1].payload.score).toBe(30);
        });
    });
});
