/**
 * Due-Item Ownership — Centralized Resolution Regression Guards
 *
 * This test suite prevents the ownership-falls-to-admin bug class by:
 * 1. Verifying the centralized ownership resolver handles all entity types
 * 2. Verifying every DueItem producer wires ownership (structural scan)
 * 3. Verifying the resolver returns the correct field per entity type
 * 4. Verifying admin fallback only occurs for truly ownerless entities
 */

import {
    resolveDueItemOwner,
    OWNERSHIP_RULES,
    getConfiguredEntityTypes,
} from '../../src/app-layer/domain/due-item-ownership';

import type { MonitoredEntityType } from '../../src/app-layer/jobs/types';

// ═════════════════════════════════════════════════════════════════════
// 1. Ownership Resolution — Centralized Rules
// ═════════════════════════════════════════════════════════════════════

describe('resolveDueItemOwner — resolution correctness', () => {

    test('EVIDENCE: resolves ownerUserId', () => {
        const result = resolveDueItemOwner('EVIDENCE', { ownerUserId: 'user-2' });
        expect(result).toBe('user-2');
    });



    test('TASK: resolves assigneeUserId (not ownerUserId)', () => {
        const result = resolveDueItemOwner('TASK', {
            assigneeUserId: 'user-5',
            ownerUserId: 'user-wrong', // should NOT use this
        });
        expect(result).toBe('user-5');
    });


});

// ═════════════════════════════════════════════════════════════════════
// 2. Fallback Behavior — Admin Only for Truly Ownerless
// ═════════════════════════════════════════════════════════════════════

describe('resolveDueItemOwner — fallback behavior', () => {
    test('null ownerUserId returns undefined (triggers admin fallback)', () => {
        const result = resolveDueItemOwner('EVIDENCE', { ownerUserId: null });
        expect(result).toBeUndefined();
    });

    test('undefined ownerUserId returns undefined', () => {
        const result = resolveDueItemOwner('EVIDENCE', {});
        expect(result).toBeUndefined();
    });

    test('empty string ownerUserId returns undefined', () => {
        const result = resolveDueItemOwner('EVIDENCE', { ownerUserId: '' });
        expect(result).toBeUndefined();
    });

    test('entity WITH owner does NOT return undefined', () => {
        const result = resolveDueItemOwner('EVIDENCE', { ownerUserId: 'user-real' });
        expect(result).not.toBeUndefined();
        expect(result).toBe('user-real');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Completeness Guard — All MonitoredEntityTypes Have Rules
// ═════════════════════════════════════════════════════════════════════

describe('OWNERSHIP_RULES — completeness', () => {
    // This is the authoritative list from types.ts. It went from nine
    // members to two across the GRC teardown; the point of restating it
    // here rather than iterating `Object.keys(OWNERSHIP_RULES)` is that
    // a type added to the union without a rule must FAIL, and deriving
    // the list from the map under test would make that impossible.
    const ALL_ENTITY_TYPES: MonitoredEntityType[] = ['EVIDENCE', 'TASK'];

    test('every MonitoredEntityType has an ownership rule', () => {
        const configured = getConfiguredEntityTypes();
        const missing = ALL_ENTITY_TYPES.filter(t => !configured.includes(t));
        expect(missing).toEqual([]);
    });

    test('every ownership rule has a valid ownerField', () => {
        for (const [_entityType, rule] of Object.entries(OWNERSHIP_RULES)) {
            expect(rule.ownerField).toBeTruthy();
            expect(typeof rule.ownerField).toBe('string');
            expect(rule.description).toBeTruthy();
        }
    });

    test('no extraneous rules for non-existent entity types', () => {
        const configured = getConfiguredEntityTypes();
        const extra = configured.filter(t => !ALL_ENTITY_TYPES.includes(t));
        expect(extra).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Structural Guards — DueItem Producers Wire Ownership
// ═════════════════════════════════════════════════════════════════════

describe('Structural: all DueItem producers wire ownerUserId', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');

    // GRC teardown phase 2 deleted jobs/vendor-renewal-check.ts (the only
    // VENDOR producer) and, inside deadline-monitor, the Risk and
    // PracticeTestPlan scanners; phase 3 took the Practice (nextDueAt)
    // and Policy (nextReviewAt) scanners with their models, leaving TASK
    // as deadline-monitor's only producer. Both remaining producer FILES
    // are scanned in full — nothing about the ownership contract was
    // relaxed, the set of files that can violate it just got smaller.
    const PRODUCER_FILES = [
        {
            name: 'deadline-monitor',
            path: '../../src/app-layer/jobs/deadline-monitor.ts',
            expectedEntityTypes: ['TASK'],
        },
        {
            name: 'evidence-expiry-monitor',
            path: '../../src/app-layer/jobs/evidence-expiry-monitor.ts',
            expectedEntityTypes: ['EVIDENCE'],
        },
    ];

    /**
     * Every `{...}` object literal that directly follows `push(` or
     * `return `, extracted with a brace counter so a literal never runs
     * past its own closing brace. String and template contents are not
     * parsed — no DueItem literal in these files contains a brace inside
     * a string, and the assertion is on substring presence, so a false
     * split would show up as a spurious violation rather than a silent
     * pass.
     */
    function extractObjectLiterals(source: string): string[] {
        const out: string[] = [];
        const starts = [...source.matchAll(/(?:push\(|return\s*)\{/g)];
        for (const m of starts) {
            const open = m.index! + m[0].length - 1;
            let depth = 0;
            for (let i = open; i < source.length; i++) {
                if (source[i] === '{') depth++;
                else if (source[i] === '}') {
                    depth--;
                    if (depth === 0) {
                        out.push(source.slice(open, i + 1));
                        break;
                    }
                }
            }
        }
        return out;
    }

    for (const producer of PRODUCER_FILES) {
        test(`${producer.name}: every DueItem construction includes ownerUserId`, () => {
            const source = readFileSync(resolve(__dirname, producer.path), 'utf8');

            // Find all DueItem constructions — they must include ownerUserId.
            //
            // These are extracted by BRACE MATCHING, not by regex. The
            // previous `return\s*\{[\s\S]*?entityType[\s\S]*?\}`
            // scanned forward from ANY `return {` until it found the word
            // `entityType` anywhere later in the file, so it happily
            // spanned unrelated statements. It went unnoticed while a
            // real DueItem return happened to sit close by; once GRC
            // teardown phase 3 removed the Practice and Policy scanners,
            // the nearest `entityType` was hundreds of lines away and the
            // guard reported `classifyUrgency`'s
            // `return { urgency, daysRemaining }` as a DueItem missing
            // its ownerUserId. A guard that reports the wrong line is
            // worse than one that reports nothing.
            const allBlocks = extractObjectLiterals(source).filter((b) =>
                b.includes('entityType'),
            );

            expect(allBlocks.length).toBeGreaterThan(0);

            const violations: string[] = [];
            for (const block of allBlocks) {
                if (!block.includes('ownerUserId')) {
                    violations.push(
                        `DueItem in ${producer.name} missing ownerUserId: ${block.slice(0, 80)}...`
                    );
                }
            }

            expect(violations).toEqual([]);
        });

        test(`${producer.name}: does NOT hardcode ownerUserId: undefined`, () => {
            const source = readFileSync(resolve(__dirname, producer.path), 'utf8');

            // The exact bug pattern we're guarding against
            const forbiddenPattern = /ownerUserId:\s*undefined/g;
            const matches = source.match(forbiddenPattern) || [];

            expect(matches).toEqual([]);
        });
    }

    test('every PRODUCED MonitoredEntityType is covered by at least one producer', () => {
        const coveredTypes = new Set<string>();
        for (const producer of PRODUCER_FILES) {
            for (const et of producer.expectedEntityTypes) {
                coveredTypes.add(et);
            }
        }

        // The set of types a surviving job actually emits. GRC teardown
        // phase 2 took the VENDOR / RISK / TEST_PLAN / TREATMENT_*
        // scanners and phase 3 took the PRACTICE and POLICY ones, along
        // with those members of the `MonitoredEntityType` union. Two
        // producers remain: deadline-monitor emits TASK, and
        // evidence-expiry-monitor emits EVIDENCE.
        const PRODUCED_TYPES: MonitoredEntityType[] = ['EVIDENCE', 'TASK'];

        const uncovered = PRODUCED_TYPES.filter(t => !coveredTypes.has(t));
        expect(uncovered).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Source Audit — Queries Select Owner Fields
// ═════════════════════════════════════════════════════════════════════

describe('Structural: scanner queries select owner fields', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');

    test('deadline-monitor: every scanner selects ownerUserId or assigneeUserId', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/jobs/deadline-monitor.ts'), 'utf8'
        );

        // Each scanner should have ownerUserId: true or assigneeUserId: true in its select.
        // The floor was 5, then 3; GRC teardown phase 3 left `scanTasks`
        // as the only scanner, so it is 1. The per-block assertion below
        // is the load-bearing half — the floor only guards against the
        // regex silently matching nothing, which would make the loop
        // vacuous.
        const selectBlocks = source.match(/select:\s*\{[\s\S]*?\}/g) || [];
        expect(selectBlocks.length).toBeGreaterThanOrEqual(1);

        for (const block of selectBlocks) {
            const hasOwnerField =
                block.includes('ownerUserId') || block.includes('assigneeUserId');
            expect(hasOwnerField).toBe(true);
        }
    });

    test('evidence-expiry-monitor: queries select ownerUserId', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/jobs/evidence-expiry-monitor.ts'), 'utf8'
        );

        const selectBlocks = source.match(/select:\s*\{[\s\S]*?\}/g) || [];
        expect(selectBlocks.length).toBeGreaterThanOrEqual(2);

        for (const block of selectBlocks) {
            expect(block).toContain('ownerUserId');
        }
    });

    // A third case scanned services/vendor-renewals.ts, deleted in GRC
    // teardown phase 2 with the Vendor model. Deliberately NOT re-pointed:
    // the two tests above already assert exactly this bound ("every select
    // block in a DueItem producer names an owner field") against both
    // surviving producers, so a replacement would be a third copy of an
    // assertion that is already enforced everywhere it can apply.
});
