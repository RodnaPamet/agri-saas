'use client';

/**
 * ParcelCadastralInfo — the Bulgarian КАИС cadastral identity of a parcel,
 * with a deep link to the public КАИС map viewer and a subtle
 * area-reconciliation badge when the documentary area (площ по документ)
 * diverges >5% from the geometry-derived area.
 *
 * Two layouts:
 *   • `compact` — a single line (link + optional warning), for the parcel
 *     list/table cell and the map hover.
 *   • `detail`  — a labelled block ("Кадастрален идентификатор"), for the
 *     ParcelDetailSheet.
 *
 * Renders nothing when the parcel has no cadastral identifier.
 */
import { useTranslations } from 'next-intl';
import { ArrowUpRight, TriangleWarning, PenWriting } from '@/components/ui/icons/nucleo';
import { Tooltip } from '@/components/ui/tooltip';
import {
    KAIS_MAP_URL,
    documentaryAreaDca,
    areaDivergesFromDocument,
} from '@/lib/agriculture/cadastre';
import { haToDca, trimNumber } from '@/lib/agro/rate-calc';

export interface ParcelCadastralInfoProps {
    cadastralId?: string | null;
    areaHa?: number | null;
    /** The parcel's propertiesJson (carries the documentary area, when present). */
    properties?: unknown;
    /**
     * LEGAL-ENTITY owners from the КАИС ownership register (empty when none).
     * Shown only in the `detail` layout. Physical persons are never included.
     */
    companyOwners?: Array<{ name: string; eik: string; rightType: string | null; subjectKind: string | null }>;
    /** When provided (detail layout), renders an inline edit affordance. */
    onEdit?: () => void;
    layout?: 'compact' | 'detail';
    className?: string;
}

export function ParcelCadastralInfo({
    cadastralId,
    areaHa,
    properties,
    companyOwners = [],
    onEdit,
    layout = 'compact',
    className,
}: ParcelCadastralInfoProps) {
    const t = useTranslations('ag.cadastre');
    const tc = useTranslations('common');
    if (!cadastralId) return null;

    const docDca = documentaryAreaDca(properties);
    const diverges = areaDivergesFromDocument(areaHa ?? null, docDca);
    const geomDca = areaHa != null ? trimNumber(haToDca(areaHa)) : null;

    const mismatchBadge =
        diverges && docDca != null && geomDca != null ? (
            <Tooltip
                content={t('areaMismatchDetail', { doc: trimNumber(docDca), geom: geomDca })}
                side="top"
            >
                <span
                    className="inline-flex items-center gap-1 text-content-warning"
                    aria-label={t('areaMismatch')}
                >
                    <TriangleWarning className="size-3.5" aria-hidden="true" />
                    {layout === 'detail' ? <span className="text-xs">{t('areaMismatch')}</span> : null}
                </span>
            </Tooltip>
        ) : null;

    // Stop the row-click (which opens the parcel sheet) from firing when the
    // КАИС link is tapped inside a clickable table row.
    const link = (
        <a
            href={KAIS_MAP_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-brand hover:underline"
            title={t('viewInKais')}
        >
            <span className="tabular-nums">{cadastralId}</span>
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </a>
    );

    if (layout === 'detail') {
        return (
            <>
                <div className={className}>
                    <dt className="text-content-muted">{t('cadastralId')}</dt>
                    <dd className="flex flex-wrap items-center gap-tight font-medium">
                        {link}
                        {mismatchBadge}
                        {onEdit ? (
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onEdit();
                                }}
                                className="inline-flex items-center text-content-subtle hover:text-content-default"
                                aria-label={tc('edit')}
                            >
                                <PenWriting className="size-3.5" aria-hidden="true" />
                            </button>
                        ) : null}
                    </dd>
                </div>
                {companyOwners.length > 0 ? (
                    <div className={className}>
                        <dt className="text-content-muted">{t('legalOwner')}</dt>
                        <dd className="space-y-0.5 font-medium">
                            {companyOwners.map((o, i) => (
                                <div key={`${o.eik}-${i}`} className="flex flex-wrap items-baseline gap-tight">
                                    <span>{o.name}</span>
                                    <span className="text-xs text-content-subtle tabular-nums">
                                        {t('eik', { eik: o.eik })}
                                    </span>
                                </div>
                            ))}
                        </dd>
                    </div>
                ) : null}
            </>
        );
    }

    return (
        <span className={`inline-flex items-center gap-tight ${className ?? ''}`}>
            {link}
            {mismatchBadge}
        </span>
    );
}

export default ParcelCadastralInfo;
