'use client';
/* eslint-disable @typescript-eslint/no-explicit-any -- self-contained
 * panel consuming server-rendered evidence rows + form events. */

/**
 * Attached-evidence panel — the writable, Control-style evidence
 * surface for an Asset detail page. Mirrors the Control / Task
 * Evidence tab: upload a file OR link a URL, both scoped to the entity
 * via `Evidence.assetId`, rendered through the shared
 * <EvidenceSubTable>.
 *
 * The `entity` prop is still threaded through (it names the element ids
 * the E2E specs select on) but has only one member since the Risk
 * variant went with the risk register.
 *
 * This is DISTINCT from `<InheritedEvidencePanel>` (read-only evidence
 * aggregated from the entity's mapped controls). The Asset Evidence
 * tab stacks both: this panel for attached evidence, the inherited panel
 * below it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { useToastWithUndo } from '@/components/ui/hooks';
import { EvidenceAddForm } from '@/components/EvidenceAddForm';
import {
    EvidenceSubTable,
    type EvidenceTabData,
} from '@/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/EvidenceSubTable';

interface AttachedEvidencePanelProps {
    /** Risk or asset id. */
    entityId: string;
    /** Drives the upload field name + element ids + copy. */
    entity: 'asset';
    /**
     * Attached-evidence endpoint WITHOUT the `/api/t/<slug>` prefix —
     * e.g. `/risks/<id>/evidence/attached`. GET returns
     * `{ links, evidence }`; POST links a URL; DELETE `${endpoint}/<id>`
     * detaches.
     */
    endpoint: string;
    apiUrl: (path: string) => string;
    tenantHref: (path: string) => string;
    canWrite: boolean;
}

export function AttachedEvidencePanel({
    entityId,
    entity,
    endpoint,
    apiUrl,
    tenantHref,
    canWrite,
}: AttachedEvidencePanelProps) {
    const t = useTranslations('evidence.attached');
    const triggerUndoToast = useToastWithUndo();
    const [data, setData] = useState<EvidenceTabData | undefined>(undefined);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const [showForm, setShowForm] = useState(false);
    const [url, setUrl] = useState('');
    const [note, setNote] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [fileTitle, setFileTitle] = useState('');
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const uploadField = 'assetId';

    const refetch = useCallback(async () => {
        try {
            const res = await fetch(apiUrl(endpoint));
            if (!res.ok) throw new Error('load failed');
            setData(await res.json());
            setError(false);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, endpoint]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; setState lands async inside refetch (mirrors InheritedEvidencePanel).
        void refetch();
    }, [refetch]);

    const resetForm = () => {
        setUrl('');
        setNote('');
        setFile(null);
        setFileTitle('');
        setFormError('');
        if (fileRef.current) fileRef.current.value = '';
        setShowForm(false);
    };

    // Unified add — a chosen file uploads via /evidence/uploads (tagged
    // with this entity); otherwise a non-empty URL links a LINK row.
    const addEvidence = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError('');
        if (file) {
            setSaving(true);
            try {
                const fd = new FormData();
                fd.append('file', file);
                if (fileTitle) fd.append('title', fileTitle);
                fd.append(uploadField, entityId);
                const res = await fetch(apiUrl('/evidence/uploads'), {
                    method: 'POST',
                    body: fd,
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || err.message || 'Upload failed');
                }
                resetForm();
                await refetch();
            } catch (err: unknown) {
                setFormError(err instanceof Error ? err.message : 'Upload failed');
            } finally {
                setSaving(false);
            }
            return;
        }
        if (!url.trim()) {
            setFormError(t('chooseFileOrUrl'));
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(apiUrl(endpoint), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url.trim(), note: note || undefined }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || err.message || 'Failed to link evidence');
            }
            resetForm();
            await refetch();
        } catch (err: unknown) {
            setFormError(err instanceof Error ? err.message : 'Failed to link evidence');
        } finally {
            setSaving(false);
        }
    };

    // Epic 67 — delayed-commit removal (detach the FK). Optimistic
    // filter, undo restores, commit-failure rolls back.
    const removeEvidence = (evidenceId: string) => {
        const previous = data;
        setData((prev) =>
            prev
                ? { ...prev, evidence: (prev.evidence ?? []).filter((ev: any) => ev.id !== evidenceId) }
                : prev,
        );
        triggerUndoToast({
            message: t('evidenceRemoved'),
            undoMessage: t('undo'),
            action: async () => {
                const res = await fetch(apiUrl(`${endpoint}/${evidenceId}`), {
                    method: 'DELETE',
                });
                if (!res.ok) throw new Error('Remove evidence failed');
                await refetch();
            },
            undoAction: () => setData(previous),
            onError: () => setData(previous),
        });
    };

    return (
        <div className="space-y-default" data-testid={`${entity}-attached-evidence`}>
            <EvidenceAddForm
                ids={{
                    trigger: `add-${entity}-evidence-btn`,
                    form: `${entity}-evidence-form`,
                    title: `${entity}-evidence-title`,
                    file: `${entity}-evidence-file`,
                    url: `${entity}-evidence-url`,
                    note: `${entity}-evidence-note`,
                    error: `${entity}-evidence-error`,
                    submit: `submit-${entity}-evidence-btn`,
                }}
                canWrite={canWrite}
                show={showForm}
                onToggleShow={() => setShowForm(!showForm)}
                file={file}
                onFileChange={(f) => {
                    setFile(f);
                    if (f && !fileTitle) setFileTitle(f.name);
                }}
                fileInputRef={fileRef}
                title={fileTitle}
                onTitleChange={setFileTitle}
                url={url}
                onUrlChange={setUrl}
                note={note}
                onNoteChange={setNote}
                onSubmit={addEvidence}
                error={formError}
                uploading={saving && !!file}
                saving={saving && !file}
            />
            {error ? (
                <InlineEmptyState
                    title={t('loadErrorTitle')}
                    description={t('loadErrorDesc')}
                />
            ) : (
                <EvidenceSubTable
                    data={data}
                    loading={loading && !data}
                    canWrite={canWrite}
                    onUnlink={() => {}}
                    onUnlinkEvidence={removeEvidence}
                    tenantHref={tenantHref}
                />
            )}
        </div>
    );
}
