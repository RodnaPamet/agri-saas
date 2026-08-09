/**
 * Elevation PR-2 — first decomposition extraction.
 *
 * The control detail page (`page.tsx`) was 1506 lines. This file
 * extracts the Edit Control modal into a presentational sub-
 * component. The page still owns the mutation + state; the modal
 * is a thin renderer.
 *
 * Pattern for future extractions:
 *   - State + mutation stay in the page (coupled to pageDataKey).
 *   - Sub-component takes everything via props.
 *   - File lives under `_modals/` (or `_tabs/`) so Next.js doesn't
 *     treat it as a route.
 *
 * Future PRs should extract: OverviewTab, TasksTab, EvidenceTab,
 * MappingsTab, ActivityTab using the same pattern.
 */
'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Modal } from '@/components/ui/modal';
import { RequiredMarker } from '@/components/ui/required-marker';
import { UserCombobox } from '@/components/ui/user-combobox';

export interface EditControlForm {
    name: string;
    description: string;
    intent: string;
    category: string;
    frequency: string;
    owner: string;
    mitigationType: string;
}

const MITIGATION_TYPE_OPTIONS: ComboboxOption[] = [
    { value: 'PREVENTIVE', label: 'Preventive' },
    { value: 'DETECTIVE', label: 'Detective' },
    { value: 'DETERRENT', label: 'Deterrent' },
    { value: 'CORRECTIVE', label: 'Corrective' },
    { value: 'COMPENSATING', label: 'Compensating' },
];

export interface EditControlModalProps {
    open: boolean;
    setOpen: (next: boolean) => void;
    form: EditControlForm;
    setForm: React.Dispatch<React.SetStateAction<EditControlForm>>;
    saving: boolean;
    error: string;
    /** Tenant slug for the owner UserCombobox roster lookup. */
    tenantSlug: string;
    categoryOptions: ComboboxOption[];
    frequencyOptions: ComboboxOption[];
    onCancel: () => void;
    onSubmit: (e: React.FormEvent) => void | Promise<void>;
}

export function EditControlModal({
    open,
    setOpen,
    form,
    setForm,
    saving,
    error,
    tenantSlug,
    categoryOptions,
    frequencyOptions,
    onCancel,
    onSubmit,
}: EditControlModalProps) {
    const t = useTranslations('controls');
    return (
        <Modal
            showModal={open}
            setShowModal={(v) => {
                const next = typeof v === 'function' ? v(open) : v;
                if (!next && !saving) onCancel();
                else setOpen(next);
            }}
            size="lg"
            title={t('editModal.title')}
            description={t('editModal.description')}
            preventDefaultClose={saving}
        >
            <Modal.Header
                title={t('editModal.title')}
                description={t('editModal.description')}
            />
            <Modal.Form
                onSubmit={onSubmit}
                id="control-edit-dialog"
                data-testid="control-edit-dialog"
            >
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            role="alert"
                            data-testid="edit-error"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset className="space-y-default" disabled={saving}>
                        <div>
                            <label
                                htmlFor="edit-name"
                                className="mb-1 block text-sm text-content-default"
                            >
                                {t('editModal.titleField')} <RequiredMarker />
                            </label>
                            <input
                                id="edit-name"
                                type="text"
                                className="input w-full"
                                value={form.name}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        name: e.target.value,
                                    }))
                                }
                                required
                                minLength={3}
                                data-testid="edit-name-input"
                            />
                        </div>
                        <div>
                            <label
                                htmlFor="edit-description"
                                className="mb-1 block text-sm text-content-default"
                            >
                                {t('editModal.descriptionField')}
                            </label>
                            <textarea
                                id="edit-description"
                                className="input w-full"
                                rows={3}
                                value={form.description}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        description: e.target.value,
                                    }))
                                }
                                data-testid="edit-description-input"
                            />
                        </div>
                        <div>
                            <label
                                htmlFor="edit-intent"
                                className="mb-1 block text-sm text-content-default"
                            >
                                {t('editModal.intent')}
                            </label>
                            <textarea
                                id="edit-intent"
                                className="input w-full"
                                rows={2}
                                value={form.intent}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        intent: e.target.value,
                                    }))
                                }
                                data-testid="edit-intent-input"
                            />
                        </div>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <div>
                                <label
                                    htmlFor="edit-category"
                                    className="mb-1 block text-sm text-content-default"
                                >
                                    {t('editModal.category')}
                                </label>
                                <Combobox
                                    hideSearch
                                    id="edit-category"
                                    selected={
                                        categoryOptions.find(
                                            (o) => o.value === form.category,
                                        ) ?? null
                                    }
                                    setSelected={(opt) =>
                                        setForm((f) => ({
                                            ...f,
                                            category: opt?.value ?? '',
                                        }))
                                    }
                                    options={categoryOptions}
                                    placeholder={t('editModal.none')}
                                    matchTriggerWidth
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="edit-frequency"
                                    className="mb-1 block text-sm text-content-default"
                                >
                                    {t('editModal.frequency')}
                                </label>
                                <Combobox
                                    hideSearch
                                    id="edit-frequency"
                                    selected={
                                        frequencyOptions.find(
                                            (o) => o.value === form.frequency,
                                        ) ?? null
                                    }
                                    setSelected={(opt) =>
                                        setForm((f) => ({
                                            ...f,
                                            frequency: opt?.value ?? '',
                                        }))
                                    }
                                    options={frequencyOptions}
                                    placeholder={t('editModal.none')}
                                    matchTriggerWidth
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <div>
                                <label
                                    htmlFor="edit-mitigation-type"
                                    className="mb-1 block text-sm text-content-default"
                                >
                                    {t('editModal.mitigationType')}
                                </label>
                                <Combobox
                                    hideSearch
                                    id="edit-mitigation-type"
                                    selected={
                                        MITIGATION_TYPE_OPTIONS.find(
                                            (o) => o.value === form.mitigationType,
                                        ) ?? null
                                    }
                                    setSelected={(opt) =>
                                        setForm((f) => ({
                                            ...f,
                                            mitigationType: opt?.value ?? '',
                                        }))
                                    }
                                    options={MITIGATION_TYPE_OPTIONS}
                                    placeholder={t('editModal.none')}
                                    matchTriggerWidth
                                />
                            </div>
                        </div>
                        <div>
                            <label
                                htmlFor="edit-owner"
                                className="mb-1 block text-sm text-content-default"
                            >
                                {t('editModal.owner')}
                            </label>
                            <UserCombobox
                                id="edit-owner"
                                name="ownerUserId"
                                tenantSlug={tenantSlug}
                                selectedId={form.owner || null}
                                onChange={(userId) =>
                                    setForm((f) => ({
                                        ...f,
                                        owner: userId ?? '',
                                    }))
                                }
                                placeholder={t('editModal.unassigned')}
                            />
                        </div>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={onCancel}
                        disabled={saving}
                        data-testid="edit-cancel-button"
                    >
                        {t('editModal.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={saving || form.name.trim().length < 3}
                        data-testid="edit-save-button"
                    >
                        {saving ? t('editModal.savingDots') : t('editModal.save')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
