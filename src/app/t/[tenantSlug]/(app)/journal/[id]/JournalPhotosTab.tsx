'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ImageIcon, Trash, CloudUpload, NucleoPhoto } from '@/components/ui/icons/nucleo';
import { EmptyState } from '@/components/ui/empty-state';
import { apiDelete } from '@/lib/api-client';
import { downscalePhoto } from '@/lib/image/downscale-photo';
import { useOfflineSync } from '@/lib/offline/use-offline-sync';
import { PhotoTooLargeError } from '@/lib/offline/outbox';
import { OfflineSyncBar } from '@/components/offline/OfflineSyncBar';
import { useToastWithUndo } from '@/components/ui/hooks';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import { cardVariants } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format-date';
import { useTranslations } from 'next-intl';

interface PhotoLink {
    id: string;
    caption?: string | null;
    createdAt: string;
    fileRecord?: { id: string; originalName?: string } | null;
}

interface JournalPhotosTabProps {
    entryId: string;
    photos: PhotoLink[];
    apiUrl: (path: string) => string;
    canWrite: boolean;
    onChanged: () => void;
}

/**
 * Photos tab — photo logging (HortusFox-style). Upload streams a
 * multipart POST to /journal/{id}/files, which creates the FileRecord
 * through the shared storage pipeline and links it via LogEntryFile.
 * Detach uses the Epic 67 undo-toast (5s delayed commit).
 */
/**
 * Mint the local preview URL for a just-captured photo.
 *
 * `URL.createObjectURL` returns a browser-generated `blob:<origin>/<uuid>`
 * — its contents are minted by the browser, never by a caller — so this is
 * the one place a preview URL can come from, and the regex is the assertion
 * of that invariant rather than a sanitiser doing real work. Anything that
 * does not match is dropped instead of rendered, so a future refactor that
 * routes some other string here fails closed.
 */
function mintPreviewUrl(file: File): string | null {
    const url = URL.createObjectURL(file);
    if (!/^blob:/.test(url)) {
        URL.revokeObjectURL(url);
        return null;
    }
    return url;
}

export function JournalPhotosTab({ entryId, photos, apiUrl, canWrite, onChanged }: JournalPhotosTabProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const cameraInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Instant local preview of the just-captured photo — an object-URL so
    // it renders immediately, before (and even without) any upload, which
    // keeps the camera flow responsive offline. Revoked on replace/unmount.
    const [previewSrc, setPreviewSrc] = useState<string | null>(null);
    const triggerUndoToast = useToastWithUndo();
    const t = useTranslations('journal.photos');
    // Offline-capable photo upload: sends immediately when online, else
    // queues the downscaled BYTES in the outbox (IndexedDB) for background
    // replay on reconnect. Same seam the field panel uses.
    const { online, pending, pendingPhotos, queueGrowing, foreign, durability, submitPhoto, flush } = useOfflineSync();

    useEffect(() => {
        return () => {
            if (previewSrc) URL.revokeObjectURL(previewSrc);
        };
    }, [previewSrc]);

    // Live-refresh when queued photos finish uploading in the background (the
    // hook flushes on reconnect, outside this component's upload handler). On
    // the pendingPhotos count draining to zero, refetch so the newly-attached
    // photos appear without a manual reload.
    const prevPendingPhotos = useRef(pendingPhotos);
    useEffect(() => {
        if (prevPendingPhotos.current > 0 && pendingPhotos === 0) onChanged();
        prevPendingPhotos.current = pendingPhotos;
    }, [pendingPhotos, onChanged]);

    const onPick = () => fileInputRef.current?.click();
    const onPickCamera = () => cameraInputRef.current?.click();

    // Direct multipart POST — the fallback when IndexedDB (the only store
    // that can hold a Blob) is unavailable, so the photo still uploads.
    const directUpload = async (toUpload: File) => {
        const fd = new FormData();
        fd.append('file', toUpload);
        const res = await fetch(apiUrl(`/journal/${entryId}/files`), { method: 'POST', body: fd });
        if (!res.ok) {
            let msg = `Upload failed (${res.status})`;
            try {
                const body = await res.json();
                msg = body?.error?.message || body?.error || msg;
            } catch {
                /* keep default */
            }
            throw new Error(typeof msg === 'string' ? msg : 'Upload failed');
        }
    };

    const uploadFile = async (file: File) => {
        setUploading(true);
        setError(null);
        try {
            // Rural operators shoot 8–12 MB camera photos and upload over flaky
            // LTE. Shrink to ~2000 px / JPEG 0.85 BEFORE the multipart POST —
            // a few hundred KB instead of megabytes. Non-images (PDFs) and
            // already-small photos pass through untouched, and any failure
            // falls back to the original File, so the upload never breaks.
            const toUpload = await downscalePhoto(file);
            let queued = false;
            try {
                // Offline-first: submitPhoto sends when online, else queues the
                // downscaled BYTES in the outbox for background-sync replay.
                const result = await submitPhoto({
                    url: apiUrl(`/journal/${entryId}/files`),
                    blob: toUpload,
                    fileName: toUpload.name || 'photo.jpg',
                    fileType: toUpload.type || 'application/octet-stream',
                    label: t('photoQueuedLabel'),
                });
                queued = result === 'queued';
            } catch (err) {
                // No IndexedDB (jsdom / private mode) — fall back to a direct
                // upload rather than silently dropping the photo. A terminal
                // 4xx from submitPhoto propagates.
                if (err instanceof Error && err.message.includes('no IndexedDB')) {
                    await directUpload(toUpload);
                } else {
                    throw err;
                }
            }
            haptic('success');
            // Only refetch when the photo actually reached the server; a queued
            // photo isn't linked yet (it uploads on reconnect).
            if (!queued) onChanged();
        } catch (err) {
            if (err instanceof PhotoTooLargeError) {
                setError(t('photoTooLarge'));
            } else {
                setError(err instanceof Error ? err.message : 'Upload failed');
            }
            haptic('error');
        } finally {
            setUploading(false);
        }
    };

    const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        // Reset the input so picking the same file again re-fires onChange.
        e.target.value = '';
        if (!file) return;
        await uploadFile(file);
    };

    const onPhotoCaptured = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        // Crisp tactile confirmation the shutter captured (field + gloves).
        haptic('tap');
        // Show the thumbnail instantly (offline-safe), then upload.
        setPreviewSrc((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return mintPreviewUrl(file);
        });
        await uploadFile(file);
    };

    const detach = (fileRecordId: string, label: string) => {
        // Optimistic removal happens via the parent refetch after commit;
        // the undo window holds the destructive DELETE for 5 seconds.
        triggerUndoToast({
            message: t('photoRemoved'),
            undoMessage: t('undo'),
            action: async () => {
                await apiDelete(apiUrl(`/journal/${entryId}/files?fileRecordId=${encodeURIComponent(fileRecordId)}`));
                onChanged();
            },
            onError: () => setError(`Failed to remove ${label}`),
        });
    };

    return (
        <div className={cn(cardVariants(), 'space-y-default')} id="journal-photos">
            {/* Surface the offline/queued state only when there's something to
                say — a clean online tab stays uncluttered. Photos queued show
                distinctly ("N photos queued"). */}
            {(!online || pending > 0) && (
                <OfflineSyncBar
                    online={online}
                    pending={pending}
                    pendingPhotos={pendingPhotos}
                    queueGrowing={queueGrowing} foreign={foreign}
                    storagePersisted={durability?.persisted ?? null}
                    onSyncNow={() => void flush()}
                />
            )}

            {error && (
                <div
                    className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                    role="alert"
                >
                    {error}
                </div>
            )}

            {canWrite && (
                <div className="flex flex-wrap items-center justify-between gap-default">
                    <span className="text-sm text-content-muted">
                        {t('attachHint')}
                    </span>
                    <div className="flex items-center gap-compact">
                        {/* Camera capture — opens the phone's rear camera on
                            mobile (capture="environment"). Desktop falls back
                            to a normal image file picker. */}
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<NucleoPhoto className="size-4" />}
                            onClick={onPickCamera}
                            loading={uploading}
                            disabled={uploading}
                            id="journal-photo-capture"
                        >
                            {t('takePhoto')}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<CloudUpload className="size-4" />}
                            onClick={onPick}
                            loading={uploading}
                            disabled={uploading}
                            id="journal-photo-upload"
                        >
                            {t('upload')}
                        </Button>
                    </div>
                    <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        accept="image/*,application/pdf"
                        onChange={onFileChosen}
                        aria-hidden="true"
                    />
                    <input
                        ref={cameraInputRef}
                        type="file"
                        className="hidden"
                        accept="image/*"
                        capture="environment"
                        onChange={onPhotoCaptured}
                        aria-hidden="true"
                    />
                </div>
            )}

            {/* Only ever preview a browser-minted local `blob:` object URL
                (from URL.createObjectURL of the just-captured File) — never a
                caller-supplied string. Defence-in-depth + clears the
                js/xss-through-dom flow into the <img> sink. */}
            {previewSrc?.startsWith('blob:') && (
                <div className="flex items-center gap-default rounded-lg border border-border-subtle p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- local object-URL preview of a just-captured photo; next/image needs known dimensions + a remote allowlist that a transient blob URL can't satisfy. */}
                    <img
                        src={previewSrc}
                        alt={t('justCaptured')}
                        className="size-16 shrink-0 rounded-md object-cover"
                    />
                    <span className="text-xs text-content-muted">
                        {uploading ? t('uploadingPhoto') : t('photoCaptured')}
                    </span>
                </div>
            )}

            {photos.length === 0 ? (
                <EmptyState
                    size="sm"
                    variant="no-records"
                    title={t('emptyTitle')}
                    description={canWrite ? t('emptyDescription') : t('emptyDescriptionReadonly')}
                />
            ) : (
                <ul className="divide-y divide-border-subtle">
                    {photos.map((p) => {
                        const fileId = p.fileRecord?.id ?? '';
                        const name = p.fileRecord?.originalName ?? 'file';
                        return (
                            <li key={p.id} className="flex items-center justify-between gap-default py-2">
                                <a
                                    href={apiUrl(`/evidence/files/${fileId}/download`)}
                                    className="inline-flex min-w-0 items-center gap-tight text-sm text-content-link hover:underline"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    <ImageIcon className="size-4 shrink-0 text-content-muted" aria-hidden="true" />
                                    <span className="min-w-0 truncate">{p.caption || name}</span>
                                </a>
                                <div className="flex items-center gap-tight">
                                    <span className="text-xs text-content-subtle whitespace-nowrap">
                                        {formatDateTime(p.createdAt)}
                                    </span>
                                    {canWrite && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => detach(fileId, name)}
                                            aria-label={t('removeFile', { name })}
                                        >
                                            <Trash className="size-4" />
                                        </Button>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
