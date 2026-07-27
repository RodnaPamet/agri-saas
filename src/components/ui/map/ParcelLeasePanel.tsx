'use client';

/**
 * ParcelLeasePanel — the land-use (аренда/наем) register for one parcel
 * (roadmap 2/3). Lists the parcel's leases, and adds / edits / removes them.
 * "Owned vs leased" is derived from whether an active lease exists. The lessor
 * pre-fills from the parcel's КАИС legal-entity owner when known.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost, apiPatch, apiDelete } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Plus, PenWriting, Trash } from '@/components/ui/icons/nucleo';
import {
    LeaseFormFields,
    EMPTY_LEASE_FORM,
    leaseToForm,
    leaseFormToBody,
    validateLeaseForm,
    type LeaseFormState,
} from '@/components/agro/LeaseFormFields';
type FormState = LeaseFormState;
const EMPTY_FORM = EMPTY_LEASE_FORM;

export interface LeaseDTO {
    id: string;
    lessorName: string;
    lessorEik: string | null;
    kind: 'ARENDA' | 'NAEM';
    rentAmount: string | number | null;
    rentUnit: string | null;
    startDate: string | null;
    endDate: string | null;
    documentRef: string | null;
    notes: string | null;
}

export function ParcelLeasePanel({
    locationId,
    parcelId,
    prefillLessor,
    prefillEik,
}: {
    locationId: string;
    parcelId: string;
    prefillLessor?: string | null;
    prefillEik?: string | null;
}) {
    const t = useTranslations('ag.lease');
    const tc = useTranslations('common');
    const buildUrl = useTenantApiUrl();
    const leasesQ = useTenantSWR<{ leases: LeaseDTO[] }>(
        `/locations/${locationId}/parcels/${parcelId}/leases`,
    );
    const leases = leasesQ.data?.leases ?? [];

    const [editing, setEditing] = useState<null | 'new' | string>(null);
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

    const startAdd = () => {
        setForm({ ...EMPTY_FORM, lessorName: prefillLessor ?? '', lessorEik: prefillEik ?? '' });
        setErr(null);
        setEditing('new');
    };
    const startEdit = (l: LeaseDTO) => {
        setForm(leaseToForm(l));
        setErr(null);
        setEditing(l.id);
    };

    const save = async () => {
        const invalid = validateLeaseForm(form);
        if (invalid) {
            setErr(t(invalid));
            return;
        }
        const payload = leaseFormToBody(form);
        setSaving(true);
        setErr(null);
        try {
            const base = buildUrl(`/locations/${locationId}/parcels/${parcelId}/leases`);
            if (editing === 'new') await apiPost(base, payload);
            else await apiPatch(`${base}/${editing}`, payload);
            setEditing(null);
            await leasesQ.mutate();
        } catch (e) {
            setErr(e instanceof Error ? e.message : t('saveFailed'));
        } finally {
            setSaving(false);
        }
    };

    const remove = async (id: string) => {
        try {
            await apiDelete(buildUrl(`/locations/${locationId}/parcels/${parcelId}/leases/${id}`));
            await leasesQ.mutate();
        } catch {
            /* non-blocking */
        }
    };

    const kindLabel = (k: 'ARENDA' | 'NAEM') => (k === 'ARENDA' ? t('kindArenda') : t('kindNaem'));
    const rentLabel = (l: LeaseDTO) =>
        l.rentAmount != null ? `${l.rentAmount}${l.rentUnit ? ` ${l.rentUnit}` : ''}` : null;
    const termLabel = (l: LeaseDTO) => {
        const s = l.startDate?.slice(0, 10);
        const e = l.endDate?.slice(0, 10);
        if (s && e) return `${s} – ${e}`;
        if (e) return `→ ${e}`;
        if (s) return `${s} →`;
        return null;
    };

    return (
        <div className="space-y-default">
            <div className="flex items-center justify-between gap-default">
                <StatusBadge variant={leases.length > 0 ? 'warning' : 'neutral'}>
                    {leases.length > 0 ? t('leased') : t('owned')}
                </StatusBadge>
                {editing === null ? (
                    <Button variant="secondary" size="sm" icon={<Plus />} onClick={startAdd}>
                        {t('lease')}
                    </Button>
                ) : null}
            </div>

            {leases.map((l) => (
                <div key={l.id} className="rounded-lg border border-border-subtle p-3 text-sm">
                    <div className="flex items-start justify-between gap-tight">
                        <div className="min-w-0">
                            <p className="font-medium text-content-emphasis">{l.lessorName}</p>
                            <p className="text-xs text-content-subtle">
                                {kindLabel(l.kind)}
                                {rentLabel(l) ? ` · ${rentLabel(l)}` : ''}
                                {termLabel(l) ? ` · ${termLabel(l)}` : ''}
                            </p>
                            {l.documentRef ? (
                                <p className="text-xs text-content-subtle">
                                    {t('documentRef')}: {l.documentRef}
                                </p>
                            ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-tight">
                            <button
                                type="button"
                                onClick={() => startEdit(l)}
                                aria-label={tc('edit')}
                                className="text-content-subtle hover:text-content-default"
                            >
                                <PenWriting className="size-4" aria-hidden="true" />
                            </button>
                            <button
                                type="button"
                                onClick={() => remove(l.id)}
                                aria-label={tc('delete')}
                                className="text-content-subtle hover:text-content-error"
                            >
                                <Trash className="size-4" aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                </div>
            ))}

            {editing !== null ? (
                <div className="space-y-default rounded-lg border border-border-default p-3">
                    <LeaseFormFields form={form} setField={set} />
                    {err ? <p className="text-xs text-content-error">{err}</p> : null}
                    <div className="flex items-center gap-tight">
                        <Button variant="secondary" size="sm" onClick={save} disabled={saving}>
                            {tc('save')}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                setEditing(null);
                                setErr(null);
                            }}
                        >
                            {tc('cancel')}
                        </Button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

export default ParcelLeasePanel;
