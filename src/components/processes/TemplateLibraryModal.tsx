'use client';

/**
 * Template library (Automation Epic 8).
 *
 * A grid of pre-built rule templates, filterable by tag. "Use template"
 * imports the template as a DRAFT rule (POST /automation/templates) and
 * revalidates the rule list. Mirrors Archer's out-of-the-box workflow packs,
 * dropping time-to-value for common GRC automation.
 */
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';

interface Template {
    id: string;
    name: string;
    description: string;
    trigger: string;
    actionType: string;
    tags: string[];
}

const ALL_TAGS = ['control', 'task', 'issue', 'notify', 'webhook'] as const;

export interface TemplateLibraryModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
}

export function TemplateLibraryModal({ open, setOpen }: TemplateLibraryModalProps) {
    const tr = useTranslations('ui');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const { mutate } = useSWRConfig();
    const { data: templates } = useTenantSWR<Template[]>(CACHE_KEYS.automation.templates());
    const [tag, setTag] = useState<string | null>(null);
    const [usingId, setUsingId] = useState<string | null>(null);

    const visible = useMemo(
        () => (templates ?? []).filter((t) => !tag || t.tags.includes(tag)),
        [templates, tag],
    );

    async function useTemplate(id: string) {
        setUsingId(id);
        try {
            const res = await fetch(apiUrl(CACHE_KEYS.automation.templates()), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ templateId: id }),
            });
            if (res.ok) {
                await mutate(apiUrl(CACHE_KEYS.automation.rules.list()));
                setOpen(false);
            }
        } finally {
            setUsingId(null);
        }
    }

    return (
        <Modal showModal={open} setShowModal={setOpen} title={tr('templateLibrary.title')} size="xl">
            <Modal.Header title={tr('templateLibrary.title')} />
            <Modal.Body>
                <div className="mb-default flex flex-wrap gap-tight">
                    <button
                        type="button"
                        onClick={() => setTag(null)}
                        className={`rounded-full px-2.5 py-0.5 text-xs ${tag === null ? 'bg-bg-inverted text-content-inverted' : 'bg-bg-muted text-content-muted'}`}
                    >
                        {tCommon('all')}
                    </button>
                    {ALL_TAGS.map((t) => (
                        <button
                            key={t}
                            type="button"
                            onClick={() => setTag(t)}
                            className={`rounded-full px-2.5 py-0.5 text-xs capitalize ${tag === t ? 'bg-bg-inverted text-content-inverted' : 'bg-bg-muted text-content-muted'}`}
                        >
                            {t}
                        </button>
                    ))}
                </div>
                <div className="grid grid-cols-1 gap-default md:grid-cols-2" data-testid="template-grid">
                    {visible.map((t) => (
                        <div
                            key={t.id}
                            className="surface-popup-texture flex flex-col gap-tight rounded-lg p-3"
                        >
                            <p className="text-sm font-medium text-content-emphasis">{t.name}</p>
                            <p className="text-xs text-content-muted">{t.description}</p>
                            <div className="flex flex-wrap gap-tight">
                                {t.tags.map((tg) => (
                                    <StatusBadge key={tg} variant="neutral">
                                        {tg}
                                    </StatusBadge>
                                ))}
                            </div>
                            <div className="mt-auto pt-tight">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    loading={usingId === t.id}
                                    disabled={usingId !== null}
                                    onClick={() => useTemplate(t.id)}
                                >
                                    {tr('templateLibrary.useTemplate')}
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            </Modal.Body>
            <Modal.Actions align="right">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                    {tCommon('close')}
                </Button>
            </Modal.Actions>
        </Modal>
    );
}
