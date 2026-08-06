'use client';

/**
 * NewSchemeModal — create a certification scheme (a global AG_SCHEME
 * framework) plus its requirements.
 *
 * Carries the scheme identity (name + stable key) and a small
 * repeatable requirements editor (code + title). Mirrors the
 * Modal.Form shell + unsaved-changes guard used by JournalEntryModal.
 */

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Plus, Trash } from '@/components/ui/icons/nucleo';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';

interface RequirementRow {
    code: string;
    title: string;
    description: string;
}

interface CreatedScheme {
    framework: { id: string; key: string; name: string };
}

export interface NewSchemeModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    onSaved?: (scheme: CreatedScheme) => void;
}

function emptyRequirement(): RequirementRow {
    return { code: '', title: '', description: '' };
}

export function NewSchemeModal({ open, setOpen, onSaved }: NewSchemeModalProps) {
    const t = useTranslations('schemes');
    const buildUrl = useTenantApiUrl();

    const [name, setName] = useState('');
    const [key, setKey] = useState('');
    const [description, setDescription] = useState('');
    const [requirements, setRequirements] = useState<RequirementRow[]>([emptyRequirement()]);
    const [dirty, setDirty] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Re-seed the form whenever the modal (re)opens.
    /* eslint-disable react-hooks/set-state-in-effect -- intentional form re-seed on open. */
    useEffect(() => {
        if (!open) return;
        setName('');
        setKey('');
        setDescription('');
        setRequirements([emptyRequirement()]);
        setDirty(false);
        setError(null);
    }, [open]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const markDirty = () => setDirty(true);

    const addRequirement = () => {
        setRequirements((rs) => [...rs, emptyRequirement()]);
        markDirty();
    };
    const updateRequirement = (i: number, patch: Partial<RequirementRow>) => {
        setRequirements((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
        markDirty();
    };
    const removeRequirement = (i: number) => {
        setRequirements((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));
        markDirty();
    };

    const validRequirements = requirements.filter((r) => r.code.trim() && r.title.trim());
    const canSubmit =
        name.trim().length > 0 &&
        key.trim().length > 0 &&
        validRequirements.length > 0 &&
        !submitting;

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const body = {
                key: key.trim(),
                name: name.trim(),
                description: description.trim() || undefined,
                requirements: validRequirements.map((r) => ({
                    code: r.code.trim(),
                    title: r.title.trim(),
                    description: r.description.trim() || undefined,
                })),
            };
            const saved = await apiPost<CreatedScheme>(buildUrl('/schemes'), body);
            setDirty(false);
            setOpen(false);
            onSaved?.(saved);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create scheme');
        } finally {
            setSubmitting(false);
        }
    };

    // Unsaved-changes guard — same shape as JournalEntryModal.
    const guardedSetOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
        (next) => {
            const wantClose = typeof next === 'function' ? !next(true) : next === false;
            if (wantClose) {
                if (submitting) return;
                if (dirty && !window.confirm(t('discardConfirm'))) {
                    return;
                }
            }
            setOpen(next);
        },
        [submitting, dirty, setOpen, t],
    );
    const close = () => guardedSetOpen(false);

    const heading = t('modalHeading');
    const subheading = t('modalSubheading');

    return (
        <Modal
            showModal={open}
            setShowModal={guardedSetOpen}
            size="lg"
            title={heading}
            description={subheading}
            preventDefaultClose={submitting}
        >
            <Modal.Header title={heading} description={subheading} />
            <Modal.Form
                id="new-scheme-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-scheme-error"
                            role="alert"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset disabled={submitting} className="m-0 p-0 border-0 space-y-default">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                            <FormField label={t('fieldName')} required>
                                <Input
                                    value={name}
                                    onChange={(e) => {
                                        setName(e.target.value);
                                        markDirty();
                                    }}
                                    placeholder={t('namePlaceholder')}
                                    id="new-scheme-name"
                                />
                            </FormField>
                            <FormField label={t('fieldKey')} required hint={t('keyHint')}>
                                <Input
                                    value={key}
                                    onChange={(e) => {
                                        setKey(e.target.value.replace(/[^A-Za-z0-9._-]/g, ''));
                                        markDirty();
                                    }}
                                    placeholder={t('keyPlaceholder')}
                                    id="new-scheme-key"
                                />
                            </FormField>
                        </div>

                        <FormField label={t('fieldDescription')}>
                            <Input
                                value={description}
                                onChange={(e) => {
                                    setDescription(e.target.value);
                                    markDirty();
                                }}
                                placeholder={t('descriptionPlaceholder')}
                                id="new-scheme-description"
                            />
                        </FormField>

                        <div className="space-y-default">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-content-emphasis">{t('requirementsLabel')}</span>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    icon={<Plus className="size-3.5" />}
                                    onClick={addRequirement}
                                    id="new-scheme-add-requirement"
                                >
                                    {t('addRequirement')}
                                </Button>
                            </div>
                            <div className="space-y-tight">
                                {requirements.map((r, i) => (
                                    <div
                                        key={i}
                                        // Stacks on a phone. The fixed
                                        // `grid-cols-12` never collapsed, so
                                        // three inputs shared a phone's width
                                        // and each got roughly a third of it —
                                        // unusable on the device this product
                                        // is built for.
                                        className="grid grid-cols-1 sm:grid-cols-12 gap-tight sm:items-end"
                                        data-testid={`scheme-requirement-row-${i}`}
                                    >
                                        <div className="sm:col-span-3">
                                            <Input
                                                value={r.code}
                                                onChange={(e) => updateRequirement(i, { code: e.target.value })}
                                                placeholder={t('codePlaceholder')}
                                                aria-label={t('reqCodeAria', { n: i + 1 })}
                                            />
                                        </div>
                                        <div className="sm:col-span-8">
                                            <Input
                                                value={r.title}
                                                onChange={(e) => updateRequirement(i, { title: e.target.value })}
                                                placeholder={t('titlePlaceholder')}
                                                aria-label={t('reqTitleAria', { n: i + 1 })}
                                            />
                                        </div>
                                        <div className="sm:col-span-1 flex justify-end">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => removeRequirement(i)}
                                                disabled={requirements.length <= 1}
                                                aria-label={t('removeReqAria', { n: i + 1 })}
                                            >
                                                <Trash className="size-4" />
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={close}
                        disabled={submitting}
                        id="new-scheme-cancel"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!canSubmit}
                        loading={submitting}
                        id="new-scheme-submit"
                    >
                        {t('createScheme')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
