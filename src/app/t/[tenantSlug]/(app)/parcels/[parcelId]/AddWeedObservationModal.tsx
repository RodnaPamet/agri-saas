'use client';

import { useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
import { localizedWeedOptions } from '@/lib/agriculture/weed-options';

/**
 * Record which weeds were identified.
 *
 * The catalogue and the free-text box submit as ONE list — the server decides
 * which entries are catalogue binomials. That is deliberate: a client that
 * chose the column could put a typo in the half that year-over-year reporting
 * depends on.
 */
export function AddWeedObservationModal({
    open,
    setOpen,
    parcelId,
    options,
    onSaved,
}: {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    parcelId: string;
    options: ReturnType<typeof localizedWeedOptions>;
    onSaved: () => void;
}) {
    const t = useTranslations('ag.parcelHistory');
    const buildUrl = useTenantApiUrl();
    const [picked, setPicked] = useState<string[]>([]);
    const [other, setOther] = useState('');
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const toggle = (value: string) =>
        setPicked((prev) =>
            prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
        );

    const submit = async () => {
        const weeds = [...picked, ...other.split(',').map((s) => s.trim()).filter(Boolean)];
        if (weeds.length === 0) return;
        setSaving(true);
        setErr(null);
        try {
            await apiPost(buildUrl(`/agro/parcels/${parcelId}/weed-observations`), {
                observedAt: new Date().toISOString(),
                weeds,
            });
            setOpen(false);
            setPicked([]);
            setOther('');
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
                <Heading level={3}>{t('weedsAdd')}</Heading>
                <FormField label={t('fieldWeeds')} hint={t('fieldWeedsHint')}>
                    <div className="flex flex-wrap gap-tight">
                        {options.map((o) => (
                            <Button
                                key={o.value}
                                type="button"
                                size="sm"
                                variant={picked.includes(o.value) ? 'primary' : 'secondary'}
                                onClick={() => toggle(o.value)}
                            >
                                {o.label}
                            </Button>
                        ))}
                    </div>
                </FormField>
                <FormField label={t('otherWeed')}>
                    <Input value={other} onChange={(e) => setOther(e.target.value)} />
                </FormField>
                {err ? <p className="text-sm text-content-danger">{err}</p> : null}
                <div className="flex justify-end gap-tight">
                    <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
                        {t('cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        loading={saving}
                        disabled={picked.length === 0 && other.trim() === ''}
                        onClick={submit}
                    >
                        {t('save')}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
