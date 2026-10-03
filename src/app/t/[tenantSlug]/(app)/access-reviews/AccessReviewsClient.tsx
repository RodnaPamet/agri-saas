'use client';

/**
 * Epic G-4 — Access Reviews list client island.
 *
 * Renders the campaign roster with status badges, deadline,
 * reviewer, and a progress bar (% decided). Admin actions:
 *   • New campaign — modal that submits to POST /access-reviews
 *   • Row click → /t/:slug/access-reviews/:id (detail page)
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { UserCombobox } from '@/components/ui/user-combobox';
import { DataTable, createColumns } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { DatePicker } from '@/components/ui/date-picker';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';

/// SSR returns Prisma rows with native Date instances; the SWR
/// fetcher returns the same shape but the dates round-trip through
/// JSON as ISO strings. The client widens to accept both.
interface AccessReviewSummary {
    id: string;
    name: string;
    scope: 'ALL_USERS' | 'ADMIN_ONLY' | 'CUSTOM';
    status: 'OPEN' | 'IN_REVIEW' | 'CLOSED';
    periodStartAt: string | Date | null;
    periodEndAt: string | Date | null;
    dueAt: string | Date | null;
    closedAt: string | Date | null;
    createdAt: string | Date;
    reviewerUserId: string;
    createdByUserId: string;
    _count: { decisions: number };
    /** Filled by the detail-page hydration; the list endpoint keeps
     *  the response small. */
    decidedCount?: number;
}

const STATUS_VARIANT: Record<
    AccessReviewSummary['status'],
    'warning' | 'info' | 'success'
> = {
    OPEN: 'warning',
    IN_REVIEW: 'info',
    CLOSED: 'success',
};

interface Props {
    tenantSlug: string;
    initialReviews: AccessReviewSummary[];
}

export function AccessReviewsClient({ tenantSlug, initialReviews }: Props) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('accessReviews');
    const apiUrl = (path: string) =>
        `/api/t/${tenantSlug}/access-reviews${path}`;
    const queryClient = useQueryClient();
    const router = useRouter();

    const reviewsQuery = useQuery<CappedList<AccessReviewSummary>>({
        queryKey: ['access-reviews', tenantSlug, 'list'],
        queryFn: async () => {
            const res = await fetch(apiUrl(''));
            if (!res.ok) throw new Error('Failed to fetch access reviews');
            return res.json();
        },
        initialData: { rows: initialReviews, truncated: false },
    });

    const reviews = reviewsQuery.data?.rows ?? [];
    const truncated = reviewsQuery.data?.truncated ?? false;

    const columns = useMemo(
        () =>
            createColumns<AccessReviewSummary>([
                {
                    id: 'name',
                    header: t('colCampaign'),
                    cell: ({ row }) => (
                        <Link
                            href={`/t/${tenantSlug}/access-reviews/${row.original.id}`}
                            className="font-medium text-content-default hover:text-brand-emphasis"
                        >
                            {row.original.name}
                        </Link>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANT[row.original.status]}>
                            {row.original.status}
                        </StatusBadge>
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colStatus') } },
                },
                {
                    id: 'scope',
                    header: t('colScope'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">
                            {row.original.scope.replace('_', ' ').toLowerCase()}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    id: 'period',
                    header: t('colPeriod'),
                    cell: ({ row }) =>
                        row.original.periodStartAt && row.original.periodEndAt
                            ? `${formatDate(row.original.periodStartAt)} → ${formatDate(row.original.periodEndAt)}`
                            : '—',
                },
                {
                    id: 'dueAt',
                    header: t('colDue'),
                    cell: ({ row }) =>
                        row.original.dueAt ? formatDate(row.original.dueAt) : '—',
                    meta: { mobileCard: { slot: 'meta', label: t('colDue') } },
                },
                {
                    id: 'progress',
                    header: t('colProgress'),
                    meta: { mobileCard: { slot: 'meta', label: t('colProgress') } },
                    cell: ({ row }) => {
                        const total = row.original._count.decisions;
                        const decided = row.original.decidedCount ?? 0;
                        const pct = total === 0 ? 0 : Math.round((decided / total) * 100);
                        const variant =
                            row.original.status === 'CLOSED'
                                ? 'success'
                                : pct >= 80
                                    ? 'info'
                                    : pct > 0
                                        ? 'brand'
                                        : 'neutral';
                        return (
                            <div className="flex items-center gap-tight">
                                <ProgressBar
                                    value={pct}
                                    variant={variant}
                                    size="sm"
                                    aria-label={t('progressAria', { decided, total })}
                                />
                                <span className="text-xs text-content-muted whitespace-nowrap">
                                    {decided}/{total}
                                </span>
                            </div>
                        );
                    },
                },
            ]),
        [tenantSlug, t, formatDate],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                                { label: t('title') },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1} data-testid="access-reviews-title">
                            {t('title')}
                        </Heading>
                        <p className="text-sm text-content-muted">
                            {t('campaignCount', { count: reviews.length })}
                        </p>
                    </div>
                    <CreateCampaignButton
                        tenantSlug={tenantSlug}
                        onCreated={(reviewId) => {
                            queryClient.invalidateQueries({
                                queryKey: ['access-reviews', tenantSlug],
                            });
                            router.push(
                                `/t/${tenantSlug}/access-reviews/${reviewId}`,
                            );
                        }}
                    />
                </div>
                {truncated ? <TruncationBanner truncated /> : null}
            </ListPageShell.Header>
            <ListPageShell.Body>
                {reviews.length === 0 ? (
                    <div
                        className="rounded border border-border-subtle bg-bg-subtle p-12 text-center"
                        data-testid="access-reviews-empty"
                    >
                        <p className="text-content-muted">
                            {t.rich('emptyState', { strong: (chunks) => <strong>{chunks}</strong> })}
                        </p>
                    </div>
                ) : (
                    <div data-testid="access-reviews-table">
                        <DataTable
                            fillBody
                            mobileFallback="card"
                            data={reviews}
                            columns={columns}
                            getRowId={(r) => r.id}
                            resourceName={(plural) =>
                                plural ? t('resourcePlural') : t('resourceSingular')
                            }
                        />
                        {/* Per-row testid markers for downstream tests
                         *  that don't reach into DataTable internals. */}
                        <div hidden>
                            {reviews.map((r) => (
                                <span
                                    key={r.id}
                                    data-testid={`access-review-row-${r.id}`}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </ListPageShell.Body>
        </ListPageShell>
    );
}

// ─── Create campaign modal ─────────────────────────────────────────

interface CreateCampaignButtonProps {
    tenantSlug: string;
    onCreated: (reviewId: string) => void;
}

function CreateCampaignButton({
    tenantSlug,
    onCreated,
}: CreateCampaignButtonProps) {
    const t = useTranslations('accessReviews');
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [scope, setScope] = useState<'ALL_USERS' | 'ADMIN_ONLY'>('ALL_USERS');
    const [reviewerUserId, setReviewerUserId] = useState('');
    const [dueAt, setDueAt] = useState<Date | null>(null);
    const [error, setError] = useState<string | null>(null);

    const apiUrl = `/api/t/${tenantSlug}/access-reviews`;

    const createMutation = useMutation({
        mutationFn: async () => {
            setError(null);
            const body = {
                name,
                description: description || undefined,
                scope,
                reviewerUserId,
                dueAt: dueAt ? dueAt.toISOString() : undefined,
            };
            const res = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Failed to create campaign');
            }
            return (await res.json()) as { accessReviewId: string };
        },
        onSuccess: (data) => {
            setOpen(false);
            setName('');
            setDescription('');
            setReviewerUserId('');
            setDueAt(null);
            onCreated(data.accessReviewId);
        },
        onError: (err) => {
            setError(err instanceof Error ? err.message : 'Unknown error');
        },
    });

    const submit = () => {
        if (!name.trim() || !reviewerUserId.trim()) {
            setError(t('errorRequired'));
            return;
        }
        createMutation.mutate();
    };

    return (
        <>
            <Button
                onClick={() => setOpen(true)}
                data-testid="access-review-new-campaign-button"
            >
                {t('newCampaign')}
            </Button>
            {open ? (
                <Modal showModal={open} setShowModal={setOpen}>
                    <Modal.Header title={t('modalTitle')} />
                    <Modal.Body>
                        <div className="space-y-default">
                            <FormField label={t('fieldName')} required>
                                <input
                                    className="input"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder={t('namePlaceholder')}
                                    data-testid="access-review-new-name"
                                />
                            </FormField>
                            <FormField label={t('fieldDescription')}>
                                <textarea
                                    className="input"
                                    rows={3}
                                    value={description}
                                    onChange={(e) =>
                                        setDescription(e.target.value)
                                    }
                                    placeholder={t('descriptionPlaceholder')}
                                />
                            </FormField>
                            <FormField label={t('fieldScope')}>
                                <RadioGroup
                                    value={scope}
                                    onValueChange={(v) =>
                                        setScope(
                                            v as 'ALL_USERS' | 'ADMIN_ONLY',
                                        )
                                    }
                                    className="flex flex-col gap-tight"
                                >
                                    {(
                                        [
                                            ['ALL_USERS', t('scopeAllUsers')],
                                            ['ADMIN_ONLY', t('scopeAdminOnly')],
                                        ] as const
                                    ).map(([value, labelText]) => (
                                        <label
                                            key={value}
                                            htmlFor={`access-review-scope-${value}`}
                                            className="flex items-center gap-tight text-sm cursor-pointer"
                                        >
                                            <RadioGroupItem
                                                id={`access-review-scope-${value}`}
                                                value={value}
                                                size="sm"
                                            />
                                            {labelText}
                                        </label>
                                    ))}
                                </RadioGroup>
                            </FormField>
                            <FormField label={t('fieldReviewer')} required>
                                {/* People-picker over the tenant's members
                                    (replaces the raw "usr_…" id input). The
                                    wrapping div keeps the stable test id; the
                                    combobox value is the selected user's id. */}
                                <div data-testid="access-review-new-reviewer">
                                    <UserCombobox
                                        tenantSlug={tenantSlug}
                                        selectedId={reviewerUserId || null}
                                        onChange={(userId) =>
                                            setReviewerUserId(userId ?? '')
                                        }
                                        placeholder={t('reviewerPlaceholder')}
                                        searchPlaceholder={t('reviewerSearchPlaceholder')}
                                        forceDropdown
                                        matchTriggerWidth
                                        id="access-review-reviewer-select"
                                    />
                                </div>
                            </FormField>
                            <FormField label={t('fieldDueDate')}>
                                <DatePicker
                                    value={dueAt}
                                    onChange={setDueAt}
                                    clearable
                                />
                            </FormField>
                            {error ? (
                                <p
                                    className="text-sm text-content-error"
                                    data-testid="access-review-new-error"
                                >
                                    {error}
                                </p>
                            ) : null}
                        </div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button
                            variant="secondary"
                            onClick={() => setOpen(false)}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            onClick={submit}
                            disabled={createMutation.isPending}
                            data-testid="access-review-new-submit"
                        >
                            {createMutation.isPending
                                ? t('creating')
                                : t('submitCreate')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            ) : null}
        </>
    );
}
