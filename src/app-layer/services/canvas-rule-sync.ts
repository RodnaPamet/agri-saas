/**
 * Canvas ↔ AutomationRule bidirectional bridge (Visual Rule Editor VR-3).
 *
 * The architectural keystone. Two sibling projections of one source of truth:
 *   • `ProcessNode` owns GEOMETRY (posX/posY/parentNodeKey/label) + the link
 *     (`dataJson.ruleId`).
 *   • `AutomationRule` owns LOGIC (triggerEvent / filter / action / chain).
 *
 * INVARIANT (locked by tests/guards/vr3-sync-invariant.test.ts):
 *   - Geometry fields NEVER appear in an AutomationRule write.
 *   - Logic fields (triggerFilterJson / actionConfigJson / triggerEvent)
 *     NEVER appear in a ProcessNode write. The only thing this bridge writes
 *     to a node is `dataJson.ruleId` (an opaque id).
 *
 * Model: an `action` node owns one rule (trigger + filter + action collapse
 * into the single AutomationRule row). Trigger/condition nodes feed that rule
 * via the inspector (VR-4), which edits the rule directly — NOT through this
 * sync. So this bridge's job is narrow + invariant-safe:
 *   Canvas → Rules (on save): create a stub rule for each NEW action node
 *     (write `ruleId` back), then wire chain topology (`chain-delay` edges →
 *     `nextRuleId`/`nextRuleDelay`). It never copies node logic to the rule.
 *   Rules → Canvas (on load): merge each rule's live status + executionCount
 *     + a derived subtitle into the node for DISPLAY only (not persisted).
 */
import type { PrismaTx } from '@/lib/db-context';
import { AUTOMATION_EVENTS } from '@/app-layer/automation';
import type { RequestContext } from '../types';
import { AutomationRuleRepository } from '../automation';

const ACTION_KIND = 'action';
const CHAIN_EDGE_KIND = 'chain-delay';
const PASS_EDGE_KIND = 'condition-pass';
const FAIL_EDGE_KIND = 'condition-fail';

interface GraphNode {
    nodeKey: string;
    nodeType: string;
    label: string;
    dataJson: unknown;
}
interface GraphEdge {
    sourceKey: string;
    targetKey: string;
    edgeKind: string;
    dataJson: unknown;
}

export interface SyncResult {
    rulesCreated: number;
    chainsLinked: number;
}

function ruleIdOf(node: GraphNode): string | null {
    const d = node.dataJson as { ruleId?: unknown } | null;
    return d && typeof d === 'object' && typeof d.ruleId === 'string' ? d.ruleId : null;
}

/**
 * Canvas → Rules. Run AFTER the graph is persisted (replaceGraph). Creates a
 * DRAFT stub rule for each action node that lacks one, writes the `ruleId`
 * back onto the node's `dataJson`, then wires chain edges.
 */
export async function syncCanvasToRules(
    db: PrismaTx,
    ctx: RequestContext,
    processMapId: string,
): Promise<SyncResult> {
    const nodes = (await db.processNode.findMany({
        where: { processMapId, tenantId: ctx.tenantId, nodeType: ACTION_KIND },
        select: { nodeKey: true, nodeType: true, label: true, dataJson: true },
    })) as GraphNode[];
    const edges = (await db.processEdge.findMany({
        where: {
            processMapId,
            tenantId: ctx.tenantId,
            edgeKind: { in: [CHAIN_EDGE_KIND, PASS_EDGE_KIND, FAIL_EDGE_KIND] },
        },
        select: { sourceKey: true, targetKey: true, edgeKind: true, dataJson: true },
    })) as GraphEdge[];

    const ruleByNodeKey = new Map<string, string>();
    let rulesCreated = 0;

    for (const node of nodes) {
        const existing = ruleIdOf(node);
        if (existing) {
            ruleByNodeKey.set(node.nodeKey, existing);
            continue;
        }
        // Create a stub rule. Default trigger/action are placeholders the
        // user refines via the inspector. NO geometry is written here.
        //
        // The placeholder MUST be a real catalogue event. This was
        // `RISK_CREATED`, which is in neither AUTOMATION_EVENTS nor
        // EVENT_LABELS — it compiled because `triggerEvent` is
        // `AutomationEventName | string`, and it persisted because the
        // column is a plain `String`. Every canvas-born rule was therefore
        // stored with a trigger that can never fire, and the node painted
        // `RISK_CREATED · NOTIFY_USER` onto itself as its identity.
        const rule = await AutomationRuleRepository.create(db, ctx, {
            name: `Canvas rule · ${node.nodeKey}`,
            triggerEvent: AUTOMATION_EVENTS.TASK_CREATED,
            actionType: 'NOTIFY_USER',
            actionConfig: { userIds: [], message: '' },
            status: 'DRAFT',
        });
        rulesCreated++;
        ruleByNodeKey.set(node.nodeKey, rule.id);
        // Write ONLY the ruleId back onto the node (preserve existing dataJson).
        const prev = (node.dataJson && typeof node.dataJson === 'object'
            ? (node.dataJson as Record<string, unknown>)
            : {});
        await db.processNode.updateMany({
            where: { processMapId, tenantId: ctx.tenantId, nodeKey: node.nodeKey },
            data: { dataJson: { ...prev, ruleId: rule.id } },
        });
    }

    // Wire chain topology — pure structure, no node logic copied:
    //   chain-delay     → nextRuleId (+ delay)   [linear next]
    //   condition-pass  → nextRuleId             [branch: filter matched]
    //   condition-fail  → elseRuleId             [branch: filter did not match]
    // The dispatcher (rule-chain-dispatch) evaluates the target rule's filter
    // at run time and follows nextRuleId on match / elseRuleId on miss.
    let chainsLinked = 0;
    for (const edge of edges) {
        const sourceRuleId = ruleByNodeKey.get(edge.sourceKey);
        const targetRuleId = ruleByNodeKey.get(edge.targetKey);
        if (!sourceRuleId || !targetRuleId) continue;
        if (edge.edgeKind === FAIL_EDGE_KIND) {
            await AutomationRuleRepository.update(db, ctx, sourceRuleId, {
                elseRuleId: targetRuleId,
            });
        } else {
            const delay =
                edge.edgeKind === CHAIN_EDGE_KIND
                    ? (edge.dataJson as { delayMinutes?: unknown } | null)?.delayMinutes
                    : undefined;
            await AutomationRuleRepository.update(db, ctx, sourceRuleId, {
                nextRuleId: targetRuleId,
                nextRuleDelay: typeof delay === 'number' ? delay : null,
            });
        }
        chainsLinked++;
    }

    return { rulesCreated, chainsLinked };
}

export interface HydratedNode extends GraphNode {
    /** Display-only enrichment merged from the live rule (not persisted). */
    dataJson: Record<string, unknown>;
}

/**
 * Rules → Canvas. Run on LOAD. For each action node with a ruleId, merge the
 * live rule's status + executionCount + a derived subtitle into the node's
 * dataJson for DISPLAY. This is read-only enrichment — never persisted.
 */
export async function hydrateCanvasFromRules<T extends GraphNode>(
    db: PrismaTx,
    ctx: RequestContext,
    nodes: T[],
): Promise<Array<T & { dataJson: Record<string, unknown> }>> {
    const ruleIds = nodes
        .filter((n) => n.nodeType === ACTION_KIND)
        .map((n) => ruleIdOf(n))
        .filter((id): id is string => !!id);

    const rules =
        ruleIds.length > 0
            ? await db.automationRule.findMany({
                  where: { id: { in: ruleIds }, tenantId: ctx.tenantId },
                  select: {
                      id: true,
                      status: true,
                      executionCount: true,
                      triggerEvent: true,
                      actionType: true,
                  },
              })
            : [];
    const ruleById = new Map(rules.map((r) => [r.id, r]));

    return nodes.map((n) => {
        const base = (n.dataJson && typeof n.dataJson === 'object'
            ? (n.dataJson as Record<string, unknown>)
            : {}) as Record<string, unknown>;
        const id = ruleIdOf(n);
        const rule = id ? ruleById.get(id) : undefined;
        if (!rule) return { ...n, dataJson: base };
        return {
            ...n,
            dataJson: {
                ...base,
                ruleStatus: rule.status,
                executionCount: rule.executionCount,
                ruleSubtitle: `${rule.triggerEvent} · ${rule.actionType}`,
            },
        };
    });
}
