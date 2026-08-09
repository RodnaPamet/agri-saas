'use client';

/**
 * Satellite imagery guide — a single explainer page for the vegetation-index
 * map overlays (NDVI / NDMI / NDRE / GNDVI / EVI). The map legend's "Learn
 * more" link deep-links here with the active index as a hash (e.g.
 * `…/knowledge/satellite#ndvi`); the effect below scrolls to that section,
 * Wikipedia-style. One section per index, each with a short blurb and a
 * "how to read the colours" note tied to the same gradient the map uses.
 *
 * ── W5/#93 (KB wire-up PR) — what folded into the article model, and what
 *    deliberately did NOT ──
 *
 * This page used to be the ONLY place this content existed. It still IS the
 * live UI (kept as-is on purpose — see below), but the same explanatory text
 * is now ALSO authored as real, versioned `KnowledgeArticle` rows AND as
 * retrievable `KnowledgeChunk` rows, so it stops being invisible to the rest
 * of the product:
 *
 *   - `scripts/rag/corpus.ts` — GLOBAL_CORPUS gained 5 bg + 5 en entries
 *     (`bg-satellite-*` / `en-satellite-*`). These are retrievable by EVERY
 *     tenant with zero setup (GLOBAL chunks need no per-tenant seeding), so
 *     the ask box (`/knowledge`), the field briefing, and the agronomy
 *     advisor can all ground an answer in this content today.
 *   - `scripts/import-knowledge.ts` — `SATELLITE_GUIDES` gained 5 bg + 5 en
 *     `KnowledgeArticle` entries (category "Satellite Imagery"), seeded via
 *     `npm run import:knowledge` the same way the growing-guide overviews
 *     are. These show up in the `/knowledge` list — searchable, filterable
 *     by category, versioned — for any tenant that has run the seed.
 *
 * What could NOT fold: THIS PAGE. `KnowledgeArticle.tenantId` is a required
 * (non-nullable) column (`prisma/schema/knowledge.prisma`) — unlike
 * `KnowledgeChunk`, there is no GLOBAL/tenant-less Article row. Making this
 * guide's LIVE rendering read from the Article model would mean either (a)
 * a schema change to make Article tenant-optional (a cross-cutting change
 * well outside this PR's scope), or (b) every tenant running the seed
 * script before the guide would show anything — which would SILENTLY EMPTY
 * this page for the (majority of) tenants that never run it, the exact
 * "drop content silently" outcome the brief for this PR warned against. So
 * the live guide below keeps reading from i18n (`messages/*.json`,
 * `satelliteImagery.*`) exactly as before — works for every tenant, with no
 * setup — and the article-model copy above is the complementary,
 * RETRIEVABLE half. The `/knowledge` link below is how a reader gets from
 * one to the other.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Heading, TextLink } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { cn } from '@/lib/cn';
import { VEGETATION_INDICES } from '@/lib/agro/vegetation-indices';

/** Matches the `category` seeded onto every `SATELLITE_GUIDES` article in
 *  `scripts/import-knowledge.ts` — the pivot the link below filters on. */
const SATELLITE_ARTICLE_CATEGORY = 'Satellite Imagery';

export default function SatelliteImageryGuidePage() {
    const t = useTranslations('satelliteImagery');
    const router = useRouter();
    const tenantHref = useTenantHref();

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
                {/* W5/#93 — this content also lives as searchable, versioned
                    articles (and, for every tenant, as retrievable ask-box /
                    field-briefing grounding) — see the module doc comment. */}
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
                {VEGETATION_INDICES.map((idx) => (
                    <section key={idx.id} id={idx.id} className="scroll-mt-24 space-y-default">
                        <Heading level={2}>{t(`${idx.id}.title`)}</Heading>
                        <p className="max-w-prose text-content-secondary">{t(`${idx.id}.blurb`)}</p>

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
                            <p className="max-w-prose text-sm text-content-secondary">
                                {t(`${idx.id}.colours`)}
                            </p>
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}
