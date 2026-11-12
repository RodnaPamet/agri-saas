'use client';

/**
 * The handling-time reading and the undelivered-statement queue — #2735, PR 4.
 *
 * ## TWO clocks, each with its own denominator
 *
 * `decision` is `createdAt` → the first `ModerationAction`; `answer` is
 * `createdAt` → the first DELIVERED statement. P5.8 recorded that these are
 * different duties under Art 16 and Art 17 and that NEITHER subsumes the
 * other — the repo even carried the two figures in two places before that was
 * settled. So both are shown, separately, and each median is rendered beside
 * its own `n`.
 *
 * A median with no denominator is the failure `a-coverage-number-names-its-axis`
 * describes: "4 hours" over three notices and over three hundred are different
 * facts, and a reader cannot tell them apart from the figure alone. A window
 * with `n: 0` is shown as having no measurement rather than as a dash that
 * reads like zero.
 *
 * ## `undelivered` is a BREACH, not a backlog
 *
 * The usecase's own comment says so. A statement queued and never sent means
 * the recipient was never answered, and the danger is that nothing else shows
 * it: the action is recorded and the notice reads ACTIONED. So the count is
 * given prominence and its oldest age beside it — an age is what separates "the
 * dispatcher is mid-cycle" from "this has been stuck for a week".
 *
 * ## What this does NOT claim
 *
 * The list below is statements that EXIST and have not been sent. It is not
 * "decisions that produced no statement" — nothing answers that question, and a
 * heading implying otherwise would read as coverage of a gap that is still
 * open.
 */
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Heading } from '@/components/ui/typography';
import { apiPost } from '@/lib/api-client';
import { formatDate } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

interface Clock {
    n: number;
    medianSeconds: number | null;
    p90Seconds: number | null;
    withinTarget: number;
}
interface StatsWire {
    windowDays: number;
    noticesByStatus: Record<string, number>;
    decision: Clock;
    answer: Clock;
    targetSeconds: number;
    undelivered: { count: number; oldestQueuedAt: string | null; oldestAgeSeconds: number | null };
    unalerted: { count: number; oldestCreatedAt: string | null };
}
interface StatementWire {
    id: string;
    actionId: string;
    recipientUserId: string;
    locale: string;
    createdAt: string;
}

/** Whole hours and minutes. A median in raw seconds is not a readable figure. */
function duration(seconds: number | null): string | null {
    if (seconds === null) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function HandlingStatsClient() {
    const t = useTranslations('moderationQueue');
    const apiUrl = useTenantApiUrl();

    const stats = useTenantSWR<StatsWire>('/admin/moderation/metrics');
    const queue = useTenantSWR<{ statements: StatementWire[] }>('/admin/moderation/statements');

    const [actionId, setActionId] = React.useState('');
    const [recipient, setRecipient] = React.useState('');
    const [body, setBody] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [sent, setSent] = React.useState<'ok' | 'failed' | null>(null);

    async function queueOne() {
        setBusy(true);
        setSent(null);
        try {
            await apiPost(`${apiUrl}/admin/moderation/statements`, {
                actionId: actionId.trim(),
                recipientUserId: recipient.trim(),
                bodyRendered: body.trim(),
            });
            setSent('ok');
            setActionId('');
            setRecipient('');
            setBody('');
            await queue.mutate();
            await stats.mutate();
        } catch {
            setSent('failed');
        } finally {
            setBusy(false);
        }
    }

    const canQueue =
        actionId.trim().length > 0 && recipient.trim().length > 0 && body.trim().length > 0;

    function clock(label: string, c: Clock | undefined) {
        if (!c) return null;
        const median = duration(c.medianSeconds);
        const p90 = duration(c.p90Seconds);
        return (
            <div className="space-y-tight">
                <p className="font-[560]">{label}</p>
                {/*
                  * The DENOMINATOR beside the figure, always. "4h" over three
                  * notices and over three hundred are different facts, and the
                  * figure alone cannot tell them apart.
                  */}
                <p className="text-content-muted">{t('stats.measured', { n: c.n })}</p>
                {c.n === 0 ? (
                    <p className="text-content-muted">{t('stats.noMeasurement')}</p>
                ) : (
                    <>
                        <p>{t('stats.median', { value: median ?? '—' })}</p>
                        <p>{t('stats.p90', { value: p90 ?? '—' })}</p>
                        <p>{t('stats.withinTarget', { n: c.withinTarget, total: c.n })}</p>
                    </>
                )}
            </div>
        );
    }

    const s = stats.data;
    const rows = queue.data?.statements ?? [];

    return (
        <div className="space-y-section">
            <div className="rounded-lg border border-border-subtle p-default space-y-default">
                <Heading level={2}>{t('stats.title')}</Heading>
                {s ? (
                    <p className="text-content-muted">
                        {t('stats.window', { days: s.windowDays })}
                    </p>
                ) : null}

                {stats.isLoading ? <Skeleton className="h-24" /> : null}
                {stats.error && !s ? <ErrorState title={t('stats.loadFailed')} /> : null}

                {s ? (
                    <>
                        <div className="flex flex-wrap gap-section">
                            {clock(t('stats.decisionClock'), s.decision)}
                            {clock(t('stats.answerClock'), s.answer)}
                        </div>

                        {/*
                          * A breach rather than a backlog — the usecase says so
                          * in those words. The AGE is what separates "the
                          * dispatcher is mid-cycle" from "stuck for a week".
                          */}
                        {s.undelivered.count > 0 ? (
                            <InlineNotice variant="warning">
                                {t('stats.undelivered', {
                                    count: s.undelivered.count,
                                    age: duration(s.undelivered.oldestAgeSeconds) ?? '—',
                                })}
                            </InlineNotice>
                        ) : (
                            <p className="text-content-muted">{t('stats.undeliveredNone')}</p>
                        )}

                        {s.unalerted.count > 0 ? (
                            <InlineNotice variant="warning">
                                {t('stats.unalerted', { count: s.unalerted.count })}
                            </InlineNotice>
                        ) : null}
                    </>
                ) : null}
            </div>

            <div className="rounded-lg border border-border-subtle p-default space-y-default">
                <Heading level={2}>{t('statements.title')}</Heading>
                {/*
                  * The heading and this sentence both say EXIST-AND-UNSENT
                  * rather than "unexplained", because nothing answers which
                  * decisions produced no statement at all.
                  */}
                <p className="text-content-muted">{t('statements.intro')}</p>

                {queue.isLoading ? <Skeleton className="h-16" /> : null}
                {queue.error && rows.length === 0 ? (
                    <ErrorState title={t('statements.loadFailed')} />
                ) : null}
                {!queue.isLoading && !queue.error && rows.length === 0 ? (
                    <EmptyState variant="no-records" title={t('statements.empty')} />
                ) : null}

                <div className="space-y-compact">
                    {rows.map((r) => (
                        <div key={r.id} className="flex flex-wrap gap-tight">
                            <span className="font-[560]">{formatDate(r.createdAt)}</span>
                            <span className="text-content-muted">
                                {t('statements.row', { actionId: r.actionId, locale: r.locale })}
                            </span>
                        </div>
                    ))}
                </div>

                <Heading level={3}>{t('statements.queueTitle')}</Heading>
                <p className="text-content-muted">{t('statements.queueIntro')}</p>
                <FormField label={t('statements.actionIdLabel')} required>
                    <Input value={actionId} onChange={(e) => setActionId(e.target.value)} />
                </FormField>
                <FormField
                    label={t('statements.recipientLabel')}
                    hint={t('statements.recipientHint')}
                    required
                >
                    <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} />
                </FormField>
                <FormField label={t('statements.bodyLabel')} hint={t('statements.bodyHint')} required>
                    <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
                </FormField>
                {sent === 'ok' ? (
                    <InlineNotice variant="success">{t('statements.queued')}</InlineNotice>
                ) : null}
                {sent === 'failed' ? (
                    <InlineNotice variant="error">{t('statements.queueFailed')}</InlineNotice>
                ) : null}
                <Button variant="primary" disabled={busy || !canQueue} onClick={queueOne}>
                    {t('statements.queueSubmit')}
                </Button>
            </div>
        </div>
    );
}
