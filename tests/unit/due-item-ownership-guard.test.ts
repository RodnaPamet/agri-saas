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
    test('CONTROL: resolves ownerUserId', () => {
        const result = resolveDueItemOwner('CONTROL', { ownerUserId: 'user-1' });
        expect(result).toBe('user-1');
    });

    test('EVIDENCE: resolves ownerUserId', () => {
        const result = resolveDueItemOwner('EVIDENCE', { ownerUserId: 'user-2' });
        expect(result).toBe('user-2');
    });

    test('POLICY: resolves ownerUserId', () => {
        const result = resolveDueItemOwner('POLICY', { ownerUserId: 'user-3' });
        expect(result).toBe('user-3');
    });

    test('VENDOR: resolves ownerUserId', () => {
        const result = resolveDueItemOwner('VENDOR', { ownerUserId: 'user-4' });
        expect(result).toBe('user-4');
    });

    test('TASK: resolves assigneeUserId (not ownerUserId)', () => {
        const result = resolveDueItemOwner('TASK', {
            assigneeUserId: 'user-5',
            ownerUserId: 'user-wrong', // should NOT use this
        });
        expect(result).toBe('user-5');
    });

    test('RISK: resolves ownerUserId', () => {
        const result = resolveDueItemOwner('RISK', { ownerUserId: 'user-6' });
        expect(result).toBe('user-6');
    });

    test('TEST_PLAN: resolves ownerUserId', () => {
        const result = resolveDueItemOwner('TEST_PLAN', { ownerUserId: 'user-7' });
        expect(result).toBe('user-7');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Fallback Behavior — Admin Only for Truly Ownerless
// ═════════════════════════════════════════════════════════════════════

describe('resolveDueItemOwner — fallback behavior', () => {
    test('null ownerUserId returns undefined (triggers admin fallback)', () => {
        const result = resolveDueItemOwner('CONTROL', { ownerUserId: null });
        expect(result).toBeUndefined();
    });

    test('undefined ownerUserId returns undefined', () => {
        const result = resolveDueItemOwner('VENDOR', {});
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
    // This is the authoritative list from types.ts
    const ALL_ENTITY_TYPES: MonitoredEntityType[] = [
        'CONTROL', 'EVIDENCE', 'POLICY', 'VENDOR', 'TASK', 'RISK', 'TEST_PLAN',
        'TREATMENT_PLAN', 'TREATMENT_MILESTONE',
    ];

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

    const PRODUCER_FILES = [
        {
            name: 'deadline-monitor',
            path: '../../src/app-layer/jobs/deadline-monitor.ts',
            expectedEntityTypes: ['CONTROL', 'POLICY', 'TASK', 'RISK', 'TEST_PLAN'],
        },
        {
            name: 'evidence-expiry-monitor',
            path: '../../src/app-layer/jobs/evidence-expiry-monitor.ts',
            expectedEntityTypes: ['EVIDENCE'],
        },
        {
            name: 'vendor-renewal-check',
            path: '../../src/app-layer/jobs/vendor-renewal-check.ts',
            expectedEntityTypes: ['VENDOR'],
        },
    ];

    for (const producer of PRODUCER_FILES) {
        test(`${producer.name}: every DueItem construction includes ownerUserId`, () => {
            const source = readFileSync(resolve(__dirname, producer.path), 'utf8');

            // Find all DueItem pushes/returns — they must include ownerUserId
            const dueItemPattern = /items\.push\(\{[\s\S]*?\}\)/g;
            const returnPattern = /return\s*\{[\s\S]*?entityType[\s\S]*?\}/g;

            const allBlocks = [
                ...(source.match(dueItemPattern) || []),
                ...(source.match(returnPattern) || []),
            ].filter(block => block.includes('entityType'));

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

    test('all MonitoredEntityTypes are covered by at least one producer', () => {
        const coveredTypes = new Set<string>();
        for (const producer of PRODUCER_FILES) {
            for (const et of producer.expectedEntityTypes) {
                coveredTypes.add(et);
            }
        }

        const ALL_TYPES: MonitoredEntityType[] = [
            'CONTROL', 'EVIDENCE', 'POLICY', 'VENDOR', 'TASK', 'RISK', 'TEST_PLAN',
        ];

        const uncovered = ALL_TYPES.filter(t => !coveredTypes.has(t));
        expect(uncovered).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Source Audit — Queries Select Owner Fields
// ═════════════════════════════════════════════════════════════════════

describe('Structural: scanner queries select owner fields', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');

    test('deadline-monitor: all 3 scanners select ownerUserId or assigneeUserId', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/jobs/deadline-monitor.ts'), 'utf8'
        );

        // Each scanner should have ownerUserId: true or assigneeUserId: true in its select.
        // Floor was 5 until the Risk + ControlTestPlan scanners went with
        // their models; Control / Policy / Task remain.
        const selectBlocks = source.match(/select:\s*\{[\s\S]*?\}/g) || [];
        expect(selectBlocks.length).toBeGreaterThanOrEqual(3);

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

    test('vendor-renewals: queries select ownerUserId', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/services/vendor-renewals.ts'), 'utf8'
        );

        const selectBlocks = source.match(/select:\s*\{[\s\S]*?\}/g) || [];
        expect(selectBlocks.length).toBeGreaterThanOrEqual(4);

        for (const block of selectBlocks) {
            expect(block).toContain('ownerUserId');
        }
    });
});
