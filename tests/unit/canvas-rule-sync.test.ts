/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * VR-3 — Canvas ↔ AutomationRule bridge.
 *
 * Verifies the sync + hydration AND the load-bearing invariant: geometry
 * never reaches a rule write; only `ruleId` is ever written to a node.
 */

jest.mock('@/app-layer/automation', () => ({
    // Spread the REAL barrel, then override only the repository. The factory
    // used to return the repository alone, so every other export — including
    // `AUTOMATION_EVENTS` — was `undefined` inside the module under test.
    // That was invisible while the source hard-coded a string literal for the
    // stub trigger; the moment it referenced the catalogue the mock became a
    // TypeError. Keeping the real constants means the assertion below is
    // about the actual catalogue value, not a copy of it.
    ...jest.requireActual('@/app-layer/automation'),
    AutomationRuleRepository: { create: jest.fn(), update: jest.fn() },
}));

import { syncCanvasToRules, hydrateCanvasFromRules } from '@/app-layer/services/canvas-rule-sync';
import { AutomationRuleRepository } from '@/app-layer/automation';

const repo = AutomationRuleRepository as jest.Mocked<typeof AutomationRuleRepository>;

const ctx = { tenantId: 't1', userId: 'u1' } as any;

function makeDb(nodes: any[], edges: any[]) {
    return {
        processNode: { findMany: jest.fn().mockResolvedValue(nodes), updateMany: jest.fn() },
        processEdge: { findMany: jest.fn().mockResolvedValue(edges) },
        automationRule: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
}

beforeEach(() => jest.clearAllMocks());

describe('syncCanvasToRules', () => {
    it('creates a stub rule for a new action node and writes only ruleId back', async () => {
        const db = makeDb(
            [{ nodeKey: 'a1', nodeType: 'action', label: 'Notify', dataJson: { color: 'blue' } }],
            [],
        );
        repo.create.mockResolvedValue({ id: 'rule-1' } as any);

        const res = await syncCanvasToRules(db, ctx, 'map-1');

        expect(res.rulesCreated).toBe(1);
        // node-write carries ONLY dataJson with ruleId (+ preserved fields), no logic
        const nodeWrite = db.processNode.updateMany.mock.calls[0][0];
        expect(nodeWrite.data.dataJson).toEqual({ color: 'blue', ruleId: 'rule-1' });
        expect(JSON.stringify(nodeWrite.data)).not.toMatch(/triggerFilterJson|actionConfigJson/);
        // rule-write carries NO geometry
        const ruleCreate = repo.create.mock.calls[0][2];
        expect(JSON.stringify(ruleCreate)).not.toMatch(/posX|posY|parentNodeKey/);
    });

    it('skips an action node that already has a ruleId', async () => {
        const db = makeDb(
            [{ nodeKey: 'a1', nodeType: 'action', label: 'X', dataJson: { ruleId: 'r-existing' } }],
            [],
        );
        const res = await syncCanvasToRules(db, ctx, 'map-1');
        expect(res.rulesCreated).toBe(0);
        expect(repo.create).not.toHaveBeenCalled();
        expect(db.processNode.updateMany).not.toHaveBeenCalled();
    });

    it('wires a chain-delay edge to nextRuleId on the source rule', async () => {
        const db = makeDb(
            [
                { nodeKey: 'a1', nodeType: 'action', label: 'A', dataJson: { ruleId: 'r1' } },
                { nodeKey: 'a2', nodeType: 'action', label: 'B', dataJson: { ruleId: 'r2' } },
            ],
            [{ sourceKey: 'a1', targetKey: 'a2', edgeKind: 'chain-delay', dataJson: { delayMinutes: 15 } }],
        );
        const res = await syncCanvasToRules(db, ctx, 'map-1');
        expect(res.chainsLinked).toBe(1);
        expect(repo.update).toHaveBeenCalledWith(db, ctx, 'r1', {
            nextRuleId: 'r2',
            nextRuleDelay: 15,
        });
    });

    it('PR-F: materializes condition-pass → nextRuleId and condition-fail → elseRuleId', async () => {
        const db = makeDb(
            [
                { nodeKey: 'a1', nodeType: 'action', label: 'A', dataJson: { ruleId: 'r1' } },
                { nodeKey: 'a2', nodeType: 'action', label: 'B', dataJson: { ruleId: 'r2' } },
                { nodeKey: 'a3', nodeType: 'action', label: 'C', dataJson: { ruleId: 'r3' } },
            ],
            [
                { sourceKey: 'a1', targetKey: 'a2', edgeKind: 'condition-pass', dataJson: null },
                { sourceKey: 'a1', targetKey: 'a3', edgeKind: 'condition-fail', dataJson: null },
            ],
        );
        await syncCanvasToRules(db, ctx, 'map-1');
        expect(repo.update).toHaveBeenCalledWith(db, ctx, 'r1', { nextRuleId: 'r2', nextRuleDelay: null });
        expect(repo.update).toHaveBeenCalledWith(db, ctx, 'r1', { elseRuleId: 'r3' });
    });
});

describe('hydrateCanvasFromRules', () => {
    it('merges live rule status/executionCount/subtitle into action nodes', async () => {
        const db = makeDb([], []);
        db.automationRule.findMany.mockResolvedValue([
            { id: 'r1', status: 'ENABLED', executionCount: 7, triggerEvent: 'TASK_CREATED', actionType: 'NOTIFY_USER' },
        ]);
        const out = await hydrateCanvasFromRules(db, ctx, [
            { nodeKey: 'a1', nodeType: 'action', label: 'A', dataJson: { ruleId: 'r1' } },
            { nodeKey: 'p1', nodeType: 'processStep', label: 'P', dataJson: { foo: 1 } },
        ] as any);
        expect(out[0].dataJson).toMatchObject({
            ruleId: 'r1',
            ruleStatus: 'ENABLED',
            executionCount: 7,
            ruleSubtitle: 'TASK_CREATED · NOTIFY_USER',
        });
        // non-action node untouched
        expect(out[1].dataJson).toEqual({ foo: 1 });
    });
});
