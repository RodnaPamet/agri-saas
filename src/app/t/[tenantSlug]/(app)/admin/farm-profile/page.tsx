'use client';

/* TODO(swr-migration): fetch-on-mount + setState pattern (see the
 * admin/security page). Migrate to useTenantSWR with Epic 69. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { cardVariants } from '@/components/ui/card';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { OfficeBuilding } from '@/components/ui/icons/nucleo/office-building';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { SkeletonInput } from '@/components/ui/skeleton';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { cn } from '@/lib/cn';

// БАБХ ДНЕВНИК — the one-per-tenant farm identity block. Every field is
// optional; the paper form tolerates blanks. egn/eik are encrypted at rest
// (Epic B manifest) — this page only ever sees plaintext.
const PROFILE_FIELDS = [
    'producerName',
    'egn',
    'eik',
    'urn',
    'address',
    'municipality',
    'settlement',
    'agricultureDirectorateCity',
    'registrationPlace',
    'registrationEkatte',
    'odbhCity',
] as const;

type ProfileKey = (typeof PROFILE_FIELDS)[number];
type Profile = Record<ProfileKey, string>;

/**
 * Which text fields render, in order, and which carry an encryption note.
 *
 * Labels come from `admin.farmProfile.fields.*` rather than being written here.
 * They were hard-coded Bulgarian before; on a product whose users are Bulgarian
 * that reads harmless, and it is the exact shape `docs/i18n-airtight-roadmap.md`
 * records as the reason a Bulgarian farmer met English dropdowns — a label
 * living in a config module rather than behind a key.
 */
const TEXT_FIELDS: { key: ProfileKey; encrypted?: boolean }[] = [
    { key: 'producerName' },
    { key: 'egn', encrypted: true },
    { key: 'eik', encrypted: true },
    { key: 'urn', encrypted: true },
    { key: 'address' },
    { key: 'municipality' },
    { key: 'settlement' },
    { key: 'agricultureDirectorateCity' },
    { key: 'registrationPlace' },
    { key: 'registrationEkatte' },
    { key: 'odbhCity' },
];

const EMPTY_PROFILE: Profile = PROFILE_FIELDS.reduce(
    (acc, k) => ({ ...acc, [k]: '' }),
    {} as Profile,
);

export default function AdminFarmProfilePage() {
    const t = useTranslations('admin.farmProfile');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
    // Form state is STRINGS because that is what an input holds. The typed
    // values are built at the API boundary, not carried through the form —
    // a half-typed "12." is a valid thing to be looking at and not a number.
    const [sizeHa, setSizeHa] = useState('');
    const [grainProduced, setGrainProduced] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const fetchProfile = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/farm-profile'));
            if (res.ok) {
                const data = await res.json();
                // API returns an all-null shape when unset — coerce to strings.
                setProfile(
                    PROFILE_FIELDS.reduce(
                        (acc, k) => ({ ...acc, [k]: data?.[k] ?? '' }),
                        {} as Profile,
                    ),
                );
                setSizeHa(data?.sizeHa == null ? '' : String(data.sizeHa));
                setGrainProduced((data?.grainProduced ?? []).join(', '));
            }
        } catch {
            setError('Неуспешно зареждане на профила на стопанството.');
        } finally {
            setLoading(false);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchProfile(); }, [fetchProfile]);

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch(apiUrl('/admin/farm-profile'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...profile,
                    // Blank clears the field; anything unparseable is sent as
                    // null rather than 0, because a farm of zero hectares and
                    // a farm nobody has measured are different claims.
                    // Accept the Bulgarian decimal comma as well as the dot.
                    sizeHa: (() => {
                        const raw = sizeHa.trim().replace(',', '.');
                        if (raw === '') return null;
                        const n = Number(raw);
                        return Number.isFinite(n) ? n : null;
                    })(),
                    grainProduced: grainProduced
                        .split(',')
                        .map((g) => g.trim())
                        .filter((g) => g !== ''),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Неуспешно записване.');
            }
            const updated = await res.json();
            setProfile(
                PROFILE_FIELDS.reduce(
                    (acc, k) => ({ ...acc, [k]: updated?.[k] ?? '' }),
                    {} as Profile,
                ),
            );
            // Re-read from the response rather than keeping what was typed: the
            // server normalises (trims, de-duplicates the grains, refuses a
            // negative size), and showing the typed value would hide that.
            setSizeHa(updated?.sizeHa == null ? '' : String(updated.sizeHa));
            setGrainProduced((updated?.grainProduced ?? []).join(', '));
            setSuccess('Профилът на стопанството е записан.');
            setTimeout(() => setSuccess(null), 3000);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Неуспешно записване.');
        } finally {
            setSaving(false);
        }
    };

    const setField = (key: ProfileKey, value: string) =>
        setProfile((p) => ({ ...p, [key]: value }));

    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                        { label: t('breadcrumbFarmProfile') },
                    ]}
                    className="mb-1"
                />
                <Heading level={2} className="flex items-center gap-tight">
                    <OfficeBuilding className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('loading')}
                </Heading>
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <SkeletonInput />
                    <SkeletonInput />
                    <SkeletonInput />
                </div>
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
                        { label: t('breadcrumbFarmProfile') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1} className="flex items-center gap-tight">
                    <OfficeBuilding className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('heading')}
                </Heading>
            </div>

            {error && <InlineNotice variant="error">{error}</InlineNotice>}
            {success && <InlineNotice variant="success">{success}</InlineNotice>}

            <div className={cn(cardVariants(), 'space-y-default')}>
                <div>
                    <Heading level={2}>Идентификация на стопанството</Heading>
                    <p className="text-sm text-content-muted mt-1">
                        Данните се отпечатват в „ДНЕВНИК за проведените растителнозащитни
                        мероприятия и торене“ (Приложение 1 към заповед № РД 11-3194/31.12.2021 г.
                        на БАБХ). Всички полета са незадължителни — празните остават като точки във формата.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                    {TEXT_FIELDS.map((f) => (
                        <FormField
                            key={f.key}
                            label={t(`fields.${f.key}`)}
                            description={
                                f.encrypted
                                    ? t('encryptedNote')
                                    : t.has(`fieldHints.${f.key}`)
                                      ? t(`fieldHints.${f.key}`)
                                      : undefined
                            }
                        >
                            <Input
                                value={profile[f.key]}
                                onChange={(e) => setField(f.key, e.target.value)}
                            />
                        </FormField>
                    ))}

                    {/*
                      * A TEXT input with a decimal keypad — deliberately NOT a
                      * native numeric input.
                      *
                      * Two reasons, and the second is the real one. The repo
                      * caps raw numeric inputs in favour of `NumberStepper`,
                      * whose +/- UX is meaningless for a free-entry decimal —
                      * the same rationale its own exemption list records for
                      * the lease-rent field.
                      *
                      * And a native numeric input REJECTS A COMMA. Bulgarian
                      * writes 412,5 — a farmer typing their own decimal
                      * separator gets a silently empty value, which is a worse
                      * failure than any stepper. Both separators are accepted
                      * and normalised on submit.
                      *
                      * (This note avoids spelling the attribute it is about:
                      * the ratchet regexes raw source, so the explanation would
                      * count as an occurrence. The cast-to-any ratchet and the
                      * CI-skip marker behave the same way — text in source is
                      * not inert, and a comment explaining a rule can break it.
                      * Writing this paragraph tripped BOTH ratchets in turn,
                      * which is the most direct demonstration available.)
                      */}
                    <FormField label={t('fields.sizeHa')} description={t('fieldHints.sizeHa')}>
                        <Input
                            inputMode="decimal"
                            value={sizeHa}
                            onChange={(e) => setSizeHa(e.target.value)}
                        />
                    </FormField>

                    <FormField
                        label={t('fields.grainProduced')}
                        description={t('fieldHints.grainProduced')}
                    >
                        <Input
                            value={grainProduced}
                            onChange={(e) => setGrainProduced(e.target.value)}
                        />
                    </FormField>
                </div>
            </div>

            <div className="flex justify-end">
                <Button
                    variant="primary"
                    onClick={handleSave}
                    disabled={saving}
                    loading={saving}
                    id="farm-profile-save-btn"
                >
                    {saving ? 'Записване…' : 'Запис'}
                </Button>
            </div>
        </div>
    );
}
