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
import { ArrowUpRight, TriangleWarning } from '@/components/ui/icons/nucleo';
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
    layout?: 'compact' | 'detail';
    className?: string;
}

export function ParcelCadastralInfo({
    cadastralId,
    areaHa,
    properties,
    layout = 'compact',
    className,
}: ParcelCadastralInfoProps) {
    const t = useTranslations('ag.cadastre');
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
            <div className={className}>
                <dt className="text-content-secondary">{t('cadastralId')}</dt>
                <dd className="flex flex-wrap items-center gap-2 font-medium">
                    {link}
                    {mismatchBadge}
                </dd>
            </div>
        );
    }

    return (
        <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
            {link}
            {mismatchBadge}
        </span>
    );
}

export default ParcelCadastralInfo;
