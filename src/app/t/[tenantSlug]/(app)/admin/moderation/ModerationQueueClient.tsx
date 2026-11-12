'use client';

/**
 * The Art 16 triage queue and the Art 17 decision form (#2735).
 *
 * ## It does NOT reimplement `assertPerformable`, deliberately
 *
 * `actOnNotice` refuses a kind the platform cannot carry out for a given
 * subject — a direct message is reportable and NOT removable, by owner ruling
 * — with `MODERATION_ACTION_NOT_PERFORMABLE`. The tempting UX is to offer only
 * the performable kinds per subject, and that would be a SECOND SPELLING of a
 * policy whose first spelling is the server's: the #1664 class, where the two
 * copies diverge and the divergence is a wrong decision rather than a wrong
 * sentence. So every kind is offered and the refusal is surfaced. A moderator
 * learns the same fact either way; only one of the two ways can drift.
 *
 * ## The outcome list is NOT symmetric, and the form says so
 *
 * `NONE` is a decision — "looked and did nothing" — which moves the notice to
 * REJECTED, because an absent row cannot distinguish that from "never looked".
 * `ACCOUNT_SUSPENDED` / `ACCOUNT_TERMINATED` additionally REQUIRE an account,
 * and that requirement is what closes #1635: for a month the console accepted
 * the outcome, the Art 17 statement told the recipient they could not post,
 * and nothing anywhere withheld anything. The account field is therefore
 * disclosed by the choice rather than always present — an always-visible field
 * on a content removal reads as optional, which is how it got forgotten.
 *
 * ## It shows no reporter, and that is not an omission to fix
 *
 * `listNotices` returns `anonymous: boolean` and never `reporterUserId`. A
 * moderator decides on the CONTENT; knowing who reported it invites deciding
 * on the reporter. `anonymous` is shown because it changes whether there is
 * anybody to answer to under Art 17.
 *
 * ## `subjectNoticeCount` is DISPLAY ONLY
 *
 * Shown because several notices about one subject is a fact a moderator should
 * have. Nothing here may SORT by it — P5.5b drew that line for the AI score
 * and `notice-score-is-shadow-only` covers this field too. "Order the queue by
 * report count" looks like an improvement and is a number a brigade can drive.
 */
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Heading } from '@/components/ui/typography';
import { apiPost } from '@/lib/api-client';
import { formatDate } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

interface NoticeWire {
    id: string;
    createdAt: string;
    subjectKind: string;
    subjectId: string;
    reasonCode: string;
    status: string;
    anonymous: boolean;
    detail: string | null;
    snapshot: { capturedAt: string; captureError: string | null } | null;
    subjectNoticeCount: number;
}

const STATUSES = ['RECEIVED', 'TRIAGED', 'ACTIONED', 'REJECTED'] as const;
type Status = (typeof STATUSES)[number];

/** Mirrors `MODERATION_ACTION_KINDS`; the server is the authority. */
const ACTION_KINDS = ['NONE', 'CONTENT_REMOVED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_TERMINATED'] as const;
type ActionKind = (typeof ACTION_KINDS)[number];

/** Which outcomes withhold access, and so require an account to be named. */
const WITHHOLDS_ACCESS: readonly ActionKind[] = ['ACCOUNT_SUSPENDED', 'ACCOUNT_TERMINATED'];

type Outcome =
    | 'ACTED'
    | 'NOT_FOUND'
    | 'NOT_PERFORMABLE'
    | 'SUSPEND_TARGET_REQUIRED'
    | 'FAILED';

export function ModerationQueueClient({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('moderationQueue');
    // The eight reason codes ALREADY have Bulgarian, under the namespace the
    // report dialog uses. A second copy here would be two spellings of one
    // label, and the i18n guards cannot see that: parity compares the two
    // CATALOGUES to each other, so duplicated copy is perfectly balanced.
    const tReason = useTranslations('trustSafety.report.reason');
    const apiUrl = useTenantApiUrl();

    const [status, setStatus] = React.useState<Status>('RECEIVED');
    const [openId, setOpenId] = React.useState<string | null>(null);
    const [kind, setKind] = React.useState<ActionKind>('CONTENT_REMOVED');
    const [rationale, setRationale] = React.useState('');
    const [suspendUserId, setSuspendUserId] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [outcome, setOutcome] = React.useState<Outcome | null>(null);

    const { data, error, isLoading, mutate } = useTenantSWR<{ notices: NoticeWire[] }>(
        `/admin/moderation/notices?status=${status}`,
    );

    const notices = data?.notices ?? [];

    function openFor(id: string) {
        // Reset the whole form, not just the id. A rationale left over from a
        // previous notice is the one mistake here that is unrecoverable: it
        // becomes the Art 17 statement sent to a different person.
        setOpenId(id);
        setKind('CONTENT_REMOVED');
        setRationale('');
        setSuspendUserId('');
        setOutcome(null);
    }

    const needsAccount = WITHHOLDS_ACCESS.includes(kind);
    const canSubmit =
        rationale.trim().length > 0 && (!needsAccount || suspendUserId.trim().length > 0);

    async function act(reportId: string) {
        setBusy(true);
        setOutcome(null);
        try {
            await apiPost(`${apiUrl}/admin/moderation/notices`, {
                reportId,
                actionKind: kind,
                rationale: rationale.trim(),
                ...(needsAccount ? { suspendUserId: suspendUserId.trim() } : {}),
            });
            setOutcome('ACTED');
            setOpenId(null);
            await mutate();
        } catch (err) {
            const code =
                err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
            if (code === 'MODERATION_ACTION_NOT_PERFORMABLE') setOutcome('NOT_PERFORMABLE');
            else if (code === 'SUSPEND_TARGET_REQUIRED') setOutcome('SUSPEND_TARGET_REQUIRED');
            else if (code === 'NOT_FOUND' || code === 'not_found') setOutcome('NOT_FOUND');
            else setOutcome('FAILED');
        } finally {
            setBusy(false);
        }
    }

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbAdmin'), href: `/t/${tenantSlug}/admin` },
                        { label: t('title') },
                    ]}
                />
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-content-muted">{t('subtitle')}</p>
            </ListPageShell.Header>

            <ListPageShell.Body>
                {/*
                  * `<ToggleGroup>`, not four buttons: Epic 60's rule is that a
                  * segmented filter row is this primitive, and #2963 learned it
                  * from `design-system-drift` rather than from reading first.
                  */}
                <ToggleGroup
                    selected={status}
                    selectAction={(v: string) => {
                        setStatus(v as Status);
                        // Collapsing the open form on a filter change is not
                        // tidiness: the notice it belonged to may not be in the
                        // new page, and a rationale left attached to a
                        // different id becomes somebody else's statement of
                        // reasons.
                        setOpenId(null);
                    }}
                    options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
                    ariaLabel={t('statusFilterAria')}
                />

                {outcome === 'ACTED' ? (
                    <InlineNotice variant="success">{t('outcome.ACTED')}</InlineNotice>
                ) : null}

                {isLoading ? <Skeleton className="h-24" /> : null}
                {error && notices.length === 0 ? (
                    // Gated on having nothing to show, so a failed BACKGROUND
                    // refetch keeps the queue on screen rather than blanking it.
                    <ErrorState title={t('loadFailed')} />
                ) : null}

                {!isLoading && !error && notices.length === 0 ? (
                    <EmptyState variant="no-records" title={t(`empty.${status}`)} />
                ) : null}

                <div className="space-y-default">
                    {notices.map((n) => (
                        <div
                            key={n.id}
                            className="rounded-lg border border-border-default p-default space-y-default"
                        >
                            <div className="flex flex-wrap items-center gap-tight">
                                <StatusBadge>{t(`status.${n.status}`)}</StatusBadge>
                                <span className="font-[560]">{tReason(n.reasonCode)}</span>
                                <span className="text-content-muted">
                                    {t('subjectLine', {
                                        kind: t(`subjectKind.${n.subjectKind}`),
                                        id: n.subjectId,
                                    })}
                                </span>
                                <span className="text-content-muted">
                                    {formatDate(n.createdAt)}
                                </span>
                            </div>

                            <div className="flex flex-wrap gap-tight text-content-muted">
                                <span>
                                    {n.anonymous ? t('anonymousYes') : t('anonymousNo')}
                                </span>
                                {/* DISPLAY ONLY — nothing sorts by this. */}
                                <span>{t('noticeCount', { count: n.subjectNoticeCount })}</span>
                                <span>
                                    {n.snapshot === null
                                        ? t('evidenceNone')
                                        : n.snapshot.captureError
                                            ? t('evidenceFailed')
                                            : t('evidenceCaptured')}
                                </span>
                            </div>

                            {n.detail ? <p>{n.detail}</p> : null}

                            {openId === n.id ? (
                                <div className="space-y-default">
                                    {/*
                                      * `<RadioGroup>`, not a native select: the
                                      * epic55 ratchet caps those and may only go
                                      * down, and four visible choices is exactly
                                      * what RadioGroup is documented for.
                                      */}
                                    <FormField label={t('outcomeLabel')} required>
                                        <RadioGroup
                                            value={kind}
                                            onValueChange={(v) => setKind(v as ActionKind)}
                                            className="flex flex-col gap-compact"
                                        >
                                            {ACTION_KINDS.map((k) => (
                                                <label
                                                    key={k}
                                                    className="flex items-start gap-compact text-sm"
                                                >
                                                    <RadioGroupItem value={k} />
                                                    <span>
                                                        <span className="font-[560]">
                                                            {t(`kind.${k}`)}
                                                        </span>
                                                        <span className="block text-content-muted">
                                                            {t(`kindHint.${k}`)}
                                                        </span>
                                                    </span>
                                                </label>
                                            ))}
                                        </RadioGroup>
                                    </FormField>

                                    <FormField label={t('rationaleLabel')} hint={t('rationaleHint')} required>
                                        <Textarea
                                            value={rationale}
                                            onChange={(e) => setRationale(e.target.value)}
                                            rows={4}
                                        />
                                    </FormField>

                                    {needsAccount ? (
                                        <FormField
                                            label={t('accountLabel')}
                                            hint={t('accountHint')}
                                            required
                                        >
                                            <Input
                                                value={suspendUserId}
                                                onChange={(e) => setSuspendUserId(e.target.value)}
                                            />
                                        </FormField>
                                    ) : null}

                                    {outcome === 'NOT_PERFORMABLE' ? (
                                        <InlineNotice variant="warning">
                                            {t('outcome.NOT_PERFORMABLE')}
                                        </InlineNotice>
                                    ) : null}
                                    {outcome === 'SUSPEND_TARGET_REQUIRED' ? (
                                        <InlineNotice variant="warning">
                                            {t('outcome.SUSPEND_TARGET_REQUIRED')}
                                        </InlineNotice>
                                    ) : null}
                                    {outcome === 'NOT_FOUND' ? (
                                        <InlineNotice variant="warning">
                                            {t('outcome.NOT_FOUND')}
                                        </InlineNotice>
                                    ) : null}
                                    {outcome === 'FAILED' ? (
                                        <InlineNotice variant="error">
                                            {t('outcome.FAILED')}
                                        </InlineNotice>
                                    ) : null}

                                    <div className="flex gap-tight">
                                        <Button
                                            variant="primary"
                                            disabled={busy || !canSubmit}
                                            onClick={() => act(n.id)}
                                        >
                                            {t('record')}
                                        </Button>
                                        <Button variant="ghost" onClick={() => setOpenId(null)}>
                                            {t('cancel')}
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <Button variant="secondary" onClick={() => openFor(n.id)}>
                                    {t('decide')}
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            </ListPageShell.Body>
        </ListPageShell>
    );
}
