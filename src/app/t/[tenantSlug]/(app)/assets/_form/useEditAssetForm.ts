'use client';

/**
 * Asset-edit form hook — modal-form P1 extraction.
 *
 * Unlike the other three entities (create flows), the asset hook is
 * an EDIT flow. The detail page passes `assetId` + `initial` (seeded
 * from the loaded `asset` row); `submit()` PATCHes the partial form
 * back. `onSuccess` receives the updated asset and is expected to
 * close the editor / refresh the detail card.
 *
 * The hook is structurally identical to the create hooks so the P2
 * `<EditAssetModal>` can compose it against the same `<EditAssetFields>`
 * markup. See
 * `docs/implementation-notes/2026-05-24-modal-form-architecture.md`.
 */
import { useState } from 'react';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

export interface EditAssetFormFields {
    name: string;
    type: string;
    owner: string;
    /** "Assigned to" — real user reference (User.id), '' = unassigned. */
    ownerUserId: string;
    location: string;
    locationId: string | null;
    usefulLifeYears: string;
    criticality: string;
    status: string;
    externalRef: string;
    manufacturer: string;
    model: string;
    serialNumber: string;
    /** Free-text numeric inputs — coerced server-side; '' = clear. */
    year: string;
    purchaseDate: string;
    purchaseCost: string;
}

export interface EditAssetFormReturn {
    fields: EditAssetFormFields;
    setField: <K extends keyof EditAssetFormFields>(
        key: K,
        value: EditAssetFormFields[K],
    ) => void;
    submitting: boolean;
    error: string | null;
    canSubmit: boolean;
    submit: () => Promise<void>;
    isDirty: boolean;
}

export interface UseEditAssetFormOptions {
    assetId: string;
    initial: Partial<EditAssetFormFields>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSuccess: (asset: any) => void;
}

const DEFAULTS: EditAssetFormFields = {
    name: '',
    type: 'TRACTOR',
    owner: '',
    ownerUserId: '',
    location: '',
    locationId: null,
    usefulLifeYears: '',
    criticality: '',
    status: 'ACTIVE',
    externalRef: '',
    manufacturer: '',
    model: '',
    serialNumber: '',
    year: '',
    purchaseDate: '',
    purchaseCost: '',
};

export function useEditAssetForm({
    assetId,
    initial,
    onSuccess,
}: UseEditAssetFormOptions): EditAssetFormReturn {
    const apiUrl = useTenantApiUrl();

    const [fields, setFields] = useState<EditAssetFormFields>(() => ({
        ...DEFAULTS,
        ...initial,
    }));
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDirty, setIsDirty] = useState(false);

    const setField = <K extends keyof EditAssetFormFields>(
        key: K,
        value: EditAssetFormFields[K],
    ) => {
        setFields((f) => ({ ...f, [key]: value }));
        setIsDirty(true);
    };

    const canSubmit = fields.name.trim().length > 0 && !submitting;

    const submit = async (): Promise<void> => {
        setSubmitting(true);
        setError(null);
        try {
            // Clean the body: empty enum / numeric text inputs must
            // serialise as null (an empty string would fail the enum or
            // coerce to 0), and the numeric fields pass as strings the
            // server-side `z.coerce.number` handles.
            const body = {
                name: fields.name,
                type: fields.type,
                status: fields.status,
                criticality: fields.criticality || null,
                owner: fields.owner,
                ownerUserId: fields.ownerUserId,
                externalRef: fields.externalRef.trim() === '' ? null : fields.externalRef,
                location: fields.location,
                locationId: fields.locationId,
                usefulLifeYears: fields.usefulLifeYears.trim()
                    ? Number(fields.usefulLifeYears)
                    : null,
                manufacturer: fields.manufacturer,
                model: fields.model,
                serialNumber: fields.serialNumber,
                year: fields.year.trim() === '' ? null : fields.year,
                purchaseDate: fields.purchaseDate,
                purchaseCost:
                    fields.purchaseCost.trim() === '' ? null : fields.purchaseCost,
            };
            const res = await fetch(apiUrl(`/assets/${assetId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`Failed to save (${res.status})`);
            const payload = await res.json();
            // PATCH /assets/:id returns `{ success, asset }` while GET
            // returns the bare asset. Unwrap so the detail page's
            // optimistic `setAsset(updated)` receives the same shape it
            // loaded with — otherwise the Overview reads undefined fields
            // (e.g. criticality C/I/A) and looks unchanged until a manual
            // refresh re-runs the GET.
            const updated = payload?.asset ?? payload;
            setIsDirty(false);
            onSuccess(updated);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            setError(err.message);
        } finally {
            setSubmitting(false);
        }
    };

    return {
        fields,
        setField,
        submitting,
        error,
        canSubmit,
        submit,
        isDirty,
    };
}
