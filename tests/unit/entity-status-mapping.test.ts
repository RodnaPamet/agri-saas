/**
 * Entity Status Mapping — Functional Unit Tests
 *
 * Behavioural coverage for `src/app-layer/domain/entity-status-mapping.ts`.
 * The module shipped at 0% coverage despite carrying real branching
 * logic (`getRiskScoreBand` — a four-band threshold classifier) and a
 * family of status→badge-variant lookup tables that every detail page
 * reads. These maps ARE domain semantics — a wrong tone is a product
 * defect, so they deserve real assertions, not a structural scan.
 */

import {
    getRiskScoreBand,
    RISK_STATUS_VARIANT,
    CONTROL_STATUS_VARIANT,
    CONTROL_APPLICABILITY_VARIANT,
    TASK_STATUS_VARIANT,
    TASK_SEVERITY_VARIANT,
    POLICY_STATUS_VARIANT,
    POLICY_APPROVAL_VARIANT,
    VENDOR_STATUS_VARIANT,
    VENDOR_CRITICALITY_VARIANT,
    VENDOR_ASSESSMENT_VARIANT,
} from '../../src/app-layer/domain/entity-status-mapping';

// ═════════════════════════════════════════════════════════════════════
// 1. getRiskScoreBand — four-band threshold classifier
// ═════════════════════════════════════════════════════════════════════

describe('getRiskScoreBand', () => {
    test('score 0 → Low / success', () => {
        expect(getRiskScoreBand(0)).toEqual({ label: 'Low', variant: 'success' });
    });

    test('boundary 5 is the top of the Low band', () => {
        expect(getRiskScoreBand(5)).toEqual({ label: 'Low', variant: 'success' });
    });

    test('boundary 6 is the bottom of the Medium band', () => {
        expect(getRiskScoreBand(6)).toEqual({ label: 'Medium', variant: 'warning' });
    });

    test('boundary 12 is the top of the Medium band', () => {
        expect(getRiskScoreBand(12)).toEqual({ label: 'Medium', variant: 'warning' });
    });

    test('boundary 13 is the bottom of the High band', () => {
        expect(getRiskScoreBand(13)).toEqual({ label: 'High', variant: 'warning' });
    });

    test('boundary 18 is the top of the High band', () => {
        expect(getRiskScoreBand(18)).toEqual({ label: 'High', variant: 'warning' });
    });

    test('boundary 19 crosses into the Critical band', () => {
        expect(getRiskScoreBand(19)).toEqual({ label: 'Critical', variant: 'error' });
    });

    test('max score 25 → Critical / error', () => {
        expect(getRiskScoreBand(25)).toEqual({ label: 'Critical', variant: 'error' });
    });

    test('the band is monotonic — never softens as score rises', () => {
        const rank = { success: 0, info: 1, neutral: 2, warning: 3, error: 4 } as const;
        let last = -1;
        for (let score = 0; score <= 25; score++) {
            const v = rank[getRiskScoreBand(score).variant];
            expect(v).toBeGreaterThanOrEqual(last);
            last = v;
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Status → StatusBadge variant maps
// ═════════════════════════════════════════════════════════════════════

describe('status-variant lookup tables', () => {
    test('risk status maps cover the full lifecycle', () => {
        expect(RISK_STATUS_VARIANT.OPEN).toBe('warning');
        expect(RISK_STATUS_VARIANT.MITIGATING).toBe('info');
        expect(RISK_STATUS_VARIANT.ACCEPTED).toBe('neutral');
        expect(RISK_STATUS_VARIANT.CLOSED).toBe('success');
    });

    test('practice status: terminal IMPLEMENTED is success, NEEDS_REVIEW is warning', () => {
        expect(CONTROL_STATUS_VARIANT.NOT_STARTED).toBe('neutral');
        expect(CONTROL_STATUS_VARIANT.IN_PROGRESS).toBe('info');
        expect(CONTROL_STATUS_VARIANT.IMPLEMENTED).toBe('success');
        expect(CONTROL_STATUS_VARIANT.NEEDS_REVIEW).toBe('warning');
    });

    test('practice applicability: only APPLICABLE draws attention', () => {
        expect(CONTROL_APPLICABILITY_VARIANT.APPLICABLE).toBe('info');
        expect(CONTROL_APPLICABILITY_VARIANT.NOT_APPLICABLE).toBe('neutral');
        expect(CONTROL_APPLICABILITY_VARIANT.EXCLUDED).toBe('neutral');
    });

    test('task status: BLOCKED is the only error tone', () => {
        expect(TASK_STATUS_VARIANT.BLOCKED).toBe('error');
        const others = Object.entries(TASK_STATUS_VARIANT)
            .filter(([k]) => k !== 'BLOCKED')
            .map(([, v]) => v);
        expect(others).not.toContain('error');
    });

    test('task severity escalates LOW → CRITICAL', () => {
        expect(TASK_SEVERITY_VARIANT.INFO).toBe('neutral');
        expect(TASK_SEVERITY_VARIANT.LOW).toBe('info');
        expect(TASK_SEVERITY_VARIANT.MEDIUM).toBe('warning');
        expect(TASK_SEVERITY_VARIANT.HIGH).toBe('warning');
        expect(TASK_SEVERITY_VARIANT.CRITICAL).toBe('error');
    });

    test('policy status: PUBLISHED is success, ARCHIVED warns', () => {
        expect(POLICY_STATUS_VARIANT.DRAFT).toBe('neutral');
        expect(POLICY_STATUS_VARIANT.IN_REVIEW).toBe('info');
        expect(POLICY_STATUS_VARIANT.PUBLISHED).toBe('success');
        expect(POLICY_STATUS_VARIANT.ARCHIVED).toBe('warning');
    });

    test('policy approval: REJECTED is error, APPROVED is success', () => {
        expect(POLICY_APPROVAL_VARIANT.PENDING).toBe('info');
        expect(POLICY_APPROVAL_VARIANT.APPROVED).toBe('success');
        expect(POLICY_APPROVAL_VARIANT.REJECTED).toBe('error');
    });

    test('vendor status maps the onboarding lifecycle', () => {
        expect(VENDOR_STATUS_VARIANT.ACTIVE).toBe('success');
        expect(VENDOR_STATUS_VARIANT.ONBOARDING).toBe('info');
        expect(VENDOR_STATUS_VARIANT.OFFBOARDING).toBe('warning');
        expect(VENDOR_STATUS_VARIANT.OFFBOARDED).toBe('neutral');
    });

    test('vendor criticality: HIGH and CRITICAL both surface as error', () => {
        expect(VENDOR_CRITICALITY_VARIANT.LOW).toBe('neutral');
        expect(VENDOR_CRITICALITY_VARIANT.MEDIUM).toBe('warning');
        expect(VENDOR_CRITICALITY_VARIANT.HIGH).toBe('error');
        expect(VENDOR_CRITICALITY_VARIANT.CRITICAL).toBe('error');
    });

    test('vendor assessment lifecycle distinct from vendor status', () => {
        expect(VENDOR_ASSESSMENT_VARIANT.DRAFT).toBe('neutral');
        expect(VENDOR_ASSESSMENT_VARIANT.IN_REVIEW).toBe('warning');
        expect(VENDOR_ASSESSMENT_VARIANT.APPROVED).toBe('success');
        expect(VENDOR_ASSESSMENT_VARIANT.REJECTED).toBe('error');
    });

    test('an unknown status key resolves to undefined (caller must default)', () => {
        // The maps are plain Records — consumers fall back to a
        // neutral tone for unmapped keys. This documents that contract.
        expect(RISK_STATUS_VARIANT['NONSENSE']).toBeUndefined();
        expect(TASK_STATUS_VARIANT['NONSENSE']).toBeUndefined();
    });

    test('every mapped variant is a known StatusBadge tone', () => {
        const allowed = new Set(['success', 'info', 'neutral', 'warning', 'error']);
        const allMaps = [
            RISK_STATUS_VARIANT, CONTROL_STATUS_VARIANT, CONTROL_APPLICABILITY_VARIANT,
            TASK_STATUS_VARIANT, TASK_SEVERITY_VARIANT, POLICY_STATUS_VARIANT,
            POLICY_APPROVAL_VARIANT, VENDOR_STATUS_VARIANT, VENDOR_CRITICALITY_VARIANT,
            VENDOR_ASSESSMENT_VARIANT,
        ];
        for (const map of allMaps) {
            for (const variant of Object.values(map)) {
                expect(allowed.has(variant)).toBe(true);
            }
        }
    });
});
