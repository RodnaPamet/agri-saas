'use client';

/**
 * Epic 43.1 — Evidence upload modal (multi-file dropzone).
 *
 * Builds on the Epic 54 modal shape but swaps the single-file
 * `<FileUpload>` primitive for the new generic `<FileDropzone>` from
 * `@/components/ui/FileDropzone`. The dropzone supports drag-and-drop,
 * click-to-browse, multi-file selection, and a per-file progress bar
 * driven by `XMLHttpRequest.upload.onprogress` (fetch can't surface
 * upload progress on any mainstream browser today).
 *
 * Business contract is preserved byte-for-byte:
 *   - `POST /api/t/:slug/evidence/uploads` with `FormData` carrying
 *     `file`, `title?`, `controlId?`. Each queued file is uploaded
 *     individually; the same metadata fields apply to every file in
 *     the batch.
 *   - Optimistic pending row inserted into the SWR cache for
 *     `CACHE_KEYS.evidence.list()` while each upload is in flight
 *     (Epic 69 — `useTenantMutation` handles the rollback on
 *     throw automatically; the temp row sticks until the
 *     post-success revalidation overwrites the cache with the
 *     authoritative server-side list).
 *   - Follow-up `POST /evidence/:id/retention` when a retention date
 *     is supplied (per uploaded evidence record).
 *   - Sibling filter variants (`/evidence?type=…`, `/evidence?status=…`,
 *     etc.) get a parallel background refetch via the function-form
 *     `swrMutate(matcher, …)` after each successful upload so the
 *     "Expiring" / "Archived" tabs and any filtered view refresh.
 *
 * E2E selectors preserved:
 *   - `#upload-form`, `#upload-evidence-cancel-btn`, `#submit-upload-btn`,
 *     `#file-input`, `#upload-title-input`, `#control-select`,
 *     `#retention-date-input`, `#upload-error`. The dropzone forwards
 *     `inputId="file-input"` so `setInputFiles('#file-input', …)`
 *     keeps working unchanged.
 *
 * The modal is intentionally submit-driven: drops queue files in the
 * dropzone, the operator fills metadata, clicks "Upload", and the
 * dropzone's imperative `startAll()` runs each upload sequentially.
 * Auto-start UX (drop → upload immediately) is left to a future
 * lighter-weight surface (e.g. a list-page bulk-upload tray); the
 * modal preserves the form-shaped flow operators are used to.
 */

import { useSWRConfig } from 'swr';
import { useTranslations } from 'next-intl';
import {
    SharePointFilePicker,
    type SpPickedItem,
} from '@/components/integrations/sharepoint/SharePointFilePicker';
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import {
    FileDropzone,
    type FileDropzoneHandle,
    type FileUploadEntry,
} from '@/components/ui/FileDropzone';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { RequiredMarker } from '@/components/ui/required-marker';
import { InfoTooltip } from '@/components/ui/tooltip';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import type { CappedList } from '@/lib/list-backfill-cap';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';
import {
    uploadWithProgress,
    UploadHttpError,
} from '@/lib/upload/upload-with-progress';

// ─── Constraints ────────────────────────────────────────────────────
// 25 MB per file — generous enough for a signed PDF or scanned policy
// pack, still small enough to surface oversized uploads client-side
// before we burn bandwidth on a 4xx round-trip. Server-side still
// enforces the canonical limit.
const MAX_FILE_SIZE_MB = 25;

const EVIDENCE_ACCEPT =
    '.pdf,.jpg,.jpeg,.png,.gif,.webp,.csv,.txt,.doc,.docx,.xlsx,.xls,.json,.zip';

// ─── Types ──────────────────────────────────────────────────────────

interface ControlOption {
    id: string;
    name: string;
    code?: string | null;
}

export interface UploadEvidenceModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    apiUrl: (path: string) => string;
    controls: ControlOption[];
}

// ─── Component ──────────────────────────────────────────────────────

export function UploadEvidenceModal({
    open,
    setOpen,

    tenantSlug: _tenantSlug,
    apiUrl,
    controls,
}: UploadEvidenceModalProps) {
    const t = useTranslations('evidence');
    const close = useCallback(() => setOpen(false), [setOpen]);
    const { mutate: swrMutate } = useSWRConfig();
    const dropzoneRef = useRef<FileDropzoneHandle>(null);

    const [title, setTitle] = useState('');
    const [controlId, setControlId] = useState('');
    // B8 follow-up — free-text folder label applied to every file
    // in the upload batch. Datalist below seeds it with values
    // already in use on existing evidence.
    const [folder, setFolder] = useState('');
    const [retentionUntil, setRetentionUntil] = useState('');
    const [error, setError] = useState('');
    const [queuedCount, setQueuedCount] = useState(0);
    const [uploadingAll, setUploadingAll] = useState(false);
    // SP-3 — SharePoint import. spConnId is the first available connection
    // (null = SharePoint not connected → the button stays hidden).
    const [spConnId, setSpConnId] = useState<string | null>(null);
    const [spPickerOpen, setSpPickerOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/integrations/sharepoint/connections'));
                if (!res.ok) return;
                const conns = (await res.json()) as Array<{ id: string }>;
                if (!cancelled) setSpConnId(conns[0]?.id ?? null);
            } catch {
                /* SharePoint optional — ignore */
            }
        })();
        return () => { cancelled = true; };
    }, [open, apiUrl]);

    const handleSpImport = useCallback(
        async (items: SpPickedItem[]) => {
            if (!spConnId || items.length === 0) return;
            try {
                const res = await fetch(apiUrl('/integrations/sharepoint/import'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        connectionId: spConnId,
                        items: items.map((i) => ({ driveId: i.driveId, itemId: i.itemId, name: i.name })),
                        controlId: controlId || undefined,
                    }),
                });
                if (!res.ok) {
                    setError(t('upload.sharePointFailed'));
                    return;
                }
                const prefix = apiUrl(CACHE_KEYS.evidence.list());
                await swrMutate((key) => typeof key === 'string' && key.startsWith(prefix));
                setOpen(false);
            } catch {
                setError(t('upload.sharePointNetworkFailed'));
            }
        },
        [apiUrl, spConnId, controlId, swrMutate, setOpen, t],
    );

    // Reset on every open so a previous cancel doesn't leak state.
    useEffect(() => {
        if (!open) return;
        setTitle('');
        setControlId('');
        setRetentionUntil('');
        setError('');
        setQueuedCount(0);
        setUploadingAll(false);
    }, [open]);

    // Project controls into ComboboxOption shape. The code +
    // name are all folded into the label so cmdk's fuzzy-match scoring
    // hits on any of them — typing "A.5.1" or "access review" or the
    // raw control code all filter to the same row.
    const controlOptions = useMemo<ComboboxOption<ControlOption>[]>(
        () =>
            controls.map((c) => ({
                value: c.id,
                label: `${c.code || 'Custom'}: ${c.name}`,
                meta: c,
            })),
        [controls],
    );

    const telemetry = useFormTelemetry('UploadEvidenceModal');

    // ─── Mutation: per-file upload (Epic 69 — useTenantMutation) ───
    //
    // Migrated from React Query's `useMutation` + `onMutate` /
    // `onError` rollback hooks. The Epic 69 hook handles three of
    // the four lifecycle concerns (optimistic apply, rollback on
    // throw, post-success revalidation) automatically — the only
    // thing this file still owns is the temp-row shape.
    //
    // Why the unfiltered list key: multiple cache entries can exist
    // (one per filter combo), but new uploads always land in the
    // unfiltered baseline. The optimistic-prepend lands there and
    // stays visible to the user; sibling filter variants get a
    // background refetch via `swrMutate(matcher)` after `trigger()`
    // resolves so they pick the new row up too.
    //
    // The actual HTTP work is `uploadWithProgress` (XMLHttpRequest)
    // so the dropzone's progress bar updates from real network
    // events — `fetch` can't surface upload progress.
    const evidenceListKey = CACHE_KEYS.evidence.list();
    const evidenceUrlPrefix = apiUrl(evidenceListKey);

    interface UploadVars {
        file: File;
        applyTitle: boolean;
        controlId: string;
        /** B8 follow-up — folder label applied to every uploaded file. */
        folder: string;
        retentionUntil: string;
        onProgress: (percent: number | null) => void;
        signal: AbortSignal;
        tempId: string;
    }

    const mutation = useTenantMutation<CappedList<unknown>, UploadVars, { id?: string }>({
        key: evidenceListKey,
        mutationFn: async (vars) => {
            const { file, applyTitle, onProgress, signal } = vars;
            const formData = new FormData();
            formData.append('file', file);
            // Apply the title input only when uploading a single file
            // (multi-file uploads just take the filename — different
            // titles would all land on the same string otherwise).
            if (applyTitle && title) formData.append('title', title);
            if (vars.controlId) formData.append('controlId', vars.controlId);
            // B8 follow-up — folder rides every uploaded row in the
            // batch. The /uploads route forwards it to createEvidence.
            if (vars.folder) formData.append('folder', vars.folder.trim());

            const uploaded = await uploadWithProgress<{ id?: string }>(
                apiUrl('/evidence/uploads'),
                formData,
                {
                    onProgress: (p) => onProgress(p.percent),
                    signal,
                },
            );

            if (vars.retentionUntil && uploaded?.id) {
                await fetch(apiUrl(`/evidence/${uploaded.id}/retention`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        retentionUntil: new Date(
                            vars.retentionUntil,
                        ).toISOString(),
                        retentionPolicy: 'FIXED_DATE',
                    }),
                });
            }

            return uploaded;
        },
        // Optimistic pending row prepended to the list. Identical
        // shape to the legacy single-file flow so every column
        // renderer (status badge, retention pill, file-type icon)
        // works without special-casing. The temp row sticks until
        // the post-success revalidation overwrites the cache with
        // the authoritative server-side list.
        optimisticUpdate: (current, vars) => {
            const pendingRow = {
                id: vars.tempId,
                title:
                    vars.applyTitle && title ? title : vars.file.name,
                fileName: vars.file.name,
                fileMimeType: vars.file.type || null,
                type: 'FILE',
                status: 'PENDING_UPLOAD',
                owner: null,
                control: null,
                controlId: null,
                retentionUntil: null,
                isArchived: false,
                expiredAt: null,
                deletedAt: null,
                fileRecordId: null,
            };
            // PR-5 — cache value is `CappedList<unknown>`; preserve the
            // `truncated` flag, only prepend to `rows`.
            return {
                rows: [pendingRow, ...(current?.rows ?? [])],
                truncated: current?.truncated ?? false,
            };
        },
    });

    // Dropzone's `onUpload` — invoked once per file at submit time.
    // The mutation owns the optimistic-row + revalidation flow per
    // call; this handler only bridges the dropzone's progress
    // callback into the mutation's input + generates a fresh
    // tempId so concurrent uploads don't collide.
    const handleDropzoneUpload = useCallback(
        async (
            file: File,
            ctx: { onProgress: (p: number | null) => void; signal: AbortSignal },
        ) => {
            const total = dropzoneRef.current?.getEntries().length ?? 1;
            const applyTitle = total === 1;
            const tempId = `temp:${crypto.randomUUID()}`;
            try {
                const uploaded = await mutation.trigger({
                    file,
                    applyTitle,
                    controlId,
                    folder,
                    retentionUntil,
                    onProgress: ctx.onProgress,
                    signal: ctx.signal,
                    tempId,
                });
                telemetry.trackSuccess({ evidenceId: uploaded?.id });
                // Fan out to sibling filter variants — the primary
                // key revalidation only refreshes the unfiltered
                // baseline. Without this, a user uploading while
                // filtered to "type:FILE" would not see the new row
                // until they cleared the filter.
                await swrMutate(
                    (key) =>
                        typeof key === 'string' &&
                        (key === evidenceUrlPrefix ||
                            key.startsWith(`${evidenceUrlPrefix}?`)),
                    undefined,
                    { revalidate: true },
                );
                return uploaded;
            } catch (err) {
                telemetry.trackError(err);
                const msg =
                    err instanceof UploadHttpError
                        ? (() => {
                              const body = err.parsedBody as
                                  | { error?: string; message?: string }
                                  | null;
                              return (
                                  body?.error || body?.message || err.message
                              );
                          })()
                        : err instanceof Error
                          ? err.message
                          : 'Upload failed';
                setError(msg);
                throw err;
            }
        },
        [
            mutation,
            controlId,
            folder,
            retentionUntil,
            telemetry,
            swrMutate,
            evidenceUrlPrefix,
        ],
    );

    const onPick = useCallback((files: File[]) => {
        setError('');
        // Add to existing count so multi-pick across drops accumulates.
        setQueuedCount((prev) => prev + files.length);
    }, []);

    const onAllSettled = useCallback((settled: FileUploadEntry[]) => {
        setUploadingAll(false);
        // Use the entries argument from FileDropzone — `getEntries()`
        // returns the ref-snapshot which still reflects the previous
        // commit at the moment `onAllSettled` fires (the ref-syncing
        // useEffect in FileDropzone hasn't run yet on this microtask).
        // Without using the live argument, the modal stayed open after
        // a successful POST in `evidence-upload-modal.spec.ts`.
        const allOk =
            settled.length > 0 && settled.every((e) => e.status === 'success');
        if (allOk) {
            // Drop the modal once every queued file landed cleanly.
            close();
        }
    }, [close]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (uploadingAll) return;
        const entries = dropzoneRef.current?.getEntries() ?? [];
        const queued = entries.filter((x) => x.status === 'queued');
        if (queued.length === 0) {
            setError(t('upload.fileRequired'));
            return;
        }
        setError('');
        telemetry.trackSubmit({
            count: queued.length,
            hasTitle: title.trim().length > 0,
            hasControlLink: Boolean(controlId),
            hasRetention: Boolean(retentionUntil),
        });
        setUploadingAll(true);
        dropzoneRef.current?.startAll().catch(() => {
            // Errors land in `mutation.onError` per file — the
            // imperative chain only signals "all done" via
            // `onAllSettled`, so no extra surface needed here.
        });
    };

    const cancel = () => {
        if (uploadingAll) {
            dropzoneRef.current?.cancelAll();
            setUploadingAll(false);
        }
        close();
    };

    const submitDisabled = queuedCount === 0 || uploadingAll;

    return (
        <>
        {spConnId && (
            <SharePointFilePicker
                showModal={spPickerOpen}
                setShowModal={setSpPickerOpen}
                connectionId={spConnId}
                multiple
                onConfirm={handleSpImport}
            />
        )}
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={t('upload.title')}
            description={t('upload.description')}
            preventDefaultClose={uploadingAll}
            isDirty={
                queuedCount > 0 ||
                title.trim().length > 0 ||
                controlId.length > 0 ||
                folder.trim().length > 0 ||
                retentionUntil.length > 0
            }
        >
            <Modal.Header
                title={t('upload.title')}
                description={t('upload.headerDescription')}
            />
            <Modal.Form id="upload-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="upload-error"
                            role="alert"
                            data-testid="upload-evidence-error"
                        >
                            {error}
                        </div>
                    )}

                    <fieldset className="space-y-default" disabled={uploadingAll}>
                        {/* Multi-file dropzone */}
                        <div>
                            <label
                                className="mb-1 block text-sm text-content-default"
                                htmlFor="file-input"
                            >
                                {t('upload.filesLabel')} <RequiredMarker />
                            </label>
                            <FileDropzone
                                ref={dropzoneRef}
                                inputId="file-input"
                                accept={EVIDENCE_ACCEPT}
                                multiple
                                autoStart={false}
                                maxFileSizeMB={MAX_FILE_SIZE_MB}
                                disabled={uploadingAll}
                                onPick={onPick}
                                onUpload={handleDropzoneUpload}
                                onAllSettled={onAllSettled}
                                hint={t('upload.dropHint', { mb: MAX_FILE_SIZE_MB })}
                            />
                            {spConnId && (
                                <div className="mt-default flex items-center gap-default">
                                    <span className="text-xs text-content-muted">{t('upload.orLabel')}</span>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => setSpPickerOpen(true)}
                                        disabled={uploadingAll}
                                    >
                                        {t('upload.importFromSharePoint')}
                                    </Button>
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            {/* Title (single-file only — see UX note below) */}
                            <div>
                                <label
                                    className="mb-1 block text-sm text-content-default"
                                    htmlFor="upload-title-input"
                                >
                                    {t('upload.titleLabel')}
                                </label>
                                <input
                                    id="upload-title-input"
                                    type="text"
                                    className="input w-full"
                                    placeholder={
                                        queuedCount > 1
                                            ? t('upload.titlePlaceholderMulti')
                                            : t('upload.titlePlaceholderSingle')
                                    }
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    autoComplete="off"
                                    disabled={queuedCount > 1}
                                />
                                {queuedCount > 1 && (
                                    <p className="mt-1 text-xs text-content-muted">
                                        {t('upload.titleMultiHint')}
                                    </p>
                                )}
                            </div>

                            {/* Retention date.
                              Epic 58 — uses the shared DatePicker; the
                              YMD-string state is the wire format the
                              retention API consumes. `disabledDays`
                              mirrors the previous `min=today` constraint. */}
                            <div>
                                <div className="mb-1 flex items-center gap-1.5">
                                    <label
                                        className="text-sm text-content-default"
                                        htmlFor="retention-date-input"
                                    >
                                        {t('upload.retainUntil')}
                                    </label>
                                    <InfoTooltip
                                        aria-label={t('upload.retainTooltip')}
                                        iconClassName="h-3.5 w-3.5"
                                        content={t('upload.retainInfo')}
                                    />
                                </div>
                                <DatePicker
                                    id="retention-date-input"
                                    className="w-full"
                                    placeholder={t('upload.retainDatePlaceholder')}
                                    clearable
                                    align="start"
                                    value={parseYMD(retentionUntil)}
                                    onChange={(next) => {
                                        setRetentionUntil(toYMD(next) ?? '');
                                    }}
                                    disabledDays={{
                                        before: startOfUtcDay(new Date()),
                                    }}
                                    aria-label={t('upload.retainUntil')}
                                />
                                <p className="mt-1 text-xs text-content-muted">
                                    {t('upload.retainHint')}
                                </p>
                            </div>
                        </div>

                        {/* Control link — Epic 55: searchable Combobox */}
                        <FormField
                            label={t('upload.linkToControl')}
                            description={
                                controls.length === 0
                                    ? t('upload.controlsEmptyHint')
                                    : controls.length === 1
                                        ? t('upload.controlSearchHintSingular', { count: controls.length })
                                        : t('upload.controlSearchHintPlural', { count: controls.length })
                            }
                        >
                            <Combobox<false, ControlOption>
                                id="control-select"
                                name="controlId"
                                options={controlOptions}
                                selected={
                                    controlOptions.find(
                                        (o) => o.value === controlId,
                                    ) ?? null
                                }
                                setSelected={(option) =>
                                    setControlId(option?.value ?? '')
                                }
                                placeholder={t('upload.controlPlaceholder')}
                                searchPlaceholder={t('upload.searchControls')}
                                emptyState={t('upload.noControlsMatch')}
                                matchTriggerWidth
                                buttonProps={{ className: 'w-full' }}
                                caret
                            />
                        </FormField>

                        {/* B8 follow-up — Folder. Applies to every
                            file in the batch; datalist seeds it
                            from existing evidence folders. */}
                        <FormField
                            label={t('upload.folderLabel')}
                            description={t('upload.folderFieldDescription')}
                        >
                            <input
                                id="upload-evidence-folder-input"
                                data-testid="upload-evidence-folder-input"
                                type="text"
                                className="input w-full"
                                placeholder={t('upload.folderPlaceholder')}
                                list="evidence-folder-suggestions"
                                value={folder}
                                onChange={(e) => setFolder(e.target.value)}
                                autoComplete="off"
                            />
                        </FormField>
                    </fieldset>
                </Modal.Body>

                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="upload-evidence-cancel-btn"
                        onClick={cancel}
                    >
                        {uploadingAll ? t('upload.stop') : t('upload.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="submit-upload-btn"
                        disabled={submitDisabled}
                    >
                        {uploadingAll
                            ? t('upload.uploading')
                            : queuedCount > 1
                              ? t('upload.uploadCount', { count: queuedCount })
                              : t('upload.upload')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
        </>
    );
}
