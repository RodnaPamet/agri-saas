'use client';

/**
 * SP-2 — SharePoint file picker.
 *
 * A modal browser over the SharePoint hierarchy: Site → Library (drive) →
 * folders → files. Folder navigation is breadcrumb drill-in (click a folder to
 * enter, click a breadcrumb to go up) rather than a persistent tree — simpler
 * and more robust for a modal, and equivalent in capability. Files are
 * multi- or single-select; the selection bar confirms.
 *
 * Reusable across consumers (evidence import in SP-3, policy link in SP-4) via
 * `onConfirm(items)`. All data comes from the SP-2 browse/sites routes; the
 * Graph boundary is never touched directly here.
 */
import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Checkbox } from '@/components/ui/checkbox';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { LoadingSpinner } from '@/components/ui/icons/loading-spinner';
import { Folder5 } from '@/components/ui/icons/nucleo/folder5';
import { FileContent } from '@/components/ui/icons/nucleo/file-content';
import { ChevronRight } from '@/components/ui/icons/nucleo/chevron-right';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useDateFormat } from '@/lib/i18n/use-date-format';

export interface SpPickedItem {
    driveId: string;
    itemId: string;
    name: string;
    webUrl?: string;
    mimeType?: string;
}

interface SpBrowseItem {
    id: string;
    name: string;
    isFolder: boolean;
    hasChildren: boolean;
    webUrl?: string;
    size?: number;
    mimeType?: string;
    lastModified?: string;
}
interface Opt {
    value: string;
    label: string;
}

type Filter = 'all' | 'documents' | 'spreadsheets' | 'pdf';
const FILTER_MIME: Record<Exclude<Filter, 'all'>, RegExp> = {
    documents: /word|document|text|presentation/i,
    spreadsheets: /sheet|excel|csv/i,
    pdf: /pdf/i,
};

export function SharePointFilePicker({
    showModal,
    setShowModal,
    connectionId,
    multiple = true,
    onConfirm,
    folderSelect = false,
    onConfirmFolder,
}: {
    showModal: boolean;
    setShowModal: Dispatch<SetStateAction<boolean>>;
    connectionId: string;
    multiple?: boolean;
    onConfirm: (items: SpPickedItem[]) => void;
    /** SP-F1 — pick a destination FOLDER (files render read-only). */
    folderSelect?: boolean;
    onConfirmFolder?: (sel: { driveId: string; folderId?: string; folderName: string }) => void;
}) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('sharepointPicker');
    const apiUrl = useTenantApiUrl();
    const [sites, setSites] = useState<Opt[]>([]);
    const [drives, setDrives] = useState<Record<string, Opt[]>>({});
    const [siteId, setSiteId] = useState('');
    const [driveId, setDriveId] = useState('');
    const [path, setPath] = useState<{ id?: string; name: string }[]>([{ name: t('library') }]);
    const [items, setItems] = useState<SpBrowseItem[]>([]);
    const [selected, setSelected] = useState<Record<string, SpPickedItem>>({});
    const [filter, setFilter] = useState<Filter>('all');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Load sites + drives once the modal opens.
    useEffect(() => {
        if (!showModal || !connectionId) return;
        let cancelled = false;
        (async () => {
            setError(null);
            try {
                const res = await fetch(apiUrl(`/integrations/sharepoint/sites?connectionId=${connectionId}`));
                if (!res.ok) throw new Error();
                const data = await res.json();
                if (cancelled) return;
                setSites(data.sites.map((s: { id: string; name: string }) => ({ value: s.id, label: s.name })));
                const driveOpts: Record<string, Opt[]> = {};
                for (const [sid, ds] of Object.entries(data.drives)) {
                    driveOpts[sid] = (ds as { id: string; name: string }[]).map((d) => ({ value: d.id, label: d.name }));
                }
                setDrives(driveOpts);
                const firstSite = data.sites[0]?.id ?? '';
                setSiteId(firstSite);
                setDriveId(driveOpts[firstSite]?.[0]?.value ?? '');
            } catch {
                if (!cancelled) setError(t('loadSitesError'));
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is a stable next-intl binding
    }, [showModal, connectionId, apiUrl]);

    const loadFolder = useCallback(
        async (folderId?: string) => {
            if (!driveId) return;
            setLoading(true);
            setError(null);
            try {
                const q = new URLSearchParams({ connectionId, driveId });
                if (folderId) q.set('itemId', folderId);
                const res = await fetch(apiUrl(`/integrations/sharepoint/browse?${q.toString()}`));
                if (!res.ok) throw new Error();
                const data = await res.json();
                setItems(data.items);
            } catch {
                setError(t('loadFolderError'));
            } finally {
                setLoading(false);
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is a stable next-intl binding
        [apiUrl, connectionId, driveId],
    );

    // Reset to the drive root whenever the drive changes.
    useEffect(() => {
        if (!driveId) return;
        setPath([{ name: t('library') }]);
        void loadFolder(undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is a stable next-intl binding
    }, [driveId, loadFolder]);

    const enterFolder = (f: SpBrowseItem) => {
        setPath((p) => [...p, { id: f.id, name: f.name }]);
        void loadFolder(f.id);
    };
    const gotoCrumb = (idx: number) => {
        const next = path.slice(0, idx + 1);
        setPath(next);
        void loadFolder(next[next.length - 1].id);
    };

    const toggle = (f: SpBrowseItem) => {
        const picked: SpPickedItem = { driveId, itemId: f.id, name: f.name, webUrl: f.webUrl, mimeType: f.mimeType };
        setSelected((cur) => {
            if (!multiple) return cur[f.id] ? {} : { [f.id]: picked };
            const next = { ...cur };
            if (next[f.id]) delete next[f.id];
            else next[f.id] = picked;
            return next;
        });
    };

    const folders = items.filter((i) => i.isFolder);
    const files = items
        .filter((i) => !i.isFolder)
        .filter((i) => filter === 'all' || (i.mimeType ? FILTER_MIME[filter].test(i.mimeType) : false));
    const selectedCount = Object.keys(selected).length;

    const confirm = () => {
        onConfirm(Object.values(selected));
        setSelected({});
        setShowModal(false);
    };
    const confirmFolder = () => {
        const cur = path[path.length - 1];
        onConfirmFolder?.({ driveId, folderId: cur.id, folderName: cur.name });
        setShowModal(false);
    };

    return (
        <Modal showModal={showModal} setShowModal={setShowModal} size="lg" title={t('title')}>
            <Modal.Header title={t('title')} description={t('description')} />
            <Modal.Body className="space-y-default">
                {error && <InlineNotice variant="error">{error}</InlineNotice>}

                <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                    <Combobox
                        id="sp-site"
                        options={sites}
                        selected={sites.find((o) => o.value === siteId) ?? null}
                        setSelected={(o) => setSiteId(o?.value ?? '')}
                        placeholder={t('sitePlaceholder')}
                        matchTriggerWidth
                    />
                    <Combobox
                        id="sp-drive"
                        options={drives[siteId] ?? []}
                        selected={(drives[siteId] ?? []).find((o) => o.value === driveId) ?? null}
                        setSelected={(o) => setDriveId(o?.value ?? '')}
                        placeholder={t('libraryPlaceholder')}
                        matchTriggerWidth
                    />
                </div>

                {/* Breadcrumb */}
                <div className="flex flex-wrap items-center gap-tight text-sm text-content-muted">
                    {path.map((c, i) => (
                        <span key={i} className="flex items-center gap-tight">
                            {i > 0 && <ChevronRight className="size-3" />}
                            <button
                                type="button"
                                className="hover:text-content-default"
                                onClick={() => gotoCrumb(i)}
                            >
                                {c.name}
                            </button>
                        </span>
                    ))}
                </div>

                {/* File-type filter */}
                <div className="flex gap-tight">
                    {(['all', 'documents', 'spreadsheets', 'pdf'] as Filter[]).map((f) => (
                        <Button
                            key={f}
                            variant={filter === f ? 'secondary' : 'ghost'}
                            size="sm"
                            onClick={() => setFilter(f)}
                        >
                            {f === 'all' ? t('filterAll') : f === 'documents' ? t('filterDocuments') : f === 'spreadsheets' ? t('filterSpreadsheets') : t('filterPdf')}
                        </Button>
                    ))}
                </div>

                <div className="max-h-80 overflow-auto rounded-md border border-border-subtle">
                    {loading ? (
                        <div className="flex justify-center p-6"><LoadingSpinner /></div>
                    ) : (
                        <ul className="divide-y divide-border-subtle">
                            {folders.map((f) => (
                                <li key={f.id}>
                                    <button
                                        type="button"
                                        onClick={() => enterFolder(f)}
                                        className="flex w-full items-center gap-default px-4 py-default text-left hover:bg-bg-muted/50"
                                    >
                                        <Folder5 className="size-4 text-content-muted" />
                                        <span className="flex-1 truncate text-sm">{f.name}</span>
                                        <ChevronRight className="size-4 text-content-muted" />
                                    </button>
                                </li>
                            ))}
                            {files.map((f) => (
                                <li key={f.id}>
                                    {folderSelect ? (
                                        <div className="flex items-center gap-default px-4 py-default opacity-60">
                                            <FileContent className="size-4 text-content-muted" />
                                            <span className="flex-1 truncate text-sm">{f.name}</span>
                                        </div>
                                    ) : (
                                        <label className="flex cursor-pointer items-center gap-default px-4 py-default hover:bg-bg-muted/50">
                                            <Checkbox checked={!!selected[f.id]} onCheckedChange={() => toggle(f)} />
                                            <FileContent className="size-4 text-content-muted" />
                                            <span className="flex-1 truncate text-sm">{f.name}</span>
                                            {f.mimeType && <StatusBadge variant="neutral">{shortType(t, f.mimeType)}</StatusBadge>}
                                            {f.lastModified && (
                                                <span className="w-24 text-right text-xs text-content-muted">
                                                    {formatDate(f.lastModified)}
                                                </span>
                                            )}
                                        </label>
                                    )}
                                </li>
                            ))}
                            {folders.length === 0 && files.length === 0 && (
                                <li className="px-4 py-6 text-center text-sm text-content-muted">{t('folderEmpty')}</li>
                            )}
                        </ul>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                {folderSelect ? (
                    <>
                        <span className="mr-auto truncate text-sm text-content-muted">
                            {t('destination', { name: path[path.length - 1].name })}
                        </span>
                        <Button variant="ghost" onClick={() => setShowModal(false)}>{t('cancel')}</Button>
                        <Button variant="primary" onClick={confirmFolder} disabled={!driveId}>{t('useThisFolder')}</Button>
                    </>
                ) : (
                    <>
                        <span className="mr-auto text-sm text-content-muted">{t('selectedCount', { count: selectedCount })}</span>
                        <Button variant="ghost" onClick={() => setShowModal(false)}>{t('cancel')}</Button>
                        <Button variant="primary" onClick={confirm} disabled={selectedCount === 0}>
                            {multiple ? (selectedCount ? t('importCount', { count: selectedCount }) : t('import')) : t('select')}
                        </Button>
                    </>
                )}
            </Modal.Footer>
        </Modal>
    );
}

/** Compress a MIME type to a short badge label. */
function shortType(t: ReturnType<typeof useTranslations>, mime: string): string {
    if (/pdf/i.test(mime)) return t('typePdf');
    if (/sheet|excel|csv/i.test(mime)) return t('typeSheet');
    if (/word|document/i.test(mime)) return t('typeDoc');
    if (/presentation|powerpoint/i.test(mime)) return t('typeSlides');
    if (/image/i.test(mime)) return t('typeImage');
    return mime.split('/').pop()?.slice(0, 8) ?? t('typeFile');
}
