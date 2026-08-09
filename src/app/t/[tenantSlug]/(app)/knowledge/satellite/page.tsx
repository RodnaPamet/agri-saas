'use client';

/**
 * Satellite imagery guide — a single explainer page for the vegetation-index
 * map overlays (NDVI / NDMI / NDRE / GNDVI / EVI). The map legend's "Learn
 * more" link deep-links here with the active index as a hash (e.g.
 * `…/knowledge/satellite#ndvi`); the effect below scrolls to that section,
 * Wikipedia-style. One section per index, with a body sourced from the
 * article model (see below) and a "how to read the colours" note tied to
 * the same gradient the map uses.
 *
 * ── W5 final task (2026-08-09) — pointed at the article model ──
 *
 * `KnowledgeArticle.tenantId` is now NULLABLE (migration
 * 20260809130000_knowledge_global_articles) — `NULL` = GLOBAL,
 * platform-authored, readable by every tenant with no per-tenant seed
 * step. `scripts/rag/ingest-satellite-guide.ts` writes one bg + one en
 * GLOBAL `KnowledgeArticle` (+ version) per vegetation index, category
 * "Satellite Imagery". This page fetches them via
 * `GET /knowledge/satellite-guide?lang=<locale>` and renders each
 * index's sanitised article HTML (minus its own `<h2>` — this page keeps
 * its own heading below) in place of the old hardcoded blurb + colour
 * text.
 *
 * FALLBACK — the exact regression this fold was deferred to avoid: if
 * the GLOBAL article for an index/language is missing (fetch failed, the
 * seed hasn't run yet, a single index's row is absent), that index's
 * section falls back to the ORIGINAL `messages/*.json`
 * (`satelliteImagery.*`) content, which stays in the message catalogues
 * UNCHANGED for exactly this reason. The fallback is per-section, not
 * all-or-nothing, and the page renders the i18n copy IMMEDIATELY (before
 * the fetch even resolves) rather than showing a loading/blank state, so
 * a slow or failed fetch degrades to "exactly like before", never to
 * blank. `GLOBAL_CORPUS` (`scripts/rag/corpus.ts`) separately carries
 * the same explanatory text as retrievable `KnowledgeChunk` rows for the
 * ask box / field briefing / agronomy advisor — unaffected by this page.
 */
import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Heading, TextLink } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { useTenantHref, useTenantApiUrl } from '@/lib/tenant-context-provider';
import { cn } from '@/lib/cn';
import { VEGETATION_INDICES } from '@/lib/agro/vegetation-indices';
import { sanitizeRichTextHtml } from '@/lib/security/sanitize';

/** Matches the `category` seeded onto every GLOBAL article by
 *  `scripts/rag/ingest-satellite-guide.ts` — the pivot the link below
 *  filters on, and (kept as a literal, no shared import — see
 *  `SATELLITE_ARTICLE_CATEGORY` in `usecases/knowledge.ts`) the same
 *  category the fetch below narrows to server-side. */
const SATELLITE_ARTICLE_CATEGORY = 'Satellite Imagery';

interface SatelliteGuideArticle {
    id: string;
    slug: string;
    title: string;
    summary: string | null;
    language: string | null;
    currentVersion: { contentType: 'HTML' | 'MARKDOWN'; contentText: string | null } | null;
}

/** `satellite-<indexId>-<lang>` → `<indexId>` — the seed script's slug
 *  convention (mirrors `VEGETATION_INDICES[].id`). */
function indexIdFromSlug(slug: string): string {
    return slug.replace(/^satellite-/, '').replace(/-(bg|en)$/, '');
}

/** The seeded HTML always opens with `<h2>{title}</h2>` (mirroring this
 *  page's own per-section heading) — stripped so the two headings don't
 *  duplicate. Safe/best-effort: a shape that doesn't match is returned
 *  unchanged rather than mangled. */
function stripLeadingHeading(html: string): string {
    return html.replace(/^\s*<h2[^>]*>[\s\S]*?<\/h2>\s*/i, '');
}

export default function SatelliteImageryGuidePage() {
    const t = useTranslations('satelliteImagery');
    const locale = useLocale();
    const router = useRouter();
    const tenantHref = useTenantHref();
    const apiUrl = useTenantApiUrl();

    // Article-model content, keyed by vegetation-index id. `null` = not
    // loaded yet (or the fetch failed) — every section renders its i18n
    // fallback in that state, so the page NEVER shows blank/loading chrome
    // for this content (see the module doc comment).
    const [articlesByIndex, setArticlesByIndex] = useState<Record<string, SatelliteGuideArticle> | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(apiUrl(`/knowledge/satellite-guide?lang=${encodeURIComponent(locale)}`));
                if (!res.ok || cancelled) return;
                const data: SatelliteGuideArticle[] = await res.json();
                if (cancelled) return;
                const map: Record<string, SatelliteGuideArticle> = {};
                for (const article of data) {
                    map[indexIdFromSlug(article.slug)] = article;
                }
                setArticlesByIndex(map);
            } catch {
                // Network/parse failure — articlesByIndex stays null and every
                // section keeps rendering its i18n fallback. Deliberately silent:
                // this is a progressive enhancement over content that already
                // renders correctly without it.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [apiUrl, locale]);

    // Scroll to the deep-linked section once the client-rendered content
    // exists — native hash scrolling misses it on the first client render.
    useEffect(() => {
        const id = window.location.hash.slice(1);
        if (!id) return;
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    return (
        <div className="mx-auto w-full max-w-3xl space-y-section px-4 py-6">
            <div className="space-y-default">
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbParent'), href: tenantHref('/knowledge') },
                        { label: t('title') },
                    ]}
                />
                <Button variant="ghost" size="sm" onClick={() => router.back()}>
                    {t('back')}
                </Button>
                <Heading level={1}>{t('title')}</Heading>
                <p className="max-w-prose text-content-secondary">{t('intro')}</p>
                {/* W5 — the sections below are sourced from this same GLOBAL
                    article category; this link is how a reader finds it in
                    the searchable /knowledge list too. See the module doc
                    comment. */}
                <p className="text-xs text-content-subtle">
                    <TextLink href={tenantHref(`/knowledge?category=${encodeURIComponent(SATELLITE_ARTICLE_CATEGORY)}`)}>
                        {t('searchableInKnowledgeBase')}
                    </TextLink>
                </p>
            </div>

            {/* Table of contents — jump links to each index's section. */}
            <nav
                aria-label={t('tocLabel')}
                className="rounded-lg border border-border-subtle bg-bg-muted p-4"
            >
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-content-subtle">
                    {t('tocLabel')}
                </p>
                <ul className="space-y-tight">
                    {VEGETATION_INDICES.map((idx) => (
                        <li key={idx.id}>
                            <a
                                href={`#${idx.id}`}
                                className="text-content-link underline hover:text-content-emphasis"
                            >
                                {t(`${idx.id}.title`)}
                            </a>
                        </li>
                    ))}
                </ul>
            </nav>

            <div className="space-y-section">
                {VEGETATION_INDICES.map((idx) => {
                    const article = articlesByIndex?.[idx.id];
                    const version = article?.currentVersion;
                    // Only an HTML version with real content overrides the
                    // fallback — a missing article, a missing version, or a
                    // non-HTML content type all fall through to i18n.
                    const articleHtml =
                        version?.contentType === 'HTML' && version.contentText
                            ? sanitizeRichTextHtml(stripLeadingHeading(version.contentText))
                            : null;

                    return (
                        <section key={idx.id} id={idx.id} className="scroll-mt-24 space-y-default">
                            <Heading level={2}>{t(`${idx.id}.title`)}</Heading>
                            {articleHtml ? (
                                // The GLOBAL article's sanitised HTML already
                                // covers BOTH the blurb AND the "how to read
                                // the colours" explanation as one block (see
                                // scripts/rag/ingest-satellite-guide.ts) —
                                // defence-in-depth sanitise on top of the
                                // write-time sanitise, mirroring the article
                                // detail page's `renderVersionContent`.
                                <div
                                    className="max-w-prose space-y-tight text-content-secondary [&_strong]:text-content-default"
                                    data-testid={`satellite-article-content-${idx.id}`}
                                    dangerouslySetInnerHTML={{ __html: articleHtml }}
                                />
                            ) : (
                                <p className="max-w-prose text-content-secondary">{t(`${idx.id}.blurb`)}</p>
                            )}

                            {/* How to read the colours — the exact gradient the map
                                legend paints, with the low/high captions. */}
                            <div className="space-y-tight rounded-lg border border-border-subtle p-3">
                                <div className="flex items-center gap-compact text-xs text-content-subtle">
                                    <span>{idx.lowLabel}</span>
                                    <span
                                        aria-hidden="true"
                                        className={cn('h-2 w-full max-w-xs rounded-full', idx.legendGradientClass)}
                                    />
                                    <span>{idx.highLabel}</span>
                                </div>
                                {/* Already folded into articleHtml above when present. */}
                                {!articleHtml && (
                                    <p className="max-w-prose text-sm text-content-secondary">
                                        {t(`${idx.id}.colours`)}
                                    </p>
                                )}
                            </div>
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
