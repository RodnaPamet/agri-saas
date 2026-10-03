'use client';

/**
 * Epic G-4 — Access Review detail / reviewer page.
 *
 * The reviewer's working surface — every snapshot subject is one
 * row in a table with:
 *   • Subject identity (name + email)
 *   • Snapshot role at campaign creation (frozen evidence)
 *   • Live role today (changes if anyone updated the membership
 *     after snapshot)
 *   • Last activity date (max UserSession.lastActiveAt for the user)
 *   • Decision dropdown — CONFIRM / REVOKE / MODIFY
 *   • Decision-aware modal for MODIFY's `modifiedToRole` + notes
 *
 * Permission gating in this component:
 *   - Only the assigned reviewer (ctx.userId === review.reviewerUserId)
 *     OR an admin can submit decisions.
 *   - Only an admin can press "Close campaign".
 *   - Anyone with read can browse + download the evidence PDF when
 *     the campaign is CLOSED.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { StatusBadge } from '@/components/ui/status-badge';
import { MetaStrip } from '@/components/ui/meta-strip';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DataTable, createColumns } from '@/components/ui/table';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';

const ALL_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'MECHANISATOR'] as const;
type Role = (typeof ALL_ROLES)[number];
type DecisionType = 'CONFIRM' | 'REVOKE' | 'MODIFY';
type Status = 'OPEN' | 'IN_REVIEW' | 'CLOSED';

interface DecisionRow {
    id: string;
    subjectUserId: string;
    subjectUser: { id: string; email: string; name: string | null };
    snapshotRole: Role;
    snapshotMembershipStatus: string;
    decision: DecisionType | null;
    decidedAt: string | Date | null;
    decidedBy: { id: string; email: string; name: string | null } | null;
    notes: string | null;
    modifiedToRole: Role | null;
    executedAt: string | Date | null;
    membership: {
        id: string;
        role: Role;
        status: string;
    } | null;
}

interface ReviewDetail {
    id: string;
    name: string;
    description: string | null;
    scope: 'ALL_USERS' | 'ADMIN_ONLY' | 'CUSTOM';
    status: Status;
    periodStartAt: string | Date | null;
    periodEndAt: string | Date | null;
    dueAt: string | Date | null;
    closedAt: string | Date | null;
    createdAt: string | Date;
    reviewerUserId: string;
    evidenceFileRecordId: string | null;
    reviewer: { id: string; email: string; name: string | null };
    createdBy: { id: string; email: string; name: string | null };
    closedBy: { id: string; email: string; name: string | null } | null;
    decisions: DecisionRow[];
    lastActivityByUser: Record<string, string | Date>;
}

interface Props {
    tenantSlug: string;
    initialReview: ReviewDetail;
    currentUserId: string;
    isAdmin: boolean;
}

const STATUS_VARIANT: Record<Status, 'warning' | 'info' | 'success'> = {
    OPEN: 'warning',
    IN_REVIEW: 'info',
    CLOSED: 'success',
};

const DECISION_VARIANT: Record<DecisionType, 'success' | 'error' | 'warning'> = {
    CONFIRM: 'success',
    REVOKE: 'error',
    MODIFY: 'warning',
};

export function AccessReviewDetailClient({
    tenantSlug,
    initialReview,
    currentUserId,
    isAdmin,
}: Props) {
    const { formatDate, formatDateTime } = useDateFormat();
    const t = useTranslations('accessReviews');
    const queryClient = useQueryClient();
    const router = useRouter();
    const apiBase = `/api/t/${tenantSlug}/access-reviews/${initialReview.id}`;

    const reviewQuery = useQuery<ReviewDetail>({
        queryKey: ['access-review', tenantSlug, initialReview.id],
        queryFn: async () => {
            const res = await fetch(apiBase);
            if (!res.ok) throw new Error('Failed to fetch access review');
            return res.json();
        },
        initialData: initialReview,
    });
    const review = reviewQuery.data!;

    const isReviewer = currentUserId === review.reviewerUserId;
    const canDecide = (isReviewer || isAdmin) && review.status !== 'CLOSED';
    const canClose = isAdmin && review.status !== 'CLOSED';

    const [activeDecision, setActiveDecision] = useState<{
        row: DecisionRow;
        type: DecisionType;
    } | null>(null);
    const [closing, setClosing] = useState(false);

    const decisionsTotal = review.decisions.length;
    const decided = review.decisions.filter((d) => d.decision !== null).length;
    const pct = decisionsTotal === 0 ? 0 : Math.round((decided / decisionsTotal) * 100);

    const decisionColumns = useMemo(
        () => createColumns<DecisionRow>([
            {
                id: 'subject',
                header: t('colSubject'),
                cell: ({ row }) => (
                    <div data-testid={`decision-row-${row.original.id}`}>
                        <div className="font-medium text-content-default">
                            {row.original.subjectUser.name || '—'}
                        </div>
                        <div className="text-xs text-content-muted">
                            {row.original.subjectUser.email}
                        </div>
                    </div>
                ),
            },
            {
                id: 'snapshotRole',
                header: t('colSnapshotRole'),
                cell: ({ row }) => (
                    <span className="text-sm">{row.original.snapshotRole}</span>
                ),
            },
            {
                id: 'liveRole',
                header: t('colLiveRole'),
                cell: ({ row }) =>
                    row.original.membership ? (
                        <span className="text-sm">{row.original.membership.role}</span>
                    ) : (
                        <span className="text-sm text-content-muted italic">{t('deleted')}</span>
                    ),
            },
            {
                id: 'lastActive',
                header: t('colLastActive'),
                cell: ({ row }) => {
                    const lastActiveAt =
                        review.lastActivityByUser[row.original.subjectUserId] ?? null;
                    return (
                        <span className="text-sm text-content-muted">
                            {lastActiveAt ? formatDate(lastActiveAt) : t('never')}
                        </span>
                    );
                },
            },
            {
                id: 'decision',
                header: t('colDecision'),
                cell: ({ row }) => {
                    const d = row.original;
                    if (d.decision) {
                        return (
                            <StatusBadge variant={DECISION_VARIANT[d.decision]}>
                                {d.decision}
                                {d.decision === 'MODIFY' && d.modifiedToRole
                                    ? ` → ${d.modifiedToRole}`
                                    : ''}
                            </StatusBadge>
                        );
                    }
                    if (canDecide) {
                        // Segmented action trigger (not a persistent selection):
                        // picking a verb opens the decision modal. Replaces the
                        // hand-rolled native <select> (Epic 55).
                        return (
                            <div data-testid={`decision-select-${d.id}`}>
                                <ToggleGroup
                                    size="sm"
                                    ariaLabel={t('decidePlaceholder')}
                                    selected={null}
                                    options={[
                                        { value: 'CONFIRM', label: t('decisionConfirm'), id: `decision-confirm-${d.id}` },
                                        { value: 'REVOKE', label: t('decisionRevoke'), id: `decision-revoke-${d.id}` },
                                        { value: 'MODIFY', label: t('decisionModify'), id: `decision-modify-${d.id}` },
                                    ]}
                                    selectAction={(v) => setActiveDecision({ row: d, type: v as DecisionType })}
                                />
                            </div>
                        );
                    }
                    return (
                        <span className="text-xs text-content-muted">{t('pending')}</span>
                    );
                },
            },
        ]),
        [canDecide, review.lastActivityByUser, t],
    );

    return (
        <EntityDetailLayout
            id="access-review-detail-page"
            breadcrumbs={[
                { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                { label: t('breadcrumbAccessReviews'), href: `/t/${tenantSlug}/access-reviews` },
                { label: review.name },
            ]}
            title={<span data-testid="access-review-detail-title">{review.name}</span>}
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            label: t('metaStatus'),
                            value: review.status,
                            variant:
                                STATUS_VARIANT[review.status] ?? 'neutral',
                        },
                    ]}
                />
            }
            actions={
                <div className="flex flex-col items-end gap-tight">
                    <div className="flex items-center gap-tight">
                        <ProgressBar
                            value={pct}
                            variant={pct >= 100 ? 'success' : pct >= 50 ? 'info' : 'brand'}
                            aria-label={t('progressAria', { decided, total: decisionsTotal })}
                            className="w-full sm:w-48"
                        />
                        <span className="text-xs text-content-muted whitespace-nowrap">
                            {decided}/{decisionsTotal}
                        </span>
                    </div>
                    <div className="flex gap-tight">
                        {review.evidenceFileRecordId ? (
                            <Button
                                variant="secondary"
                                onClick={() =>
                                    window.open(`${apiBase}/evidence`, '_blank')
                                }
                                data-testid="access-review-download-evidence"
                            >
                                {t('downloadEvidence')}
                            </Button>
                        ) : null}
                        {canClose ? (
                            <Button
                                onClick={() => setClosing(true)}
                                disabled={decided !== decisionsTotal}
                                data-testid="access-review-close-button"
                            >
                                {t('closeCampaign')}
                            </Button>
                        ) : null}
                    </div>
                </div>
            }
        >
            {/* Description + meta data list — preserved as the first body
                element since EntityDetailLayout's `meta` prop is sized
                for inline badges, not multi-row metadata. */}
            <div className="space-y-tight">
                {review.description ? (
                    <p className="text-sm text-content-muted max-w-prose">
                        {review.description}
                    </p>
                ) : null}
                <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-content-muted">
                    <div>
                        <dt className="font-semibold uppercase">{t('metaReviewer')}</dt>
                        <dd>{review.reviewer.email}</dd>
                    </div>
                    <div>
                        <dt className="font-semibold uppercase">{t('metaScope')}</dt>
                        <dd>{review.scope.replace('_', ' ').toLowerCase()}</dd>
                    </div>
                    <div>
                        <dt className="font-semibold uppercase">{t('metaDue')}</dt>
                        <dd>{review.dueAt ? formatDate(review.dueAt) : '—'}</dd>
                    </div>
                    {review.closedAt ? (
                        <div>
                            <dt className="font-semibold uppercase">{t('metaClosed')}</dt>
                            <dd>{formatDateTime(review.closedAt)}</dd>
                        </div>
                    ) : null}
                </dl>
            </div>

            {/* Roster — DataTable */}
            <DataTable
                data={review.decisions}
                columns={decisionColumns}
                getRowId={(d) => d.id}
                emptyState={t('rosterEmpty')}
                resourceName={(p) => (p ? t('subjectPlural') : t('subjectSingular'))}
                data-testid="access-review-roster-table"
            />

            {activeDecision ? (
                <DecisionDialog
                    apiBase={apiBase}
                    decision={activeDecision}
                    onClose={() => setActiveDecision(null)}
                    onSuccess={() => {
                        setActiveDecision(null);
                        queryClient.invalidateQueries({
                            queryKey: ['access-review', tenantSlug, initialReview.id],
                        });
                    }}
                />
            ) : null}

            {closing ? (
                <CloseDialog
                    apiBase={apiBase}
                    onClose={() => setClosing(false)}
                    onSuccess={() => {
                        setClosing(false);
                        queryClient.invalidateQueries({
                            queryKey: ['access-review', tenantSlug, initialReview.id],
                        });
                        // List page sees the new CLOSED state too.
                        queryClient.invalidateQueries({
                            queryKey: ['access-reviews', tenantSlug, 'list'],
                        });
                        router.refresh();
                    }}
                />
            ) : null}
        </EntityDetailLayout>
    );
}

// ─── Decision dialog ─────────────────────────────────────────────────

function DecisionDialog({
    apiBase,
    decision,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    decision: { row: DecisionRow; type: DecisionType };
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('accessReviews');
    const [notes, setNotes] = useState('');
    const [modifiedToRole, setModifiedToRole] = useState<Role>('READER');
    const [error, setError] = useState<string | null>(null);

    const targetRoleOptions = useMemo<ComboboxOption[]>(
        () =>
            ALL_ROLES.filter((r) => r !== decision.row.snapshotRole).map((r) => ({
                value: r,
                label: r,
            })),
        [decision.row.snapshotRole],
    );

    const submit = useMutation({
        mutationFn: async () => {
            setError(null);
            const body =
                decision.type === 'MODIFY'
                    ? { decision: 'MODIFY', modifiedToRole, notes: notes || undefined }
                    : { decision: decision.type, notes: notes || undefined };
            const res = await fetch(
                `${apiBase}/decisions/${decision.row.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                },
            );
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Failed to submit decision');
            }
            return res.json();
        },
        onSuccess,
        onError: (err) =>
            setError(err instanceof Error ? err.message : 'Unknown error'),
    });

    const titleByType: Record<DecisionType, string> = {
        CONFIRM: t('decisionConfirm'),
        REVOKE: t('decisionRevoke'),
        MODIFY: t('decisionModify'),
    };

    return (
        <Modal showModal={true} setShowModal={(v) => !v && onClose()}>
            <Modal.Header
                title={t('decisionDialogTitle', { action: titleByType[decision.type], email: decision.row.subjectUser.email })}
            />
            <Modal.Body>
                <div className="space-y-default">
                    <p className="text-sm text-content-muted">
                        {t('snapshotRolePrefix')}{' '}
                        <strong>{decision.row.snapshotRole}</strong>
                        {decision.row.membership &&
                        decision.row.membership.role !== decision.row.snapshotRole ? (
                            <>
                                {' '}
                                ({t('liveNowPrefix')} <strong>{decision.row.membership.role}</strong>)
                            </>
                        ) : null}
                    </p>
                    {decision.type === 'MODIFY' ? (
                        <FormField label={t('targetRole')} required>
                            {/* Combobox inside a Modal → auto-renders as a
                                dropdown via OverlayDepthContext (P3.2), no
                                nested mobile drawer. Wrapper carries the E2E
                                testid since ButtonProps has no data-testid slot. */}
                            <div data-testid="decision-modal-modified-to-role">
                                <Combobox
                                    hideSearch
                                    matchTriggerWidth
                                    id="decision-modal-modified-to-role"
                                    options={targetRoleOptions}
                                    selected={targetRoleOptions.find((o) => o.value === modifiedToRole) ?? null}
                                    setSelected={(opt) => opt && setModifiedToRole(opt.value as Role)}
                                />
                            </div>
                        </FormField>
                    ) : null}
                    <FormField
                        label={
                            decision.type === 'CONFIRM'
                                ? t('justificationOptional')
                                : t('justificationRecommended')
                        }
                    >
                        <textarea
                            className="input"
                            rows={3}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder={t('notesPlaceholder')}
                            data-testid="decision-modal-notes"
                        />
                    </FormField>
                    {error ? (
                        <p
                            className="text-sm text-content-error"
                            data-testid="decision-modal-error"
                        >
                            {error}
                        </p>
                    ) : null}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>
                    {t('cancel')}
                </Button>
                <Button
                    onClick={() => submit.mutate()}
                    disabled={submit.isPending}
                    data-testid="decision-modal-submit"
                >
                    {submit.isPending ? t('submitting') : t('submitDecision')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

// ─── Close-campaign dialog ───────────────────────────────────────────

function CloseDialog({
    apiBase,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('accessReviews');
    const [error, setError] = useState<string | null>(null);

    const close = useMutation({
        mutationFn: async () => {
            setError(null);
            const res = await fetch(`${apiBase}/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Failed to close campaign');
            }
            return res.json();
        },
        onSuccess,
        onError: (err) =>
            setError(err instanceof Error ? err.message : 'Unknown error'),
    });

    return (
        <Modal showModal={true} setShowModal={(v) => !v && onClose()}>
            <Modal.Header title={t('closeDialogTitle')} />
            <Modal.Body>
                <p className="text-sm text-content-muted">
                    {t.rich('closeDialogBody', { b: (chunks) => <strong>{chunks}</strong> })}
                </p>
                {error ? (
                    <p
                        className="mt-3 text-sm text-content-error"
                        data-testid="close-modal-error"
                    >
                        {error}
                    </p>
                ) : null}
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>
                    {t('cancel')}
                </Button>
                <Button
                    onClick={() => close.mutate()}
                    disabled={close.isPending}
                    data-testid="close-modal-submit"
                >
                    {close.isPending ? t('closing') : t('closeGenerate')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}
