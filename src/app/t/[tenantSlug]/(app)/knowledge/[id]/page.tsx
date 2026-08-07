'use client';
/* TODO(swr-migration): this file mirrors the Policy detail page's
 * fetch-on-mount + setState shape (flagged by
 * react-hooks/set-state-in-effect). Each call site carries an inline
 * disable directive; a later pass migrates the whole detail surface to
 * useTenantSWR (Epic 69), same as the Policy detail follow-up. */

import { formatDate } from '@/lib/format-date';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import {
    useTenantApiUrl,
    useTenantHref,
    useTenantContext,
} from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { sanitizeRichTextHtml } from '@/lib/security/sanitize';
import type { RichTextContentType } from '@/components/ui/RichTextEditor';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { MetaStrip } from '@/components/ui/meta-strip';
import { Card, cardVariants } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { cn } from '@/lib/cn';

// Lazy-load Tiptap — the editor + ProseMirror chunks land at ~200KB
// gzipped; deferring the import keeps the static parts of the detail
// page (current view, versions) light unless the Editor tab opens.
// Mirrors the Policy detail page.
function EditorLoading() {
    const t = useTranslations('knowledge.detail');
    return (
        <Card
            elevation="inset"
            density="compact"
            className="text-center text-sm text-content-muted"
        >
            {t('loadingEditor')}
        </Card>
    );
}

const RichTextEditor = dynamic(
    () => import('@/components/ui/RichTextEditor').then((m) => m.RichTextEditor),
    {
        ssr: false,
        loading: () => <EditorLoading />,
    },
);

// Status badge tone keyed off the article status enum.
const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    PUBLISHED: 'success',
    ARCHIVED: 'warning',
};

interface ArticleVersion {
    id: string;
    versionNumber: number;
    contentType: 'HTML' | 'MARKDOWN';
    contentText: string | null;
    changeSummary: string | null;
    createdAt: string;
    createdBy: { id: string; name: string | null } | null;
    _count?: { acknowledgements: number };
}

interface ArticleDetail {
    id: string;
    slug: string;
    title: string;
    summary: string | null;
    category: string | null;
    status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
    source: string | null;
    language: string | null;
    currentVersionId: string | null;
    owner: { id: string; name: string | null } | null;
    updatedAt: string;
    versions: ArticleVersion[];
    currentVersion: ArticleVersion | null;
    acknowledged: boolean;
}

type KnowledgeTab = 'current' | 'versions' | 'editor';

export default function KnowledgeArticleDetailPage() {
    const t = useTranslations('knowledge.detail');
    const tk = useTranslations('knowledge');
    const params = useParams();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const tenant = useTenantContext();
    const articleId = params?.id as string;

    const [article, setArticle] = useState<ArticleDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [tab, setTab] = useState<KnowledgeTab>('current');

    // Editor state
    const [editorContent, setEditorContent] = useState('');
    const [editorContentType, setEditorContentType] =
        useState<RichTextContentType>('HTML');
    const [changeSummary, setChangeSummary] = useState('');
    const [saving, setSaving] = useState(false);

    // Per-action loading key (publish-<id>, acknowledge, …)
    const [actionLoading, setActionLoading] = useState('');

    const fetchArticle = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(apiUrl(`/knowledge/${articleId}`));
            if (!res.ok) throw new Error('Article not found');
            const data = await res.json();
            setArticle(data);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, [apiUrl, articleId]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => {
        fetchArticle();
    }, [fetchArticle]);

    // ── Actions ──

    const createVersion = async () => {
        if (!editorContent.trim()) return;
        setSaving(true);
        setError('');
        try {
            const res = await fetch(apiUrl(`/knowledge/${articleId}/versions`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contentType: editorContentType,
                    contentText: editorContent,
                    changeSummary: changeSummary || null,
                }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error?.message || d.error || 'Failed to create version');
            }
            setEditorContent('');
            setChangeSummary('');
            setEditorContentType('HTML');
            setTab('versions');
            await fetchArticle();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setSaving(false);
        }
    };

    const publishVersion = async (versionId: string) => {
        setActionLoading('publish-' + versionId);
        try {
            const res = await fetch(apiUrl(`/knowledge/${articleId}/publish`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ versionId }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error?.message || d.error || 'Failed to publish');
            }
            await fetchArticle();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setActionLoading('');
        }
    };

    const acknowledge = async () => {
        setActionLoading('acknowledge');
        try {
            const res = await fetch(
                apiUrl(`/knowledge/${articleId}/acknowledge`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                },
            );
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error?.message || d.error || 'Failed to acknowledge');
            }
            await fetchArticle();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setActionLoading('');
        }
    };

    const archiveArticle = async () => {
        setActionLoading('archive');
        try {
            const res = await fetch(apiUrl(`/knowledge/${articleId}/archive`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error?.message || d.error || 'Failed to archive');
            }
            await fetchArticle();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setActionLoading('');
        }
    };

    // ── Helpers ──

    // COPY of the Policy detail page's version-content rendering: HTML
    // versions render via dangerouslySetInnerHTML with
    // `sanitizeRichTextHtml` as defence-in-depth (the backend already
    // sanitises on write via `sanitizeRichTextHtml`). MARKDOWN keeps the
    // whitespace-pre rendering — the content path stores markdown as
    // literal text and we deliberately don't add a parser here.
    const renderVersionContent = (v: ArticleVersion) => {
        if (v.contentType === 'HTML') {
            const safe = sanitizeRichTextHtml(v.contentText ?? '');
            if (!safe.trim()) {
                return (
                    <span className="text-content-subtle italic">{t('noContent')}</span>
                );
            }
            return (
                <div
                    className="prose prose-sm prose-invert max-w-none text-content-default text-sm"
                    data-testid={`knowledge-version-html-${v.id}`}
                    dangerouslySetInnerHTML={{ __html: safe }}
                />
            );
        }
        return (
            <div className="prose prose-sm prose-invert max-w-none text-content-default whitespace-pre-wrap text-sm">
                {v.contentText || (
                    <span className="text-content-subtle italic">{t('noContent')}</span>
                )}
            </div>
        );
    };

    // ── Render ──

    const breadcrumbs = [
        { label: tk('bcDashboard'), href: tenantHref('/dashboard') },
        { label: tk('bcKnowledge'), href: tenantHref('/knowledge') },
        { label: article?.title ?? t('bcArticle') },
    ];

    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (error && !article) {
        return (
            <EntityDetailLayout error={error} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!article) {
        return (
            <EntityDetailLayout
                empty={{ message: t('notFound') }}
                title=""
                breadcrumbs={breadcrumbs}
            >
                <></>
            </EntityDetailLayout>
        );
    }

    // NO fallback to `versions?.[0]` — an article with no PUBLISHED
    // version must show the "not yet published" empty state, never the
    // newest DRAFT. Falling back here would present an unapproved
    // procedure as "Current" to every reader (a real-world safety
    // issue on an SOP surface — see the 2026-08-07 implementation note).
    const currentVersion = article.currentVersion;
    const versions = article.versions || [];
    const canWrite = tenant.permissions.canWrite;
    const canAdmin = tenant.permissions.canAdmin;
    const isPublished = article.status === 'PUBLISHED';
    // Publish is the only thing that moves `currentVersionId` — every
    // OTHER version is pending work that hasn't gone live yet.
    const unpublishedCount = versions.filter((v) => v.id !== article.currentVersionId).length;

    const tabs: ReadonlyArray<{ key: KnowledgeTab; label: string }> = [
        { key: 'current', label: t('tabCurrent') },
        { key: 'versions', label: t('tabVersions') },
        ...(canWrite ? ([{ key: 'editor' as const, label: t('tabEditor') }]) : []),
    ];

    return (
        <EntityDetailLayout
            id="knowledge-detail-page"
            breadcrumbs={breadcrumbs}
            tabs={tabs}
            activeTab={tab}
            onTabChange={setTab}
            title={
                <span className="truncate" id="knowledge-title">
                    {article.title}
                </span>
            }
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            id: 'knowledge-status',
                            label: t('metaStatus'),
                            value: article.status,
                            variant: STATUS_VARIANT[article.status] ?? 'neutral',
                        },
                        ...(article.category
                            ? [
                                  {
                                      label: t('metaCategory'),
                                      value: article.category,
                                  } as const,
                              ]
                            : []),
                        ...(article.source
                            ? [
                                  {
                                      label: t('metaSource'),
                                      value: article.source,
                                  } as const,
                              ]
                            : []),
                        ...(article.owner
                            ? [
                                  {
                                      label: t('metaOwner'),
                                      value: article.owner.name ?? '—',
                                  } as const,
                              ]
                            : []),
                        // Publish semantics (2026-08-07): a new version no
                        // longer retracts the live PUBLISHED content, so
                        // pending edits can silently pile up underneath it.
                        // Surface the count here so they stay visible.
                        ...(unpublishedCount > 0
                            ? [
                                  {
                                      kind: 'metric',
                                      label: t('metaPendingVersions'),
                                      value: unpublishedCount,
                                  } as const,
                              ]
                            : []),
                    ]}
                />
            }
            actions={
                <>
                    {canWrite && article.status !== 'ARCHIVED' && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                                setTab('editor');
                                setEditorContent(currentVersion?.contentText || '');
                                setEditorContentType(
                                    currentVersion?.contentType === 'MARKDOWN'
                                        ? 'MARKDOWN'
                                        : 'HTML',
                                );
                            }}
                            id="new-version-btn"
                        >
                            {t('newVersion')}
                        </Button>
                    )}
                    {canAdmin && article.status !== 'ARCHIVED' && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-content-muted hover:text-content-error"
                            onClick={archiveArticle}
                            disabled={actionLoading === 'archive'}
                            id="archive-btn"
                        >
                            {actionLoading === 'archive' ? '…' : t('archive')}
                        </Button>
                    )}
                </>
            }
        >
            {error && (
                <InlineNotice
                    variant="error"
                    icon={null}
                    onDismiss={() => setError('')}
                >
                    {error}
                </InlineNotice>
            )}

            {/* Summary + acknowledge affordance */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                {article.summary && (
                    <p className="text-sm text-content-muted">{article.summary}</p>
                )}
                <div className="flex items-center justify-between gap-default">
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-content-subtle">
                        {article.language && <span>{article.language}</span>}
                        <span>
                            {t('versionsCount', { count: versions.length })}
                        </span>
                    </div>
                    {/* Acknowledge — readership receipt. Only meaningful on a
                        PUBLISHED article (you acknowledge published content,
                        not a draft). Once acknowledged, show the confirmed
                        state instead of the button. */}
                    {article.acknowledged ? (
                        <span
                            className="inline-flex items-center gap-tight text-xs font-medium text-content-success"
                            id="knowledge-acknowledged"
                            data-testid="knowledge-acknowledged"
                        >
                            <StatusBadge variant="success">
                                {t('acknowledgedBadge')}
                            </StatusBadge>
                        </span>
                    ) : (
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={acknowledge}
                            disabled={!isPublished || actionLoading === 'acknowledge'}
                            id="acknowledge-btn"
                            data-testid="acknowledge-btn"
                        >
                            {actionLoading === 'acknowledge'
                                ? '…'
                                : t('acknowledge')}
                        </Button>
                    )}
                </div>
                {!isPublished && !article.acknowledged && (
                    <p className="text-xs text-content-subtle">
                        {t('ackOpensWhenPublished')}
                    </p>
                )}
            </div>

            {/* ── Current Version ── */}
            {tab === 'current' && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    {currentVersion ? (
                        <>
                            <div className="flex items-center justify-between">
                                <div className="text-sm text-content-muted">
                                    {t('versionLine', {
                                        number: currentVersion.versionNumber,
                                        author: currentVersion.createdBy?.name ?? t('unknownAuthor'),
                                        date: formatDate(currentVersion.createdAt),
                                    })}
                                </div>
                            </div>
                            {renderVersionContent(currentVersion)}
                        </>
                    ) : (
                        <div className="text-center text-content-subtle py-8">
                            <p>{t('noVersionPublished')}</p>
                            {canWrite && (
                                <p className="text-sm mt-1">
                                    {t('createInEditor')}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* ── Version History ── */}
            {tab === 'versions' && (
                <div className="space-y-compact" id="version-history">
                    {versions.length === 0 ? (
                        <Card className="text-center text-content-subtle">
                            {t('noVersionsYet')}
                        </Card>
                    ) : (
                        versions.map((v) => {
                            const isCurrentPublished =
                                article.currentVersionId === v.id;
                            const ackCount = v._count?.acknowledgements ?? 0;
                            return (
                                <div
                                    key={v.id}
                                    className={cn(
                                        cardVariants({ density: 'compact' }),
                                        'space-y-compact',
                                    )}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-compact">
                                            <span className="text-sm font-semibold text-[var(--brand-default)]">
                                                v{v.versionNumber}
                                            </span>
                                            {isCurrentPublished ? (
                                                <StatusBadge variant="success">
                                                    {t('publishedBadge')}
                                                </StatusBadge>
                                            ) : (
                                                <StatusBadge variant="neutral">
                                                    {t('draftBadge')}
                                                </StatusBadge>
                                            )}
                                            <span className="text-xs text-content-subtle">
                                                {v.createdBy?.name ?? t('unknownAuthor')} ·{' '}
                                                {formatDate(v.createdAt)}
                                            </span>
                                            <span className="text-xs text-content-subtle">
                                                {t('acksCount', { count: ackCount })}
                                            </span>
                                        </div>
                                        <div className="flex gap-tight">
                                            {canAdmin && !isCurrentPublished && (
                                                <Button
                                                    variant="primary"
                                                    size="sm"
                                                    onClick={() =>
                                                        publishVersion(v.id)
                                                    }
                                                    disabled={!!actionLoading}
                                                    id={`publish-version-${v.versionNumber}`}
                                                >
                                                    {actionLoading ===
                                                    'publish-' + v.id
                                                        ? '…'
                                                        : t('publish')}
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                    {v.changeSummary && (
                                        <p className="text-sm text-content-muted italic">
                                            {v.changeSummary}
                                        </p>
                                    )}
                                    <details className="group">
                                        <summary className="text-xs text-[var(--brand-default)] cursor-pointer hover:text-[var(--brand-muted)]">
                                            {t('showContent')}
                                        </summary>
                                        <div className="mt-2 border-t border-border-subtle pt-2">
                                            {renderVersionContent(v)}
                                        </div>
                                    </details>
                                </div>
                            );
                        })
                    )}
                </div>
            )}

            {/* ── Editor ── */}
            {tab === 'editor' && canWrite && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <div className="flex items-center justify-between">
                        <Heading level={3}>{t('createNewVersion')}</Heading>
                    </div>

                    <RichTextEditor
                        id="version-editor"
                        value={editorContent}
                        contentType={editorContentType}
                        placeholder={t('editorPlaceholder')}
                        onChange={(value, nextType) => {
                            setEditorContent(value);
                            setEditorContentType(nextType);
                        }}
                    />

                    <FormField label={t('changeSummary')} hint={t('changeSummaryHint')}>
                        <Input
                            value={changeSummary}
                            onChange={(e) => setChangeSummary(e.target.value)}
                            placeholder={t('changeSummaryPlaceholder')}
                            id="change-summary-input"
                        />
                    </FormField>

                    <Button
                        variant="primary"
                        onClick={createVersion}
                        disabled={saving || !editorContent.trim()}
                        id="save-version-btn"
                    >
                        {saving ? t('saving') : t('saveVersion')}
                    </Button>
                </div>
            )}
        </EntityDetailLayout>
    );
}
