'use client';

import { formatDate, formatDateTime } from '@/lib/format-date';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { textLinkVariants } from '@/components/ui/typography';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { DataTable, createColumns } from '@/components/ui/table';
import {
    EntityPicker,
    type EntityPickerKind,
} from '@/components/ui/entity-picker';
import { useToastWithUndo } from '@/components/ui/hooks';
import { SkeletonLine } from '@/components/ui/skeleton';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { UserCombobox } from '@/components/ui/user-combobox';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { FieldOperationPanel } from '@/components/ui/map/FieldOperationPanel';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { toYMD } from '@/components/ui/date-picker/date-utils';
import { CopyText } from '@/components/ui/copy-text';
import { TERMINAL_WORK_ITEM_STATUSES } from '@/app-layer/domain/work-item-status';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { MetaStrip } from '@/components/ui/meta-strip';
import {
    TASK_STATUS_VARIANT,
    TASK_SEVERITY_VARIANT,
} from '@/app-layer/domain/entity-status-mapping';
import { cardVariants } from '@/components/ui/card';
// Shared evidence sub-table — lives under the control detail route's `_tabs/`
// (kept there so existing guard exemptions + a unit test keyed on that path
// stay valid). Imported here via the `@/app` alias.
import { EvidenceSubTable } from '@/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/EvidenceSubTable';
import { EvidenceAddForm } from '@/components/EvidenceAddForm';
import { Pen2, CircleCheck, Trash } from '@/components/ui/icons/nucleo';
import { cn } from '@/lib/cn';
import { useTranslations } from 'next-intl';
import {
    FARM_TASK_TYPES,
    FARM_TASK_CATEGORIES,
    getFarmTaskType,
} from '@/lib/agriculture/farm-task-types';

// Farm task detail — the SINGLE task-detail destination in the app (the
// compliance /tasks/[taskId] page was retired). It reuses the whole shared
// task API surface (GET/PATCH/DELETE /tasks/{id}, …/status, …/assign,
// …/comments, …/evidence, …/links, …/activity) unchanged, so it renders any
// Task — a FARM_TASK / FIELD_OPERATION, or a legacy compliance row reached
// from a repointed deep-link. Farm-first: the header leads with the field-work
// catalog type; severity / control / audit fields only surface when the row
// actually carries them.
const ENTITY_TYPE_OPTIONS = ['CONTROL', 'ASSET', 'EVIDENCE', 'FRAMEWORK_REQUIREMENT', 'LOCATION', 'PARCEL', 'EQUIPMENT'];
const RELATION_OPTIONS = ['RELATES_TO', 'CAUSED_BY', 'MITIGATED_BY', 'EVIDENCE_FOR'];
const SELECTABLE_STATUSES = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED', 'CLOSED', 'CANCELED'];
// Statuses a task can legally move to RESOLVED from (BLOCKED must be unblocked
// first — see WORK_ITEM_TRANSITIONS). "Mark done" is only offered from these.
const DONE_FROM_STATUSES = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'PENDING_REVIEW'];
const PRIORITY_VALUES = ['P0', 'P1', 'P2', 'P3'];

// Farm-task type picker options, grouped by category (catalog order).
const TYPE_BY_VALUE = new Map(FARM_TASK_TYPES.map((ty) => [ty.key, ty]));
const FARM_TYPE_OPTIONS: ComboboxOption[] = FARM_TASK_CATEGORIES.flatMap((cat) =>
    FARM_TASK_TYPES.filter((ty) => ty.category === cat).map((ty) => ({
        value: ty.key,
        label: ty.name,
    })),
);

type Tab = 'overview' | 'evidence' | 'links' | 'comments' | 'activity';

interface EditFarmTaskForm {
    title: string;
    description: string;
    priority: string;
    dueAt: string;
    farmTaskType: string;
}

export function FarmTaskDetailClient({
    tenantSlug,
    taskId,
    currentUserId,
}: {
    tenantSlug: string;
    taskId: string;
    currentUserId: string | null;
}) {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions, role } = useTenantContext();
    const triggerUndoToast = useToastWithUndo();
    const t = useTranslations('tasks.detail');
    const tf = useTranslations('farmTasks');
    const te = useTranslations('taskEnums');
    const statusLabel = (s: string) => (te.has(`status.${s}`) ? te(`status.${s}`) : s);
    const typeLabel = (ty: string) => (te.has(`type.${ty}`) ? te(`type.${ty}`) : ty);
    const severityLabel = (s: string) => (te.has(`severity.${s}`) ? te(`severity.${s}`) : s);
    const priorityLabel = (p: string) => (te.has(`priority.${p}`) ? te(`priority.${p}`) : p);
    const categoryLabel = (c: string) => (te.has(`category.${c}`) ? te(`category.${c}`) : c);
    const actionLabel = (a: string) => (te.has(`action.${a}`) ? te(`action.${a}`) : a.replace(/_/g, ' '));
    const relationLabel = (r: string) => (te.has(`relation.${r}`) ? te(`relation.${r}`) : r.replace(/_/g, ' '));
    const entityTypeLabel = (et: string) => (te.has(`entityType.${et}`) ? te(`entityType.${et}`) : et.replace(/_/g, ' '));
    const ENTITY_TYPE_CB_OPTIONS: ComboboxOption[] = ENTITY_TYPE_OPTIONS.map((et) => ({ value: et, label: entityTypeLabel(et) }));
    const RELATION_CB_OPTIONS: ComboboxOption[] = RELATION_OPTIONS.map((r) => ({ value: r, label: relationLabel(r) }));
    const TASK_STATUS_CB_OPTIONS: ComboboxOption[] = SELECTABLE_STATUSES.map((val) => ({ value: val, label: statusLabel(val) }));
    const PRIORITY_CB_OPTIONS: ComboboxOption[] = PRIORITY_VALUES.map((p) => ({ value: p, label: priorityLabel(p) }));

    const [tab, setTab] = useState<Tab>('overview');

    // Status-change flags + terminal resolution prompt.
    const [changingStatus, setChangingStatus] = useState(false);
    const [pendingTerminalStatus, setPendingTerminalStatus] = useState<string | null>(null);
    const [resolutionDraft, setResolutionDraft] = useState('');
    const [statusError, setStatusError] = useState('');
    const [assigning, setAssigning] = useState(false);
    const [assigneeDraft, setAssigneeDraft] = useState<string | null | undefined>(undefined);

    // Link form state.
    const [showLinkForm, setShowLinkForm] = useState(false);
    const [linkEntityType, setLinkEntityType] = useState('LOCATION');
    const [linkEntityId, setLinkEntityId] = useState('');
    const [linkRelation, setLinkRelation] = useState('RELATES_TO');
    const [savingLink, setSavingLink] = useState(false);

    // Evidence form state.
    const [showEvidenceForm, setShowEvidenceForm] = useState(false);
    const [evidenceUrl, setEvidenceUrl] = useState('');
    const [evidenceNote, setEvidenceNote] = useState('');
    const [fileToUpload, setFileToUpload] = useState<File | null>(null);
    const [fileUploadTitle, setFileUploadTitle] = useState('');
    const [evidenceError, setEvidenceError] = useState('');
    const [savingEvidence, setSavingEvidence] = useState(false);
    const fileUploadRef = useRef<HTMLInputElement>(null);

    // Comment form state.
    const [commentBody, setCommentBody] = useState('');
    const [savingComment, setSavingComment] = useState(false);

    // Edit-task modal state (farm-flavoured: title / notes / priority / due /
    // field-work type). Severity + compliance type are not edited here.
    const [showEditModal, setShowEditModal] = useState(false);
    const [editForm, setEditForm] = useState<EditFarmTaskForm>({
        title: '', description: '', priority: 'P2', dueAt: '', farmTaskType: '',
    });
    const [savingEdit, setSavingEdit] = useState(false);
    const [editError, setEditError] = useState('');

    // Delete flow uses the Epic-67 undo-toast convention.
    const [deleted, setDeleted] = useState(false);

    const canComment = role !== 'READER';

    const taskQuery = useTenantSWR<any>(taskId ? `/tasks/${taskId}` : null);
    const task = taskQuery.data ?? null;
    const loading = taskQuery.isLoading;
    const error = taskQuery.error
        ? (taskQuery.error instanceof Error ? taskQuery.error.message : t('notFound'))
        : '';

    const linksQuery = useTenantSWR<any[]>(taskId && tab === 'links' ? `/tasks/${taskId}/links` : null);
    const links = linksQuery.data ?? [];
    const linksLoading = linksQuery.isLoading;

    const evidenceQuery = useTenantSWR<{ links: any[]; evidence: any[] }>(
        taskId && tab === 'evidence' ? `/tasks/${taskId}/evidence` : null,
    );

    const commentsQuery = useTenantSWR<any[]>(taskId && tab === 'comments' ? `/tasks/${taskId}/comments` : null);
    const comments = commentsQuery.data ?? [];
    const commentsLoading = commentsQuery.isLoading;

    const activityQuery = useTenantSWR<any[]>(taskId && tab === 'activity' ? `/tasks/${taskId}/activity` : null);
    const activity = activityQuery.data ?? [];
    const activityLoading = activityQuery.isLoading;

    const assigneeValue: string | null =
        assigneeDraft !== undefined ? assigneeDraft : (task?.assigneeUserId ?? null);

    // Assignee self-serve: an operator assigned to the task can complete it
    // even without general write (mirrors setTaskStatus:320). Managers
    // (OWNER/ADMIN/EDITOR → canWrite) can complete any task.
    const isAssignee = !!currentUserId && task?.assigneeUserId === currentUserId;
    const canComplete = !!permissions.canWrite || isAssignee;

    const requestStatusChange = (status: string) => {
        setStatusError('');
        if ((TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(status)) {
            setResolutionDraft('');
            setPendingTerminalStatus(status);
            return;
        }
        void commitStatus(status, null);
    };

    // Review gate (#6) — approve / request-changes a PENDING_REVIEW field op.
    const [reviewComment, setReviewComment] = useState('');
    const [reviewing, setReviewing] = useState(false);
    const submitReview = async (action: 'APPROVE' | 'REQUEST_CHANGES') => {
        setReviewing(true);
        setStatusError('');
        try {
            const res = await fetch(apiUrl(`/field-operations/${taskId}/review`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, comment: reviewComment.trim() || undefined }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((typeof data?.error === 'string' && data.error) || data?.message || 'Review failed');
            }
            setReviewComment('');
            await taskQuery.mutate();
        } catch (e) {
            setStatusError(e instanceof Error ? e.message : 'Review failed');
        } finally {
            setReviewing(false);
        }
    };

    const commitStatus = async (status: string, resolution: string | null) => {
        setChangingStatus(true);
        setStatusError('');
        try {
            await taskQuery.mutate((cur: any) => (cur ? { ...cur, status } : cur), { revalidate: false });
            const res = await fetch(apiUrl(`/tasks/${taskId}/status`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(resolution ? { status, resolution } : { status }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((typeof data?.error === 'string' && data.error) || data?.message || 'Failed to change status');
            }
            setPendingTerminalStatus(null);
        } catch (e) {
            setStatusError(e instanceof Error ? e.message : 'Failed to change status');
        } finally {
            setChangingStatus(false);
            await taskQuery.mutate();
        }
    };

    const handleAssign = async () => {
        setAssigning(true);
        const assigneeUserId = assigneeValue || null;
        try {
            await taskQuery.mutate((cur: any) => (cur ? { ...cur, assigneeUserId } : cur), { revalidate: false });
            await fetch(apiUrl(`/tasks/${taskId}/assign`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assigneeUserId }),
            });
        } finally {
            setAssigning(false);
            await taskQuery.mutate();
        }
    };

    const addLink = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!linkEntityId.trim()) return;
        setSavingLink(true);
        try {
            await fetch(apiUrl(`/tasks/${taskId}/links`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: linkEntityType, entityId: linkEntityId, relation: linkRelation }),
            });
            setLinkEntityId('');
            setShowLinkForm(false);
        } finally {
            setSavingLink(false);
            await Promise.all([linksQuery.mutate(), taskQuery.mutate()]);
        }
    };

    // Epic 67 — delayed-commit link removal.
    const removeLink = (linkId: string) => {
        const previous = linksQuery.data ?? [];
        void linksQuery.mutate(previous.filter((l: any) => l.id !== linkId), { revalidate: false });
        triggerUndoToast({
            message: t('linkRemoved'),
            undoMessage: t('undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/tasks/${taskId}/links/${linkId}`), { method: 'DELETE' });
                if (!res.ok) throw new Error('Remove link failed');
            },
            undoAction: () => { void linksQuery.mutate(previous, { revalidate: false }); },
            onError: () => { void linksQuery.mutate(previous, { revalidate: false }); },
        });
    };

    const resetEvidenceForm = () => {
        setEvidenceUrl('');
        setEvidenceNote('');
        setFileToUpload(null);
        setFileUploadTitle('');
        setEvidenceError('');
        if (fileUploadRef.current) fileUploadRef.current.value = '';
        setShowEvidenceForm(false);
    };

    const addEvidence = async (e: React.FormEvent) => {
        e.preventDefault();
        setEvidenceError('');
        if (fileToUpload) {
            setSavingEvidence(true);
            try {
                const formData = new FormData();
                formData.append('file', fileToUpload);
                if (fileUploadTitle) formData.append('title', fileUploadTitle);
                formData.append('taskId', taskId);
                const res = await fetch(apiUrl('/evidence/uploads'), { method: 'POST', body: formData });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
                    throw new Error(err.error || err.message || 'Upload failed');
                }
                resetEvidenceForm();
                await Promise.all([evidenceQuery.mutate(), taskQuery.mutate()]);
            } catch (err: unknown) {
                setEvidenceError(err instanceof Error ? err.message : 'Upload failed');
            } finally {
                setSavingEvidence(false);
            }
            return;
        }
        if (!evidenceUrl.trim()) {
            setEvidenceError(t('chooseFileError'));
            return;
        }
        setSavingEvidence(true);
        try {
            const res = await fetch(apiUrl(`/tasks/${taskId}/evidence`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: evidenceUrl.trim(), note: evidenceNote || undefined }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || err.message || 'Failed to link evidence');
            }
            resetEvidenceForm();
            await Promise.all([evidenceQuery.mutate(), taskQuery.mutate()]);
        } catch (err: unknown) {
            setEvidenceError(err instanceof Error ? err.message : 'Failed to link evidence');
        } finally {
            setSavingEvidence(false);
        }
    };

    // Epic 67 — delayed-commit evidence removal (detach Evidence.taskId).
    const removeEvidence = (evidenceId: string) => {
        const previous = evidenceQuery.data;
        void evidenceQuery.mutate(
            previous ? { ...previous, evidence: (previous.evidence ?? []).filter((ev: any) => ev.id !== evidenceId) } : previous,
            { revalidate: false },
        );
        triggerUndoToast({
            message: t('evidenceRemoved'),
            undoMessage: t('undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/tasks/${taskId}/evidence/${evidenceId}`), { method: 'DELETE' });
                if (!res.ok) throw new Error('Remove evidence failed');
                await Promise.all([evidenceQuery.mutate(), taskQuery.mutate()]);
            },
            undoAction: () => { void evidenceQuery.mutate(previous, { revalidate: false }); },
            onError: () => { void evidenceQuery.mutate(previous, { revalidate: false }); },
        });
    };

    const openEditModal = () => {
        if (!task) return;
        setEditError('');
        setEditForm({
            title: task.title ?? '',
            description: task.description ?? '',
            priority: task.priority ?? 'P2',
            dueAt: task.dueAt ? toYMD(new Date(task.dueAt)) ?? '' : '',
            farmTaskType: task.metadataJson?.farmTaskType ?? '',
        });
        setShowEditModal(true);
    };

    const handleEditSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSavingEdit(true);
        setEditError('');
        try {
            const typeDef = editForm.farmTaskType ? getFarmTaskType(editForm.farmTaskType) : null;
            const body: Record<string, unknown> = {
                title: editForm.title,
                description: editForm.description || null,
                priority: editForm.priority,
                dueAt: editForm.dueAt ? new Date(editForm.dueAt).toISOString() : null,
            };
            // Only farm tasks carry a catalog type in metadataJson; preserve it
            // (and its category) on save. Compliance rows leave metadata alone.
            if (typeDef) body.metadataJson = { farmTaskType: typeDef.key, farmTaskCategory: typeDef.category };
            const res = await fetch(apiUrl(`/tasks/${taskId}`), {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((typeof data?.error === 'string' && data.error) || data?.message || 'Failed to save task');
            }
            setShowEditModal(false);
            await taskQuery.mutate();
        } catch (err) {
            setEditError(err instanceof Error ? err.message : 'Failed to save task');
        } finally {
            setSavingEdit(false);
        }
    };

    // Epic 67 — delayed-commit delete. The row is optimistically hidden (the
    // page shows an empty state); Undo restores it, commit navigates away.
    const handleDelete = () => {
        setDeleted(true);
        triggerUndoToast({
            message: tf('detail.deleted'),
            undoMessage: t('undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/tasks/${taskId}`), { method: 'DELETE' });
                if (!res.ok) throw new Error('Delete failed');
            },
            undoAction: () => setDeleted(false),
            onError: () => setDeleted(false),
            onCommit: () => { window.location.href = tenantHref('/farm-tasks'); },
        });
    };

    const addComment = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!commentBody.trim()) return;
        setSavingComment(true);
        try {
            await fetch(apiUrl(`/tasks/${taskId}/comments`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body: commentBody }),
            });
            setCommentBody('');
        } finally {
            setSavingComment(false);
            await Promise.all([commentsQuery.mutate(), taskQuery.mutate()]);
        }
    };

    const breadcrumbs = [
        { label: t('dashboard'), href: tenantHref('/dashboard') },
        { label: tf('breadcrumb'), href: tenantHref('/farm-tasks') },
        { label: task?.title ?? t('taskFallback') },
    ];
    if (loading) {
        return <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}><></></EntityDetailLayout>;
    }
    if (error) {
        return <EntityDetailLayout error={error} title="" breadcrumbs={breadcrumbs}><></></EntityDetailLayout>;
    }
    if (!task || deleted) {
        return <EntityDetailLayout empty={{ message: t('notFound') }} title="" breadcrumbs={breadcrumbs}><></></EntityDetailLayout>;
    }

    const tabs: { key: Tab; label: string; count?: number }[] = [
        { key: 'overview', label: t('tabOverview') },
        { key: 'evidence', label: t('tabEvidence'), count: evidenceQuery.data?.evidence?.length ?? task._count?.evidence },
        { key: 'links', label: t('tabLinks'), count: task._count?.links ?? links.length },
        { key: 'comments', label: t('tabComments'), count: task._count?.comments ?? comments.length },
        { key: 'activity', label: t('tabActivity') },
    ];

    const isOverdue = task.dueAt && new Date(task.dueAt) < new Date() && !(TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(task.status);
    const metadata = task.metadataJson || {};
    const isFarmTask = task.type === 'FARM_TASK' || task.type === 'FIELD_OPERATION';
    const farmTypeDef = metadata.farmTaskType ? getFarmTaskType(metadata.farmTaskType) : undefined;
    const farmTypeName = farmTypeDef?.name ?? (metadata.farmTaskType as string | undefined);
    const canMarkDone = canComplete && DONE_FROM_STATUSES.includes(task.status);

    return (
        <EntityDetailLayout
            id="task-detail-page"
            breadcrumbs={breadcrumbs}
            title={<span id="task-title">{task.title}</span>}
            meta={
                <MetaStrip
                    items={[
                        ...(task.key
                            ? [{
                                  label: t('metaKey'),
                                  value: (
                                      <CopyText
                                          value={task.key}
                                          label={t('copyTaskKey', { key: task.key })}
                                          successMessage={t('taskKeyCopied')}
                                          className="text-xs text-content-subtle"
                                      >
                                          {task.key}
                                      </CopyText>
                                  ),
                              } as const]
                            : []),
                        {
                            kind: 'status' as const,
                            id: 'task-status',
                            label: t('metaStatus'),
                            value: statusLabel(task.status),
                            variant: TASK_STATUS_VARIANT[task.status] ?? 'neutral',
                        },
                        // Farm rows lead with the field-work type; compliance
                        // rows keep the severity pill they were triaged with.
                        ...(isFarmTask && farmTypeName
                            ? [{ label: tf('detail.fieldWorkType'), value: farmTypeName } as const]
                            : [{
                                  kind: 'status' as const,
                                  id: 'task-severity',
                                  label: t('metaSeverity'),
                                  value: severityLabel(task.severity),
                                  variant: TASK_SEVERITY_VARIANT[task.severity] ?? 'neutral',
                              } as const]),
                        { label: t('metaType'), value: typeLabel(task.type) },
                        ...(isOverdue
                            ? [{ kind: 'status' as const, label: t('metaSla'), value: t('overdue'), variant: 'error' as const }]
                            : []),
                    ]}
                />
            }
            actions={
                <div className="flex items-center gap-compact">
                    {canMarkDone && (
                        <Button
                            variant="primary"
                            icon={<CircleCheck className="size-4" />}
                            onClick={() => requestStatusChange('RESOLVED')}
                            disabled={changingStatus}
                            id="mark-done-btn"
                        >
                            {tf('detail.markDone')}
                        </Button>
                    )}
                    {permissions.canWrite && (
                        <Combobox
                            hideSearch
                            id="task-status-select"
                            selected={TASK_STATUS_CB_OPTIONS.find(o => o.value === task.status) ?? null}
                            setSelected={(opt) => { if (opt) requestStatusChange(opt.value); }}
                            options={TASK_STATUS_CB_OPTIONS}
                            disabled={changingStatus}
                            placeholder={t('statusPlaceholder')}
                            buttonProps={{ className: 'text-sm' }}
                        />
                    )}
                </div>
            }
            tabs={tabs}
            activeTab={tab}
            onTabChange={(next) => setTab(next as Tab)}
        >
            {/* Assignment controls */}
            {permissions.canWrite && (
                <div className={cardVariants({ density: 'compact' })}>
                    <div className="flex items-center gap-compact flex-wrap">
                        <span className="text-sm text-content-muted">{t('assigneeLabel')}</span>
                        <span className="text-sm text-content-emphasis font-medium" id="task-assignee">
                            {task.assignee?.name || task.assigneeUserId || t('unassigned')}
                        </span>
                        <div className="w-64">
                            <UserCombobox
                                id="task-assignee-input"
                                name="assigneeUserId"
                                tenantSlug={tenantSlug}
                                selectedId={assigneeValue}
                                onChange={(userId) => setAssigneeDraft(userId ?? null)}
                                placeholder={t('unassigned')}
                                forceDropdown={false}
                            />
                        </div>
                        <Button variant="secondary" onClick={handleAssign} disabled={assigning} id="assign-task-btn">
                            {assigning ? t('saving') : t('assign')}
                        </Button>
                    </div>
                </div>
            )}

            {/* Overview Tab */}
            {tab === 'overview' && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    {task.type === 'FIELD_OPERATION' && (
                        <div className="border-b border-border-subtle pb-section">
                            <Heading level={3} className="mb-3">{t('fieldOperation')}</Heading>
                            <FieldOperationPanel taskId={task.id} />
                            {task.status === 'PENDING_REVIEW' && permissions.canAdmin && (
                                <div className="mt-default space-y-default rounded-lg border border-border-emphasis bg-bg-subtle p-4">
                                    <p className="text-sm font-medium text-content-emphasis">{t('review.title')}</p>
                                    <p className="text-xs text-content-muted">{t('review.hint')}</p>
                                    <FormField label={t('review.commentLabel')}>
                                        <textarea
                                            value={reviewComment}
                                            onChange={(e) => setReviewComment(e.target.value)}
                                            rows={2}
                                            className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-1.5 text-sm"
                                            placeholder={t('review.commentPlaceholder')}
                                        />
                                    </FormField>
                                    <div className="flex gap-compact">
                                        <Button variant="primary" size="sm" loading={reviewing} onClick={() => submitReview('APPROVE')} id="review-approve-btn">
                                            {t('review.approve')}
                                        </Button>
                                        <Button variant="secondary" size="sm" disabled={reviewing} onClick={() => submitReview('REQUEST_CHANGES')} id="review-request-changes-btn">
                                            {t('review.requestChanges')}
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                    {permissions.canWrite && (
                        <div className="flex justify-end gap-compact -mt-1 -mb-2">
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={openEditModal}
                                data-testid="task-edit-button"
                                id="task-edit-button"
                                aria-label={tf('detail.editTask')}
                                title={tf('detail.editTask')}
                            >
                                <Pen2 className="size-4" />
                            </Button>
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={handleDelete}
                                data-testid="task-delete-button"
                                id="task-delete-button"
                                aria-label={tf('detail.deleteTask')}
                                title={tf('detail.deleteTask')}
                            >
                                <Trash className="size-4 text-content-error" />
                            </Button>
                        </div>
                    )}
                    <div className="grid grid-cols-2 gap-section">
                        <div className="col-span-2">
                            <span className="text-xs text-content-subtle uppercase">{t('description')}</span>
                            <p className="text-sm text-content-default mt-1 whitespace-pre-wrap">{task.description || t('noDescription')}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{isFarmTask ? tf('detail.fieldWorkType') : t('type')}</span>
                            <p className="text-sm text-content-default mt-1">
                                {isFarmTask && farmTypeName
                                    ? (farmTypeDef ? `${farmTypeName} · ${categoryLabel(farmTypeDef.category)}` : farmTypeName)
                                    : typeLabel(task.type)}
                            </p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('priority')}</span>
                            <p className="text-sm text-content-default mt-1">{priorityLabel(task.priority)}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('assignee')}</span>
                            <p className="text-sm text-content-default mt-1">{task.assignee?.name || '—'}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('reporter')}</span>
                            <p className="text-sm text-content-default mt-1">{task.createdBy?.name || '—'}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('dueDate')}</span>
                            <p className="text-sm text-content-default mt-1">{task.dueAt ? formatDate(task.dueAt) : '—'}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('created')}</span>
                            <p className="text-sm text-content-default mt-1">{formatDateTime(task.createdAt)}</p>
                        </div>
                        {task.control && (
                            <div>
                                <span className="text-xs text-content-subtle uppercase">{t('control')}</span>
                                <p className="text-sm mt-1">
                                    <Link href={tenantHref(`/controls/${task.control.id}`)} className={textLinkVariants({ tone: 'link' })} id="task-control-link">
                                        {task.control.code} — {task.control.name}
                                    </Link>
                                </p>
                            </div>
                        )}
                        {task.completedAt && (
                            <div>
                                <span className="text-xs text-content-subtle uppercase">{t('completedAt')}</span>
                                <p className="text-sm text-content-success mt-1">{formatDateTime(task.completedAt)}</p>
                            </div>
                        )}
                        {task.resolution && (
                            <div className="col-span-2">
                                <span className="text-xs text-content-subtle uppercase">{t('resolution')}</span>
                                <p className="text-sm text-content-default mt-1 whitespace-pre-wrap">{task.resolution}</p>
                            </div>
                        )}
                    </div>

                    {(task.type === 'AUDIT_FINDING' || task.type === 'CONTROL_GAP') && (metadata.findingSource || metadata.controlGapType) && (
                        <div className="border-t border-border-default pt-4 mt-4">
                            <Heading level={3} className="mb-3">{t('auditDetails')}</Heading>
                            <div className="grid grid-cols-2 gap-default">
                                {metadata.findingSource && (
                                    <div>
                                        <span className="text-xs text-content-subtle uppercase">{t('findingSource')}</span>
                                        <p className="text-sm text-content-default mt-1">{te.has(`findingSource.${metadata.findingSource}`) ? te(`findingSource.${metadata.findingSource}`) : metadata.findingSource}</p>
                                    </div>
                                )}
                                {metadata.controlGapType && (
                                    <div>
                                        <span className="text-xs text-content-subtle uppercase">{t('controlGapType')}</span>
                                        <p className="text-sm text-content-default mt-1">{te.has(`gapType.${metadata.controlGapType}`) ? te(`gapType.${metadata.controlGapType}`) : metadata.controlGapType}</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Evidence Tab */}
            {tab === 'evidence' && (
                <div className="space-y-default">
                    <EvidenceAddForm
                        ids={{
                            trigger: 'add-evidence-btn',
                            form: 'task-evidence-form',
                            title: 'task-upload-title',
                            file: 'evidence-file-input',
                            url: 'evidence-url-input',
                            note: 'evidence-note-input',
                            error: 'task-evidence-error',
                            submit: 'submit-evidence-btn',
                        }}
                        canWrite={!!permissions.canWrite}
                        show={showEvidenceForm}
                        onToggleShow={() => setShowEvidenceForm(!showEvidenceForm)}
                        file={fileToUpload}
                        onFileChange={(f) => {
                            setFileToUpload(f);
                            if (f && !fileUploadTitle) setFileUploadTitle(f.name);
                        }}
                        fileInputRef={fileUploadRef}
                        title={fileUploadTitle}
                        onTitleChange={setFileUploadTitle}
                        url={evidenceUrl}
                        onUrlChange={setEvidenceUrl}
                        note={evidenceNote}
                        onNoteChange={setEvidenceNote}
                        onSubmit={addEvidence}
                        error={evidenceError}
                        uploading={savingEvidence && !!fileToUpload}
                        saving={savingEvidence && !fileToUpload}
                    />
                    {evidenceQuery.error ? (
                        <InlineEmptyState title={t('evidenceLoadErrorTitle')} description={t('evidenceLoadErrorDescription')} />
                    ) : (
                        <EvidenceSubTable
                            data={evidenceQuery.data}
                            loading={evidenceQuery.isLoading && !evidenceQuery.data}
                            canWrite={!!permissions.canWrite}
                            onUnlink={() => {}}
                            onUnlinkEvidence={removeEvidence}
                            tenantHref={tenantHref}
                        />
                    )}
                </div>
            )}

            {/* Links Tab */}
            {tab === 'links' && (
                <div className="space-y-default">
                    {permissions.canWrite && (
                        <div className="flex justify-end">
                            <Button variant="primary" onClick={() => setShowLinkForm(!showLinkForm)} id="add-link-btn">
                                + {te('ui.link')}
                            </Button>
                        </div>
                    )}
                    {showLinkForm && permissions.canWrite && (
                        <form onSubmit={addLink} className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}>
                            <div className="grid grid-cols-3 gap-compact">
                                <Combobox hideSearch id="link-entity-type" selected={ENTITY_TYPE_CB_OPTIONS.find(o => o.value === linkEntityType) ?? null} setSelected={(opt) => setLinkEntityType(opt?.value ?? linkEntityType)} options={ENTITY_TYPE_CB_OPTIONS} matchTriggerWidth />
                                <EntityPicker
                                    tenantSlug={tenantSlug}
                                    entityType={linkEntityType as EntityPickerKind}
                                    value={linkEntityId}
                                    onChange={setLinkEntityId}
                                    id="link-entity-id"
                                    testId="task-link-entity-picker"
                                    placeholder={te('ui.selectEntity')}
                                />
                                <Combobox hideSearch id="link-relation" selected={RELATION_CB_OPTIONS.find(o => o.value === linkRelation) ?? null} setSelected={(opt) => setLinkRelation(opt?.value ?? linkRelation)} options={RELATION_CB_OPTIONS} matchTriggerWidth />
                            </div>
                            <Button type="submit" variant="primary" disabled={savingLink} id="submit-link-btn">
                                {savingLink ? t('linking') : t('linkAction')}
                            </Button>
                        </form>
                    )}
                    <TaskLinksTable links={links} loading={linksLoading} canWrite={!!permissions.canWrite} onRemove={removeLink} />
                </div>
            )}

            {/* Comments Tab */}
            {tab === 'comments' && (
                <div className="space-y-default">
                    {canComment && (
                        <form onSubmit={addComment} className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}>
                            <textarea
                                className="input w-full"
                                rows={3}
                                placeholder={t('commentPlaceholder')}
                                value={commentBody}
                                onChange={e => setCommentBody(e.target.value)}
                                required
                                id="comment-body"
                            />
                            <Button type="submit" variant="primary" disabled={savingComment} id="submit-comment-btn">
                                {savingComment ? t('posting') : t('commentAction')}
                            </Button>
                        </form>
                    )}
                    <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')} id="comments-list">
                        {commentsLoading ? (
                            <div className="p-4 space-y-compact">
                                {Array.from({ length: 3 }).map((_, i) => (
                                    <div key={i} className="space-y-1">
                                        <SkeletonLine className="w-32" />
                                        <SkeletonLine className="w-full" />
                                    </div>
                                ))}
                            </div>
                        ) : comments.length === 0 ? (
                            <InlineEmptyState title={t('noCommentsTitle')} description={t('noCommentsDescription')} />
                        ) : (
                            <div className="divide-y divide-border-default/50">
                                {comments.map((c: any) => (
                                    <div key={c.id} className="px-5 py-3">
                                        <div className="flex items-center gap-tight mb-1">
                                            <span className="text-sm font-medium text-content-emphasis">{c.createdBy?.name || t('unknownUser')}</span>
                                            <span className="text-xs text-content-subtle">{formatDateTime(c.createdAt)}</span>
                                        </div>
                                        <p className="text-sm text-content-default whitespace-pre-wrap">{c.body}</p>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Activity Tab */}
            {tab === 'activity' && (
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')} id="activity-list">
                    {activityLoading ? (
                        <div className="p-4 space-y-compact">
                            {Array.from({ length: 4 }).map((_, i) => (
                                <div key={i} className="flex items-start gap-compact">
                                    <div className="animate-pulse rounded-full bg-bg-elevated/60 w-2 h-2 mt-2" />
                                    <div className="flex-1 space-y-1">
                                        <SkeletonLine className="w-48" />
                                        <SkeletonLine className="w-full" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : activity.length === 0 ? (
                        <InlineEmptyState title={t('noActivityTitle')} description={t('noActivityDescription')} />
                    ) : (
                        <div className="divide-y divide-border-default/50">
                            {activity.map((evt: any) => (
                                <div key={evt.id} className="px-5 py-3 flex items-start gap-compact">
                                    <div className="w-2 h-2 rounded-full bg-[var(--brand-default)] mt-2 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-tight mb-0.5">
                                            <span className="text-sm font-medium text-content-emphasis">{evt.user?.name || t('systemUser')}</span>
                                            <StatusBadge variant="neutral">{evt.action ? actionLabel(evt.action) : ''}</StatusBadge>
                                        </div>
                                        <p className="text-xs text-content-muted truncate">{evt.details?.split('\n')[0]}</p>
                                        <span className="text-xs text-content-subtle">{formatDateTime(evt.createdAt)}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Resolution prompt — completing / closing a task records a
                resolution note on the audit trail (S8). Reused for the
                "Mark done" button (RESOLVED) and the CLOSED / CANCELED
                status picks. */}
            <Modal
                showModal={pendingTerminalStatus !== null}
                setShowModal={(next) => { if (next === false && !changingStatus) setPendingTerminalStatus(null); }}
                size="sm"
                title={`${pendingTerminalStatus ? statusLabel(pendingTerminalStatus) : t('closeFallback')} ${t('taskWord')}`}
                description={t('resolutionModalDescription')}
                preventDefaultClose={changingStatus}
            >
                <Modal.Header
                    title={`${pendingTerminalStatus ? statusLabel(pendingTerminalStatus) : t('closeFallback')} ${t('taskWord')}`}
                    description={t('resolutionModalHeaderDescription')}
                />
                <Modal.Body>
                    {statusError && (
                        <div className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error" role="alert" id="task-status-error">
                            {statusError}
                        </div>
                    )}
                    <FormField label={t('resolutionField')} required>
                        <textarea
                            id="task-resolution-input"
                            className="input w-full"
                            rows={3}
                            placeholder={t('resolutionPlaceholder')}
                            value={resolutionDraft}
                            onChange={(e) => setResolutionDraft(e.target.value)}
                            disabled={changingStatus}
                        />
                    </FormField>
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" onClick={() => setPendingTerminalStatus(null)} disabled={changingStatus} id="task-status-cancel-btn">
                        {t('cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        id="confirm-task-status-btn"
                        disabled={!resolutionDraft.trim() || changingStatus}
                        onClick={() => pendingTerminalStatus && commitStatus(pendingTerminalStatus, resolutionDraft.trim())}
                    >
                        {changingStatus ? t('savingEllipsis') : `${pendingTerminalStatus ? statusLabel(pendingTerminalStatus) : t('closeFallback')} ${t('taskWord')}`}
                    </Button>
                </Modal.Actions>
            </Modal>

            {/* Edit-task modal (farm-flavoured, inline). */}
            <Modal
                showModal={showEditModal}
                setShowModal={setShowEditModal}
                size="lg"
                title={tf('detail.editTask')}
                description={tf('detail.editDescription')}
                preventDefaultClose={savingEdit}
            >
                <Modal.Header title={tf('detail.editTask')} description={tf('detail.editDescription')} />
                <Modal.Form id="edit-farm-task-form" onSubmit={handleEditSave}>
                    <Modal.Body>
                        {editError && (
                            <div className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error" role="alert" id="edit-task-error">
                                {editError}
                            </div>
                        )}
                        <fieldset disabled={savingEdit} className="m-0 p-0 border-0 space-y-default">
                            <FormField label={tf('fieldTitle')} required>
                                <Input id="edit-task-title" value={editForm.title} onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))} placeholder={tf('titlePlaceholder')} />
                            </FormField>
                            <FormField label={tf('detail.notes')}>
                                <textarea
                                    id="edit-task-description"
                                    className="input w-full"
                                    rows={3}
                                    value={editForm.description}
                                    onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                                    placeholder={tf('detail.notesPlaceholder')}
                                />
                            </FormField>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                                {isFarmTask && (
                                    <FormField label={tf('fieldTaskType')}>
                                        <Combobox
                                            id="edit-task-type"
                                            options={FARM_TYPE_OPTIONS}
                                            selected={FARM_TYPE_OPTIONS.find((o) => o.value === editForm.farmTaskType) ?? null}
                                            setSelected={(o) => setEditForm((f) => ({ ...f, farmTaskType: o?.value ?? '' }))}
                                            optionDescription={(o) => { const def = TYPE_BY_VALUE.get(o.value); return def ? categoryLabel(def.category) : null; }}
                                            placeholder={tf('taskTypePlaceholder')}
                                            searchPlaceholder={tf('taskTypeSearch')}
                                            aria-label={tf('taskTypeAria')}
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                )}
                                <FormField label={tf('fieldPriority')}>
                                    <Combobox
                                        id="edit-task-priority"
                                        options={PRIORITY_CB_OPTIONS}
                                        selected={PRIORITY_CB_OPTIONS.find((o) => o.value === editForm.priority) ?? null}
                                        setSelected={(o) => setEditForm((f) => ({ ...f, priority: o?.value ?? 'P2' }))}
                                        placeholder={tf('priorityPlaceholder')}
                                        hideSearch
                                        aria-label={tf('priorityAria')}
                                        matchTriggerWidth
                                    />
                                </FormField>
                                <FormField label={tf('fieldDueDate')}>
                                    <DatePicker
                                        id="edit-task-due"
                                        className="w-full"
                                        value={editForm.dueAt ? new Date(editForm.dueAt) : null}
                                        onChange={(d) => setEditForm((f) => ({ ...f, dueAt: d ? toYMD(d) ?? '' : '' }))}
                                        clearable
                                        placeholder={tf('datePlaceholder')}
                                        aria-label={tf('dueDateAria')}
                                    />
                                </FormField>
                            </div>
                        </fieldset>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button variant="secondary" size="sm" type="button" onClick={() => setShowEditModal(false)} disabled={savingEdit} id="edit-task-cancel">
                            {t('cancel')}
                        </Button>
                        <Button variant="primary" size="sm" type="submit" loading={savingEdit} disabled={!editForm.title.trim()} id="edit-task-submit">
                            {tf('detail.saveTask')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>
        </EntityDetailLayout>
    );
}

interface TaskLinkRow {
    id: string;
    entityType: string;
    entityId: string;
    relation?: string | null;
    createdAt: string;
}

function TaskLinksTable({
    links,
    loading,
    canWrite,
    onRemove,
}: {
    links: TaskLinkRow[];
    loading: boolean;
    canWrite: boolean;
    onRemove: (id: string) => void;
}) {
    const t = useTranslations('tasks.detail.links');
    const te = useTranslations('taskEnums');
    const entityTypeLabel = (et: string) => (te.has(`entityType.${et}`) ? te(`entityType.${et}`) : et.replace(/_/g, ' '));
    const relationLabel = (r: string) => (te.has(`relation.${r}`) ? te(`relation.${r}`) : r.replace(/_/g, ' '));
    const columns = useMemo(
        () =>
            createColumns<TaskLinkRow>([
                { id: 'entityType', header: t('colType'), cell: ({ row }) => (<StatusBadge variant="info">{entityTypeLabel(row.original.entityType)}</StatusBadge>) },
                { id: 'entityId', header: t('colEntityId'), cell: ({ row }) => (<span className="text-sm text-content-default font-mono">{row.original.entityId}</span>) },
                { id: 'relation', header: t('colRelation'), cell: ({ row }) => (<span className="text-xs text-content-muted">{row.original.relation ? relationLabel(row.original.relation) : '—'}</span>) },
                { id: 'createdAt', header: t('colCreated'), cell: ({ row }) => (<span className="text-xs text-content-muted">{formatDate(row.original.createdAt)}</span>) },
                ...(canWrite
                    ? [{
                          id: 'actions',
                          header: t('colActions'),
                          cell: ({ row }) => (
                              <button className="text-content-error text-xs hover:text-content-error" onClick={() => onRemove(row.original.id)}>
                                  × {te('ui.remove')}
                              </button>
                          ),
                      } as Parameters<typeof createColumns<TaskLinkRow>>[0][number]]
                    : []),
            ]),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [canWrite, onRemove, t, te],
    );
    return (
        <DataTable
            data={links}
            columns={columns}
            getRowId={(l) => l.id}
            loading={loading}
            emptyState={<InlineEmptyState title={t('noLinksTitle')} description={t('noLinksDescription')} />}
            resourceName={(p) => (p ? 'links' : 'link')}
            data-testid="task-links-table"
        />
    );
}
