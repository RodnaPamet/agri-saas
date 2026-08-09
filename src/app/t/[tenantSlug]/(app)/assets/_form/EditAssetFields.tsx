'use client';

/**
 * Controlled field markup for the asset-edit form (agricultural assets
 * — machines, buildings, equipment).
 *
 * The detail page renders this inline; the P2 `<EditAssetModal>` renders
 * it inside Modal.Body. State + submit live in `useEditAssetForm`.
 */
import { useTranslations } from 'next-intl';
import { AssetLocationField } from './AssetLocationField';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { parseYMD, toYMD } from '@/components/ui/date-picker/date-utils';
import { ASSET_CRITICALITY_OPTIONS, ASSET_STATUS_OPTIONS } from './asset-options';
import { buildAssetTypeLabels } from '../filter-defs';
import type { EditAssetFormReturn } from './useEditAssetForm';

// Built at RENDER, not module load: the labels resolve through
// next-intl now, so a Bulgarian farmer picks 'Трактор' rather than
// 'Tractor' when registering a machine.
function buildTypeOptions(t: (k: string) => string): ComboboxOption[] {
    return Object.entries(buildAssetTypeLabels(t)).map(([value, label]) => ({ value, label }));
}

export function EditAssetFields({
    form,
    tenantSlug,
}: {
    form: EditAssetFormReturn;
    tenantSlug: string;
}) {
    const t = useTranslations('assets');
    return (
        <>
        <div className="grid grid-cols-2 gap-default">
            <div>
                <label className="input-label">{t('name')} *</label>
                <input
                    className="input"
                    value={form.fields.name}
                    onChange={(e) => form.setField('name', e.target.value)}
                />
            </div>
            <div>
                <label className="input-label">{t('type')}</label>
                <Combobox
                    hideSearch
                    selected={
                        buildTypeOptions(t).find((o) => o.value === form.fields.type) ??
                        null
                    }
                    setSelected={(opt) =>
                        form.setField('type', opt?.value ?? 'TRACTOR')
                    }
                    options={buildTypeOptions(t)}
                    matchTriggerWidth
                    buttonProps={{ className: 'w-full' }}
                    caret
                />
            </div>
            <div>
                <label className="input-label">{t('status')}</label>
                <Combobox
                    hideSearch
                    selected={
                        ASSET_STATUS_OPTIONS.find(
                            (o) => o.value === form.fields.status,
                        ) ?? null
                    }
                    setSelected={(opt) =>
                        form.setField('status', opt?.value ?? 'ACTIVE')
                    }
                    options={ASSET_STATUS_OPTIONS}
                    matchTriggerWidth
                    buttonProps={{ className: 'w-full' }}
                    caret
                />
            </div>
            <div>
                <label className="input-label">{t('criticality')}</label>
                <Combobox
                    hideSearch
                    selected={
                        ASSET_CRITICALITY_OPTIONS.find(
                            (o) => o.value === form.fields.criticality,
                        ) ?? null
                    }
                    setSelected={(opt) =>
                        form.setField('criticality', opt?.value ?? '')
                    }
                    options={ASSET_CRITICALITY_OPTIONS}
                    placeholder={t('selectCriticality')}
                    matchTriggerWidth
                    buttonProps={{ className: 'w-full' }}
                    caret
                />
            </div>
            <div>
                <label className="input-label">{t('manufacturer')}</label>
                <input
                    className="input"
                    value={form.fields.manufacturer}
                    onChange={(e) => form.setField('manufacturer', e.target.value)}
                />
            </div>
            <div>
                <label className="input-label">{t('model')}</label>
                <input
                    className="input"
                    value={form.fields.model}
                    onChange={(e) => form.setField('model', e.target.value)}
                />
            </div>
            <div>
                <label className="input-label">{t('serialNumber')}</label>
                <input
                    className="input"
                    value={form.fields.serialNumber}
                    onChange={(e) => form.setField('serialNumber', e.target.value)}
                />
            </div>
            <div>
                <label className="input-label">{t('year')}</label>
                <input
                    className="input"
                    inputMode="numeric"
                    value={form.fields.year}
                    onChange={(e) => form.setField('year', e.target.value)}
                />
            </div>
            <div>
                <label className="input-label">{t('assignedTo')}</label>
                <UserCombobox
                    tenantSlug={tenantSlug}
                    selectedId={form.fields.ownerUserId || null}
                    onChange={(userId) =>
                        form.setField('ownerUserId', userId ?? '')
                    }
                    forceDropdown
                    matchTriggerWidth
                    id="asset-assignee"
                    placeholder={t('unassigned')}
                />
            </div>
            <div>
                <label className="input-label">{t('keeper')}</label>
                <input
                    className="input"
                    id="asset-keeper"
                    value={form.fields.owner}
                    onChange={(e) => form.setField('owner', e.target.value)}
                    placeholder={t('keeperPlaceholder')}
                />
            </div>
            <AssetLocationField
                locationId={form.fields.locationId}
                onLocationIdChange={(id) => form.setField('locationId', id)}
                note={form.fields.location}
                onNoteChange={(v) => form.setField('location', v)}
            />
            <div>
                <label className="input-label">{t('externalRef')}</label>
                <input
                    className="input"
                    id="asset-external-ref"
                    value={form.fields.externalRef}
                    onChange={(e) => form.setField('externalRef', e.target.value)}
                    placeholder={t('externalRefPlaceholder')}
                />
            </div>
            <div>
                <label className="input-label">{t('purchaseDate')}</label>
                <DatePicker
                    id="asset-edit-purchase-date"
                    placeholder={t('selectDate')}
                    clearable
                    align="start"
                    value={parseYMD(form.fields.purchaseDate)}
                    onChange={(next) =>
                        form.setField('purchaseDate', toYMD(next) ?? '')
                    }
                />
            </div>
            <div>
                <label className="input-label">{t('purchaseCost')}</label>
                <input
                    className="input"
                    inputMode="decimal"
                    value={form.fields.purchaseCost}
                    onChange={(e) => form.setField('purchaseCost', e.target.value)}
                />
            </div>
        </div>
        </>
    );
}
