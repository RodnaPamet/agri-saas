'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

export type PdfReportType = 'RISK_REGISTER';

interface PdfExportButtonProps {
    tenantSlug: string;
    reportType: PdfReportType;
    /** Button label */
    label?: string;
    /** Allow saving as evidence file record */
    allowSave?: boolean;
    /** Additional CSS classes */
    className?: string;
}

/**
 * Pill-styled PDF export button.
 * - Click → calls server-side PDF generation → triggers browser download.
 * - Shift+click (or "Save" variant) → saves to FileRecord too.
 */
export function PdfExportButton({
    tenantSlug,
    reportType,
    label,
    allowSave = false,
    className = '',
}: PdfExportButtonProps) {
    const t = useTranslations('pdfExport');
    const resolvedLabel = label ?? t('exportPdf');
    const [generating, setGenerating] = useState(false);
    const [saving, setSaving] = useState(false);

    const handleExport = async (saveToFile = false) => {
        const setLoading = saveToFile ? setSaving : setGenerating;
        setLoading(true);

        try {
            const res = await fetch(`/api/t/${tenantSlug}/reports/pdf/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: reportType,
                    saveToFileRecord: saveToFile,
                }),
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'PDF generation failed');
            }

            if (saveToFile) {
                // FileRecord saved — show confirmation
                const data = await res.json();
                alert(t('alertSaved', { fileName: data.fileName, size: (data.sizeBytes / 1024).toFixed(1) }));
            } else {
                // Stream → download
                const blob = await res.blob();
                const disposition = res.headers.get('Content-Disposition');
                const fileNameMatch = disposition?.match(/filename="?([^"]+)"?/);
                const fileName = fileNameMatch?.[1] || `${reportType}_${new Date().toISOString().slice(0, 10)}.pdf`;

                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
        } catch (err) {
            console.error('PDF export error:', err);
            alert(t('alertFailed'));
        } finally {
            setLoading(false);
        }
    };

    const isLoading = generating || saving;

    return (
        <div className="inline-flex gap-1">
            <Button
                variant="secondary"
                className={className}
                onClick={() => handleExport(false)}
                disabled={isLoading}
                id={`export-pdf-${reportType.toLowerCase()}-btn`}
            >
                {generating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                    <Download className="w-3.5 h-3.5" />
                )}
                {generating ? t('generating') : resolvedLabel}
            </Button>

            {allowSave && (
                <Tooltip content={t('saveTooltip')}>
                    <Button
                        variant="secondary"
                        onClick={() => handleExport(true)}
                        disabled={isLoading}
                        aria-label={t('saveAria')}
                        id={`save-pdf-${reportType.toLowerCase()}-btn`}
                    >
                        {saving ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Save className="w-3.5 h-3.5" />
                        )}
                    </Button>
                </Tooltip>
            )}
        </div>
    );
}
