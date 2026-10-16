'use client';

/* TODO(swr-migration): fetch-on-mount + setState, matching the parent
 * EntraProviderWizard. Migrate together to useTenantSWR. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Trash } from '@/components/ui/icons/nucleo/trash';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { NumberStepper } from '@/components/ui/number-stepper';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { useToastWithUndo } from '@/components/ui/hooks';
import { ENTRA_MAPPABLE_ROLES } from '@/app-layer/schemas/entra-group-mapping.schemas';

interface GroupMapping {
    id: string;
    aadGroupId: string;
    aadGroupName: string | null;
    role: string;
    priority: number;
}

const ROLE_OPTIONS = ENTRA_MAPPABLE_ROLES.map((r) => ({ value: r, label: r }));

/**
 * EI-2 — manage the tenant's Entra security-group → IC-role mappings. At
 * sign-in (EI-3) a user's resolved groups are matched against these rows to
 * sync their membership role. OWNER is intentionally not offered — ownership
 * stays manually granted.
 */
export function GroupMappingsSection({ apiUrl }: { apiUrl: (path: string) => string }) {
    const t = useTranslations('admin.entra');
    const [rows, setRows] = useState<GroupMapping[]>([]);
    const [groupId, setGroupId] = useState('');
    const [groupName, setGroupName] = useState('');
    const [role, setRole] = useState<string>('READER');
    const [priority, setPriority] = useState(0);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const triggerUndoToast = useToastWithUndo();

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/sso/entra/group-mappings'));
            if (!res.ok) return;
            setRows(await res.json());
        } catch {
            /* read-only load; ignore */
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- the setState lands after an await, in a later task, so this is not the synchronous render cascade the rule is about; the loader is an async useCallback whose deps cannot change while mounted, so it runs once
    useEffect(() => { void load(); }, [load]);

    const add = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/sso/entra/group-mappings'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    aadGroupId: groupId.trim(),
                    aadGroupName: groupName.trim() || undefined,
                    role,
                    priority,
                }),
            });
            if (!res.ok) {
                setError(
                    res.status === 409
                        ? t('mappingExists')
                        : res.status === 403
                          ? t('mappingAccessDenied')
                          : t('mappingAddFailedGuid'),
                );
                return;
            }
            setGroupId('');
            setGroupName('');
            setRole('READER');
            setPriority(0);
            await load();
        } catch {
            setError(t('mappingAddFailedNetwork'));
        } finally {
            setSaving(false);
        }
    }, [apiUrl, groupId, groupName, role, priority, load, t]);

    const remove = useCallback(
        (m: GroupMapping) => {
            setRows((rs) => rs.filter((r) => r.id !== m.id)); // optimistic
            triggerUndoToast({
                message: t('mappingRemoved', { group: m.aadGroupName ?? m.aadGroupId }),
                undoMessage: t('undo'),
                action: async () => {
                    const res = await fetch(apiUrl(`/sso/entra/group-mappings/${m.id}`), {
                        method: 'DELETE',
                    });
                    // fetch only rejects on network error — surface HTTP failures
                    // so onError fires and the optimistic removal is rolled back.
                    if (!res.ok && res.status !== 404) {
                        throw new Error(`Delete failed (${res.status})`);
                    }
                },
                undoAction: () => load(),
                onError: () => {
                    setError(t('mappingRemoveFailed'));
                    void load();
                },
            });
        },
        [apiUrl, triggerUndoToast, load, t],
    );

    return (
        <Card className="space-y-default p-6">
            <Heading level={3}>{t('mappingsTitle')}</Heading>
            <p className="text-sm text-content-muted">
                {t('mappingsDescription')}
            </p>

            {error && <InlineNotice variant="error">{error}</InlineNotice>}

            {rows.length === 0 ? (
                <EmptyState
                    title={t('mappingsEmptyTitle')}
                    description={t('mappingsEmptyDescription')}
                />
            ) : (
                <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle">
                    {rows.map((m) => (
                        <li key={m.id} className="flex items-center gap-default px-4 py-default">
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-content-default">
                                    {m.aadGroupName ?? m.aadGroupId}
                                </div>
                                {m.aadGroupName && (
                                    <div className="truncate font-mono text-xs text-content-muted">
                                        {m.aadGroupId}
                                    </div>
                                )}
                            </div>
                            <StatusBadge variant="neutral">{m.role}</StatusBadge>
                            <span className="w-20 text-right text-xs text-content-muted">
                                {t('priorityValue', { value: m.priority })}
                            </span>
                            <Button
                                variant="ghost"
                                size="sm"
                                icon={<Trash />}
                                aria-label={t('removeMappingAria', { group: m.aadGroupName ?? m.aadGroupId })}
                                onClick={() => remove(m)}
                            />
                        </li>
                    ))}
                </ul>
            )}

            {/* Add-mapping row */}
            <div className="grid grid-cols-1 gap-default sm:grid-cols-[1fr_1fr_auto_auto_auto] sm:items-end">
                <FormField label={t('groupObjectIdLabel')}>
                    <Input
                        id="entra-mapping-group-id"
                        placeholder="00000000-0000-0000-0000-000000000000"
                        value={groupId}
                        onChange={(e) => setGroupId(e.target.value)}
                    />
                </FormField>
                <FormField label={t('displayNameLabel')}>
                    <Input
                        id="entra-mapping-group-name"
                        placeholder={t('displayNamePlaceholder')}
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                    />
                </FormField>
                <FormField label={t('roleLabel')} hint={t('roleHint')}>
                    <Combobox
                        id="entra-mapping-role"
                        options={ROLE_OPTIONS}
                        selected={ROLE_OPTIONS.find((o) => o.value === role) ?? ROLE_OPTIONS[0]}
                        setSelected={(opt) => setRole(opt?.value ?? 'READER')}
                        matchTriggerWidth
                    />
                </FormField>
                <FormField label={t('priorityLabel')}>
                    <NumberStepper value={priority} onChange={setPriority} min={0} max={1000} />
                </FormField>
                <Button
                    variant="primary"
                    onClick={add}
                    disabled={saving || !groupId.trim()}
                >
                    {saving ? t('addingMapping') : t('addMapping')}
                </Button>
            </div>
        </Card>
    );
}
