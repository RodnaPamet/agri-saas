'use client';

/* TODO(swr-migration): fetch-on-mount + setState pattern (matches the
 * sibling admin/sso page). Migrate to useTenantSWR with that page. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { GroupMappingsSection } from './GroupMappingsSection';

interface EntraConfig {
    aadTenantId: string;
    clientId: string;
    groupClaimMode: 'securityGroup' | 'applicationRole';
    enforceGroupGate: boolean;
    allowedDomains?: string[];
}

const EMPTY: EntraConfig = {
    aadTenantId: '',
    clientId: '',
    groupClaimMode: 'securityGroup',
    enforceGroupGate: false,
    allowedDomains: [],
};

export default function EntraProviderWizard() {
    const t = useTranslations('admin.entra');
    const apiUrl = useTenantApiUrl();
    const [config, setConfig] = useState<EntraConfig>(EMPTY);
    const [configured, setConfigured] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/sso/entra'));
            if (!res.ok) return;
            const data = await res.json();
            if (data?.config) {
                setConfig({ ...EMPTY, ...data.config });
                setConfigured(true);
            }
        } catch {
            /* read-only load; ignore */
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- the setState lands after an await, in a later task, so this is not the synchronous render cascade the rule is about; the loader is an async useCallback whose deps cannot change while mounted, so it runs once
    useEffect(() => { void load(); }, [load]);

    const save = useCallback(async () => {
        setSaving(true);
        setError(null);
        setSaved(false);
        try {
            const res = await fetch(apiUrl('/sso/entra'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...config,
                    allowedDomains: (config.allowedDomains ?? []).filter(Boolean),
                }),
            });
            if (!res.ok) {
                setError(t('saveFailedGuid'));
                return;
            }
            setConfigured(true);
            setSaved(true);
        } catch {
            setError(t('saveFailedNetwork'));
        } finally {
            setSaving(false);
        }
    }, [apiUrl, config, t]);

    return (
        <div className="space-y-section">
            <PageBreadcrumbs items={[{ label: t('breadcrumbAdmin') }, { label: t('breadcrumbEntra') }]} />
            <div className="flex items-center gap-default">
                <Heading level={1}>{t('heading')}</Heading>
                {configured && (
                    <span className="inline-flex items-center gap-tight text-sm text-content-muted">
                        {t('configured')}
                    </span>
                )}
            </div>

            {/* Step 1 + 2 — setup instructions the tenant admin performs in Entra */}
            <Card className="space-y-default p-6">
                <Heading level={3}>{t('step1Title')}</Heading>
                <ol className="list-decimal space-y-tight pl-5 text-sm text-content-muted">
                    <li>
                        {t.rich('step1Item1', {
                            icUrl: '{IC_URL}',
                            code: (chunks) => <code>{chunks}</code>,
                        })}
                    </li>
                    <li>
                        {t.rich('step1Item2', {
                            strong: (chunks) => <strong>{chunks}</strong>,
                            code: (chunks) => <code>{chunks}</code>,
                        })}
                    </li>
                </ol>
                <a
                    className="inline-flex items-center gap-tight text-sm text-content-link"
                    href="https://entra.microsoft.com"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {t('openEntraPortal')}
                </a>
            </Card>

            {/* Step 3 — provider config form */}
            <Card className="space-y-default p-6">
                <Heading level={3}>{t('step2Title')}</Heading>
                {error && <InlineNotice variant="error">{error}</InlineNotice>}
                {saved && <InlineNotice variant="success">{t('saved')}</InlineNotice>}

                <FormField label={t('directoryIdLabel')}>
                    <Input
                        id="aadTenantId"
                        placeholder="00000000-0000-0000-0000-000000000000"
                        value={config.aadTenantId}
                        onChange={(e) => setConfig((c) => ({ ...c, aadTenantId: e.target.value }))}
                    />
                </FormField>
                <FormField label={t('clientIdLabel')}>
                    <Input
                        id="clientId"
                        placeholder="00000000-0000-0000-0000-000000000000"
                        value={config.clientId}
                        onChange={(e) => setConfig((c) => ({ ...c, clientId: e.target.value }))}
                    />
                </FormField>
                <FormField label={t('allowedDomainsLabel')}>
                    <Input
                        id="domains"
                        placeholder={t('allowedDomainsPlaceholder')}
                        value={(config.allowedDomains ?? []).join(', ')}
                        onChange={(e) =>
                            setConfig((c) => ({
                                ...c,
                                allowedDomains: e.target.value.split(',').map((s) => s.trim()),
                            }))
                        }
                    />
                </FormField>
                {/* Group claim mode is fixed to Security groups — Application
                    Roles aren't supported yet (the resolver reads the `groups`
                    claim only); the schema keeps the value for back-compat. */}
                <FormField
                    label={t('enforceGateLabel')}
                    hint={t('enforceGateHint')}
                >
                    <ToggleGroup
                        selected={config.enforceGroupGate ? 'on' : 'off'}
                        selectAction={(v) => setConfig((c) => ({ ...c, enforceGroupGate: v === 'on' }))}
                        options={[
                            { value: 'off', label: t('off') },
                            { value: 'on', label: t('on') },
                        ]}
                    />
                </FormField>

                <div className="flex justify-end pt-default">
                    <Button variant="primary" onClick={save} disabled={saving}>
                        {saving ? t('saving') : t('save')}
                    </Button>
                </div>
            </Card>

            {/* Step 3 — group → role mappings (EI-2) */}
            <GroupMappingsSection apiUrl={apiUrl} />
        </div>
    );
}
