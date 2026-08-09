/**
 * PDF Report Types
 */

export type WatermarkMode = 'DRAFT' | 'FINAL' | 'NONE';

export interface ReportMeta {
    tenantName: string;
    reportTitle: string;
    reportSubtitle?: string;
    generatedAt: string;
    framework?: string;
    watermark?: WatermarkMode;
    /** SHA-256 hash of report data (set after generation) */
    contentHash?: string;
    /**
     * Font family for the document. `'latin'` (default) keeps PDFKit's
     * built-in Helvetica (AFM, latin-only) — every existing report is
     * unchanged. `'unicode'` registers the bundled DejaVu Sans over the
     * `Helvetica`/`Helvetica-Bold` names so Cyrillic (the БАБХ ДНЕВНИК)
     * renders instead of tofu — see `createPdfDocument`.
     */
    fontFamily?: 'latin' | 'unicode';
}

export interface TableColumn {
    key: string;
    header: string;
    width: number;      // points
    align?: 'left' | 'center' | 'right';
}

export interface TableRenderOptions {
    headerBg?: string;
    headerColor?: string;
    altRowBg?: string;
    fontSize?: number;
    rowPadding?: number;
    startY?: number;
}

export interface TotalsRow {
    /** Map of column key → display value for totals */
    values: Record<string, string>;
    /** Background color */
    bg?: string;
}

export interface GeneratePdfInput {
    saveToFileRecord?: boolean;
    watermark?: WatermarkMode;
}

export interface SummaryMetric {
    label: string;
    value: string | number;
}

export interface DataSourceNote {
    source: string;
    description: string;
}
