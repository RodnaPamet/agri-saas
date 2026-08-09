'use client';

/**
 * T00 — UI language selector.
 *
 * Sits as a sibling pill next to the Theme practice in the admin page
 * header. Compact segmented practice (matching the Theme pill's visual
 * weight) that PUTs the chosen locale to `/api/account/language` — an
 * account-scoped (NOT tenant-scoped) endpoint that persists
 * `User.uiLanguage` and sets the `NEXT_LOCALE` cookie — then calls
 * `router.refresh()` so the server re-renders in the new locale.
 *
 * All visible chrome routes through `useTranslations`; the option
 * labels are locale endonyms from `LOCALE_LABELS`.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Globe } from '@/components/ui/icons/nucleo';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { LOCALES, LOCALE_LABELS, isLocale } from '@/lib/i18n/locales';

export function LanguageSetting() {
    const t = useTranslations('common');
    const router = useRouter();
    const activeLocale = useLocale();

    // Optimistic local selection for immediate feedback; reconciles with
    // the server-resolved locale once `router.refresh()` completes.
    const [selected, setSelected] = useState<string>(activeLocale);
    const [isPending, startTransition] = useTransition();

    const options = LOCALES.map((code) => ({
        value: code,
        label: LOCALE_LABELS[code],
        id: `admin-language-option-${code}`,
    }));

    const onSelect = (value: string) => {
        if (!isLocale(value) || value === selected || isPending) return;
        const previous = selected;
        setSelected(value);
        startTransition(async () => {
            try {
                const res = await fetch('/api/account/language', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ language: value }),
                });
                if (!res.ok) {
                    setSelected(previous);
                    return;
                }
                // Re-render server components (layout re-resolves the
                // locale from the freshly-set cookie).
                router.refresh();
            } catch {
                setSelected(previous);
            }
        });
    };

    return (
        <div
            className="flex items-center gap-compact rounded-lg border border-border-subtle bg-bg-default px-3 py-1.5"
            id="admin-language-section"
        >
            <Globe className="w-4 h-4 text-content-muted" aria-hidden="true" />
            <span className="text-sm text-content-muted">{t('language')}</span>
            <ToggleGroup
                size="sm"
                options={options}
                selected={selected}
                selectAction={onSelect}
                ariaLabel={t('language')}
            />
        </div>
    );
}
