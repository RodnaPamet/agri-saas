'use client';

/**
 * Controlled field markup for the asset-create form (agricultural
 * assets — machines, buildings, equipment).
 */
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { AssetLocationField } from './AssetLocationField';
import { Input } from '@/components/ui/input';
import { UserCombobox } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { parseYMD, toYMD } from '@/components/ui/date-picker/date-utils';
import { ASSET_CRITICALITY_OPTIONS, ASSET_STATUS_OPTIONS } from './asset-options';
import { ASSET_TYPE_LABELS } from '../filter-defs';
import type { NewAssetFormFields, NewAssetFormReturn } from './useNewAssetForm';

const ASSET_TYPE_OPTIONS: ComboboxOption[] = Object.entries(ASSET_TYPE_LABELS).map(
    ([value, label]) => ({ value, label }),
);

export interface NewAssetFieldsLabels {
    name: string;
    type: string;
    location: string;
}

export function NewAssetFields({
    form,
    labels,
    tenantSlug,
}: {
    form: NewAssetFormReturn;
    labels: NewAssetFieldsLabels;
    tenantSlug: string;
}) {
    const t = useTranslations('assets');
    const numeric = (value: string): number | undefined =>
        value.trim() === '' ? undefined : Number(value);

    return (
        <>
            <FormField label={labels.name} required>
                <Input
                    id="asset-name-input"
                    value={form.fields.name}
                    onChange={(e) => form.setField('name', e.target.value)}
                    placeholder={t('namePlaceholderNew')}
                    required
                />
            </FormField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                <FormField label={labels.type}>
                    <Combobox
                        id="asset-type-select"
                        name="type"
                        options={ASSET_TYPE_OPTIONS}
                        selected={
                            ASSET_TYPE_OPTIONS.find(
                                (o) => o.value === form.fields.type,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField(
                                'type',
                                (o?.value ?? 'TRACTOR') as NewAssetFormFields['type'],
                            )
                        }
                        placeholder={t('selectType')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
                <FormField label={t('criticality')}>
                    <Combobox
                        id="asset-criticality-select"
                        name="criticality"
                        options={ASSET_CRITICALITY_OPTIONS}
                        selected={
                            ASSET_CRITICALITY_OPTIONS.find(
                                (o) => o.value === form.fields.criticality,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField(
                                'criticality',
                                (o?.value as NewAssetFormFields['criticality']) ??
                                    undefined,
                            )
                        }
                        placeholder={t('selectCriticality')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                <FormField label={t('manufacturer')}>
                    <Input
                        id="asset-manufacturer-input"
                        value={form.fields.manufacturer}
                        onChange={(e) =>
                            form.setField('manufacturer', e.target.value)
                        }
                        placeholder={t('manufacturerPlaceholder')}
                    />
                </FormField>
                <FormField label={t('model')}>
                    <Input
                        id="asset-model-input"
                        value={form.fields.model}
                        onChange={(e) => form.setField('model', e.target.value)}
                        placeholder={t('modelPlaceholder')}
                    />
                </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                <FormField label={t('serialNumber')}>
                    <Input
                        id="asset-serial-input"
                        value={form.fields.serialNumber}
                        onChange={(e) =>
                            form.setField('serialNumber', e.target.value)
                        }
                    />
                </FormField>
                <FormField label={t('year')}>
                    <Input
                        id="asset-year-input"
                        inputMode="numeric"
                        value={form.fields.year ?? ''}
                        onChange={(e) =>
                            form.setField('year', numeric(e.target.value))
                        }
                        placeholder={t('yearPlaceholder')}
                    />
                </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                <FormField label={t('assignedTo')}>
                    <UserCombobox
                        id="asset-owner-input"
                        tenantSlug={tenantSlug}
                        selectedId={form.fields.ownerUserId || null}
                        onChange={(userId) =>
                            form.setField('ownerUserId', userId ?? '')
                        }
                        forceDropdown
                        matchTriggerWidth
                        placeholder={t('unassigned')}
                    />
                </FormField>
                <FormField label={t('keeper')}>
                    <Input
                        id="asset-keeper-input"
                        value={form.fields.owner ?? ''}
                        onChange={(e) => form.setField('owner', e.target.value)}
                        placeholder={t('keeperPlaceholder')}
                    />
                </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                <AssetLocationField
                    locationId={form.fields.locationId}
                    onLocationIdChange={(id) => form.setField('locationId', id)}
                    note={form.fields.location}
                    onNoteChange={(v) => form.setField('location', v)}
                />
                <FormField label={t('externalRef')}>
                    <Input
                        id="asset-external-ref-input"
                        value={form.fields.externalRef ?? ''}
                        onChange={(e) =>
                            form.setField('externalRef', e.target.value)
                        }
                        placeholder={t('externalRefPlaceholder')}
                    />
                </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                <FormField label={t('status')}>
                    <Combobox
                        id="asset-status-select"
                        name="status"
                        options={ASSET_STATUS_OPTIONS}
                        selected={
                            ASSET_STATUS_OPTIONS.find(
                                (o) => o.value === form.fields.status,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField(
                                'status',
                                (o?.value ?? 'ACTIVE') as NewAssetFormFields['status'],
                            )
                        }
                        placeholder={t('selectStatus')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
                <FormField label={t('purchaseDate')}>
                    <DatePicker
                        id="asset-purchase-date-input"
                        placeholder={t('selectDate')}
                        clearable
                        align="start"
                        value={parseYMD(form.fields.purchaseDate)}
                        onChange={(next) =>
                            form.setField('purchaseDate', toYMD(next) ?? '')
                        }
                    />
                </FormField>
            </div>

            <FormField label={t('purchaseCost')}>
                <Input
                    id="asset-purchase-cost-input"
                    inputMode="decimal"
                    value={form.fields.purchaseCost ?? ''}
                    onChange={(e) =>
                        form.setField('purchaseCost', numeric(e.target.value))
                    }
                    placeholder={t('costPlaceholder')}
                />
            </FormField>
        </>
    );
}
