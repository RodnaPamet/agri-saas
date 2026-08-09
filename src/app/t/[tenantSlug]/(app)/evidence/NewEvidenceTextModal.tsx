'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 54 — Add Text/Link Evidence modal.
 *
 * Modal-based replacement for the inline `#text-evidence-form` that
 * EvidenceClient rendered toggle-style above the list. Keeps the same
 * POST `/evidence` contract (type=TEXT) and the same React-Query cache
 * invalidation so behaviour is byte-identical to the legacy flow.
 *
 * Preserved form ID: `text-evidence-form` (used by existing E2E).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
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
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { RequiredMarker } from '@/components/ui/required-marker';
import { queryKeys } from '@/lib/queryKeys';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';

interface ControlOption {
    id: string;
    name: string;
    code?: string | null;
}

export interface NewEvidenceTextModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    apiUrl: (path: string) => string;
    controls: ControlOption[];
}

export function NewEvidenceTextModal({
    open,
    setOpen,
    tenantSlug,
    apiUrl,
    controls,
}: NewEvidenceTextModalProps) {
    const tr = useTranslations('evidence');
    const close = useCallback(() => setOpen(false), [setOpen]);
    const queryClient = useQueryClient();
    // Epic 69 — bridge cache invalidation. EvidenceClient now reads
    // from `useTenantSWR(CACHE_KEYS.evidence.list())`, so the React
    // Query invalidation below alone wouldn't refresh the page. We
    // invalidate BOTH caches: RQ (in case other consumers still
    // depend on it) and SWR (the actual source of truth for the
    // list page after Epic 69). Once every consumer of the
    // evidence list has migrated to SWR, the queryClient calls can
    // be dropped.
    const { mutate: swrMutate } = useSWRConfig();
    const titleRef = useRef<HTMLInputElement>(null);

    const [form, setForm] = useState({
        title: '',
        content: '',
        controlId: '',
        category: '',
        // B8 follow-up — free-text folder label. Datalist below
        // seeds it with values already in use on existing evidence.
        folder: '',
        owner: '',
    });
    const [error, setError] = useState('');

    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({
            title: '',
            content: '',
            controlId: '',
            category: '',
            folder: '',
            owner: '',
        });
        setError('');
        const t = setTimeout(() => titleRef.current?.focus(), 60);
        return () => clearTimeout(t);
    }, [open]);

    const update = <K extends keyof typeof form>(
        field: K,
        value: (typeof form)[K],
    ) => setForm((prev) => ({ ...prev, [field]: value }));

    const controlOptions = useMemo<ComboboxOption<ControlOption>[]>(
        () =>
            controls.map((c) => ({
                value: c.id,
                label: `${c.code || 'Custom'}: ${c.name}`,
                meta: c,
            })),
        [controls],
    );

    const mutation = useMutation({
        mutationFn: async (body: typeof form) => {
            const res = await fetch(apiUrl('/evidence'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, type: 'TEXT' }),
            });
            if (!res.ok) {
                const err = await res
                    .json()
                    .catch(() => ({ error: 'Failed to create evidence' }));
                throw new Error(
                    err.error || err.message || 'Failed to create evidence',
                );
            }
            return res.json();
        },
        onSuccess: (data) => {
            // Invalidate React Query cache for any RQ-using consumers.
            queryClient.invalidateQueries({
                queryKey: queryKeys.evidence.all(tenantSlug),
            });
            // Invalidate every `/evidence?…` SWR cache entry so the
            // list page (Epic 69 SWR-first) refreshes regardless of
            // which filter view the user uploaded from.
            const evidenceUrlPrefix = apiUrl(CACHE_KEYS.evidence.list());
            swrMutate(
                (key) =>
                    typeof key === 'string' &&
                    (key === evidenceUrlPrefix ||
                        key.startsWith(`${evidenceUrlPrefix}?`)),
                undefined,
                { revalidate: true },
            );
            telemetry.trackSuccess({
                evidenceId: (data as { id?: string })?.id,
            });
            close();
        },
        onError: (err) => {
            telemetry.trackError(err);
            setError(
                err instanceof Error ? err.message : tr('textModal.createFailed'),
            );
        },
    });

    const telemetry = useFormTelemetry('NewEvidenceTextModal');

    const canSubmit =
        form.title.trim().length > 0 && !mutation.isPending;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        setError('');
        telemetry.trackSubmit({
            hasControlLink: Boolean(form.controlId),
            contentLength: form.content?.length ?? 0,
        });
        mutation.mutate(form);
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={tr('textModal.title')}
            description={tr('textModal.description')}
            preventDefaultClose={mutation.isPending}
        >
            <Modal.Header
                title={tr('textModal.title')}
                description={tr('textModal.description')}
            />
            <Modal.Form id="text-evidence-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="text-evidence-error"
                            role="alert"
                            data-testid="text-evidence-error"
                        >
                            {error}
                        </div>
                    )}

                    <fieldset
                        className="space-y-default"
                        disabled={mutation.isPending}
                    >
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <div>
                                <label
                                    className="mb-1 block text-sm text-content-default"
                                    htmlFor="text-evidence-title-input"
                                >
                                    {tr('textModal.fieldTitle')} <RequiredMarker />
                                </label>
                                <input
                                    id="text-evidence-title-input"
                                    ref={titleRef}
                                    type="text"
                                    className="input w-full"
                                    required
                                    value={form.title}
                                    onChange={(e) =>
                                        update('title', e.target.value)
                                    }
                                    autoComplete="off"
                                />
                            </div>
                            <FormField label={tr('textModal.linkToControl')}>
                                <Combobox<false, ControlOption>
                                    id="text-evidence-control-select"
                                    name="controlId"
                                    options={controlOptions}
                                    selected={
                                        controlOptions.find(
                                            (o) => o.value === form.controlId,
                                        ) ?? null
                                    }
                                    setSelected={(option) =>
                                        update('controlId', option?.value ?? '')
                                    }
                                    placeholder={tr('textModal.controlPlaceholder')}
                                    searchPlaceholder={tr('textModal.searchControls')}
                                    emptyState={tr('textModal.noControlsMatch')}
                                    matchTriggerWidth
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>
                            <div>
                                <label
                                    className="mb-1 block text-sm text-content-default"
                                    htmlFor="text-evidence-owner-input"
                                >
                                    {tr('textModal.fieldOwner')}
                                </label>
                                <input
                                    id="text-evidence-owner-input"
                                    type="text"
                                    className="input w-full"
                                    value={form.owner}
                                    onChange={(e) =>
                                        update('owner', e.target.value)
                                    }
                                    autoComplete="off"
                                />
                            </div>
                            <div>
                                <label
                                    className="mb-1 block text-sm text-content-default"
                                    htmlFor="text-evidence-category-input"
                                >
                                    {tr('textModal.fieldCategory')}
                                </label>
                                <input
                                    id="text-evidence-category-input"
                                    type="text"
                                    className="input w-full"
                                    value={form.category}
                                    onChange={(e) =>
                                        update('category', e.target.value)
                                    }
                                    autoComplete="off"
                                />
                            </div>
                        </div>
                        {/* B8 follow-up — Folder. Free text with a
                            datalist that suggests folders already
                            in use on the loaded evidence so users
                            converge on a small named set without
                            being forced into one. */}
                        <div>
                            <label
                                className="mb-1 block text-sm text-content-default"
                                htmlFor="text-evidence-folder-input"
                            >
                                {tr('textModal.folderLabel')} <span className="text-content-subtle font-normal">{tr('textModal.folderOptional')}</span>
                            </label>
                            <input
                                id="text-evidence-folder-input"
                                data-testid="text-evidence-folder-input"
                                type="text"
                                className="input w-full"
                                placeholder={tr('textModal.folderPlaceholder')}
                                list="evidence-folder-suggestions"
                                value={form.folder}
                                onChange={(e) =>
                                    update('folder', e.target.value)
                                }
                                autoComplete="off"
                            />
                        </div>
                        <div>
                            <label
                                className="mb-1 block text-sm text-content-default"
                                htmlFor="text-evidence-content-input"
                            >
                                {tr('textModal.fieldContent')}
                            </label>
                            <textarea
                                id="text-evidence-content-input"
                                className="input w-full"
                                rows={4}
                                value={form.content}
                                onChange={(e) =>
                                    update('content', e.target.value)
                                }
                                placeholder={tr('textModal.contentPlaceholder')}
                            />
                        </div>
                    </fieldset>
                </Modal.Body>

                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="text-evidence-cancel-btn"
                        onClick={() => {
                            if (!mutation.isPending) close();
                        }}
                        disabled={mutation.isPending}
                    >
                        {tr('textModal.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="create-text-evidence-btn"
                        disabled={!canSubmit}
                    >
                        {mutation.isPending ? tr('textModal.creating') : tr('textModal.addEvidence')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
