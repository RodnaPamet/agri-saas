'use client';

/**
 * LeaseFormFields — the ONE definition of a lease's editable fields.
 *
 * Both lease surfaces render this: the Rent-page modal and the parcel-detail
 * `<ParcelLeasePanel>`. They had drifted (different placeholders, different
 * validation, different date rendering, and neither exposed ЕИК or notes even
 * though both round-tripped them through the API), so the field set,
 * defaults, date helpers and validation now live here.
 *
 * Page-specific chrome stays with the page: the parcel picker + its validation
 * (Rent modal only), КАИС prefill (panel only), the undo-delete toast, and the
 * payments log. This component owns fields, nothing else.
 */
import { useTranslations } from 'next-intl';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { DatePicker, type DateValue } from '@/components/ui/date-picker';

export interface LeaseFormState {
    lessorName: string;
    lessorEik: string;
    kind: 'ARENDA' | 'NAEM';
    rentAmount: string;
    rentUnit: string;
    startDate: DateValue | null;
    endDate: DateValue | null;
    documentRef: string;
    notes: string;
}

/**
 * Shared defaults — rent is quoted per decare in EURO.
 *
 * Owner ruling 2026-10-31: new leases are entered in `€/дка` only. The field
 * stays free text, so a lease already recorded in `лв/дка` still edits and
 * saves as it was typed, and `canonicalRentUnit` recognises both — what
 * changes is which one a NEW lease starts in. Existing lev leases are read as
 * euro at the fixed peg by `resolveRentBasis`, so nothing has to be migrated
 * for the figures to add up.
 */
export const EMPTY_LEASE_FORM: LeaseFormState = {
    lessorName: '',
    lessorEik: '',
    kind: 'ARENDA',
    rentAmount: '',
    rentUnit: '€/дка',
    startDate: null,
    endDate: null,
    documentRef: '',
    notes: '',
};

/** `Date | null` → `YYYY-MM-DD | null`, UTC-midnight safe. */
export function toYMD(d: DateValue | null): string | null {
    if (!d) return null;
    const dt = d instanceof Date ? d : new Date(d as unknown as string);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD | null` → `Date | null`. */
export function parseDate(s: string | null): Date | null {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Hydrate the shared form state from a persisted lease row. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function leaseToForm(l: any): LeaseFormState {
    return {
        lessorName: l.lessorName ?? '',
        lessorEik: l.lessorEik ?? '',
        kind: l.kind ?? 'ARENDA',
        rentAmount: l.rentAmount != null ? String(l.rentAmount) : '',
        rentUnit: l.rentUnit ?? '',
        startDate: parseDate(l.startDate),
        endDate: parseDate(l.endDate),
        documentRef: l.documentRef ?? '',
        notes: l.notes ?? '',
    };
}

/** The API body both surfaces POST/PATCH. */
export function leaseFormToBody(form: LeaseFormState) {
    return {
        lessorName: form.lessorName.trim(),
        lessorEik: form.lessorEik.trim() || null,
        kind: form.kind,
        rentAmount: form.rentAmount.trim() ? Number(form.rentAmount) : null,
        rentUnit: form.rentUnit.trim() || null,
        startDate: toYMD(form.startDate),
        endDate: toYMD(form.endDate),
        documentRef: form.documentRef.trim() || null,
        notes: form.notes.trim() || null,
    };
}

/** Shared required-field check. Returns an i18n KEY under `ag.lease`, or null. */
export function validateLeaseForm(form: LeaseFormState): 'lessorRequired' | null {
    return form.lessorName.trim() ? null : 'lessorRequired';
}

export function LeaseFormFields({
    form,
    setField,
    disabled,
}: {
    form: LeaseFormState;
    setField: <K extends keyof LeaseFormState>(key: K, value: LeaseFormState[K]) => void;
    disabled?: boolean;
}) {
    const tl = useTranslations('ag.lease');

    return (
        <>
            <FormField label={tl('lessor')} required>
                <Input
                    id="lease-lessor-input"
                    value={form.lessorName}
                    onChange={(e) => setField('lessorName', e.target.value)}
                    placeholder={tl('lessorPlaceholder')}
                    disabled={disabled}
                />
            </FormField>

            <FormField label={tl('lessorEik')} hint={tl('lessorEikHint')}>
                <Input
                    id="lease-lessor-eik-input"
                    value={form.lessorEik}
                    inputMode="numeric"
                    onChange={(e) => setField('lessorEik', e.target.value)}
                    placeholder={tl('lessorEikPlaceholder')}
                    disabled={disabled}
                />
            </FormField>

            <FormField label={tl('kind')}>
                <ToggleGroup
                    size="sm"
                    ariaLabel={tl('kind')}
                    selected={form.kind}
                    selectAction={(v) => setField('kind', v as 'ARENDA' | 'NAEM')}
                    options={[
                        { value: 'ARENDA', label: tl('kindArenda') },
                        { value: 'NAEM', label: tl('kindNaem') },
                    ]}
                />
            </FormField>

            <div className="grid grid-cols-2 gap-default">
                <FormField label={tl('rent')}>
                    <Input
                        id="lease-rent-input"
                        type="number"
                        inputMode="decimal"
                        value={form.rentAmount}
                        onChange={(e) => setField('rentAmount', e.target.value)}
                        disabled={disabled}
                    />
                </FormField>
                <FormField label={tl('rentUnit')}>
                    <Input
                        id="lease-rent-unit-input"
                        value={form.rentUnit}
                        onChange={(e) => setField('rentUnit', e.target.value)}
                        placeholder={EMPTY_LEASE_FORM.rentUnit}
                        disabled={disabled}
                    />
                </FormField>
            </div>

            <div className="grid grid-cols-2 gap-default">
                <FormField label={tl('startDate')}>
                    <DatePicker value={form.startDate} onChange={(d) => setField('startDate', d)} />
                </FormField>
                <FormField label={tl('endDate')}>
                    <DatePicker value={form.endDate} onChange={(d) => setField('endDate', d)} />
                </FormField>
            </div>

            <FormField label={tl('documentRef')}>
                <Input
                    id="lease-document-ref-input"
                    value={form.documentRef}
                    onChange={(e) => setField('documentRef', e.target.value)}
                    placeholder={tl('documentRefPlaceholder')}
                    disabled={disabled}
                />
            </FormField>

            <FormField label={tl('notes')}>
                <textarea
                    id="lease-notes-input"
                    className="input min-h-20"
                    rows={3}
                    value={form.notes}
                    onChange={(e) => setField('notes', e.target.value)}
                    placeholder={tl('notesPlaceholder')}
                    disabled={disabled}
                />
            </FormField>
        </>
    );
}

export default LeaseFormFields;
