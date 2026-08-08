'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked as follow-up. */
/**
 * Epic 54 — Control quick-inspect / edit Sheet.
 *
 * Side-panel detail view for the common-case inspect + edit flow on the
 * Controls list. The full control detail page (`/controls/[controlId]`)
 * keeps ownership of the deep tabs (evidence, tasks, related, applicability
 * workflows) — this Sheet is the *fast* contextual path that replaces
 * full-page navigation for routine edits: name, description, intent,
 * category, frequency, owner. The list stays visible behind the Sheet so
 * filters, scroll position, and pagination survive the edit.
 *
 * Business behaviour is identical to the legacy modal on the detail page:
 *   - PATCH /controls/:id with name/description/intent/category/frequency.
 *   - POST  /controls/:id/owner when the owner actually changed.
 *   - Success → invalidate controls.all(tenantSlug) so the list reflects
 *     the new name/owner immediately, then close the Sheet.
 *
 * The Sheet is a "edit-first" model: fields are rendered as standard
 * inputs pre-populated with the current values, plus a small read-only
 * summary card (code / annex / status / applicability) so users keep
 * context of what they're editing. Status + applicability have their
 * own dedicated pills on the list row (Epic 52) so editing them is
 * intentionally not inlined here — keeps this surface focused and
 * avoids re-implementing the justification modal.
 */

import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Sheet } from '@/components/ui/sheet';
import { Button, buttonVariants } from '@/components/ui/button';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { UserCombobox } from '@/components/ui/user-combobox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { RequiredMarker } from '@/components/ui/required-marker';
import { queryKeys } from '@/lib/queryKeys';
import { extractMutationError } from '@/lib/mutations';

// ─── Types ──────────────────────────────────────────────────────────

interface ControlDetailResponse {
    id: string;
    code: string | null;
    name: string;
    description: string | null;
    intent: string | null;
    category: string | null;
    frequency: string | null;
    status: string;
    applicability: string;
    ownerUserId: string | null;
    owner: { id: string; name: string | null; email: string | null } | null;
}

type EditForm = {
    name: string;
    description: string;
    intent: string;
    category: string;
    frequency: string;
    owner: string;
};

// ─── Static labels (match the existing detail page) ─────────────────

const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    NOT_STARTED: 'neutral',
    PLANNED: 'info',
    IN_PROGRESS: 'info',
    IMPLEMENTING: 'info',
    IMPLEMENTED: 'success',
    NEEDS_REVIEW: 'warning',
    NOT_APPLICABLE: 'neutral',
};

const FREQUENCY_OPTIONS: ComboboxOption[] = [
    { value: 'AD_HOC', label: 'Ad Hoc' },
    { value: 'DAILY', label: 'Daily' },
    { value: 'WEEKLY', label: 'Weekly' },
    { value: 'MONTHLY', label: 'Monthly' },
    { value: 'QUARTERLY', label: 'Quarterly' },
    { value: 'ANNUALLY', label: 'Annually' },
];

const CATEGORY_OPTIONS: ComboboxOption[] = [
    { value: 'Access Control', label: 'Access Control' },
    { value: 'Encryption', label: 'Encryption' },
    { value: 'Network Security', label: 'Network Security' },
    { value: 'Physical Security', label: 'Physical Security' },
    { value: 'HR Security', label: 'HR Security' },
    { value: 'Operations', label: 'Operations' },
    { value: 'Compliance', label: 'Compliance' },
    { value: 'Incident Management', label: 'Incident Management' },
    { value: 'Business Continuity', label: 'Business Continuity' },
    { value: 'Other', label: 'Other' },
];

// ─── Props ──────────────────────────────────────────────────────────

export interface ControlDetailSheetProps {
    /** Open when non-null; the value is the control id being edited. */
    controlId: string | null;
    setControlId: Dispatch<SetStateAction<string | null>>;
    tenantSlug: string;
    /** Helper to build tenant-scoped API URLs. */
    apiUrl: (path: string) => string;
    /** Helper to build tenant-scoped app URLs (for "Open full detail"). */
    tenantHref: (path: string) => string;
    /** Gate the edit controls behind the caller's write permission. */
    canWrite: boolean;
}

// ─── Component ──────────────────────────────────────────────────────

export function ControlDetailSheet({
    controlId,
    setControlId,
    tenantSlug,
    apiUrl,
    tenantHref,
    canWrite,
}: ControlDetailSheetProps) {
    const t = useTranslations('controls');
    const open = controlId !== null;
    const queryClient = useQueryClient();
    const nameInputRef = useRef<HTMLInputElement>(null);

    // ── Load the control ──
    const detailQuery = useQuery<ControlDetailResponse>({
        queryKey: controlId
            ? queryKeys.controls.detail(tenantSlug, controlId)
            : ['control-sheet', 'idle'],
        queryFn: async () => {
            const res = await fetch(apiUrl(`/controls/${controlId}`));
            if (!res.ok) throw new Error('Failed to load control');
            return res.json();
        },
        enabled: open,
        // Keep any cache written by the full detail page; this Sheet and
        // that page share the same query key so edits propagate both ways.
        staleTime: 30_000,
    });

    const control = detailQuery.data;

    // ── Local edit state, seeded from server data on each (re)open ──
    const [form, setForm] = useState<EditForm>({
        name: '',
        description: '',
        intent: '',
        category: '',
        frequency: '',
        owner: '',
    });
    const [dirty, setDirty] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!control) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({
            name: control.name || '',
            description: control.description || '',
            intent: control.intent || '',
            category: control.category || '',
            frequency: control.frequency || '',
            owner: control.ownerUserId || '',
        });
        setDirty(false);
        setError('');
    }, [control?.id, control?.name, control?.description, control?.intent, control?.category, control?.frequency, control?.ownerUserId]);

    // Focus the name input shortly after open so users can start typing.
    useEffect(() => {
        if (!open || !control) return;
        const t = setTimeout(() => nameInputRef.current?.focus(), 80);
        return () => clearTimeout(t);
    }, [open, control?.id]);

    const update = (field: keyof EditForm, value: string) => {
        setForm((prev) => ({ ...prev, [field]: value }));
        setDirty(true);
    };

    // ── Mutation: save edits ──
    const mutation = useMutation({
        mutationFn: async (draft: EditForm) => {
            if (!controlId) throw new Error('No control selected');
            const res = await fetch(apiUrl(`/controls/${controlId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: draft.name.trim(),
                    description: draft.description.trim() || null,
                    intent: draft.intent.trim() || null,
                    category: draft.category.trim() || null,
                    frequency: draft.frequency || null,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(extractMutationError(data, 'Update failed'));
            }
            // Owner lives on a dedicated endpoint — only fire when it changed.
            const originalOwner = control?.ownerUserId || '';
            if (draft.owner.trim() !== originalOwner) {
                const ownerRes = await fetch(apiUrl(`/controls/${controlId}/owner`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ownerUserId: draft.owner.trim() || null }),
                });
                if (!ownerRes.ok) {
                    const data = await ownerRes.json().catch(() => ({}));
                    throw new Error(extractMutationError(data, 'Owner update failed'));
                }
            }
            return draft;
        },
        onSuccess: () => {
            // Refresh the list (so the new name / owner show without a full
            // refetch wait) and the detail cache (so if the user opens the
            // full detail page next, it's pre-warmed).
            queryClient.invalidateQueries({ queryKey: queryKeys.controls.all(tenantSlug) });
            setControlId(null);
        },
        onError: (err) => {
            setError(err instanceof Error ? err.message : 'Update failed');
        },
    });

    const canSave = canWrite && dirty && form.name.trim().length >= 3 && !mutation.isPending;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSave) return;
        setError('');
        mutation.mutate(form);
    };

    // Guard against dropping unsaved edits on accidental close.
    const handleOpenChange = (next: boolean) => {
        if (next) return;
        if (dirty && !mutation.isPending) {
            const ok = typeof window !== 'undefined'
                ? window.confirm('Discard unsaved changes?')
                : true;
            if (!ok) return;
        }
        setControlId(null);
    };

    // ── Summary chips (read-only context) ──
    const summary = useMemo(() => {
        if (!control) return [] as { label: string; value: string; badge?: StatusBadgeVariant }[];
        const rows: { label: string; value: string; badge?: StatusBadgeVariant }[] = [];
        if (control.code) {
            rows.push({ label: t('sheet.labelCode'), value: control.code || '—' });
        }
        rows.push({
            label: t('sheet.labelStatus'),
            value: control.status.replace(/_/g, ' '),
            badge: STATUS_BADGE[control.status] || 'neutral',
        });
        rows.push({
            label: t('sheet.labelApplicability'),
            value: control.applicability === 'NOT_APPLICABLE' ? 'N/A' : 'Yes',
            badge: control.applicability === 'NOT_APPLICABLE' ? 'warning' : 'success',
        });
        if (control.owner?.name) {
            rows.push({ label: t('sheet.labelOwner'), value: control.owner.name });
        }
        return rows;
    }, [control, t]);

    return (
        <Sheet
            open={open}
            onOpenChange={handleOpenChange}
            size="md"
            title={control?.name ?? t('sheet.detailTitle')}
            description={control?.description ?? undefined}
        >
            {detailQuery.isLoading || !control ? (
                <>
                    <Sheet.Header title={t('sheet.loading')} />
                    <Sheet.Body>
                        <div className="flex h-40 items-center justify-center text-sm text-content-muted">
                            {t('sheet.loadingBody')}
                        </div>
                    </Sheet.Body>
                </>
            ) : detailQuery.isError ? (
                <>
                    <Sheet.Header title={t('sheet.controlTitle')} />
                    <Sheet.Body>
                        <div
                            className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            role="alert"
                            data-testid="control-sheet-error"
                        >
                            {detailQuery.error instanceof Error
                                ? detailQuery.error.message
                                : t('sheet.loadFailed')}
                        </div>
                    </Sheet.Body>
                </>
            ) : (
                <>
                    <Sheet.Header
                        title={control.name}
                        description={control.code || undefined}
                    />
                    <form
                        onSubmit={handleSubmit}
                        className="flex flex-1 flex-col overflow-hidden"
                        data-testid="control-sheet-form"
                    >
                        <Sheet.Body>
                            {/* Read-only summary */}
                            <section
                                className="mb-5 grid grid-cols-2 gap-compact rounded-lg border border-border-subtle bg-bg-subtle px-4 py-3"
                                data-testid="control-sheet-summary"
                            >
                                {summary.map((row) => (
                                    <div key={row.label} className="flex flex-col gap-0.5">
                                        <span className="text-xs uppercase tracking-wide text-content-muted">
                                            {row.label}
                                        </span>
                                        {row.badge ? (
                                            <StatusBadge variant={row.badge} className="w-fit">
                                                {row.value}
                                            </StatusBadge>
                                        ) : (
                                            <span className="text-sm text-content-emphasis">
                                                {row.value}
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </section>

                            {error && (
                                <div
                                    className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                                    role="alert"
                                    data-testid="control-sheet-save-error"
                                >
                                    {error}
                                </div>
                            )}

                            <fieldset className="space-y-default" disabled={!canWrite || mutation.isPending}>
                                <div>
                                    <label
                                        className="mb-1 block text-sm text-content-default"
                                        htmlFor="sheet-name-input"
                                    >
                                        {t('sheet.name')} <RequiredMarker />
                                    </label>
                                    <input
                                        id="sheet-name-input"
                                        ref={nameInputRef}
                                        type="text"
                                        className="input w-full"
                                        data-testid="sheet-name-input"
                                        value={form.name}
                                        onChange={(e) => update('name', e.target.value)}
                                        required
                                        minLength={3}
                                    />
                                </div>
                                <div>
                                    <label
                                        className="mb-1 block text-sm text-content-default"
                                        htmlFor="sheet-description-input"
                                    >
                                        {t('sheet.description')}
                                    </label>
                                    <textarea
                                        id="sheet-description-input"
                                        className="input w-full"
                                        rows={3}
                                        value={form.description}
                                        onChange={(e) => update('description', e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label
                                        className="mb-1 block text-sm text-content-default"
                                        htmlFor="sheet-intent-input"
                                    >
                                        {t('sheet.intent')}
                                    </label>
                                    <textarea
                                        id="sheet-intent-input"
                                        className="input w-full"
                                        rows={2}
                                        value={form.intent}
                                        onChange={(e) => update('intent', e.target.value)}
                                    />
                                </div>
                                <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                    <div>
                                        <label
                                            className="mb-1 block text-sm text-content-default"
                                            htmlFor="sheet-category-input"
                                        >
                                            {t('sheet.category')}
                                        </label>
                                        <Combobox
                                            id="sheet-category-input"
                                            name="category"
                                            options={CATEGORY_OPTIONS}
                                            selected={CATEGORY_OPTIONS.find(o => o.value === form.category) ?? null}
                                            setSelected={(o) => update('category', o?.value ?? '')}
                                            placeholder="—"
                                            searchPlaceholder={t('sheet.searchCategories')}
                                            disabled={!canWrite}
                                            matchTriggerWidth
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    </div>
                                    <div>
                                        <label
                                            className="mb-1 block text-sm text-content-default"
                                            htmlFor="sheet-frequency-input"
                                        >
                                            {t('sheet.frequency')}
                                        </label>
                                        <Combobox
                                            id="sheet-frequency-input"
                                            name="frequency"
                                            options={FREQUENCY_OPTIONS}
                                            selected={FREQUENCY_OPTIONS.find(o => o.value === form.frequency) ?? null}
                                            setSelected={(o) => update('frequency', o?.value ?? '')}
                                            placeholder="—"
                                            disabled={!canWrite}
                                            hideSearch
                                            matchTriggerWidth
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    </div>
                                </div>
                                <FormField
                                    label={t('sheet.owner')}
                                    description={t('sheet.ownerHelp')}
                                >
                                    <UserCombobox
                                        id="sheet-owner-input"
                                        name="ownerUserId"
                                        tenantSlug={tenantSlug}
                                        disabled={!canWrite}
                                        selectedId={form.owner || null}
                                        onChange={(userId) =>
                                            update('owner', userId ?? '')
                                        }
                                        placeholder={
                                            control.owner?.name ||
                                            control.owner?.email ||
                                            t('sheet.unassigned')
                                        }
                                    />
                                </FormField>
                            </fieldset>
                        </Sheet.Body>
                        <Sheet.Actions align="between">
                            <Link
                                href={tenantHref(`/controls/${control.id}`)}
                                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                                data-testid="control-sheet-open-full"
                                onClick={() => setControlId(null)}
                            >
                                {t('sheet.openFull')}
                            </Link>
                            <div className="flex items-center gap-tight">
                                <Sheet.Close asChild>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        data-testid="control-sheet-cancel"
                                        text={t('sheet.cancel')}
                                    />
                                </Sheet.Close>
                                <Button
                                    type="submit"
                                    variant="primary"
                                    size="sm"
                                    data-testid="control-sheet-save"
                                    disabled={!canSave}
                                    text={mutation.isPending ? t('sheet.saving') : t('sheet.saveChanges')}
                                />
                            </div>
                        </Sheet.Actions>
                    </form>
                </>
            )}
        </Sheet>
    );
}
