'use client';

/**
 * Automation inspector panel (Visual Rule Editor VR-4).
 *
 * Inline rule configuration when an automation node is selected — the Rule
 * Builder's per-step forms, without leaving the canvas. Branches on node kind
 * (trigger / condition / action / slaGate); edits auto-save to the linked
 * AutomationRule (the node's `dataJson.ruleId`, written by the VR-3 sync).
 *
 * The panel edits the RULE (logic lives on AutomationRule, per the VR-3
 * invariant); it never writes logic back onto the node.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { eventOptionsByDomain } from '@/lib/automation/event-labels';

type AutomationKind = 'trigger' | 'condition' | 'action' | 'slaGate';

interface Rule {
    id: string;
    name: string;
    description: string | null;
    triggerEvent: string;
    triggerFilterJson: unknown;
    actionType: string;
    actionConfigJson: unknown;
    status: string;
    slaWindowMinutes: number | null;
}

const TRIGGER_OPTIONS: ComboboxOption[] = eventOptionsByDomain().flatMap((g) =>
    g.events.map((ev) => ({ value: ev.name, label: ev.label })),
);

export function AutomationInspectorPanel({
    kind,
    ruleId,
}: {
    kind: AutomationKind;
    ruleId: string | null;
}) {
    const t = useTranslations('ui');
    const apiUrl = useTenantApiUrl();
    const ACTION_OPTIONS: ComboboxOption[] = useMemo(
        () => [
            { value: 'NOTIFY_USER', label: t('automationInspector.actionNotifyUser') },
            { value: 'CREATE_TASK', label: t('automationInspector.actionCreateTask') },
            { value: 'UPDATE_STATUS', label: t('automationInspector.actionUpdateStatus') },
            { value: 'WEBHOOK', label: t('automationInspector.actionWebhook') },
        ],
        [t],
    );
    const { data: rule, mutate } = useTenantSWR<Rule>(
        ruleId ? CACHE_KEYS.automation.rules.detail(ruleId) : null,
    );
    const [name, setName] = useState('');
    const [sla, setSla] = useState('');

    // Seeded ONCE PER RULE, not on every change to the server's copy (#1471).
    //
    // This used to depend on `rule?.name` and `rule?.slaWindowMinutes`, which
    // made it a bug rather than only a lint finding. The inputs auto-save on
    // blur and then `mutate()`, so the sequence was: type, blur, PUT in
    // flight, type again, `mutate` resolves, `rule.name` changes, the effect
    // re-seeds — and the keystrokes typed after the blur are gone. An SWR
    // revalidation on focus or interval does the same thing with no save at
    // all.
    //
    // The ref marks which rule the draft belongs to, so switching nodes
    // re-seeds and a server-side change to the rule the user is editing does
    // not. That ordering is the right way round for a draft: while someone is
    // typing, what they typed wins.
    const seededForRuleId = useRef<string | null>(null);
    useEffect(() => {
        if (!rule || seededForRuleId.current === rule.id) return;
        seededForRuleId.current = rule.id;
        setName(rule.name ?? '');
        setSla(rule.slaWindowMinutes != null ? String(rule.slaWindowMinutes) : '');
    }, [rule]);

    // Auto-save via PUT (UpdateAutomationRuleSchema accepts each field
    // optionally; its action-config superRefine only fires when actionType
    // AND actionConfig are sent together, so single-field edits are valid).
    async function patchRule(patch: Record<string, unknown>) {
        if (!ruleId || !rule) return;
        await fetch(apiUrl(CACHE_KEYS.automation.rules.detail(ruleId)), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        await mutate();
    }

    const triggerSelected = useMemo(
        () => TRIGGER_OPTIONS.find((o) => o.value === rule?.triggerEvent) ?? null,
        [rule?.triggerEvent],
    );
    const actionSelected = useMemo(
        () => ACTION_OPTIONS.find((o) => o.value === rule?.actionType) ?? null,
        [ACTION_OPTIONS, rule?.actionType],
    );

    if (!ruleId) {
        return (
            <p className="text-sm text-content-muted" data-testid="automation-inspector-unsynced">
                {t('automationInspector.unsynced')}
            </p>
        );
    }

    return (
        <div className="space-y-default" data-testid="automation-inspector">
            <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wide text-content-subtle">
                    {t('automationInspector.kindRule', { kind })}
                </span>
                <label className="flex items-center gap-tight text-xs text-content-muted">
                    {rule?.status === 'ENABLED' ? t('automationInspector.enabled') : t('automationInspector.disabled')}
                    <Switch
                        checked={rule?.status === 'ENABLED'}
                        onCheckedChange={(c) => patchRule({ status: c ? 'ENABLED' : 'DISABLED' })}
                        aria-label={t('automationInspector.toggleEnabled')}
                    />
                </label>
            </div>

            <FormField label={t('automationInspector.ruleName')}>
                <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => name.trim() && name !== rule?.name && patchRule({ name: name.trim() })}
                />
            </FormField>

            {kind === 'trigger' && (
                <FormField label={t('automationInspector.triggerEvent')}>
                    <Combobox
                        options={TRIGGER_OPTIONS}
                        selected={triggerSelected}
                        setSelected={(o) => o && patchRule({ triggerEvent: o.value })}
                        placeholder={t('automationInspector.selectEvent')}
                        forceDropdown
                        matchTriggerWidth
                    />
                </FormField>
            )}

            {kind === 'action' && (
                <FormField label={t('automationInspector.actionType')}>
                    <Combobox
                        options={ACTION_OPTIONS}
                        selected={actionSelected}
                        setSelected={(o) => o && patchRule({ actionType: o.value })}
                        placeholder={t('automationInspector.selectAction')}
                        forceDropdown
                        matchTriggerWidth
                    />
                </FormField>
            )}

            {kind === 'condition' && (
                <p className="text-xs text-content-subtle">
                    {t('automationInspector.conditionFilter', {
                        state: rule?.triggerFilterJson
                            ? t('automationInspector.configured')
                            : t('automationInspector.matchesAll'),
                    })}
                </p>
            )}

            {kind === 'slaGate' && (
                <FormField label={t('automationInspector.slaWindow')}>
                    <Input
                        type="number"
                        min={1}
                        value={sla}
                        onChange={(e) => setSla(e.target.value)}
                        onBlur={() =>
                            patchRule({ slaWindowMinutes: sla ? Number(sla) : null })
                        }
                        placeholder={t('automationInspector.slaPlaceholder')}
                    />
                </FormField>
            )}
        </div>
    );
}
