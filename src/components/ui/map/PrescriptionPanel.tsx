'use client';

/**
 * PrescriptionPanel — turns a parcel selection into a spray job. Pick a
 * product + dose (RATE unit) + operator, then POST the field-operation:
 * one FIELD_OPERATION Task assigned to the operator with one
 * OperationParcel line per selected parcel.
 */
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';

interface ItemDTO {
    id: string;
    name: string;
    category: string;
    defaultUnit?: { id: string; symbol: string } | null;
}
interface UnitDTO {
    id: string;
    key: string;
    name: string;
    symbol: string;
    measure: string;
}

export interface PrescriptionPanelProps {
    locationId: string;
    tenantSlug: string;
    selectedParcelIds: string[];
    onCreated?: (r: { taskId: string; taskKey?: string | null; parcelCount: number }) => void;
}

export function PrescriptionPanel({ locationId, tenantSlug, selectedParcelIds, onCreated }: PrescriptionPanelProps) {
    const t = useTranslations('ag.map.prescription');
    // Reusing `inventory`'s ПРЗ labels rather than a second spelling of them.
    const tInv = useTranslations('inventory');
    const buildUrl = useTenantApiUrl();
    const { data: items } = useTenantSWR<ItemDTO[]>('/items');
    // Units are a slow-changing catalog — relax SWR revalidation.
    const { data: units } = useTenantSWR<UnitDTO[]>('/units?measure=RATE', {
        revalidateOnFocus: false,
        dedupingInterval: 60_000,
    });

    // Free text, not a chosen id — owner decision, 2026-10-09: the product and
    // fertiliser dropdowns are gone. This picker was also the one with NO
    // category filter at all, so it offered fertilisers on the product path;
    // removing it resolves that too.
    const [productName, setProductName] = useState('');
    const [pppRegNo, setPppRegNo] = useState('');
    const [quarantineDays, setQuarantineDays] = useState('');
    const [doseValue, setDoseValue] = useState('');
    const [doseUnitId, setDoseUnitId] = useState('');
    const [assigneeUserId, setAssigneeUserId] = useState<string | null>(null);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canSubmit = Boolean(
        selectedParcelIds.length > 0 &&
        productName.trim() &&
        doseValue &&
        doseUnitId &&
        assigneeUserId &&
        // Blocked here rather than refused after submit: this panel creates a
        // job over several parcels at once, so a server refusal costs the whole
        // batch.
        (!typedNameIsNew || registrationComplete) &&
        !busy,
    );

    const submit = async () => {
        if (!assigneeUserId) return;
        setBusy(true);
        setError(null);
        try {
            const result = await apiPost<{ taskId: string; taskKey?: string | null; parcelCount: number }>(
                buildUrl(`/locations/${locationId}/operations`),
                {
                    operationType: 'SPRAY',
                    assigneeUserId,
                    parcelIds: selectedParcelIds,
                    productName: productName.trim(),
                    ...(typedNameIsNew
                        ? {
                              newProductRegistration: {
                                  pppRegistrationNo: pppRegNo.trim(),
                                  quarantinePeriodDays: Number(quarantineDays),
                              },
                          }
                        : {}),
                    doseValue: Number(doseValue),
                    doseUnitId,
                    targetNote: note || null,
                },
            );
            onCreated?.(result);
            setProductName('');
            setPppRegNo('');
            setQuarantineDays('');
            setDoseValue('');
            setDoseUnitId('');
            setAssigneeUserId(null);
            setNote('');
        } catch (err) {
            setError(err instanceof Error ? err.message : t('createFailed'));
        } finally {
            setBusy(false);
        }
    };

    /**
     * Case-insensitive, to agree with the server's unique index on
     * `(tenantId, lower(name))`. A case-sensitive check would hide the ПРЗ
     * fields for a name the server then matches — harmless — but the reverse,
     * hiding them when the server WILL create, is a refusal in the field.
     */
    const typedNameIsNew = useMemo(() => {
        const needle = productName.trim().toLowerCase();
        if (!needle) return false;
        return !(items ?? []).some((it) => it.name.trim().toLowerCase() === needle);
    }, [items, productName]);
    const registrationComplete = !!pppRegNo.trim() && quarantineDays.trim() !== '';
    const unitOptions: ComboboxOption[] = (units ?? []).map((u) => ({ value: u.id, label: u.symbol }));

    return (
        <div className="space-y-default">
            <p className="text-sm text-content-muted">
                {t('parcelsSelected', { count: selectedParcelIds.length })}
            </p>
            {error && (
                <div role="alert" className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                    {error}
                </div>
            )}
            <FormField label={t('product')} required>
                <Input
                    id="prescription-product-name"
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    placeholder={t('typeProduct')}
                    aria-label={t('product')}
                />
            </FormField>
            {/* A product this farm does not have yet is created as a PESTICIDE,
                which cannot be saved without both of these. */}
            {typedNameIsNew && (
                <div className="grid grid-cols-2 gap-default">
                    <FormField label={tInv('pppRegNo')} required>
                        <Input
                            id="prescription-ppp-reg"
                            value={pppRegNo}
                            onChange={(e) => setPppRegNo(e.target.value)}
                            aria-label={tInv('pppRegNo')}
                        />
                    </FormField>
                    <FormField label={tInv('quarantineDays')} required>
                        <Input
                            id="prescription-quarantine"
                            inputMode="numeric"
                            value={quarantineDays}
                            onChange={(e) => setQuarantineDays(e.target.value)}
                            aria-label={tInv('quarantineDays')}
                        />
                    </FormField>
                </div>
            )}
            <div className="grid grid-cols-2 gap-default">
                <FormField label={t('dose')} required>
                    <Input type="number" min="0" step="0.0001" value={doseValue} onChange={(e) => setDoseValue(e.target.value)} placeholder={t('dosePlaceholder')} />
                </FormField>
                <FormField label={t('unit')} required>
                    <Combobox
                        id="prescription-unit-select"
                        options={unitOptions}
                        selected={unitOptions.find((o) => o.value === doseUnitId) ?? null}
                        setSelected={(opt) => setDoseUnitId(opt?.value ?? '')}
                        placeholder={t('unitPlaceholder')}
                        matchTriggerWidth
                        forceDropdown
                    />
                </FormField>
            </div>
            <FormField label={t('operator')} required>
                <UserCombobox
                    tenantSlug={tenantSlug}
                    selectedId={assigneeUserId}
                    onChange={(id) => setAssigneeUserId(id)}
                    placeholder={t('assignOperator')}
                    forceDropdown
                />
            </FormField>
            <FormField label={t('note')}>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('notePlaceholder')} />
            </FormField>
            <Button variant="primary" size="sm" onClick={submit} disabled={!canSubmit} loading={busy}>
                {busy ? t('creating') : t('createJob')}
            </Button>
        </div>
    );
}

export default PrescriptionPanel;
