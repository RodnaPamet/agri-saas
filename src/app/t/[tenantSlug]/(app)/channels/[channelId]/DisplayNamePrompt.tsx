'use client';

/**
 * Ask once for a display name, in the composer — #2989.
 *
 * ## Why a prompt is part of the feature rather than a nicety
 *
 * The author line reads `displayName` from a PUBLISHED `PersonProfile`, and
 * production held **zero** of those rows when this was built, because nothing
 * in the product ever wrote one. Without an entry point every post in every
 * channel shows the farm alone for ever, and no guard would notice:
 * `pages-are-reachable` governs whether a SCREEN is linked, and this is not a
 * screen. P6 shipped `/admin/public-profile` linked from nowhere and measured
 * zero `FarmBrand` rows — the same shape, which #2989 names as #2844 a third
 * time.
 *
 * ## It asks where the decision is made
 *
 * Beside the composer, not on a settings page: the moment a person is about
 * to post is the moment "how should this be signed" is a live question. A
 * settings page would be a second screen nobody visits.
 *
 * ## It is OPTIONAL, by owner ruling
 *
 * Relayed 2026-11-12: «Не сега» posts with the farm alone, and a name is
 * never required before a first post. So this prompt can always be
 * dismissed, and the farm-alone author line stays a designed state rather
 * than a degraded one — which is also why it is a panel above the composer
 * and not a modal in front of it.
 *
 * ## «Не сега» is remembered, and only in this browser
 *
 * A prompt that reappears on every visit is a prompt people learn to dismiss
 * without reading. The skip is per browser via `useLocalStorage`, keyed by
 * USER — a shared device must not hide the prompt from the next person — and
 * deliberately NOT persisted server-side: it is a UI convenience, not a
 * decision worth a column, and a lost skip costs one dismissal.
 *
 * Saving a name clears the skip, because the prompt then has nothing to ask.
 */
import * as React from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { useLocalStorage } from '@/components/ui/hooks';
import { apiGet, apiPut } from '@/lib/api-client';

interface ProfileWire {
    displayName: string | null;
    published: boolean;
}

export function DisplayNamePrompt({
    userId,
    onSaved,
}: {
    /** Namespaces the skip, so a shared device does not hide it. */
    userId: string;
    onSaved?: () => void;
}): React.ReactElement | null {
    const t = useTranslations('channels');
    const [skipped, setSkipped] = useLocalStorage(
        `agri.channels.displayNameSkipped.${userId}`,
        false,
    );
    const [needed, setNeeded] = React.useState<boolean | null>(null);
    const [value, setValue] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let live = true;
        // Asked even when the prompt is skipped, because the answer decides
        // whether the skip still means anything: a person who set a name on
        // the phone should not be asked again here.
        void apiGet<ProfileWire>('/api/social/profile')
            .then((p) => {
                if (live) setNeeded(p.displayName === null);
            })
            .catch(() => {
                // A failed read must not produce a prompt. Asking somebody to
                // re-enter a name they may already have is worse than not
                // asking, and the feature degrades to the farm-alone line
                // that is already a designed state.
                if (live) setNeeded(false);
            });
        return () => {
            live = false;
        };
    }, []);

    const save = React.useCallback(async () => {
        const name = value.trim();
        if (!name) return;
        setSaving(true);
        setError(null);
        try {
            await apiPut<ProfileWire>('/api/social/profile', { displayName: name });
            setNeeded(false);
            setSkipped(false);
            onSaved?.();
        } catch {
            setError(t('displayNameError'));
        } finally {
            setSaving(false);
        }
    }, [value, setSkipped, onSaved, t]);

    if (needed !== true || skipped) return null;

    return (
        <div className="space-y-default rounded-md border border-border-default bg-bg-subtle p-default">
            <div className="space-y-tight">
                <p className="text-sm font-[560] text-content-default">{t('displayNameTitle')}</p>
                <p className="text-xs text-content-muted">{t('displayNameHint')}</p>
            </div>
            {/*
              * No `id` on either element: `FormField` generates one and
              * INJECTS it into its single child, which is what wires the
              * label to the control. Passing my own was rejected — `id` is on
              * `InjectedControlProps`, not on `FormFieldProps`.
              *
              * `error ?? undefined` because this state is `string | null` and
              * the prop is `string | undefined`. Both of these were caught by
              * ts-jest and NOT by a warm `tsc -p tsconfig.json`, which honours
              * `incremental: true` and read a stale tsbuildinfo — the #1829
              * trap, on a NEW file, which is the case that note says wants the
              * cold run.
              */}
            <FormField label={t('displayNameLabel')} error={error ?? undefined}>
                <Input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={t('displayNamePlaceholder')}
                    maxLength={60}
                />
            </FormField>
            <div className="flex gap-tight">
                <Button variant="primary" onClick={save} disabled={saving || !value.trim()}>
                    {t('displayNameSave')}
                </Button>
                <Button variant="ghost" onClick={() => setSkipped(true)} disabled={saving}>
                    {t('displayNameSkip')}
                </Button>
            </div>
        </div>
    );
}
