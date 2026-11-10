'use client';

/**
 * The «Канали» directory (P9.5, #2939).
 *
 * ## Grouped by the KEY PREFIX, not by `kind`
 *
 * P9.2 made the prefix load-bearing: an input channel is `TOPIC` with an
 * `input:` key, never `CROP` with `crop:`, because suggestion treats them
 * differently — a crop channel goes to a farm that grows that crop, and an
 * input channel has no such join because every arable farm buys diesel and
 * fertiliser. Grouping on `kind` would put the five input channels under a
 * heading that stops being true the first time a `TOPIC` is added that is not
 * an input. The prefix says what the channel IS.
 *
 * Anything with an unrecognised prefix falls into a final group rather than
 * disappearing, because a channel the directory silently omits is a channel
 * nobody can join — and `listChannels` already filters archived ones, so an
 * absence here would be indistinguishable from a retirement.
 *
 * ## LEAVING goes through the undo toast, because it is not lossless
 *
 * Epic 67's rule is that every delete answers for itself, and the tempting
 * answer here was an EXEMPT entry reading "leaving is reversible from the same
 * button, so ceremony around it is ceremony around an undoable action" — which
 * is `BlockPersonButton`'s exemption almost verbatim.
 *
 * It is false. Leaving DELETES the `ChannelMembership` row, and that row
 * carries `lastReadAt` and `mutedAt`. Rejoining writes a FRESH row
 * (`@@unique([channelId, userId])`), so a misclicked Leave loses the read
 * cursor — where «Нови съобщения» would sit — and any mute. Small, and real,
 * and exactly what a five-second window protects.
 *
 * JOIN stays immediate: it is additive, and an undo window on it would delay
 * the thing the person asked for.
 *
 * ## Join and leave are OPTIMISTIC, and the row is the source of truth
 *
 * `listChannels` returns `joined` from the caller's OWN membership row —
 * `channel_membership_select` admits that row and no other (P9.1's recursion
 * rule), which is also why `memberCount` is denormalised. So the button acts
 * on what the server said about this caller, and a failure revalidates rather
 * than guessing: the alternative is a count drifting from a membership nobody
 * can re-read.
 *
 * ## Nothing here joins anybody automatically
 *
 * P9.2's rule, held by a guard whose allowlist names exactly one file: a
 * channel is SUGGESTED and joined by the person. This screen lists and the
 * person presses.
 */
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import useSWR from 'swr';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Heading } from '@/components/ui/typography';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { useToastWithUndo } from '@/components/ui/hooks';
import { apiDelete, apiGet, apiPost } from '@/lib/api-client';

interface ChannelWire {
    id: string;
    key: string;
    nameBg: string;
    nameEn: string;
    kind: string;
    memberCount: number;
    slowModeSeconds: number;
    joined: boolean;
    banned: boolean;
}

/** The prefixes P9.2 seeds, in the order a farmer is likeliest to want them. */
const GROUPS = ['crop:', 'oblast:', 'input:'] as const;

export function ChannelsDirectoryClient({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('channels');
    const locale = useLocale();

    // A LITERAL person-scoped path. Every list on this screen's neighbours
    // builds `/api/t/{tenantSlug}/…`; channel policies key on `app.user_id`,
    // which only `runInUserContext` sets, so a tenant route would read zero
    // rows with no error (#1664).
    const { data, error, isLoading, mutate } = useSWR<{ channels: ChannelWire[] }>(
        '/api/social/channels',
        (url: string) => apiGet<{ channels: ChannelWire[] }>(url),
    );

    const [busy, setBusy] = React.useState<string | null>(null);
    const triggerUndoToast = useToastWithUndo();

    const channels = data?.channels ?? [];

    const nameOf = React.useCallback(
        (c: ChannelWire) => (locale === 'bg' ? c.nameBg : c.nameEn),
        [locale],
    );

    const join = React.useCallback(
        async (c: ChannelWire) => {
            setBusy(c.id);
            try {
                await apiPost(`/api/social/channels/${encodeURIComponent(c.id)}/join`, {});
            } finally {
                setBusy(null);
                // REVALIDATE rather than guess, on success AND on failure.
                // `memberCount` is denormalised because a member cannot count
                // the others (P9.1's recursion rule), so an optimistic number
                // invented here could not be corrected by any later read.
                await mutate();
            }
        },
        [mutate],
    );

    const leave = React.useCallback(
        (c: ChannelWire) => {
            // The DELETE is deferred five seconds; Undo cancels it outright, so
            // a misclick never reaches the server and `lastReadAt` survives.
            triggerUndoToast({
                action: () =>
                    apiDelete(`/api/social/channels/${encodeURIComponent(c.id)}/join`),
                onCommit: () => void mutate(),
                onError: () => void mutate(),
                message: t('leftChannel'),
                undoMessage: t('undo'),
            });
        },
        [mutate, t, triggerUndoToast],
    );

    const grouped = React.useMemo(() => {
        const out: { label: string; rows: ChannelWire[] }[] = [];
        for (const prefix of GROUPS) {
            const rows = channels.filter((c) => c.key.startsWith(prefix));
            if (rows.length > 0) out.push({ label: t(`group.${prefix.slice(0, -1)}`), rows });
        }
        const other = channels.filter((c) => !GROUPS.some((p) => c.key.startsWith(p)));
        if (other.length > 0) out.push({ label: t('group.other'), rows: other });
        return out;
    }, [channels, t]);

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('breadcrumbCurrent') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-xs text-content-muted">{t('intro')}</p>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <div className="min-h-0 flex-1 space-y-section overflow-y-auto pr-1">
                    {error ? (
                        <ErrorState description={t('loadError')} onRetry={() => void mutate()} />
                    ) : isLoading && channels.length === 0 ? (
                        <div className="space-y-default" aria-busy="true">
                            {[0, 1, 2].map((i) => (
                                <Skeleton key={i} className="h-14 w-full rounded-lg" />
                            ))}
                        </div>
                    ) : channels.length === 0 ? (
                        <EmptyState variant="no-records" title={t('empty')} />
                    ) : (
                        grouped.map((group) => (
                            <section key={group.label} className="space-y-default">
                                <Heading
                                    level={2}
                                    className="text-xs font-[560] uppercase tracking-[0.04em] text-content-muted"
                                >
                                    {group.label}
                                </Heading>
                                {group.rows.map((c) => (
                                    <div
                                        key={c.id}
                                        className="flex items-center gap-default rounded-lg border border-border-subtle p-4"
                                    >
                                        <Link
                                            href={`/t/${tenantSlug}/channels/${c.id}`}
                                            className="min-w-0 flex-1 hover:underline"
                                        >
                                            <span className="font-medium text-content-emphasis">
                                                {nameOf(c)}
                                            </span>
                                            {/*
                                              * The number goes AFTER a label. The
                                              * client interpolator handles ICU, but
                                              * the i18n drift check reads an ICU
                                              * plural's inner words as placeholder
                                              * names, and «членове: 3» is
                                              * grammatical at every count in both
                                              * languages.
                                              */}
                                            <span className="ml-2 text-xs text-content-muted">
                                                {t('members', { count: c.memberCount })}
                                            </span>
                                        </Link>
                                        {c.banned ? (
                                            /*
                                              * Shown rather than silently refusing.
                                              * P9.1 keeps the membership row on a
                                              * ban precisely so a rejoin cannot
                                              * escape it, so the button would fail
                                              * with no explanation.
                                              */
                                            <StatusBadge variant="error">
                                                {t('banned')}
                                            </StatusBadge>
                                        ) : (
                                            <Button
                                                variant={c.joined ? 'secondary' : 'primary'}
                                                onClick={() =>
                                                    c.joined ? leave(c) : void join(c)
                                                }
                                                disabled={busy === c.id}
                                            >
                                                {c.joined ? t('leave') : t('join')}
                                            </Button>
                                        )}
                                    </div>
                                ))}
                            </section>
                        ))
                    )}
                </div>
            </ListPageShell.Body>
        </ListPageShell>
    );
}
