'use client';

/**
 * Shared "add evidence" form — the single canonical add-evidence surface
 * used by the Practice, Task, Risk and Asset evidence tabs so they are
 * EXACTLY the same. Upload a file (title + browse, brand-tinted file
 * button) OR link a URL + note; a chosen file takes precedence (the URL
 * fields disable). Presentational only — each page owns its state +
 * submit handler and passes them in, plus the element ids it needs to
 * keep stable for E2E selectors.
 */
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

const FILE_ACCEPT =
    '.pdf,.jpg,.jpeg,.png,.gif,.webp,.csv,.txt,.doc,.docx,.xlsx,.xls,.json,.zip';

export interface EvidenceAddFormIds {
    trigger: string;
    form: string;
    title: string;
    file: string;
    url: string;
    note: string;
    error: string;
    submit: string;
}

export interface EvidenceAddFormProps {
    ids: EvidenceAddFormIds;
    canWrite: boolean;
    show: boolean;
    onToggleShow: () => void;
    file: File | null;
    onFileChange: (file: File | null) => void;
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    title: string;
    onTitleChange: (value: string) => void;
    url: string;
    onUrlChange: (value: string) => void;
    note: string;
    onNoteChange: (value: string) => void;
    onSubmit: (e: React.FormEvent) => void;
    error: string;
    /** A file upload is in flight — shows the progress bar + "Uploading…". */
    uploading: boolean;
    /** A URL link is in flight — shows "Linking…". */
    saving: boolean;
}

function formatSize(bytes: number): string {
    return bytes < 1048576
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1048576).toFixed(1)} MB`;
}

export function EvidenceAddForm({
    ids,
    canWrite,
    show,
    onToggleShow,
    file,
    onFileChange,
    fileInputRef,
    title,
    onTitleChange,
    url,
    onUrlChange,
    note,
    onNoteChange,
    onSubmit,
    error,
    uploading,
    saving,
}: EvidenceAddFormProps) {
    const t = useTranslations('evidenceForm');
    return (
        <>
            {canWrite && (
                <div className="flex justify-end">
                    <Button variant="primary" onClick={onToggleShow} id={ids.trigger}>
                        {t('addEvidence')}
                    </Button>
                </div>
            )}
            {show && canWrite && (
                <form
                    onSubmit={onSubmit}
                    className={cn(cardVariants({ density: 'compact' }), 'space-y-default')}
                    id={ids.form}
                >
                    <div className="space-y-compact">
                        <div>
                            <label
                                className="mb-1 block text-xs font-medium text-content-muted"
                                htmlFor={ids.title}
                            >
                                {t('title')}
                            </label>
                            <input
                                type="text"
                                className="input w-full"
                                placeholder={t('titlePlaceholder')}
                                value={title}
                                onChange={(e) => onTitleChange(e.target.value)}
                                id={ids.title}
                            />
                        </div>
                        <div>
                            <label
                                className="mb-1 block text-xs font-medium text-content-muted"
                                htmlFor={ids.file}
                            >
                                {t('uploadFile')}
                            </label>
                            <input
                                ref={fileInputRef}
                                type="file"
                                className="input w-full file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-[var(--brand-default)] file:text-content-emphasis"
                                onChange={(e) => onFileChange(e.target.files?.[0] || null)}
                                id={ids.file}
                                accept={FILE_ACCEPT}
                            />
                            {file && (
                                <p className="mt-1 text-xs text-content-muted">
                                    {file.name} ({formatSize(file.size)})
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="space-y-compact border-t border-border-subtle pt-3">
                        <label
                            className="block text-xs font-medium text-content-muted"
                            htmlFor={ids.url}
                        >
                            {t('orLinkUrl')}
                        </label>
                        <input
                            type="url"
                            className="input w-full"
                            placeholder="https://…"
                            value={url}
                            onChange={(e) => onUrlChange(e.target.value)}
                            id={ids.url}
                            disabled={!!file}
                        />
                        <textarea
                            className="input w-full"
                            rows={2}
                            placeholder={t('notePlaceholder')}
                            value={note}
                            onChange={(e) => onNoteChange(e.target.value)}
                            id={ids.note}
                            disabled={!!file}
                        />
                    </div>
                    {error && (
                        <div
                            className="text-content-error text-sm bg-bg-error rounded px-3 py-2"
                            id={ids.error}
                        >
                            {error}
                        </div>
                    )}
                    {uploading && (
                        <ProgressBar
                            value={60}
                            size="md"
                            variant="brand"
                            aria-label={t('uploadingAria')}
                        />
                    )}
                    <Button
                        type="submit"
                        variant="primary"
                        disabled={uploading || saving || (!file && !url.trim())}
                        id={ids.submit}
                    >
                        {uploading ? t('uploading') : saving ? t('linking') : t('addEvidence')}
                    </Button>
                </form>
            )}
        </>
    );
}
