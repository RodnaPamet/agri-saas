/**
 * Field-journal list-page filter configuration.
 *
 * Keys align with `JournalQuerySchema`: type, status. Values MUST match
 * the Prisma enums (LogEntryType, LogEntryStatus) — the UI selection is
 * passed straight through to Prisma.
 */

import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import type { FilterType } from '@/components/ui/filter';
import type { useTranslations } from 'next-intl';
import { CircleDot, Layers, Sprout } from 'lucide-react';
import { CROP_PICKER_VALUES } from '@/lib/grain/crop-picker';
import type { CropPickerValue } from '@/lib/grain/crop-picker';

/**
 * Culture (crop) filter options — the values match `Parcel.cropType` (the
 * same catalogue the parcel crop picker uses). Inlined here so the journal
 * filter has no build-time coupling to the map crop-picker module.
 */
/**
 * DERIVED from `CROP_PICKER_VALUES`, not restated.
 *
 * The cost entry form offers the same six crops for its `CROP` allocation
 * basis (#1530), so this list had two consumers the moment that landed. A
 * second literal copy is the shape `cost-categories-agree` and
 * `allocation-bases-agree` were both written for — a list edited in N places
 * becomes N-1 — so the values live in `@/lib/grain/crop-picker` and this is
 * the `optionsFromEnum`-shaped view of them.
 *
 * Still a value-keyed map rather than a plain array, because `optionsFromEnum`
 * takes one and `JournalClient` does `culture in CROP_FILTER_LABELS` as its
 * membership test before localizing.
 */
export const CROP_FILTER_LABELS = Object.fromEntries(
    CROP_PICKER_VALUES.map((v) => [v, v]),
) as Record<CropPickerValue, CropPickerValue>;

/**
 * FieldOperationType (Prisma enum) — the membership guard for localizing the
 * journal list's Operation column. Values only; the labels live in
 * `journalEnums.operationType.*`.
 */
export const FIELD_OPERATION_TYPES = {
    SPRAY: 'SPRAY',
    FERTILIZE: 'FERTILIZE',
    SEED: 'SEED',
    OTHER: 'OTHER',
} as const;

export const LOG_ENTRY_TYPE_LABELS = {
    ACTIVITY: 'Activity',
    OBSERVATION: 'Observation',
    INPUT_APPLICATION: 'Input application',
    SEEDING: 'Seeding',
    TRANSPLANTING: 'Transplanting',
    HARVEST: 'Harvest',
    IRRIGATION: 'Irrigation',
    MAINTENANCE: 'Maintenance',
    LAB_TEST: 'Lab test',
    GRAZING: 'Grazing',
} as const;

export const LOG_ENTRY_STATUS_LABELS = {
    PLANNED: 'Planned',
    DONE: 'Done',
} as const;

const STATIC_DEFS = {
    type: {
        label: 'Type',
        description: 'Field-event category.',
        group: 'Attributes',
        icon: Layers,
        options: optionsFromEnum(LOG_ENTRY_TYPE_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
    status: {
        label: 'Status',
        description: 'Planned vs done.',
        group: 'Attributes',
        icon: CircleDot,
        options: optionsFromEnum(LOG_ENTRY_STATUS_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
    // Culture (crop) — dnevnik #10. Matches the operation line's parcel crop.
    crop: {
        label: 'Culture',
        description: 'Crop of the treated parcel.',
        group: 'Attributes',
        icon: Sprout,
        options: optionsFromEnum(CROP_FILTER_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

export const journalFilterDefs = createTypedFilterDefs()(STATIC_DEFS);
export const JOURNAL_FILTER_KEYS = journalFilterDefs.filterKeys;

/**
 * Localize the journal filter defs. Enum VALUES (the option `value`s, filter
 * keys, icons) are preserved; only the display labels are swapped for the
 * `journalEnums` catalogue. `t` is a `useTranslations('journalEnums')`
 * translator supplied by the consuming client component.
 */
export function buildJournalFilters(
    t: ReturnType<typeof useTranslations>,
): FilterType[] {
    const localize = (options: FilterType['options'], prefix: string): FilterType['options'] =>
        options
            ? options.map((o) => ({ ...o, label: t(`${prefix}.${o.value}`) }))
            : options;
    return journalFilterDefs.filters.map((f) => {
        switch (f.key) {
            case 'type':
                return { ...f, label: t('filter.type'), options: localize(f.options, 'logType') };
            case 'status':
                return { ...f, label: t('filter.status'), options: localize(f.options, 'status') };
            case 'crop':
                return { ...f, label: t('filter.crop'), options: localize(f.options, 'crop') };
            default:
                return f;
        }
    });
}
