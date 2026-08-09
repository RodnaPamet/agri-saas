/**
 * Epic 46.3 — pure compliance-status computation.
 *
 * The rules are the single source of truth for tree dots, the
 * minimap colored bars, the detail-pane status chip, and (in
 * future) the framework header summary. Drift between any of
 * those surfaces and what the audit reports has been the most
 * frequent failure mode in compliance UIs — pinning the rule
 * table here is the cheapest defence.
 */

import {
    aggregateComplianceStatus,
    computeRequirementComplianceStatus,
    decorateTreeWithCompliance,
    type PracticeForCompliance,
} from '@/lib/framework-tree/compliance';
import type { FrameworkTreeNode } from '@/lib/framework-tree/types';

const C = (
    status: PracticeForCompliance['status'],
    applicability: PracticeForCompliance['applicability'] = 'APPLICABLE',
): PracticeForCompliance => ({ status, applicability });

describe('computeRequirementComplianceStatus', () => {
    it('returns "gap" when no practices are mapped', () => {
        expect(computeRequirementComplianceStatus([])).toBe('gap');
    });

    it('returns "compliant" when every applicable practice is IMPLEMENTED', () => {
        expect(
            computeRequirementComplianceStatus([
                C('IMPLEMENTED'),
                C('IMPLEMENTED'),
                C('IMPLEMENTED'),
            ]),
        ).toBe('compliant');
    });

    it('returns "partial" with a mix of IMPLEMENTED and other applicable statuses', () => {
        expect(
            computeRequirementComplianceStatus([
                C('IMPLEMENTED'),
                C('IN_PROGRESS'),
            ]),
        ).toBe('partial');
        expect(
            computeRequirementComplianceStatus([
                C('IMPLEMENTED'),
                C('NOT_STARTED'),
                C('NEEDS_REVIEW'),
            ]),
        ).toBe('partial');
    });

    it('returns "gap" when none of the applicable practices are IMPLEMENTED', () => {
        expect(
            computeRequirementComplianceStatus([
                C('IN_PROGRESS'),
                C('PLANNED'),
                C('NEEDS_REVIEW'),
            ]),
        ).toBe('gap');
    });

    it('returns "na" when every mapped practice is NOT_APPLICABLE', () => {
        expect(
            computeRequirementComplianceStatus([
                C('IN_PROGRESS', 'NOT_APPLICABLE'),
                C('IMPLEMENTED', 'NOT_APPLICABLE'),
            ]),
        ).toBe('na');
    });

    it('treats NOT_APPLICABLE practices as ignored, not gaps', () => {
        // Mixing one IMPLEMENTED applicable + one NOT_APPLICABLE
        // (any status) → the N/A is ignored, so the requirement is
        // fully compliant.
        expect(
            computeRequirementComplianceStatus([
                C('IMPLEMENTED'),
                C('IN_PROGRESS', 'NOT_APPLICABLE'),
            ]),
        ).toBe('compliant');
    });
});

describe('aggregateComplianceStatus', () => {
    it('returns "unknown" for an empty input', () => {
        expect(aggregateComplianceStatus([])).toBe('unknown');
    });

    it('returns "compliant" when every descendant is compliant', () => {
        expect(
            aggregateComplianceStatus(['compliant', 'compliant', 'compliant']),
        ).toBe('compliant');
    });

    it('returns "gap" when every descendant is a gap', () => {
        expect(aggregateComplianceStatus(['gap', 'gap'])).toBe('gap');
    });

    it('returns "na" when every descendant is N/A', () => {
        expect(aggregateComplianceStatus(['na', 'na'])).toBe('na');
    });

    it('treats N/A descendants as ignored — compliant + na is still compliant', () => {
        expect(
            aggregateComplianceStatus(['compliant', 'compliant', 'na']),
        ).toBe('compliant');
        // Same for gap + na.
        expect(aggregateComplianceStatus(['gap', 'na'])).toBe('gap');
    });

    it('returns "partial" for mixed compliant + gap + partial', () => {
        expect(
            aggregateComplianceStatus(['compliant', 'gap', 'partial']),
        ).toBe('partial');
        expect(aggregateComplianceStatus(['compliant', 'gap'])).toBe('partial');
    });

    it('does NOT promote unknown to compliant', () => {
        expect(
            aggregateComplianceStatus(['compliant', 'unknown', 'compliant']),
        ).toBe('partial');
    });
});

describe('decorateTreeWithCompliance', () => {
    function req(id: string, code: string): FrameworkTreeNode {
        return {
            id,
            kind: 'requirement',
            label: code,
            title: `Req ${code}`,
            description: null,
            code,
            sortOrder: 0,
            descendantCount: 0,
            childCount: 0,
            hasChildren: false,
            children: [],
        };
    }
    function section(
        id: string,
        label: string,
        children: FrameworkTreeNode[],
    ): FrameworkTreeNode {
        return {
            id,
            kind: 'section',
            label,
            title: label,
            description: null,
            descendantCount: children.length,
            childCount: children.length,
            hasChildren: children.length > 0,
            children,
        };
    }

    it('decorates every node with a status from the practices lookup', () => {
        const tree: FrameworkTreeNode[] = [
            section('s-org', 'ORG', [req('r-5.1', '5.1'), req('r-5.2', '5.2')]),
            section('s-people', 'PEOPLE', [req('r-6.1', '6.1')]),
        ];
        const ctlMap = new Map<string, PracticeForCompliance[]>([
            ['r-5.1', [C('IMPLEMENTED')]],
            ['r-5.2', [C('IN_PROGRESS')]],
            ['r-6.1', [C('IMPLEMENTED', 'NOT_APPLICABLE')]],
        ]);
        const out = decorateTreeWithCompliance(tree, ctlMap);
        expect(out[0].complianceStatus).toBe('partial'); // ORG: compliant + gap
        expect(out[0].children[0].complianceStatus).toBe('compliant');
        expect(out[0].children[1].complianceStatus).toBe('gap');
        expect(out[1].complianceStatus).toBe('na'); // PEOPLE: only N/A
    });

    it('reports per-status counts that sum to the descendant requirement count', () => {
        const tree: FrameworkTreeNode[] = [
            section('s', 'S', [
                req('r-1', '1'),
                req('r-2', '2'),
                req('r-3', '3'),
            ]),
        ];
        const ctlMap = new Map<string, PracticeForCompliance[]>([
            ['r-1', [C('IMPLEMENTED')]],
            ['r-2', [C('IN_PROGRESS')]],
            // r-3 has no mapped practices → gap
        ]);
        const out = decorateTreeWithCompliance(tree, ctlMap);
        const counts = out[0].statusCounts!;
        expect(counts.compliant).toBe(1);
        expect(counts.gap).toBe(2); // r-2 → gap (no IMPLEMENTED), r-3 → gap (no practices)
        expect(counts.partial).toBe(0);
        expect(counts.na).toBe(0);
        expect(counts.compliant + counts.partial + counts.gap + counts.na).toBe(3);
    });

    it('does not mutate the input tree', () => {
        const original: FrameworkTreeNode[] = [
            section('s', 'S', [req('r-1', '1')]),
        ];
        const ctlMap = new Map<string, PracticeForCompliance[]>([
            ['r-1', [C('IMPLEMENTED')]],
        ]);
        decorateTreeWithCompliance(original, ctlMap);
        expect(original[0].complianceStatus).toBeUndefined();
        expect(original[0].children[0].complianceStatus).toBeUndefined();
    });

    it('aggregates 3+ levels deep — section → requirement → sub-requirement', () => {
        // Section with one requirement (5.1) that itself has two
        // sub-requirements (5.1.1, 5.1.2). The parent requirement
        // 5.1 has no own practices; status comes from leaf children.
        const sub1 = req('r-5.1.1', '5.1.1');
        const sub2 = req('r-5.1.2', '5.1.2');
        const parent = req('r-5.1', '5.1');
        parent.children = [sub1, sub2];
        parent.hasChildren = true;
        parent.childCount = 2;
        parent.descendantCount = 2;
        const tree = [section('s', 'S', [parent])];
        const ctlMap = new Map<string, PracticeForCompliance[]>([
            ['r-5.1.1', [C('IMPLEMENTED')]],
            ['r-5.1.2', [C('IN_PROGRESS')]],
            // r-5.1 has no practices of its own — status comes from
            // its mapping (gap), but the SECTION aggregates over
            // leaves only.
        ]);
        const out = decorateTreeWithCompliance(tree, ctlMap);
        // Section reflects leaf statuses (compliant + gap → partial),
        // not just the immediate child's own status.
        expect(out[0].complianceStatus).toBe('partial');
    });
});
