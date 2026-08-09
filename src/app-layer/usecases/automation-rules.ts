/**
 * Automation rule usecases (Workflow Automation Epic 1).
 *
 * Thin orchestration over `AutomationRuleRepository`: assert the
 * automation-domain policy, run inside the tenant RLS context, call the
 * repo, emit an audit event on mutation. The HTTP routes under
 * `/api/t/[slug]/automation/rules` call these — never the repo directly.
 *
 * RBAC uses the automation module's own policies (`assertCanReadAutomation`
 * / `assertCanManageAutomation`) rather than new `PermissionSet` keys: the
 * domain already ships dedicated RBAC (read = any member, manage = ADMIN),
 * and `/automation/` is not a `PRIVILEGED_ROOTS` entry in the
 * api-permission-coverage guard, so the usecase-policy pattern is correct
 * here (same as practices/risks/evidence).
 */
import { RequestContext } from '../types';
import {
    AutomationRuleRepository,
    assertCanReadAutomation,
    assertCanManageAutomation,
    type AutomationRuleListFilters,
    type CreateAutomationRuleInput,
    type UpdateAutomationRuleInput,
} from '../automation';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * Pure cycle check (Epic 7): walking the chain from `nextRuleId` via
 * `nextOf`, would we ever reach `ruleId` (loop back) or revisit a node
 * (pre-existing cycle)? Exported for unit testing the algorithm.
 */
export function followChainHasCycle(
    ruleId: string,
    nextRuleId: string,
    nextOf: (id: string) => string | null,
    maxHops = 100,
): boolean {
    let cur: string | null = nextRuleId;
    const seen = new Set<string>();
    let hops = 0;
    while (cur && hops < maxHops) {
        if (cur === ruleId) return true;
        if (seen.has(cur)) return true;
        seen.add(cur);
        cur = nextOf(cur);
        hops++;
    }
    return false;
}

/** Optional free-text fields are sanitised before persistence. */
function sanitizeOptional(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return sanitizePlainText(value);
}

export async function listAutomationRules(
    ctx: RequestContext,
    filters: AutomationRuleListFilters = {},
) {
    assertCanReadAutomation(ctx);
    return runInTenantContext(ctx, (db) =>
        AutomationRuleRepository.list(db, ctx, filters),
    );
}

export async function getAutomationRule(ctx: RequestContext, id: string) {
    assertCanReadAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rule = await AutomationRuleRepository.getById(db, ctx, id);
        if (!rule) throw notFound('Automation rule not found');
        return rule;
    });
}

export async function createAutomationRule(
    ctx: RequestContext,
    input: CreateAutomationRuleInput,
) {
    assertCanManageAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rule = await AutomationRuleRepository.create(db, ctx, {
            ...input,
            name: sanitizePlainText(input.name),
            description: sanitizeOptional(input.description),
        });
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULE_CREATED',
            entityType: 'AutomationRule',
            entityId: rule.id,
            detailsJson: {
                name: rule.name,
                triggerEvent: rule.triggerEvent,
                actionType: rule.actionType,
                status: rule.status,
            },
        });
        return rule;
    });
}

export async function updateAutomationRule(
    ctx: RequestContext,
    id: string,
    input: UpdateAutomationRuleInput,
) {
    assertCanManageAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        // Chain cycle guard (Epic 7): a new nextRuleId must not loop back.
        if (input.nextRuleId) {
            const nextCache = new Map<string, string | null>();
            let cur: string | null = input.nextRuleId;
            const seen = new Set<string>();
            let hops = 0;
            while (cur && hops < 100) {
                if (cur === id) throw badRequest('Rule chain would create a cycle');
                if (seen.has(cur)) break;
                seen.add(cur);
                if (!nextCache.has(cur)) {
                    const r = await AutomationRuleRepository.getById(db, ctx, cur);
                    nextCache.set(cur, r?.nextRuleId ?? null);
                }
                cur = nextCache.get(cur) ?? null;
                hops++;
            }
        }
        const rule = await AutomationRuleRepository.update(db, ctx, id, {
            ...input,
            ...(input.name !== undefined ? { name: sanitizePlainText(input.name) } : {}),
            ...(input.description !== undefined
                ? { description: sanitizeOptional(input.description) }
                : {}),
        });
        if (!rule) throw notFound('Automation rule not found');
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULE_UPDATED',
            entityType: 'AutomationRule',
            entityId: rule.id,
            detailsJson: { name: rule.name, status: rule.status },
        });
        return rule;
    });
}

export async function toggleAutomationRule(
    ctx: RequestContext,
    id: string,
    status: 'ENABLED' | 'DISABLED',
) {
    assertCanManageAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rule = await AutomationRuleRepository.toggle(db, ctx, id, status);
        if (!rule) {
            throw notFound('Automation rule not found, or it has been archived');
        }
        await logEvent(db, ctx, {
            action: status === 'ENABLED' ? 'AUTOMATION_RULE_ENABLED' : 'AUTOMATION_RULE_DISABLED',
            entityType: 'AutomationRule',
            entityId: rule.id,
            detailsJson: { name: rule.name, status },
        });
        return rule;
    });
}

export async function archiveAutomationRule(ctx: RequestContext, id: string) {
    assertCanManageAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await AutomationRuleRepository.getById(db, ctx, id);
        if (!existing) throw notFound('Automation rule not found');
        const rule = await AutomationRuleRepository.archive(db, ctx, id);
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULE_ARCHIVED',
            entityType: 'AutomationRule',
            entityId: id,
            detailsJson: { name: existing.name },
        });
        return rule;
    });
}
