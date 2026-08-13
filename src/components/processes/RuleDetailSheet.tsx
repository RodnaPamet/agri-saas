'use client';

/**
 * Rule detail sheet (Automation Epic 2).
 *
 * Inline inspect-and-edit panel for a single automation rule — the
 * slide-out detail Archer's workflow manager opens from its rule list.
 * Enable/disable toggle + priority stepper mutate optimistically against
 * the list cache; trigger + action summary cards read the rule's config.
 *
 * The execution mini-log is a placeholder until Epic 6 (execution history)
 * lands; the Edit button opens the builder modal from Epic 3.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Sheet } from '@/components/ui/sheet';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { NumberStepper } from '@/components/ui/number-stepper';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { ExecutionsPanel } from '@/components/processes/ExecutionsPanel';
import type { AutomationRuleRow } from '@/components/processes/types';
import { RULE_ACTION_LABELS } from '@/components/processes/automation-filter-defs';

function humanizeEvent(name: string): string {
    return name
        .toLowerCase()
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

export interface RuleDetailSheetProps {
    rule: AutomationRuleRow | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Opens the builder modal in edit mode (Epic 3). */
    onEdit?: (rule: AutomationRuleRow) => void;
}

export function RuleDetailSheet({ rule, open, onOpenChange, onEdit }: RuleDetailSheetProps) {
    const t = useTranslations('ui');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();

    const patchMutation = useTenantMutation<
        AutomationRuleRow[],
        { id: string; status?: 'ENABLED' | 'DISABLED'; priority?: number },
        unknown
    >({
        key: CACHE_KEYS.automation.rules.list(),
        mutationFn: async ({ id, status, priority }) => {
            const res = await fetch(apiUrl(CACHE_KEYS.automation.rules.detail(id)), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, priority }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Update failed' }));
                throw new Error(err.error ?? 'Update failed');
            }
            return res.json();
        },
        optimisticUpdate: (current, { id, status, priority }) =>
            (current ?? []).map((r) =>
                r.id === id
                    ? {
                          ...r,
                          ...(status !== undefined ? { status } : {}),
                          ...(priority !== undefined ? { priority } : {}),
                      }
                    : r,
            ),
    });

    const isArchived = rule?.status === 'ARCHIVED';
    const isEnabled = rule?.status === 'ENABLED';

    const triggerSummary = useMemo(
        () => (rule ? humanizeEvent(rule.triggerEvent) : ''),
        [rule],
    );

    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={rule?.name ?? t('ruleDetail.rule')}
            description={t('ruleDetail.detailDescription')}
        >
            {rule && (
                <>
                    <Sheet.Header title={rule.name} />
                    <Sheet.Body>
                        <div className="space-y-default">
                            {/* Status + enable toggle */}
                            <div className="flex items-center justify-between gap-default">
                                <div className="flex items-center gap-compact">
                                    <StatusBadge
                                        variant={isEnabled ? 'success' : 'neutral'}
                                    >
                                        {rule.status}
                                    </StatusBadge>
                                </div>
                                <label className="flex items-center gap-compact text-sm text-content-muted">
                                    {isEnabled ? t('automationInspector.enabled') : t('automationInspector.disabled')}
                                    <Switch
                                        checked={isEnabled}
                                        disabled={isArchived || patchMutation.isMutating}
                                        onCheckedChange={(checked) =>
                                            patchMutation.trigger({
                                                id: rule.id,
                                                status: checked ? 'ENABLED' : 'DISABLED',
                                            })
                                        }
                                        aria-label={t('automationInspector.toggleEnabled')}
                                    />
                                </label>
                            </div>

                            {/* Trigger summary */}
                            <Card>
                                <div className="space-y-tight">
                                    <p className="text-[11px] uppercase tracking-wide text-content-subtle">
                                        {t('ruleDetail.trigger')}
                                    </p>
                                    <p className="text-sm text-content-emphasis">
                                        {triggerSummary}
                                    </p>
                                </div>
                            </Card>

                            {/* Action summary */}
                            <Card>
                                <div className="space-y-tight">
                                    <p className="text-[11px] uppercase tracking-wide text-content-subtle">
                                        {t('ruleDetail.action')}
                                    </p>
                                    <p className="text-sm text-content-emphasis">
                                        {RULE_ACTION_LABELS[rule.actionType] ?? rule.actionType}
                                    </p>
                                </div>
                            </Card>

                            {/* Priority */}
                            <div className="flex items-center justify-between gap-default">
                                <span className="text-sm text-content-muted">{t('ruleDetail.priority')}</span>
                                <NumberStepper
                                    value={rule.priority}
                                    min={0}
                                    max={1000}
                                    disabled={isArchived || patchMutation.isMutating}
                                    onChange={(value) =>
                                        patchMutation.trigger({ id: rule.id, priority: value })
                                    }
                                    aria-label={t('ruleDetail.rulePriority')}
                                />
                            </div>

                            {/* Execution history (Epic 6) — list + re-trigger. */}
                            <Card>
                                <ExecutionsPanel ruleId={rule.id} ruleEnabled={isEnabled} />
                            </Card>
                        </div>
                    </Sheet.Body>
                    <Sheet.Actions align="between">
                        <Sheet.Close asChild>
                            <Button variant="ghost">{tCommon('close')}</Button>
                        </Sheet.Close>
                        {onEdit && !isArchived && (
                            <Button variant="secondary" onClick={() => onEdit(rule)}>
                                {tCommon('edit')}
                            </Button>
                        )}
                    </Sheet.Actions>
                </>
            )}
        </Sheet>
    );
}
