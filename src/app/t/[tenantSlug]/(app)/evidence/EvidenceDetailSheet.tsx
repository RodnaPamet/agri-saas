'use client';

/**
 * B5 — Evidence detail sheet.
 *
 * Pre-B5 the evidence table had no way to drill into a single
 * record — every action (Submit, Approve, Reject) was inline on the
 * row, and the underlying detail fields (description, owner,
 * retention, related control) were invisible from the list.
 *
 * This sheet opens on row click. It shows the read-only evidence
 * detail + the existing approval-flow buttons (which call back to
 * the parent's `onReview` to keep the existing optimistic-update
 * mutation pipeline intact) + an "Edit" button that delegates to
 * the parent to mount the EditEvidenceModal.
 *
 * Mirrors the `<ControlDetailSheet>` shape so the surface reads as
 * a sibling of the established controls drill-down.
 */
import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Sheet } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { formatDate } from '@/lib/format-date';
import { Pen2 } from '@/components/ui/icons/nucleo';
import Link from 'next/link';
import { textLinkVariants } from '@/components/ui/typography';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

const EVIDENCE_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    SUBMITTED: 'info',
    APPROVED: 'success',
    REJECTED: 'error',
    NEEDS_REVIEW: 'warning',
};

export interface EvidenceDetailSheetProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /** The clicked row id; `null` while the sheet is closed. */
    evidenceId: string | null;
    /** Allowed write surfaces — gates the edit + review buttons. */
    canWrite: boolean;
    canAdmin: boolean;
    /** Open the edit modal for the loaded evidence. */
    onEdit: (evidence: {
        id: string;
        title: string;
        description: string | null;
        ownerUserId: string | null;
        controlId: string | null;
        /** B8 follow-up — current folder, threaded to the edit modal. */
        folder: string | null;
        /** Retention date (ISO) — edited in the modal now. */
        retentionUntil: string | null;
    }) => void;
    /** Existing parent review pipeline — re-uses the optimistic mutation. */
    onReview: (id: string, action: 'SUBMITTED' | 'APPROVED' | 'REJECTED') => void;
}

interface EvidenceDetailPayload {
    id: string;
    title: string;
    description: string | null;
    type: string;
    status: string;
    nextReviewDate: string | null;
    retentionUntil: string | null;
    owner: string | null;
    ownerUserId: string | null;
    controlId: string | null;
    control?: { id: string; code: string | null; name: string } | null;
    taskId: string | null;
    /** Source task / risk / asset — set when uploaded from that entity. */
    task?: { id: string; key: string | null; title: string } | null;
    riskId: string | null;
    risk?: { id: string; key: string | null; title: string } | null;
    assetId: string | null;
    asset?: { id: string; key: string | null; name: string } | null;
    createdAt: string;
    updatedAt: string;
    /** SP-3 — present when imported from SharePoint. */
    sharePoint?: { sourceUrl: string; lastSyncedAt: string | null; syncStatus: string } | null;
}

export function EvidenceDetailSheet({
    open,
    setOpen,
    evidenceId,
    canWrite,
    canAdmin,
    onEdit,
    onReview,
}: EvidenceDetailSheetProps) {
    const t = useTranslations('evidence');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();

    const detailQuery = useQuery<EvidenceDetailPayload>({
        queryKey: ['evidence', 'detail', evidenceId],
        queryFn: async () => {
            const res = await fetch(apiUrl(`/evidence/${evidenceId}`));
            if (!res.ok) throw new Error('Failed to load evidence');
            return res.json();
        },
        enabled: open && !!evidenceId,
    });

    const evidence = detailQuery.data;

    const metaRows = useMemo(() => {
        if (!evidence) return [];
        const rows: Array<{ label: string; value: React.ReactNode }> = [];
        rows.push({ label: t('detailSheet.metaType'), value: evidence.type });
        if (evidence.owner) rows.push({ label: t('detailSheet.metaOwner'), value: evidence.owner });
        if (evidence.control) {
            rows.push({
                label: t('detailSheet.metaControl'),
                value: `${evidence.control.code ?? ''}${evidence.control.code ? ' — ' : ''}${evidence.control.name}`,
            });
        }
        if (evidence.task) {
            // Back-reference — which task this evidence was uploaded from.
            rows.push({
                label: t('detailSheet.uploadedFromTask'),
                value: (
                    <Link
                        href={tenantHref(`/farm-tasks/${evidence.task.id}`)}
                        className={textLinkVariants({ tone: 'link' })}
                    >
                        {evidence.task.key ? `${evidence.task.key} — ` : ''}
                        {evidence.task.title}
                    </Link>
                ),
            });
        }
        if (evidence.risk) {
            rows.push({
                label: t('detailSheet.uploadedFromRisk'),
                value: (
                    <Link
                        href={tenantHref(`/risks/${evidence.risk.id}`)}
                        className={textLinkVariants({ tone: 'link' })}
                    >
                        {evidence.risk.key ? `${evidence.risk.key} — ` : ''}
                        {evidence.risk.title}
                    </Link>
                ),
            });
        }
        if (evidence.asset) {
            rows.push({
                label: t('detailSheet.uploadedFromAsset'),
                value: (
                    <Link
                        href={tenantHref(`/assets/${evidence.asset.id}`)}
                        className={textLinkVariants({ tone: 'link' })}
                    >
                        {evidence.asset.key ? `${evidence.asset.key} — ` : ''}
                        {evidence.asset.name}
                    </Link>
                ),
            });
        }
        if (evidence.nextReviewDate) {
            rows.push({
                label: t('detailSheet.metaNextReview'),
                value: formatDate(new Date(evidence.nextReviewDate)),
            });
        }
        rows.push({
            label: t('detailSheet.metaUpdated'),
            value: formatDate(new Date(evidence.updatedAt)),
        });
        if (evidence.sharePoint?.sourceUrl) {
            rows.push({
                label: t('detailSheet.metaSource'),
                value: (
                    <a
                        href={evidence.sharePoint.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-content-link"
                    >
                        {t('detailSheet.viewInSharePoint')}
                    </a>
                ),
            });
        }
        return rows;
    }, [evidence, tenantHref, t]);

    return (
        <Sheet
            open={open}
            onOpenChange={setOpen}
            size="md"
            title={evidence?.title ?? t('detailSheet.fallbackTitle')}
        >
            {detailQuery.isLoading || !evidence ? (
                <>
                    <Sheet.Header title={t('detailSheet.loading')} />
                    <Sheet.Body>
                        <div className="flex h-40 items-center justify-center text-sm text-content-muted">
                            {t('detailSheet.loadingBody')}
                        </div>
                    </Sheet.Body>
                </>
            ) : detailQuery.isError ? (
                <>
                    <Sheet.Header title={t('detailSheet.errorHeader')} />
                    <Sheet.Body>
                        <div
                            className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            role="alert"
                            data-testid="evidence-sheet-error"
                        >
                            {detailQuery.error instanceof Error
                                ? detailQuery.error.message
                                : t('detailSheet.loadError')}
                        </div>
                    </Sheet.Body>
                </>
            ) : (
                <>
                    <Sheet.Header
                        title={evidence.title}
                        description={evidence.description || undefined}
                    />
                    <Sheet.Body>
                        <div className="space-y-default">
                            <div className="flex items-center gap-tight">
                                <StatusBadge
                                    variant={
                                        EVIDENCE_STATUS_VARIANT[evidence.status] ??
                                        'neutral'
                                    }
                                    id="evidence-sheet-status"
                                >
                                    {evidence.status}
                                </StatusBadge>
                            </div>

                            {metaRows.length > 0 && (
                                <dl className="grid grid-cols-1 gap-1">
                                    {metaRows.map((row) => (
                                        <div
                                            key={row.label}
                                            className="flex items-baseline justify-between gap-default text-sm"
                                        >
                                            <dt className="text-content-muted">
                                                {row.label}
                                            </dt>
                                            <dd className="text-content-default text-right">
                                                {row.value}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            )}

                            {evidence.description && (
                                <div className="space-y-tight">
                                    <p className="text-xs font-medium uppercase tracking-widest text-content-subtle">
                                        {t('detailSheet.descriptionLabel')}
                                    </p>
                                    <p className="text-sm text-content-default whitespace-pre-wrap">
                                        {evidence.description}
                                    </p>
                                </div>
                            )}
                        </div>
                    </Sheet.Body>
                    <Sheet.Footer>
                        <div className="flex flex-wrap items-center gap-tight">
                            {canWrite && (
                                <Button
                                    variant="secondary"
                                    size="icon"
                                    onClick={() =>
                                        onEdit({
                                            id: evidence.id,
                                            title: evidence.title,
                                            description: evidence.description,
                                            ownerUserId: evidence.ownerUserId,
                                            controlId: evidence.controlId,
                                            // B8 follow-up — the
                                            // detail sheet fetches a
                                            // fresh evidence row;
                                            // forward its current
                                            // folder so the edit
                                            // modal opens already
                                            // populated.
                                            folder: (
                                                evidence as {
                                                    folder?: string | null;
                                                }
                                            ).folder ?? null,
                                            retentionUntil: evidence.retentionUntil,
                                        })
                                    }
                                    id="evidence-sheet-edit-btn"
                                    aria-label={t('client.editEvidence')}
                                >
                                    <Pen2 className="size-4" />
                                </Button>
                            )}
                            {/* Approval flow — existing parent mutation
                                runs the optimistic update + audit
                                emission; the sheet just routes the
                                button click back to the parent.

                                B5 primary-action discipline + modal
                                action-order rule:
                                  - Author-side corrections (Submit /
                                    Re-submit / Re-certify) render as
                                    `secondary`. They're rendered
                                    FIRST so the affirmative action
                                    on the SUBMITTED branch ends the
                                    JSX last.
                                  - Reviewer's destructive Reject
                                    sits before the approving CTA so
                                    the LAST button on every visible
                                    branch is the most-affirmative
                                    action (matches the modal-
                                    action-order rule). */}
                            {canWrite && evidence.status === 'DRAFT' && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => onReview(evidence.id, 'SUBMITTED')}
                                    id="evidence-sheet-submit-btn"
                                >
                                    {t('detailSheet.submitForReview')}
                                </Button>
                            )}
                            {canWrite && evidence.status === 'REJECTED' && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => onReview(evidence.id, 'SUBMITTED')}
                                    id="evidence-sheet-resubmit-btn"
                                >
                                    {t('detailSheet.resubmit')}
                                </Button>
                            )}
                            {canWrite && evidence.status === 'NEEDS_REVIEW' && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => onReview(evidence.id, 'SUBMITTED')}
                                    id="evidence-sheet-recertify-btn"
                                >
                                    {t('detailSheet.resubmitForReview')}
                                </Button>
                            )}
                            {canAdmin && evidence.status === 'SUBMITTED' && (
                                <>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => onReview(evidence.id, 'REJECTED')}
                                        id="evidence-sheet-reject-btn"
                                    >
                                        {t('detailSheet.reject')}
                                    </Button>
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        onClick={() => onReview(evidence.id, 'APPROVED')}
                                        id="evidence-sheet-approve-btn"
                                    >
                                        {t('detailSheet.approve')}
                                    </Button>
                                </>
                            )}
                        </div>
                    </Sheet.Footer>
                </>
            )}
        </Sheet>
    );
}
