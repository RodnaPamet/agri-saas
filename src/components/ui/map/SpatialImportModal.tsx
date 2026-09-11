'use client';

/**
 * SpatialImportModal — import parcel boundaries into a Location. Two tabs:
 *
 *   • „Файл" — upload a shapefile (.zip) / KML / GeoJSON. Posts multipart to
 *     the spatial-import route; parcels are ADDED to the location's existing set.
 *   • „От кадастъра" — import by cadastral identifier (ЕКАТТЕ.масив.номер) from
 *     the Bulgarian КАИС OpenData portal. Only shown when the server reports the
 *     feature configured (`cadastreEnabled`); the КАИС URL is never exposed here.
 *
 * Both paths run OFF the request thread: the POST stages/enqueues (202 + jobId),
 * then this modal polls the per-job status route until completion. Rejections
 * surface as the job's `failedReason`.
 */
import { useTranslations } from 'next-intl';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Combobox } from '@/components/ui/combobox';
import { TabSelect } from '@/components/ui/tab-select';
import { localizedCropOptions } from '@/lib/agriculture/crop-options';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { parseIdentifierList } from '@/lib/cadastre/identifier';

export interface SpatialImportModalProps {
    locationId: string;
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /** Server-computed flag — is КАИС cadastre import configured? */
    cadastreEnabled?: boolean;
    onImported?: (result: {
        parcelCount: number;
        format: string;
        skipped: number;
        /** Requested cadastral identifiers with no match (cadastre tab). */
        notFound?: string[];
        source?: 'file' | 'cadastre';
    }) => void;
}

type ImportMode = 'file' | 'cadastre';

interface JobStatus {
    state: 'completed' | 'failed' | 'active' | 'waiting' | 'delayed' | 'unknown' | string;
    result?: {
        details?: {
            parcelCount?: number;
            imported?: number;
            format?: string;
            skipped?: number;
            notFound?: string[];
        };
    } | null;
    failedReason?: string | null;
}

const POLL_INTERVAL_MS = 1000;
const MAX_POLLS = 120; // ~2 min ceiling — the КАИС walk can take longer than a file parse.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function SpatialImportModal({ locationId, open, setOpen, cadastreEnabled, onImported }: SpatialImportModalProps) {
    const t = useTranslations('ag.map.spatialImport');
    const tc = useTranslations('common');
    const tCrops = useTranslations('crops');
    const cropOptions = localizedCropOptions(tCrops);
    const buildUrl = useTenantApiUrl();
    const [mode, setMode] = useState<ImportMode>('file');
    const [file, setFile] = useState<File | null>(null);
    // Default crop stamped on every imported parcel (#7); '' = mixed/set later.
    const [crop, setCrop] = useState<string>('');
    const [identifiers, setIdentifiers] = useState<string>('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Live client-side per-line validation for the cadastre tab.
    const parsedIds = parseIdentifierList(identifiers);

    /** Poll the job status route until the import completes or fails. */
    const pollUntilDone = async (endpoint: string, jobId: string): Promise<JobStatus> => {
        for (let i = 0; i < MAX_POLLS; i++) {
            await sleep(POLL_INTERVAL_MS);
            const res = await fetch(buildUrl(`/locations/${locationId}/${endpoint}/${jobId}`));
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error?.message || body?.error || t('statusCheckFailed', { status: res.status }));
            }
            const status = (await res.json()) as JobStatus;
            if (status.state === 'completed') return status;
            if (status.state === 'failed') {
                throw new Error(status.failedReason || t('failedProcessing'));
            }
        }
        throw new Error(t('takingLong'));
    };

    const resetAndClose = () => {
        setOpen(false);
        setFile(null);
        setCrop('');
        setIdentifiers('');
    };

    const submitFile = async () => {
        if (!file) {
            setError(t('chooseFile'));
            return;
        }
        const fd = new FormData();
        fd.append('file', file);
        if (crop) fd.append('cropType', crop);
        const res = await fetch(buildUrl(`/locations/${locationId}/spatial-import`), { method: 'POST', body: fd });
        if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error?.message || body?.error || t('importFailedStatus', { status: res.status }));
        }
        const { jobId } = await res.json();
        const status = await pollUntilDone('spatial-import', jobId);
        const details = status.result?.details ?? {};
        onImported?.({
            parcelCount: details.parcelCount ?? 0,
            format: details.format ?? '',
            skipped: details.skipped ?? 0,
            source: 'file',
        });
        resetAndClose();
    };

    const submitCadastre = async () => {
        if (parsedIds.valid.length === 0) {
            setError(t('cadastreNoValid'));
            return;
        }
        const res = await fetch(buildUrl(`/locations/${locationId}/cadastre-import`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifiers: parsedIds.valid }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error?.message || body?.error || t('importFailedStatus', { status: res.status }));
        }
        const { jobId } = await res.json();
        const status = await pollUntilDone('cadastre-import', jobId);
        const details = status.result?.details ?? {};
        onImported?.({
            parcelCount: details.imported ?? 0,
            format: 'cadastre',
            skipped: 0,
            notFound: details.notFound ?? [],
            source: 'cadastre',
        });
        resetAndClose();
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            if (mode === 'cadastre') await submitCadastre();
            else await submitFile();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('importFailed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="md"
            title={t('title')}
            description={t('description')}
            preventDefaultClose={busy}
        >
            <Modal.Header title={t('title')} description={t('description')} />
            <Modal.Form id="spatial-import-form" onSubmit={submit}>
                <Modal.Body>
                    {error && (
                        <div role="alert" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                            {error}
                        </div>
                    )}

                    {cadastreEnabled && (
                        <div className="mb-4">
                            <TabSelect<ImportMode>
                                options={[
                                    { id: 'file', label: t('tabFile') },
                                    { id: 'cadastre', label: t('tabCadastre') },
                                ]}
                                selected={mode}
                                onSelect={(id: ImportMode) => {
                                    setMode(id);
                                    setError(null);
                                }}
                                ariaLabel={t('tabsAria')}
                            />
                        </div>
                    )}

                    {mode === 'file' ? (
                        <>
                            <FormField label={t('spatialFile')} required description={t('accepted')}>
                                <input
                                    type="file"
                                    accept=".zip,.kml,.kmz,.geojson,.json"
                                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                                    className="block w-full text-sm text-content-secondary file:mr-3 file:rounded-md file:border file:border-border-subtle file:bg-bg-subtle file:px-3 file:py-1.5 file:text-sm"
                                />
                            </FormField>
                            {/* Optional default crop stamped on every imported parcel
                                (#7). Leaving it unset means "mixed / set later". */}
                            <FormField label={t('cropLabel')} description={t('cropDescription')}>
                                <Combobox
                                    options={cropOptions}
                                    selected={cropOptions.find((o) => o.value === crop) ?? null}
                                    setSelected={(o) => setCrop(o?.value ?? '')}
                                    optionRight={(o) =>
                                        o.meta?.season ? (
                                            <span className="text-xs text-content-subtle">{o.meta.season}</span>
                                        ) : null
                                    }
                                    placeholder={t('cropPlaceholder')}
                                    hideSearch
                                    matchTriggerWidth
                                    caret
                                    buttonProps={{ className: 'w-full' }}
                                />
                            </FormField>
                        </>
                    ) : (
                        <FormField
                            label={t('cadastreIdentifiers')}
                            required
                            description={t('cadastreIdentifiersHint')}
                        >
                            <div>
                                <textarea
                                    value={identifiers}
                                    onChange={(e) => setIdentifiers(e.target.value)}
                                    rows={6}
                                    spellCheck={false}
                                    placeholder={'68134.8360.729\n02676.15.42'}
                                    className="block w-full rounded-lg border border-border-subtle bg-bg-default px-3 py-2 font-mono text-base md:text-sm text-content-default"
                                />
                                {parsedIds.invalid.length > 0 && (
                                    <p className="mt-2 text-xs text-content-error">
                                        {t('cadastreInvalidLines', { list: parsedIds.invalid.slice(0, 5).join(', ') })}
                                    </p>
                                )}
                                {parsedIds.valid.length > 0 && (
                                    <p className="mt-1 text-xs text-content-subtle">
                                        {t('cadastreValidCount', { count: parsedIds.valid.length })}
                                    </p>
                                )}
                            </div>
                        </FormField>
                    )}
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(false)}>{tc('cancel')}</Button>
                    <Button
                        variant="primary"
                        size="sm"
                        type="submit"
                        loading={busy}
                        disabled={busy || (mode === 'file' ? !file : parsedIds.valid.length === 0)}
                    >
                        {busy ? t('importing') : t('import')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}

export default SpatialImportModal;
