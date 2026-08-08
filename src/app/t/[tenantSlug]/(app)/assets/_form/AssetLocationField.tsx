'use client';

/**
 * Structured "where does this machine live" picker.
 *
 * `Asset.location` was free text, so "which machines are at the Dobrich
 * yard" was a string match that missed "Добрич", "dobrich yard" and
 * every typo. `locationId` makes it a query.
 *
 * Filtered to the BUILT location kinds. Note `LocationKind` has no YARD
 * or BUILDING member today — it is FIELD | BIN | STORAGE — so STORAGE
 * and BIN are the closest the schema allows. FIELD is excluded because
 * a growing block is not where you keep a tractor, and including every
 * field would bury the handful of real answers.
 *
 * The free-text column is RETAINED alongside this, for the detail a
 * Location row does not model ("north shed, back bay").
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';

/** Location kinds a machine can sensibly be kept at. */
const KEEPABLE_KINDS = new Set(['STORAGE', 'BIN']);

interface LocationRow {
    id: string;
    name: string;
    kind?: string | null;
    status?: string | null;
}

interface Props {
    locationId: string | null | undefined;
    onLocationIdChange: (id: string | null) => void;
    /** The retained free-text note. */
    note: string | undefined;
    onNoteChange: (value: string) => void;
}

export function AssetLocationField({
    locationId,
    onLocationIdChange,
    note,
    onNoteChange,
}: Props) {
    const t = useTranslations('assets');
    const { data } = useTenantSWR<LocationRow[] | { rows: LocationRow[] }>('/locations');

    const options = useMemo<ComboboxOption[]>(() => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
        return list
            .filter((l) => KEEPABLE_KINDS.has(String(l.kind ?? '')) && l.status !== 'ARCHIVED')
            .map((l) => ({ value: l.id, label: l.name }));
    }, [data]);

    const selected = options.find((o) => o.value === locationId) ?? null;

    return (
        <>
            <FormField label={t('locationStructured')} hint={t('locationStructuredHelp')}>
                <Combobox
                    id="asset-location-select"
                    options={options}
                    selected={selected}
                    setSelected={(o) => onLocationIdChange(o?.value ?? null)}
                    placeholder={t('locationNone')}
                    matchTriggerWidth
                />
            </FormField>
            <FormField label={t('location')}>
                <Input
                    id="asset-location-input"
                    value={note ?? ''}
                    onChange={(e) => onNoteChange(e.target.value)}
                    placeholder={t('locationNotePlaceholder')}
                />
            </FormField>
        </>
    );
}
