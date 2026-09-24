'use client';

import { useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
import { localizedCropOptions } from '@/lib/agriculture/crop-options';

/** Record what the parcel grew in a harvest year. Back-filling is the point. */
export function AddCropSeasonModal({
    open,
    setOpen,
    parcelId,
    options,
    onSaved,
}: {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    parcelId: string;
    options: ReturnType<typeof localizedCropOptions>;
    onSaved: () => void;
}) {
    const t = useTranslations('ag.parcelHistory');
    const buildUrl = useTenantApiUrl();
    const [year, setYear] = useState(String(new Date().getUTCFullYear()));
    const [crop, setCrop] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const submit = async () => {
        if (!crop) return;
        setSaving(true);
        setErr(null);
        try {
            await apiPost(buildUrl(`/agro/parcels/${parcelId}/crop-seasons`), {
                year: Number(year),
                cropType: crop,
            });
            setOpen(false);
            setCrop(null);
            onSaved();
        } catch {
            setErr(t('saveFailed'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal showModal={open} setShowModal={setOpen} size="sm">
            <div className="space-y-default p-4">
                <Heading level={3}>{t('cropsAdd')}</Heading>
                <FormField label={t('fieldYear')} description={t('fieldYearHint')}>
                    <Input
                        type="number"
                        inputMode="numeric"
                        value={year}
                        onChange={(e) => setYear(e.target.value)}
                    />
                </FormField>
                <FormField label={t('fieldCrop')}>
                    <Combobox
                        options={options}
                        selected={options.find((o) => o.value === crop) ?? null}
                        setSelected={(o) => setCrop(o?.value ?? null)}
                    />
                </FormField>
                {err ? <p className="text-sm text-content-danger">{err}</p> : null}
                <div className="flex justify-end gap-tight">
                    <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
                        {t('cancel')}
                    </Button>
                    <Button variant="primary" size="sm" loading={saving} disabled={!crop} onClick={submit}>
                        {t('save')}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
