'use client';

/**
 * Conversations from BOTH sides AND both kinds, in one list.
 *
 * A tenant sells in some threads and buys in others, and since P8.4 the same
 * screen also carries direct conversations, which belong to the PERSON rather
 * than to any farm. They are one inbox to whoever is reading them, whatever
 * the schema calls the parties.
 *
 * ── Two queries, and they are not interchangeable ──
 *
 * The Борса half comes from the tenant-scoped `/exchange/threads`, whose
 * audience includes either farm's OWNER/ADMIN — so an owner sees a colleague's
 * negotiation, which they can do today and must keep doing. The DM half comes
 * from `/api/social/inbox?source=dm`, which is person-scoped.
 *
 * `listInbox` also has an exchange half, and using it here would have been the
 * tidy-looking mistake: it admits the caller only as the inquirer or the
 * listing's seller, so the merge would silently REMOVE rows this screen shows
 * now. Hence `?source=dm` — see that route's docblock.
 *
 * ── Why polling ──
 *
 * There is no broker for either half (#2809 is the person-scoped channel the
 * DM side will need). A 30s refresh is what makes an inbox feel live without
 * one. When a transport lands, this file changes and nothing behind it does.
 *
 * ── The DM half is the same under every farm ──
 *
 * This screen is `/t/{tenantSlug}/…` and a DM has no tenant, so a member of
 * three farms sees the same direct conversations under all three. Inherent to
 * the ruling that put them here, not a bug to scope away — the DM policies key
 * on `app.user_id`, which a tenant context does not set (#1664).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { apiGet } from '@/lib/api-client';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { useTenantHref } from '@/lib/tenant-context-provider';

import { ExchangeNav } from '../ExchangeNav';

/** The wire shape of `listExchangeThreads` — dates arrive as ISO strings. */
interface ThreadSummary {
    id: string;
    listingId: string;
    listingCommodity: string;
    listingRegionName: string;
    listingQuantityTonnes: string;
    sellerDisplayName: string | null;
    role: 'seller' | 'inquirer';
    lastMessageAt: string;
    closed: boolean;
    hasUnread: boolean;
}

/** The wire shape of one `listInbox` item. */
interface InboxItemWire {
    source: 'dm' | 'exchange';
    id: string;
    lastMessageAt: string;
    lastReadAt: string | null;
    unread: boolean;
    awaitingMyAnswer: boolean | null;
    title: string | null;
}

/**
 * A literal path, NOT `useTenantSWR`. Every other call on this screen builds
 * `/api/t/{tenantSlug}/…`, so reaching for that hook here is the natural
 * mistake — and this route is person-scoped precisely because the DM policies
 * key on `app.user_id`, which only `runInUserContext` sets. A tenant route
 * would read zero rows with no error. Same rule as the P5.3 trust-safety
 * controls.
 */
const DM_INBOX_PATH = '/api/social/inbox?source=dm';

type Row =
    | { kind: 'exchange'; at: string; thread: ThreadSummary }
    | { kind: 'dm'; at: string; item: InboxItemWire };

/**
 * ONE badge per DM row, strongest first — or none.
 *
 * `awaitingYourReply` WINS over `unread` rather than sitting beside it. The
 * two are not the same fact (a request can be read and still unanswered) but
 * they are the same CALL — look at this one — and `badge-density` is right
 * that two loud badges on a row compete rather than inform.
 *
 * It is a FUNCTION returning a variant rather than two JSX branches because
 * that guard counts badge ELEMENTS in the source, not renders per row: this
 * file sits at the default budget of 4, and two branches would be two
 * elements. Consolidating is the remedy the guard's own message asks for, next
 * to demoting.
 *
 * The element name is not written anywhere in this comment on purpose. That
 * guard does NOT strip comments before counting, so an explanatory docblock
 * naming it becomes a fifth element and keeps the file over budget — which is
 * exactly what the first version of this comment did.
 *
 * `awaitingYourReply` is a phrase and not a noun, because «Заявки» is spoken
 * for by `exchange.nav.myInterests` («Моите заявки») — naming a request bucket
 * needs a ruling this PR does not have.
 */
function dmBadge(item: InboxItemWire): { variant: 'warning' | 'success' } | null {
    if (item.awaitingMyAnswer) return { variant: 'warning' };
    if (item.unread) return { variant: 'success' };
    return null;
}

export interface ThreadsClientProps {
    /** The EXCHANGE module is available (plan ∧ tenant). */
    readonly exchange: boolean;
    /** The `social.direct-messages` flag is on for this caller. */
    readonly directMessages: boolean;
}

export function ThreadsClient({ exchange, directMessages }: ThreadsClientProps) {
    const { formatDateTime } = useDateFormat();
    const t = useTranslations('exchange.messaging');
    const tDm = useTranslations('chat');
    const tenantHref = useTenantHref();

    // `null` as the key is SWR's documented way to skip a fetch. A disabled
    // half must not be requested at all: the API would answer 404 on the flag
    // or redirect on the module, and an error state for a surface the caller
    // was never offered is noise they cannot act on.
    const ex = useTenantSWR<{ threads: ThreadSummary[] }>(
        exchange ? '/exchange/threads' : null,
        { refreshInterval: 30_000 },
    );
    const dm = useSWR<{ items: InboxItemWire[] }>(
        directMessages ? DM_INBOX_PATH : null,
        (url: string) => apiGet<{ items: InboxItemWire[] }>(url),
        { refreshInterval: 30_000 },
    );

    const rows: Row[] = [
        ...(ex.data?.threads ?? []).map(
            (thread): Row => ({ kind: 'exchange', at: thread.lastMessageAt, thread }),
        ),
        ...(dm.data?.items ?? []).map((item): Row => ({ kind: 'dm', at: item.lastMessageAt, item })),
    ]
        // One total order over both kinds. Descending by activity, with the id
        // as a tie-break so two rows stamped in the same millisecond do not
        // swap places between renders — a list that reorders under a thumb is
        // how somebody opens the wrong conversation.
        .sort((a, b) => {
            if (a.at !== b.at) return a.at < b.at ? 1 : -1;
            const aId = a.kind === 'dm' ? a.item.id : a.thread.id;
            const bId = b.kind === 'dm' ? b.item.id : b.thread.id;
            return aId < bId ? 1 : -1;
        });

    // A half that is OFF contributes no error and no spinner. Loading is
    // "something we asked for has not answered"; failure is "everything we
    // asked for failed" — a half-failure keeps the rows we did get rather than
    // blanking the screen, which is the `isError && rows.length === 0` rule
    // the list pages already follow.
    const loading = (exchange && ex.isLoading) || (directMessages && dm.isLoading);
    const failedAll =
        (!exchange || Boolean(ex.error)) && (!directMessages || Boolean(dm.error));
    const anyAsked = exchange || directMessages;

    const retry = () => {
        if (exchange) void ex.mutate();
        if (directMessages) void dm.mutate();
    };

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbExchange'), href: tenantHref('/exchange') },
                        { label: t('breadcrumbCurrent') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('inboxTitle')}</Heading>
                <ExchangeNav />
            </ListPageShell.Header>
            <ListPageShell.Body>
                <div className="min-h-0 flex-1 space-y-default overflow-y-auto pr-1">
                    {anyAsked && failedAll ? (
                        <ErrorState description={t('loadError')} onRetry={retry} />
                    ) : loading && rows.length === 0 ? (
                        <div className="space-y-default" aria-busy="true">
                            {[0, 1, 2].map((i) => (
                                <Skeleton key={i} className="h-16 w-full rounded-lg" />
                            ))}
                        </div>
                    ) : rows.length === 0 ? (
                        /*
                         * `<EmptyState>`, not an inline div. The inline
                         * version predates this PR and was INVISIBLE to
                         * `empty-state-coverage`, whose detector matches
                         * `rows|items|data|results|list|entries|records`
                         * `.length === 0` — the old code said
                         * `threads.length === 0`, and `threads` is not in that
                         * list. Renaming the variable for the merge is what
                         * brought the file into the guard's population, so the
                         * finding is real and pre-existing rather than
                         * introduced here.
                         */
                        <EmptyState variant="no-records" title={t('inboxEmpty')} />
                    ) : (
                        rows.map((row) =>
                            row.kind === 'exchange' ? (
                                <Link
                                    key={`ex:${row.thread.id}`}
                                    href={tenantHref(`/exchange/threads/${row.thread.id}`)}
                                    className="flex items-center gap-default rounded-lg border border-border-subtle p-4 hover:bg-bg-muted/50"
                                >
                                    <span className="font-medium text-content-emphasis">
                                        {row.thread.listingCommodity}
                                    </span>
                                    {/*
                                      * Region and tonnage, because commodity alone
                                      * could not tell two wheat listings apart. The
                                      * seller name is a bonus when published — it is
                                      * opt-in, and two listings from one seller would
                                      * still collide without the facts beside it.
                                      */}
                                    <span className="text-xs text-content-muted">
                                        {row.thread.listingRegionName} ·{' '}
                                        {row.thread.listingQuantityTonnes} t
                                        {row.thread.sellerDisplayName
                                            ? ` · ${row.thread.sellerDisplayName}`
                                            : ''}
                                    </span>
                                    <StatusBadge variant="neutral">
                                        {row.thread.role === 'seller'
                                            ? t('roleSeller')
                                            : t('roleInquirer')}
                                    </StatusBadge>
                                    {row.thread.hasUnread ? (
                                        <StatusBadge variant="success">{t('unread')}</StatusBadge>
                                    ) : null}
                                    {row.thread.closed ? (
                                        <StatusBadge variant="neutral">{t('closed')}</StatusBadge>
                                    ) : null}
                                    <span className="ml-auto text-sm text-content-muted">
                                        {formatDateTime(row.thread.lastMessageAt)}
                                    </span>
                                </Link>
                            ) : (
                                <Link
                                    key={`dm:${row.item.id}`}
                                    href={tenantHref(`/exchange/threads/dm/${row.item.id}`)}
                                    className="flex items-center gap-default rounded-lg border border-border-subtle p-4 hover:bg-bg-muted/50"
                                >
                                    <span className="font-medium text-content-emphasis">
                                        {/*
                                          * `title` is the counterparty's farm name when
                                          * one is published. A null title is a real
                                          * state — the other party has no public
                                          * profile — so it falls back to a neutral
                                          * label rather than rendering an empty row
                                          * that looks like a loading failure.
                                          */}
                                        {row.item.title ?? tDm('directConversation')}
                                    </span>
                                    {/*
                                      * ONE badge per row, strongest first.
                                      * `awaitingYourReply` is a phrase rather
                                      * than a noun because «Заявки» is spoken
                                      * for by `exchange.nav.myInterests`
                                      * («Моите заявки»), so naming a bucket
                                      * needs a ruling this PR does not have.
                                      *
                                      * It WINS over `unread` instead of
                                      * sitting beside it: the two are not the
                                      * same fact (a request can be read and
                                      * still unanswered) but they are the same
                                      * CALL — look at this one — and
                                      * `badge-density` is right that two loud
                                      * badges on a row compete rather than
                                      * inform. It refused this file at 5
                                      * against a default budget of 4, which is
                                      * what prompted the collapse.
                                      */}
                                    {dmBadge(row.item) ? (
                                        <StatusBadge variant={dmBadge(row.item)!.variant}>
                                            {dmBadge(row.item)!.variant === 'warning'
                                                ? tDm('awaitingYourReply')
                                                : t('unread')}
                                        </StatusBadge>
                                    ) : null}
                                    <span className="ml-auto text-sm text-content-muted">
                                        {formatDateTime(row.item.lastMessageAt)}
                                    </span>
                                </Link>
                            ),
                        )
                    )}
                </div>
            </ListPageShell.Body>
        </ListPageShell>
    );
}
