'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card, cardVariants } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { ShieldCheck, Save, AlertTriangle, LogOut, Users, UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InfoTooltip } from '@/components/ui/tooltip';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { cn } from '@/lib/cn';

type MfaPolicy = 'DISABLED' | 'OPTIONAL' | 'REQUIRED';

interface SecuritySettings {
    mfaPolicy: MfaPolicy;
    sessionMaxAgeMinutes: number | null;
}

const POLICY_OPTIONS: { value: MfaPolicy; label: string; description: string }[] = [
    {
        value: 'DISABLED',
        label: 'Disabled',
        description: 'MFA is not available. Users cannot enroll in multi-factor authentication.',
    },
    {
        value: 'OPTIONAL',
        label: 'Optional',
        description: 'Users can choose to enable MFA. Enrolled users will be challenged at login.',
    },
    {
        value: 'REQUIRED',
        label: 'Required',
        description: 'All users must enroll in MFA. Users without MFA will be redirected to enrollment on login.',
    },
];

export default function AdminSecurityPage() {
    const t = useTranslations('admin.security');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [settings, setSettings] = useState<SecuritySettings>({ mfaPolicy: 'DISABLED', sessionMaxAgeMinutes: null });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [revoking, setRevoking] = useState(false);
    const [revokeUserId, setRevokeUserId] = useState('');

    const fetchSettings = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/security/mfa/policy'));
            if (res.ok) {
                const data = await res.json();
                setSettings(data);
            }
        } catch {
            setError(t('loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchSettings(); }, [fetchSettings]);

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch(apiUrl('/security/mfa/policy'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || t('saveFailed'));
            }
            const updated = await res.json();
            setSettings(updated);
            setSuccess(t('settingsSaved'));
            setTimeout(() => setSuccess(null), 3000);
        } catch (err) {
            setError(err instanceof Error ? err.message : t('saveSettingsFailed'));
        } finally {
            setSaving(false);
        }
    };

    const handleRevokeMySessions = async () => {
        if (!confirm(t('confirmRevokeMine'))) return;
        setRevoking(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/sessions/revoke-current'), { method: 'POST' });
            if (res.ok) {
                setSuccess(t('mySessionsRevoked'));
                setTimeout(() => {
                    // Full navigation: the session was just revoked, so cached
                    // client state must not survive into a soft router push.
                    window.location.href = new URL('/login', window.location.origin).href;
                }, 2000);
            } else {
                throw new Error(t('revokeSessionsFailed'));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('revocationFailed'));
        } finally {
            setRevoking(false);
        }
    };

    const handleRevokeAllTenant = async () => {
        if (!confirm(t('confirmRevokeAll'))) return;
        setRevoking(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/sessions/revoke-all'), { method: 'POST' });
            const data = await res.json();
            if (res.ok) {
                setSuccess(t('allSessionsRevoked', { count: data.usersAffected }));
            } else {
                throw new Error(data.error || t('revokeFailedShort'));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('bulkRevocationFailed'));
        } finally {
            setRevoking(false);
        }
    };

    const handleRevokeUser = async () => {
        if (!revokeUserId.trim()) return;
        if (!confirm(t('confirmRevokeUser', { user: revokeUserId }))) return;
        setRevoking(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/sessions/revoke-user'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetUserId: revokeUserId.trim() }),
            });
            const data = await res.json();
            if (res.ok) {
                setSuccess(t('userSessionsRevoked'));
                setRevokeUserId('');
                setTimeout(() => setSuccess(null), 3000);
            } else {
                throw new Error(data.error || t('revokeUserFailed'));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('userRevocationFailed'));
        } finally {
            setRevoking(false);
        }
    };

    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                        { label: t('breadcrumbSecurity') },
                    ]}
                    className="mb-1"
                />
                <Heading level={2} className="flex items-center gap-tight">
                    <ShieldCheck className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('loading')}
                </Heading>
                <Card>
                    <div className="animate-pulse space-y-default">
                        <div className="h-4 bg-bg-elevated rounded w-1/3" />
                        <div className="h-10 bg-bg-elevated rounded w-full" />
                        <div className="h-10 bg-bg-elevated rounded w-full" />
                        <div className="h-10 bg-bg-elevated rounded w-full" />
                    </div>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn">
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                        { label: t('breadcrumbSecurity') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1} className="flex items-center gap-tight">
                    <ShieldCheck className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('heading')}
                </Heading>
            </div>

            {error && (
                <InlineNotice variant="error" icon={AlertTriangle}>{error}</InlineNotice>
            )}

            {success && (
                <InlineNotice variant="success">{success}</InlineNotice>
            )}

            {/* MFA Policy Section */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                <div>
                    <div className="flex items-center gap-tight">
                        <Heading level={2}>{t('mfaPolicyTitle')}</Heading>
                        <InfoTooltip
                            aria-label={t('mfaPolicyAbout')}
                            iconClassName="h-4 w-4"
                            content={t('mfaPolicyTooltip')}
                        />
                    </div>
                    <p className="text-sm text-content-muted mt-1">
                        {t('mfaPolicyDesc')}
                    </p>
                </div>

                <div className="space-y-compact">
                    {POLICY_OPTIONS.map((option) => (
                        <label
                            key={option.value}
                            className={`flex items-start gap-compact p-4 rounded-lg border cursor-pointer transition-all ${
                                settings.mfaPolicy === option.value
                                    ? 'border-[var(--brand-default)]/60 bg-[var(--brand-subtle)]'
                                    : 'border-border-default hover:border-border-emphasis'
                            }`}
                        >
                            <input
                                type="radio"
                                name="mfaPolicy"
                                value={option.value}
                                checked={settings.mfaPolicy === option.value}
                                onChange={() => setSettings(s => ({ ...s, mfaPolicy: option.value }))}
                                className="mt-1 accent-[var(--brand-default)]"
                            />
                            <div>
                                <span className={`text-sm font-medium ${
                                    settings.mfaPolicy === option.value ? 'text-[var(--brand-muted)]' : 'text-content-emphasis'
                                }`}>
                                    {t(`policy.${option.value}.label`)}
                                    {option.value === 'REQUIRED' && (
                                        <StatusBadge variant="warning" className="ml-2">{t('strict')}</StatusBadge>
                                    )}
                                </span>
                                <p className="text-xs text-content-muted mt-1">{t(`policy.${option.value}.description`)}</p>
                            </div>
                        </label>
                    ))}
                </div>

                {settings.mfaPolicy === 'REQUIRED' && (
                    <InlineNotice variant="warning" title={t('beforeRequired')}>
                        <ul className="text-xs text-content-warning list-disc pl-4 space-y-1">
                            <li>{t('beforeRequired1')}</li>
                            <li>{t('beforeRequired2')}</li>
                            <li>{t('beforeRequired3')}</li>
                        </ul>
                    </InlineNotice>
                )}
            </div>

            {/* Session Settings */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                <div>
                    <Heading level={2} className="mb-1">{t('sessionSettings')}</Heading>
                    <p className="text-sm text-content-muted">
                        {t('sessionSettingsDesc')}
                    </p>
                </div>

                <div>
                    <div className="mb-1 flex items-center gap-1.5">
                        <label className="block text-sm text-content-default">{t('maxSessionAge')}</label>
                        <InfoTooltip
                            aria-label={t('maxSessionAgeAbout')}
                            iconClassName="h-3.5 w-3.5"
                            content={t('maxSessionAgeTooltip')}
                        />
                    </div>
                    <input
                        type="number"
                        min={5}
                        max={43200}
                        placeholder={t('defaultNoLimit')}
                        value={settings.sessionMaxAgeMinutes ?? ''}
                        onChange={(e) => {
                            const val = e.target.value ? parseInt(e.target.value, 10) : null;
                            setSettings(s => ({ ...s, sessionMaxAgeMinutes: val }));
                        }}
                        className="input w-full max-w-xs"
                    />
                    <p className="text-xs text-content-subtle mt-1">{t('minMaxNote')}</p>
                </div>
            </div>

            {/* Save Button */}
            <div className="flex justify-end">
                <Button
                    variant="primary"
                    onClick={handleSave}
                    disabled={saving}
                    loading={saving}
                    id="security-save-btn"
                >
                    <Save className="w-4 h-4" />
                    {saving ? t('savingSettings') : t('saveSettings')}
                </Button>
            </div>

            {/* ──── Session Management ──── */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                <div>
                    <Heading level={2} className="mb-1">{t('sessionManagement')}</Heading>
                    <p className="text-sm text-content-muted">
                        {t('sessionManagementDesc')}
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-compact">
                    {/* Revoke my sessions */}
                    <button
                        onClick={handleRevokeMySessions}
                        disabled={revoking}
                        className="p-4 border border-border-default rounded-lg hover:border-[var(--brand-default)]/50 transition text-left flex items-start gap-compact group"
                        id="revoke-my-sessions-btn"
                    >
                        <LogOut className="w-5 h-5 text-content-muted group-hover:text-[var(--brand-default)] transition mt-0.5 shrink-0" />
                        <div>
                            <span className="text-sm font-medium text-content-emphasis">{t('signOutOthers')}</span>
                            <p className="text-xs text-content-subtle mt-1">{t('signOutOthersDesc')}</p>
                        </div>
                    </button>

                    {/* Revoke all tenant sessions */}
                    <button
                        onClick={handleRevokeAllTenant}
                        disabled={revoking}
                        className="p-4 border border-border-error rounded-lg hover:border-border-error transition text-left flex items-start gap-compact group"
                        id="revoke-all-sessions-btn"
                    >
                        <Users className="w-5 h-5 text-content-error transition mt-0.5 shrink-0" />
                        <div>
                            <span className="text-sm font-medium text-content-error">{t('revokeAllUsers')}</span>
                            <p className="text-xs text-content-subtle mt-1">{t('revokeAllUsersDesc')}</p>
                        </div>
                    </button>
                </div>

                {/* Revoke specific user */}
                <div className="border-t border-border-default/50 pt-4">
                    <label className="block text-sm text-content-default mb-2">{t('revokeSpecificUser')}</label>
                    <div className="flex gap-tight">
                        <input
                            type="text"
                            placeholder={t('userIdPlaceholder')}
                            value={revokeUserId}
                            onChange={(e) => setRevokeUserId(e.target.value)}
                            className="input flex-1"
                            id="revoke-user-id-input"
                        />
                        <Button
                            variant="destructive-outline"
                            onClick={handleRevokeUser}
                            disabled={revoking || !revokeUserId.trim()}
                            id="revoke-user-btn"
                        >
                            <UserX className="w-4 h-4" />
                            {t('revoke')}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
